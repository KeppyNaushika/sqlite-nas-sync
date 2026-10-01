/**
 * 同期の前提（設計書 `docs/rows-table-design.md` §1.8）を、起動時に確かめる。
 *
 * ここで断るものは、**通してしまうと後から直せない**種類の破れである。
 *
 * | 何を見るか | 破れたとき | なぜ |
 * | --- | --- | --- |
 * | 主キーが NULL を取らないこと（P1） | 例外 | NULL の主キーは版の鍵にならず、`INTEGER PRIMARY KEY` では SQLite が id を作ってしまう |
 * | 決定的でない関数（P8） | 例外 | 同じ行が端末や時刻によって置ける・置けないに分かれ、補題2と定理1が破れる |
 * | 独自に登録された照合順序・関数（P8） | 例外 | 一時 DB に同じものが無く、判定が別物になる |
 * | 解析できない索引（P8） | 例外 | かぶりの勝者を引けない |
 * | 同期する表を親とする外部キーが親の主キー以外を参照する（P14） | 例外 | 子の親が削除されたのか、まだ届いていないのかを区別できず、原則4 に従えない |
 * | 親のいない子（P5） | 警告 | 親を置けない行はアプリの表に出ないので、導入前から壊れていた行が静かに消える |
 * | 時刻列に ISO-8601 の文字列でない値（P15） | 例外 | 削除は実行した時刻で比べるので、数値や NULL などの時刻とは比べられない |
 * | 大きく未来の時刻 | 警告 | 引き上げは下がらないので、その行の順序が以後ほぼ書き込み順だけで決まる |
 * | 内部テーブルと同じ名前の表やビューで、ライブラリが読む列が無い | 例外 | ライブラリはその表を自分の表として読み書きし、列が無いという例外で止まるか、アプリの表を消す |
 *
 * @module setup/rows-preflight
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, foldIdentifier, isSameIdentifier } from './sql'
import { parseCreateIndex } from '../rows/index-parse'
import { VERSION_COLUMNS, tableOfRowsTable } from '../rows/schema'
import { assertDeterministicSql } from '../rows/sql-functions'
import { isIsoTimeSql } from '../rows/triggers'
import { DEFAULTS } from '../types'

/** 検査する表1つ分の指定。 */
interface RowsPreflightTable {
  name: string
  /**
   * 順序に使う時刻列。無い列を指しても、その表の時刻にまつわる検査を飛ばすだけ
   * @defaultValue `'updatedAt'`
   */
  timestampColumn?: string
}

/** {@link checkRowsPreconditions} の設定。`setupSync` は渡さない。試験のための差し込み口。 */
interface RowsPreflightOptions {
  /**
   * 「大きく未来」と見なす幅（ミリ秒）。現在時刻からこれ以上先の値は警告になる
   * @defaultValue 366日
   */
  futureToleranceMs?: number
  /** いま何時かを答える手続き（検査から差し替えるための口） */
  now?: () => number
}

/** {@link checkRowsPreconditions} の結果。例外にならなかった気がかりを載せる。 */
interface RowsPreflightResult {
  /** 利用者へ知らせる警告（空なら気がかり無し） */
  warnings: string[]
}

/** 1年ぶん。これより先の時刻は「時計が進んでいる」と見て警告する。 */
const DEFAULT_FUTURE_TOLERANCE_MS = 366 * 24 * 60 * 60 * 1000

/**
 * 設計書 §1.8 の前提を確かめる。破れていれば例外、気がかりは警告として返す。
 *
 * @param db 同期するローカル DB
 * @param tables 同期する表
 */
export function checkRowsPreconditions(
  db: Database.Database,
  tables: RowsPreflightTable[],
  options: RowsPreflightOptions = {}
): RowsPreflightResult {
  const warnings: string[] = []
  // 内部テーブルは移行が書き換えるので、ほかの検査より先に見る
  assertInternalTablesAreOurs(db)
  const custom = readCustomRegistrations(db)

  for (const table of tables) {
    assertPrimaryKeyIsNotNull(db, table.name)
    assertSchemaIsDeterministic(db, table.name, custom)
    assertIndexesAreReadable(db, table.name, custom)
    warnings.push(...checkTimestampColumn(db, table, options))
  }
  // 同期する表を親とする外部キーは、子が同期しない表でも見るので、DB の全表を回す
  assertForeignKeysReferencePrimaryKeys(db, tables)
  // 外部キーだけは**表ごとのループの外**で1回。`foreign_key_check(<表>)` は
  // 「その表が子である違反」しか返さないので、同期する表だけを回すと、
  // 同期しない表から同期する表への違反を取りこぼす
  warnings.push(...checkForeignKeys(db, tables))
  return { warnings }
}

