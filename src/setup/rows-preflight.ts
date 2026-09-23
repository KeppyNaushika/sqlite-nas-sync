/**
 * 案A の前提（設計書 `docs/rows-table-design.md` §1.8）を、起動時に確かめる。
 *
 * ここで断るものは、**通してしまうと後から直せない**種類の破れである。
 *
 * | 何を見るか | 破れたとき | なぜ |
 * | --- | --- | --- |
 * | 主キーが NULL を取らないこと（P1） | 例外 | NULL の主キーは版の鍵にならず、`INTEGER PRIMARY KEY` では SQLite が id を作ってしまう |
 * | 決定的でない関数（P8） | 例外 | 同じ行が端末や時刻によって置ける・置けないに分かれ、補題2と定理1が破れる |
 * | 独自に登録された照合順序・関数（P8） | 例外 | 一時 DB に同じものが無く、判定が別物になる |
 * | 解析できない索引（P8） | 例外 | かぶりの勝者を引けない |
 * | 親のいない子（P5） | 警告 | 案A では親を置けない行が表に出ないので、導入前から壊れていた行が静かに消える |
 * | 時刻列の BLOB（穴7） | 例外 | 値の種類がいちばん強い群なので、入った行の順序が以後ほぼ書き込み順だけで決まる |
 * | 大きく未来の時刻（穴7） | 警告 | 引き上げは下がらないので、その行の順序が以後ほぼ書き込み順だけで決まる |
 * | 時刻列に値の種類が混ざる（§1.2.3） | 警告 | 順序は決まるが、利用者の期待とは違いうる |
 *
 * @module setup/rows-preflight
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, foldIdentifier } from './sql'
import { parseCreateIndex } from '../rows/index-parse'
import { assertDeterministicSql } from '../rows/sql-functions'

/** 検査する表1つ分の指定。 */
interface RowsPreflightTable {
  name: string
  /**
   * 順序に使う時刻列。無い列を指しても、その表の時刻にまつわる検査を飛ばすだけ
   * @defaultValue `'updatedAt'`
   */
  timestampColumn?: string
}

/** {@link checkRowsPreconditions} の設定。 */
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
  const custom = readCustomRegistrations(db)

  for (const table of tables) {
    assertPrimaryKeyIsNotNull(db, table.name)
    assertSchemaIsDeterministic(db, table.name, custom)
    assertIndexesAreReadable(db, table.name, custom)
    warnings.push(...checkTimestampColumn(db, table, options))
  }
  // 外部キーだけは**表ごとのループの外**で1回。`foreign_key_check(<表>)` は
  // 「その表が子である違反」しか返さないので、同期する表だけを回すと、
  // 同期しない表から同期する表への違反を取りこぼす
  warnings.push(...checkForeignKeys(db, tables))
  return { warnings }
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
    throw new Error(`同期する表 ${table} に主キーが無い（前提 P1）`)
  }
  // 複合主キーは断る（前提 P11）。真の id・`_tombstone.recordId`・`_sns_shown` の
  // すべてが「1つの値」を前提にしているので、通すと版の鍵が定まらない
  if (primaryKey.length > 1) {
    throw new Error(
      `同期する表 ${table} の主キーが複合（${primaryKey
        .map((column) => column.name)
        .join(', ')}）である（前提 P11）`
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
          `（宣言: ${column.type || '無し'}、前提 P1）。` +
          ` 端末をまたいで一意な id（UUID / cuid）を TEXT で持つこと` +
          `（INTEGER PRIMARY KEY の自動採番は、別の端末が同じ値を別の行に割り当てる）`
      )
    }
    // `WITHOUT ROWID` の主キーは暗黙に NOT NULL
    if (withoutRowid || column.notnull === 1) continue
    throw new Error(
      `同期する表 ${table} の主キー ${column.name} が NULL を取れる（前提 P1）。` +
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
      `同期する表 ${table} に、主キーが NULL の行がある（前提 P1）`
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
        `組み込みでない照合順序 ${column.coll} が索引 ${entry.name} に使われている（前提 P8）`
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
      `組み込みでない照合順序 ${name} が ${where} に現れている（前提 P8）`
    )
  }
}

/* ------------------------------------------------------------------ *
 * 時刻列（穴7・§1.2.3）
 * ------------------------------------------------------------------ */

/**
 * 時刻列を見る。BLOB があれば例外、大きく未来の値と値の種類の混在は警告。
 *
 * BLOB を例外にするのは、それが**いちばん強い群**だからである。1回でも入ると
 * その行の `_sns_ts` は引き上げでその高さに固定され、以後その行の順序は
 * 実質 `(lamport, instanceId)` だけで決まる（設計書 §1.2.1 の穴7）。
 */
function checkTimestampColumn(
  db: Database.Database,
  table: RowsPreflightTable,
  options: RowsPreflightOptions
): string[] {
  const column = table.timestampColumn ?? 'updatedAt'
  const info = db.pragma(`table_xinfo(${escapeIdentifier(table.name)})`) as {
    name: string
  }[]
  if (!info.some((entry) => entry.name === column)) return []

  const quoted = escapeIdentifier(column)
  const name = escapeIdentifier(table.name)
  const blob = db
    .prepare(
      `SELECT 1 AS found FROM ${name} WHERE typeof(${quoted}) = 'blob' LIMIT 1`
    )
    .get()
  if (blob !== undefined) {
    throw new Error(
      `同期する表 ${table.name} の時刻列 ${column} に BLOB がある（穴7）。` +
        ` BLOB は値の種類のうち最も強く、入った行の順序は以後ほぼ書き込み順だけで決まる`
    )
  }

  const warnings: string[] = []
  const kinds = db
    .prepare(
      `SELECT DISTINCT typeof(${quoted}) AS kind FROM ${name}
        WHERE ${quoted} IS NOT NULL`
    )
    .all() as { kind: string }[]
  const distinct = new Set(kinds.map((row) => row.kind))
  // 整数と実数は同じ群（群1）なので、混ざっていても順序は素直に決まる
  if (
    distinct.has('text') &&
    (distinct.has('integer') || distinct.has('real'))
  ) {
    warnings.push(
      `同期する表 ${table.name} の時刻列 ${column} に値の種類が混ざっている` +
        `（${[...distinct].join(' / ')}）。順序は決まるが、数値は文字列より常に弱くなる`
    )
  }

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
        `（${String(future.value)}）。順序用の時刻は下がらないので、` +
        `その行の順序は以後ほぼ書き込み順だけで決まる（穴7）`
    )
  }
  return warnings
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
        `同期する表 ${table} に、親のいない行が ${count} 件ある（親は ${parents}。前提 P5）。` +
        `この状態で同期を始めると、その行はアプリの表から外れる（版は残る）`,
      (count, tableCount) =>
        `ほか ${tableCount} 表の、同期に関わる行にも親がいない（合計 ${count} 件。前提 P5）。` +
        `この状態で同期を始めると、それらの行はアプリの表から外れる（版は残る）`
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