/* ------------------------------------------------------------------ *
 * 内部テーブルの名前
 * ------------------------------------------------------------------ */

/**
 * 内部テーブルの名前と、ライブラリがその表から読む列。
 *
 * 以前の版が作り、移行が撤去する `_id_merge` と `_heartbeat` も含める。
 * 列は、その表を作ったすべての版にある列だけを並べる。後の版で足した列は移行が足すので、ここでは求めない。
 */
const INTERNAL_TABLE_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map([
  ['_sync_meta', ['key', 'value']],
  ['_sync_state', ['remoteClientId', 'lastSeenId']],
  ['_changelog', ['id', 'tableName', 'recordId', 'operation']],
  ['_changelog_prune', ['onlyRow', 'prunedThroughId']],
  ['_tombstone', ['tableName', 'recordId']],
  ['_id_merge', ['tableName', 'losingId', 'winningId']],
  ['_heartbeat', ['id', 'updatedAt']],
  ['_sns_clock', ['onlyRow', 'lamport', 'instanceId']],
  ['_sns_tick', ['tableName', 'tick']],
  ['_sns_dirty', ['tableName']],
  ['_sns_shown', ['tableName', 'trueId', 'shownId']],
  ['_sns_hidden', ['tableName', 'trueId', 'winnerId']],
  ['_sns_unplaceable', ['tableName', 'trueId']],
  ['_sns_rebuilding', ['onlyRow']],
])

/** 内部テーブルの名前なら、ライブラリがその表から読む列。そうでなければ `null`。 */
function internalTableColumns(name: string): readonly string[] | null {
  const folded = foldIdentifier(name)
  if (tableOfRowsTable(folded) !== null) return Object.values(VERSION_COLUMNS)
  return INTERNAL_TABLE_COLUMNS.get(folded) ?? null
}

/**
 * 内部テーブルの名前を持つ表とビューが、ライブラリの作った形であること。
 *
 * `_` で始まる表は同期の対象にならないが、内部テーブルと名前が同じなら、ライブラリはその表を自分の表として読み書きする。
 * そのままでは、列が無いという SQLite の例外で止まるか、移行が `_sync_state` の行を消し、`_id_merge` などを `DROP` する。
 * ライブラリが読む列が1つでも無ければ、アプリの表とみなして、DB に触る前に例外にする。
 * 列がすべてそろっている表は、ライブラリが作った表と区別できないので通す。
 */
function assertInternalTablesAreOurs(db: Database.Database): void {
  const entries = db
    .prepare(
      `SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view')`
    )
    .all() as { type: string; name: string }[]
  for (const entry of entries) {
    const required = internalTableColumns(entry.name)
    if (required === null) continue
    const advice = 'アプリの表なら名前を変えること'
    if (entry.type === 'view') {
      throw new Error(
        `${entry.name} は sqlite-nas-sync の内部テーブルの名前だが、ビューである。${advice}`
      )
    }
    const present = (
      db.pragma(`table_xinfo(${escapeIdentifier(entry.name)})`) as {
        name: string
      }[]
    ).map((column) => column.name)
    const missing = required.filter(
      (column) => !present.some((name) => isSameIdentifier(name, column))
    )
    if (missing.length > 0) {
      throw new Error(
        `${entry.name} は sqlite-nas-sync の内部テーブルの名前だが、ライブラリが読む列 ${missing.join(', ')} が無い。${advice}`
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * P1: 主キーが TEXT で宣言され、NULL を取らない
 * ------------------------------------------------------------------ */

/**
 * 主キーが `TEXT` で宣言され、NULL を取らないこと（設計書 §1.8 の P1）。
 *
 * 素の `TEXT PRIMARY KEY` は **NULL を許す**（`WITHOUT ROWID` でも
 * `NOT NULL` 宣言でもない限り）。許したまま同期すると、版の鍵が定まらない。
 *
 * **`INTEGER PRIMARY KEY`（自動採番）は断る。** rowid そのものなので NULL には
 * ならないが、別々の端末が**同じ値を別の行に**割り当てる。その2行は同期で1つの
 * 行として扱われ、片方の中身が失われる。このライブラリは端末をまたいで一意な id
 * （UUID / cuid）を前提にしている。
 */
function assertPrimaryKeyIsNotNull(db: Database.Database, table: string): void {
  const info = db.pragma(`table_xinfo(${escapeIdentifier(table)})`) as {
    name: string
    type: string
    notnull: number
    pk: number
    hidden: number
  }[]
  const primaryKey = info
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
  if (primaryKey.length === 0) {
    throw new Error(
      `同期する表 ${table} に主キーが無い。` +
        ` クライアントをまたいで一意な id（UUID / cuid）を持つ1列を、TEXT で NOT NULL の PRIMARY KEY として宣言すること`
    )
  }
  // 複合主キーは断る（前提 P11）。真の id・`_tombstone.recordId`・`_sns_shown` の
  // すべてが「1つの値」を前提にしているので、通すと版の鍵が定まらない
  if (primaryKey.length > 1) {
    throw new Error(
      `同期する表 ${table} の主キーが複合（${primaryKey
        .map((column) => column.name)
        .join(', ')}）である。複合主キーは扱えないので、主キーを1列にすること`
    )
  }
  const sql = tableSql(db, table)
  const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(sql)

  for (const column of primaryKey) {
    // 端末をまたいで一意な id（UUID / cuid）が前提。自動採番は同じ値が別の行に
    // 割り当たるので、型の宣言の段階で断る
    if (!/^TEXT$/i.test(column.type)) {
      throw new Error(
        `同期する表 ${table} の主キー ${column.name} が TEXT で宣言されていない` +
          `（宣言: ${column.type || '無し'}）。` +
          ` クライアントをまたいで一意な id（UUID / cuid）を TEXT で持つこと` +
          `（INTEGER PRIMARY KEY の自動採番は、別のクライアントが同じ値を別の行に割り当てる）`
      )
    }
    // `WITHOUT ROWID` の主キーは暗黙に NOT NULL
    if (withoutRowid || column.notnull === 1) continue
    throw new Error(
      `同期する表 ${table} の主キー ${column.name} が NULL を取れる。` +
        ` NOT NULL を宣言するか、WITHOUT ROWID にすること`
    )
  }

  // 宣言が正しくても、既存の行に NULL が残っていることはある（旧版で入った行など）
  const condition = primaryKey
    .map((column) => `${escapeIdentifier(column.name)} IS NULL`)
    .join(' OR ')
  const offending = db
    .prepare(
      `SELECT 1 AS found FROM ${escapeIdentifier(table)} WHERE ${condition} LIMIT 1`
    )
    .get()
  if (offending !== undefined) {
    throw new Error(
      `同期する表 ${table} に、主キーが NULL の行がある。` +
        ` 主キーが NULL の行は同期できないので、値を入れるか行を消してから setupSync を呼ぶこと`
    )
  }
}

/* ------------------------------------------------------------------ *
 * P8: 決定的でない関数・独自の登録・読めない索引
 * ------------------------------------------------------------------ */

/** 独自に登録された関数の名前と、組み込みの照合順序の名前（どちらも小文字）。 */
interface CustomRegistrations {
  /** その接続に独自に登録されている関数 */
  functions: Set<string>
  /** 素の SQLite が持っている照合順序（`BINARY` / `NOCASE` / `RTRIM`） */
  builtinCollations: Set<string>
}

/**
 * 独自に登録された関数を、**まっさらな DB と引き比べて**見つける。
 *
 * 組み込みの名前を自分で並べると、SQLite の版が変わるたびに古くなる。
 * 同じ better-sqlite3 で開いた素の `:memory:` に無い名前は、利用者が
 * `db.function()` の類で足したものである。
 *
 * 照合順序は逆に「組み込みの一覧」を取る。宣言に現れた `COLLATE` の名前が
 * そこに無ければ、独自のものか、そもそも存在しないものである。
 * どちらも一時 DB では同じようには判定できないので、断る。
 */
function readCustomRegistrations(db: Database.Database): CustomRegistrations {
  const pristine = new Database(':memory:')
  try {
    const namesOf = (
      target: Database.Database,
      pragma: string,
      key: string
    ): Set<string> =>
      new Set(
        (target.pragma(pragma) as Record<string, string>[]).map((row) =>
          foldIdentifier(String(row[key]))
        )
      )
    const builtinFunctions = namesOf(pristine, 'function_list', 'name')
    const functions = new Set<string>()
    for (const name of namesOf(db, 'function_list', 'name')) {
      if (!builtinFunctions.has(name)) functions.add(name)
    }
    return {
      functions,
      builtinCollations: namesOf(pristine, 'collation_list', 'name'),
    }
  } finally {
    pristine.close()
  }
}

/** 表の `CREATE TABLE` 文（`sqlite_master.sql`）。 */
function tableSql(db: Database.Database, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined
  if (row === undefined || row.sql === null) {
    throw new Error(`同期する表 ${table} の CREATE TABLE が読めない`)
  }
  return row.sql
}

/** `CREATE TABLE` に決定的でない関数・独自の関数・独自の照合順序が無いこと。 */
function assertSchemaIsDeterministic(
  db: Database.Database,
  table: string,
  custom: CustomRegistrations
): void {
  const sql = tableSql(db, table)
  assertDeterministicSql(sql, `表 ${table} の宣言`, custom.functions)
  assertCollationsAreBuiltin(
    sql,
    `表 ${table} の宣言`,
    custom.builtinCollations
  )
}

/**
 * 索引が全部読めること（設計書 §1.5・P8）。
 *
 * 一意でない索引も見る。かぶりの勝者には関わらないが、**式に決定的でない関数が
 * 入っていれば、その索引が張られた表への書き込みが端末ごとに変わりうる**。
 */
function assertIndexesAreReadable(
  db: Database.Database,
  table: string,
  custom: CustomRegistrations
): void {
  const indexes = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`
    )
    .all(table) as { name: string; sql: string }[]
  for (const index of indexes) {
    // 読めない形はここで例外になる（式・照合順序・部分索引の述語も一緒に見る）
    const parsed = parseCreateIndex(index.sql)
    for (const collation of parsed.collations) {
      if (collation === null) continue
      assertCollationsAreBuiltin(
        `COLLATE ${collation}`,
        `索引 ${index.name}`,
        custom.builtinCollations
      )
    }
    assertDeterministicSql(index.sql, `索引 ${index.name}`, custom.functions)
  }
  // 宣言から生えた索引（`UNIQUE` と主キー）の照合順序も見る。`sqlite_master.sql`
  // が NULL なので、字面ではなく `PRAGMA` から読む
  const list = db.pragma(`index_list(${escapeIdentifier(table)})`) as {
    name: string
  }[]
  for (const entry of list) {
    const columns = db.pragma(
      `index_xinfo(${escapeIdentifier(entry.name)})`
    ) as { coll: string; key: number }[]
    for (const column of columns) {
      if (column.key !== 1) continue
      if (custom.builtinCollations.has(foldIdentifier(String(column.coll)))) {
        continue
      }
      throw new Error(
        `組み込みでない照合順序 ${column.coll} が索引 ${entry.name} に使われている。` +
          ` 同期は一時 DB で同じ索引を作って判定するので、組み込みの照合順序（BINARY・NOCASE・RTRIM）にすること`
      )
    }
  }
}

/** `COLLATE <名前>` に組み込み以外の照合順序が現れていないこと。 */
function assertCollationsAreBuiltin(
  sql: string,
  where: string,
  builtinCollations: ReadonlySet<string>
): void {
  const pattern =
    /\bCOLLATE\s+("[^"]*"|\[[^\]]*\]|`[^`]*`|[A-Za-z_][A-Za-z0-9_]*)/gi
  for (const match of sql.matchAll(pattern)) {
    const name = foldIdentifier(match[1].replace(/^["[`]|["\]`]$/g, ''))
    if (builtinCollations.has(name)) continue
    throw new Error(
      `組み込みでない照合順序 ${name} が ${where} に現れている。` +
        ` 同期は一時 DB で同じ表と索引を作って判定するので、組み込みの照合順序（BINARY・NOCASE・RTRIM）にすること`
    )
  }
}

/* ------------------------------------------------------------------ *
 * 時刻列（P15）と、大きく未来の時刻
 * ------------------------------------------------------------------ */

/**
 * 時刻列を見る。ISO 8601 の文字列でない値があれば例外、大きく未来の値は警告。
 *
 * 時刻列に許すのは ISO 8601 の文字列（設計書 §1.2.3 の群3）だけである。削除の版は
 * 削除を実行した時刻（ISO 8601 の文字列）で比べるので、数値・ISO でない文字列・
 * BLOB・NULL の時刻とは同じ物差しで比べられない。判定はトリガーと同じ式
 * （{@link isIsoTimeSql}）を使う。導入後の書き込みはトリガーが止める。
 *
 * 時刻列の名前は大文字小文字を畳んで探す（SQLite にとって同じ列なので）。
 * 表に時刻列が無ければ、時刻にまつわる検査は飛ばす。
 */
function checkTimestampColumn(
  db: Database.Database,
  table: RowsPreflightTable,
  options: RowsPreflightOptions
): string[] {
  const wanted = table.timestampColumn ?? DEFAULTS.timestampColumn
  const info = db.pragma(`table_xinfo(${escapeIdentifier(table.name)})`) as {
    name: string
  }[]
  const found = info.find((entry) => isSameIdentifier(entry.name, wanted))
  if (found === undefined) return []
  const column = found.name

  const quoted = escapeIdentifier(column)
  const name = escapeIdentifier(table.name)
  const notIso = `NOT ${isIsoTimeSql(quoted)}`
  const { count } = db
    .prepare(`SELECT count(*) AS count FROM ${name} WHERE ${notIso}`)
    .get() as { count: number }
  if (count > 0) {
    // 代表は値の種類ごとに1つ（数値・文字列・BLOB・NULL のどれが入っているかが
    // 分かれば、直し方が決まる）。WITHOUT ROWID の表もあるので rowid では選ばない
    const samples = db
      .prepare(
        `SELECT typeof(${quoted}) AS kind, min(${quoted}) AS value
           FROM ${name} WHERE ${notIso}
          GROUP BY typeof(${quoted}) ORDER BY kind`
      )
      .all() as { kind: string; value: unknown }[]
    throw new Error(
      `同期する表 ${table.name} の時刻列 ${column} に、ISO-8601 の文字列でない値が ${count} 件ある` +
        `（例: ${samples.map((row) => describeValue(row.value)).join(', ')}）。` +
        `時刻列は ISO-8601 の文字列（例: 2026-01-01T00:00:00.000Z）で書くこと。` +
        `削除は実行した時刻で比べるので、数値や NULL の時刻とは比べられない`
    )
  }

  const warnings: string[] = []
  const now = options.now?.() ?? Date.now()
  const tolerance = options.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS
  // julianday のエポックは 1970-01-01T00:00:00Z が 2440587.5
  const limit = (now + tolerance) / 86400000 + 2440587.5
  const future = db
    .prepare(
      `SELECT ${quoted} AS value FROM ${name}
        WHERE julianday(${quoted}) > ? ORDER BY julianday(${quoted}) DESC LIMIT 1`
    )
    .get(limit) as { value: unknown } | undefined
  if (future !== undefined) {
    warnings.push(
      `同期する表 ${table.name} の時刻列 ${column} に大きく未来の値がある` +
        `（${String(future.value)}）。` +
        `同期は、その行へのあとの変更の時刻をこの値より小さくしない（単調化）ので、` +
        `その行への変更の勝ち負けは、時刻列の値ではなくほぼ書き込んだ順で決まる`
    )
  }
  return warnings
}

/** 例外の文面に載せる値の見え方。種類が分かるように書く。 */
function describeValue(value: unknown): string {
  if (value === null) return 'NULL'
  if (Buffer.isBuffer(value)) return `BLOB（${value.length} バイト）`
  if (typeof value === 'string') return `'${value}'`
  return String(value)
}

/* ------------------------------------------------------------------ *
 * P14: 同期する表を親とする外部キーは、親の主キーを参照する
 * ------------------------------------------------------------------ */

/**
 * 同期する表を親とする外部キーが、親の主キーを参照していること（前提 P14）。
 *
 * 原則4 は「親行が削除されたときは宣言された `ON DELETE` に従う」。親の主キーを
 * 参照していれば、子の親が削除されたのかを親の削除の版から引ける。主キー以外の
 * `UNIQUE` 列を参照していると、その値を持つ親が削除されたのか、まだ届いていないのかを
 * 区別できず、`ON DELETE` に従えない。
 *
 * 子が同期しない表でも見る。同期する表の親が他の端末で削除されれば、その子にも
 * 同じ問題が起きるからである。`foreign_key_list` は子の側からしか引けないので、
 * DB のすべての表を回す。このライブラリの表（`_` で始まる）と SQLite の内部の表は
 * 対象外。
 *
 * `REFERENCES parent` と列を書かない形は `to` が NULL で返り、親の主キーを指すので通す。
 * 列名は大文字小文字を畳んで比べる。
 */
function assertForeignKeysReferencePrimaryKeys(
  db: Database.Database,
  tables: RowsPreflightTable[]
): void {
  const synced = new Map(
    tables.map((table) => [foldIdentifier(table.name), table.name])
  )
  const children = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_'
        ORDER BY name`
    )
    .all() as { name: string }[]
  for (const { name: child } of children) {
    if (child.startsWith('_')) continue
    const list = db.pragma(`foreign_key_list(${escapeIdentifier(child)})`) as {
      id: number
      seq: number
      table: string
      from: string
      to: string | null
    }[]
    const byId = new Map<number, typeof list>()
    for (const entry of list) {
      byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry])
    }
    for (const entries of byId.values()) {
      const parent = synced.get(foldIdentifier(entries[0].table))
      if (parent === undefined) continue
      entries.sort((a, b) => a.seq - b.seq)
      // 列を書かない参照は親の主キーを指す
      if (entries.every((entry) => entry.to === null)) continue
      const keyColumns = primaryKeyColumnsOf(db, parent)
      const to = entries.map((entry) => entry.to ?? '')
      const matches =
        to.length === keyColumns.length &&
        to.every((column, at) => isSameIdentifier(column, keyColumns[at]))
      if (matches) continue
      throw new Error(
        `表 ${child} の外部キー（${entries.map((entry) => entry.from).join(', ')}）が、` +
          `同期する表 ${parent} の主キーでない列（${to.join(', ')}）を参照している。` +
          `同期する表を親とする外部キーは、親の主キー（${keyColumns.join(', ')}）を参照すること。` +
          `主キー以外の列を参照すると、親が削除されたのか、まだ届いていないのかを区別できない`
      )
    }
  }
}

/** 表の主キーの列の名前（宣言の順）。 */
function primaryKeyColumnsOf(db: Database.Database, table: string): string[] {
  const info = db.pragma(`table_xinfo(${escapeIdentifier(table)})`) as {
    name: string
    pk: number
  }[]
  return info
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
}

/* ------------------------------------------------------------------ *
 * P5: 外部キー
 * ------------------------------------------------------------------ */

/** 警告に個別の表として並べる表の数の上限。超えたぶんは1行にまとめる。 */
const FOREIGN_KEY_TABLE_LIMIT = 10

/** 1つの表の警告に名前を挙げる親の表の数の上限。 */
const FOREIGN_KEY_PARENT_LIMIT = 3

/** 表1つぶんの、親のいない行の数え上げ。 */
interface MissingParentSummary {
  /** その表で見つかった違反の件数 */
  count: number
  /** 親の表ごとの件数（名前は `sqlite_master` の綴りのまま） */
  parents: Map<string, number>
}

/**
 * 親のいない子が残っていないこと（前提 P5）。**例外ではなく警告**である。
 *
 * 導入前から外部キーが壊れている DB は実在する。案A では版を
 * `_sns_rows_<表>` に持ち、そこからアプリの表へ書き戻すが、**親を置けない行は
 * 書き戻せない**。つまり壊れていた行は版としては残るのに、アプリの表からは
 * 静かに消える。断って起動できなくするより、同期を1回回す前に知らせる方がよい。
 *
 * 検査は**引数なしで1回だけ**呼ぶ。`PRAGMA foreign_key_check(<表>)` は
 * 「その表が子である違反」しか返さないので、同期する表だけを回すと、
 * 同期しない表が同期する表を参照して壊れている形を取りこぼす
 * （`src/rows/rebuild.ts` の決まりごと6 と同じ理由）。
 *
 * 違反は1件ずつ返る。大きな DB では数千件出うるので、**全件は文字列にしない**。
 * 表ごとに数え上げ、代表として親の表の名前をいくつか添えるだけにする。
 */
function checkForeignKeys(
  db: Database.Database,
  tables: RowsPreflightTable[]
): string[] {
  const violations = db.pragma('foreign_key_check') as {
    table: string
    rowid: number | null
    parent: string
    fkid: number
  }[]
  if (violations.length === 0) return []

  const targets = new Set(tables.map((table) => foldIdentifier(table.name)))
  const inTargets = new Map<string, MissingParentSummary>()
  const elsewhere = new Map<string, MissingParentSummary>()

  for (const violation of violations) {
    const child = String(violation.table)
    // `_` で始まる表はこのライブラリが自分で作って自分で直すもので、利用者が
    // 直せる気がかりではない。ここで挙げても手の打ちようがなく、アプリの表の
    // 破れを埋もれさせるだけなので数えない（このライブラリの表の外部キーは、
    // 作り直しの適用が `src/rows/rebuild.ts` で別に見ている）
    if (child.startsWith('_')) continue
    const folded = foldIdentifier(child)
    // 親が同期する表なら、子が対象外でもその子は同期の影響を受ける
    const parent = String(violation.parent)
    const related =
      targets.has(folded) || targets.has(foldIdentifier(parent))
        ? inTargets
        : elsewhere
    let summary = related.get(child)
    if (summary === undefined) {
      summary = { count: 0, parents: new Map() }
      related.set(child, summary)
    }
    summary.count += 1
    summary.parents.set(parent, (summary.parents.get(parent) ?? 0) + 1)
  }

  return [
    ...describeMissingParents(
      inTargets,
      (table, count, parents) =>
        `同期する表 ${table} に、親のいない行が ${count} 件ある（親は ${parents}）。` +
        `この状態で同期を始めると、その行はユーザーテーブルから外れる（バージョンは残る）`,
      (count, tableCount) =>
        `ほか ${tableCount} 表の、同期に関わる行にも親がいない（合計 ${count} 件）。` +
        `この状態で同期を始めると、それらの行はユーザーテーブルから外れる（バージョンは残る）`
    ),
    ...describeMissingParents(
      elsewhere,
      (table, count, parents) =>
        `同期しない表 ${table} に、親のいない行が ${count} 件ある（親は ${parents}）。` +
        `同期は触らないが、DB がもともと壊れている印なので、あわせて直すこと`,
      (count, tableCount) =>
        `ほか ${tableCount} 表にも親のいない行がある（合計 ${count} 件）。` +
        `同期は触らないが、DB がもともと壊れている印なので、あわせて直すこと`
    ),
  ]
}

/**
 * 数え上げを警告の文にする。件数の多い表から順に {@link FOREIGN_KEY_TABLE_LIMIT}
 * 表ぶんだけ個別に並べ、残りは1行にまとめる。
 */
function describeMissingParents(
  summaries: Map<string, MissingParentSummary>,
  describe: (table: string, count: number, parents: string) => string,
  describeRest: (count: number, tableCount: number) => string
): string[] {
  if (summaries.size === 0) return []
  // 件数の多い順、同数なら名前順。並びが入力の順に揺れないようにする
  const ordered = [...summaries].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])
  )
  const warnings = ordered
    .slice(0, FOREIGN_KEY_TABLE_LIMIT)
    .map(([table, summary]) =>
      describe(table, summary.count, describeParents(summary.parents))
    )
  const rest = ordered.slice(FOREIGN_KEY_TABLE_LIMIT)
  if (rest.length > 0) {
    const count = rest.reduce((total, [, summary]) => total + summary.count, 0)
    warnings.push(describeRest(count, rest.length))
  }
  return warnings
}

/** 親の表の名前を、件数の多い順に上限まで並べる。 */
function describeParents(parents: Map<string, number>): string {
  const ordered = [...parents].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )
  const shown = ordered.slice(0, FOREIGN_KEY_PARENT_LIMIT).map(([name]) => name)
  const hidden = ordered.length - shown.length
  return hidden > 0
    ? `${shown.join(' / ')} ほか ${hidden} 表`
    : shown.join(' / ')
}
