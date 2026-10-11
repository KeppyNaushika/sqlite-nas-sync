/**
 * 作り直しの**計算**（設計書 `docs/rows-table-design.md` §3.7.1）。
 *
 * ここは読むだけで、DB を1バイトも書き換えない。出力の {@link RebuildPlan} は
 * `postMessage` の構造化複製でそのまま渡せる形にしてある（`worker_threads` で
 * 計算するため）。適用は `src/rows/rebuild.ts` の受け持ちである。
 *
 * 守っている決まりごと:
 *
 * 1. **token をどのデータより先に読む**（§3.7.1 の (A-1)）。一時 DB の用意より
 *    後に読むと、その間の書き込みを見落とす
 * 2. **計算全体を読みのトランザクションで囲む**（(A-2)）。読み取り専用の接続でも、
 *    囲まないと**文ごとに別の快照**を見る。親を読んだあとに主スレッドが親を消すと、
 *    子だけが新しい姿で読まれ、「計画が裂けたまま token が一致して適用される」
 *    （アプリが消した行が表に戻る）
 * 3. **大きい整数は `BigInt` のまま**運ぶ（`defaultSafeIntegers(true)`）。
 *    `Number` へ戻すと 2^53 を超える id と時刻が壊れる
 *
 * @module rows/rebuild-plan
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier } from '../setup/sql'
import { CandidateResult, RowsSchema, derive } from './derive'
import {
  VERSION_COLUMNS,
  primaryKeyColumn,
  rowsTableName,
  syncedColumns,
} from './schema'
import { RowVersion, SqlValue, ValueOrdering } from './versions'

/**
 * 計算を始めた時点の印（設計書 §3.7.2）。
 *
 * 10進の文字列で持つのは、`BigInt` でも `Number` でも取り違えずに比べられる形が
 * 1つだけ欲しいからである。
 */
interface RebuildToken {
  /** 表 → `_sns_tick.tick` */
  ticks: Record<string, string>
  /** `_sns_clock.importTick` */
  importTick: string
}

/** アプリの表に当てる差の内訳（設計書 §4.4 の `inserted` / `updated` / `deleted`）。 */
export interface RebuildPlanCounts {
  /** 計画にあって、アプリの表に無かった行 */
  inserted: number
  /** 主キーは同じだが中身が違っていた行 */
  updated: number
  /** アプリの表にあって、計画に無かった行 */
  deleted: number
}

/**
 * 消す行1つ。主キーを、DB に格納されたバイト列のまま持つ（設計書 §3.7.2）。
 *
 * JS の文字列を通すと、UTF-8 として正しくないバイト列は U+FFFD に置き換わり、元の行を指せなくなる。
 */
export interface RebuildPlanDelete {
  /** 主キーが TEXT で格納されているか（そうでなければ BLOB） */
  text: boolean
  /** `CAST(<主キー> AS BLOB)`。TEXT なら DB の文字コードのバイト列 */
  bytes: Buffer
}

/** 計画のすべての表の差の内訳を足し合わせる。 */
export function sumCounts(plan: RebuildPlan): RebuildPlanCounts {
  const counts: RebuildPlanCounts = { inserted: 0, updated: 0, deleted: 0 }
  for (const table of plan.apply) {
    counts.inserted += table.counts.inserted
    counts.updated += table.counts.updated
    counts.deleted += table.counts.deleted
  }
  return counts
}

/**
 * 適用する表1つ分。**計算した時点のアプリの表との差**だけを持つ（設計書 §3.7.2）。
 *
 * 中身の違う行は、`deletes` で消してから `inserts` で入れ直す。
 */
export interface RebuildPlanTable {
  name: string
  /** 主キーの列 */
  primaryKey: string
  /** 書き込む列（生成列を除く） */
  columns: string[]
  /** 消す行 */
  deletes: RebuildPlanDelete[]
  /** 入れる行（`columns` の値） */
  inserts: Record<string, SqlValue>[]
  counts: RebuildPlanCounts
}

/** 1:1 の表の「真の id ↔ 表示している id」（`_sns_shown`）。 */
interface RebuildPlanShown {
  table: string
  trueId: string
  shownId: string
}

/** 隠れた行と勝者（`_sns_hidden`）。 */
interface RebuildPlanHidden {
  table: string
  trueId: string
  winnerId: string | null
}

/**
 * 置かない行（`_sns_unplaceable`）。
 *
 * 親が削除されているので置かない行（原則4）では、`causeTable` と `causeId` に
 * 大元の削除が入る。それ以外の置かない行では両方 `null`。
 */
interface RebuildPlanUnplaceable {
  table: string
  trueId: string
  reason: string | null
  causeTable: string | null
  causeId: string | null
}

/** {@link computeRebuildPlan} の結果。**構造化複製でそのまま渡せる形**。 */
export interface RebuildPlan {
  token: RebuildToken
  /** 適用する表（**親が先**の順） */
  apply: RebuildPlanTable[]
  shown: RebuildPlanShown[]
  hidden: RebuildPlanHidden[]
  unplaceable: RebuildPlanUnplaceable[]
}

/** {@link computeRebuildPlan} の設定。 */
export interface RebuildPlanOptions {
  /** 同期する表の名前 */
  tables: string[]
  /**
   * 適用する表。省略すると `_sns_dirty` の表とその子孫（設計書 §3.7）。
   * 祖先は**計算はするが適用しない**。
   * 渡すのは `rebuildDiffCount`（網羅検査器の判定8）だけである
   */
  targets?: string[]
  /** 作り直しの対象から外す表（外部キーの検査に落ちた表。設計書 §6.2） */
  excluded?: readonly string[]
  /** すでにトランザクションの中にいる（k 回目の合流経路） */
  insideTransaction?: boolean
}

/**
 * 作り直しを計算する。**DB は読むだけ**。
 *
 * @param db 読み取り専用で開いた接続でよい（ワーカー）。主スレッドの接続でも動く
 */
export function computeRebuildPlan(
  db: Database.Database,
  options: RebuildPlanOptions
): RebuildPlan {
  const opened = options.insideTransaction !== true
  if (opened) db.exec('BEGIN')
  try {
    // (A-1) token を、一時 DB の用意も含めてどのデータより先に読む
    const token = readRebuildToken(db, options.tables)
    // 表か `_sns_rows_<表>` が無い表は計算しない（同期の段階0 が仕組みを取り付け直す）
    const known = options.tables.filter(
      (table) => tableExists(db, table) && tableExists(db, rowsTableName(table))
    )
    const order = dependencyOrder(db, known)
    const targets = resolveTargets(db, known, order, options)
    // 計算するのは適用する表とその祖先だけ（設計書 §3.7）。
    // 表の計算は、その表の版と親の表の計算の結果だけで決まるので、残りの表を計算しても答えは変わらない
    const computed = withAncestors(db, known, targets)
    const schema = readSchema(db, computed)
    const metas = new Map(computed.map((table) => [table, readMeta(db, table)]))
    const versions = readVersions(db, computed, metas)

    const derived = derive(versions, schema)
    const values = new ValueOrdering({ memoize: true })
    try {
      const apply: RebuildPlanTable[] = []
      const shown: RebuildPlanShown[] = []
      const hidden: RebuildPlanHidden[] = []
      const unplaceable: RebuildPlanUnplaceable[] = []
      for (const table of order) {
        if (!targets.has(table)) continue
        const meta = metas.get(table) as TableMeta
        const rows = (derived.rows.get(table) ?? []).map((row) =>
          pick(row, meta.storedColumns)
        )
        apply.push({
          name: table,
          primaryKey: meta.primaryKey,
          columns: meta.storedColumns,
          // アプリの表も同じ読みのトランザクションで読む。token より後の書き込みは
          // 適用の直前に token で捕まえるので、ここで読んだ姿との差を当ててよい
          ...diffAgainstApplication(db, meta, rows, values),
        })
        for (const candidate of (
          derived.candidates.get(table) ?? new Map<string, CandidateResult>()
        ).values()) {
          collectOutputs(values, meta, candidate, shown, hidden, unplaceable)
        }
      }
      return { token, apply, shown, hidden, unplaceable }
    } finally {
      values.close()
    }
  } finally {
    if (opened && db.inTransaction) db.exec('COMMIT')
  }
}

/**
 * token を読む（設計書 §3.7.2）。
 *
 * 適用の直前に読み直して、1つでも違えば見送る。
 */
export function readRebuildToken(
  db: Database.Database,
  tables: readonly string[]
): RebuildToken {
  const ticks: Record<string, string> = {}
  const statement = db.prepare(`SELECT tick FROM _sns_tick WHERE tableName = ?`)
  statement.safeIntegers(true)
  for (const table of tables) {
    const row = statement.get(table) as { tick: bigint } | undefined
    ticks[table] = row === undefined ? '' : String(row.tick)
  }
  const clock = db.prepare(`SELECT importTick FROM _sns_clock`)
  clock.safeIntegers(true)
  const row = clock.get() as { importTick: bigint } | undefined
  return { ticks, importTick: row === undefined ? '' : String(row.importTick) }
}

/** token が一致するか（設計書 §3.7.2）。 */
export function sameRebuildToken(a: RebuildToken, b: RebuildToken): boolean {
  if (a.importTick !== b.importTick) return false
  const names = new Set([...Object.keys(a.ticks), ...Object.keys(b.ticks)])
  for (const name of names) {
    if ((a.ticks[name] ?? '') !== (b.ticks[name] ?? '')) return false
  }
  return true
}

/**
 * `postMessage` を通ったあとの計画を、元の値の形へ戻す。
 *
 * BLOB は構造化複製で `Uint8Array` になる。`Buffer` へ戻さないと、
 * better-sqlite3 の束縛が BLOB として受け取らない。
 */
export function reviveRebuildPlan(plan: RebuildPlan): RebuildPlan {
  for (const table of plan.apply) {
    for (const key of table.deletes) key.bytes = Buffer.from(key.bytes)
    for (const row of table.inserts) {
      for (const [column, value] of Object.entries(row)) {
        row[column] = reviveValue(value)
      }
    }
  }
  return plan
}

function reviveValue(value: SqlValue): SqlValue {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value)
    : value
}

/* ------------------------------------------------------------------ *
 * 読み取り
 * ------------------------------------------------------------------ */

/** 表1つ分の、計算と適用に要る姿。 */
interface TableMeta {
  name: string
  primaryKey: string
  /** 書ける列（生成列を除く） */
  storedColumns: string[]
}

function readMeta(db: Database.Database, table: string): TableMeta {
  return {
    name: table,
    primaryKey: primaryKeyColumn(db, table).name,
    storedColumns: syncedColumns(db, table).map((column) => column.name),
  }
}

/** `CREATE TABLE` と索引を読む（一時 DB へそのまま流す）。 */
function readSchema(
  db: Database.Database,
  tables: readonly string[]
): RowsSchema {
  const ddlOf = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
  )
  const indexesOf = db.prepare(
    `SELECT sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`
  )
  return {
    tables: tables.map((table) => {
      const row = ddlOf.get(table) as { sql: string | null } | undefined
      if (row === undefined || row.sql === null) {
        throw new Error(`同期する表 ${table} の CREATE TABLE が読めない`)
      }
      return {
        name: table,
        ddl: row.sql,
        indexes: (indexesOf.all(table) as { sql: string }[]).map(
          (index) => index.sql
        ),
      }
    }),
  }
}

/**
 * 版を読む（`_sns_rows_<t>` と `_tombstone`）。
 *
 * **版の3つ組が欠けている行は読み飛ばす。**
 * `_sns_rows_<t>` の `_sns_lamport` と `_sns_instance` は NOT NULL で、`_tombstone` の版の列は取り付けのとき（`src/rows/schema.ts` の `ensureTombstoneVersionColumns`）に埋めるので、ふつうは欠けない。
 * 外で書き換えられた DB で、順序の付かない版を比べて全部を同着にしないための守りである。
 */
function readVersions(
  db: Database.Database,
  tables: readonly string[],
  metas: Map<string, TableMeta>
): RowVersion[] {
  const versions: RowVersion[] = []
  const hasTombstone = tableExists(db, '_tombstone')
  for (const table of tables) {
    const meta = metas.get(table) as TableMeta
    const rows = db.prepare(
      `SELECT * FROM ${escapeIdentifier(rowsTableName(table))}`
    )
    rows.safeIntegers(true)
    for (const row of rows.all() as Record<string, SqlValue>[]) {
      const version = versionOf(row, table, row[meta.primaryKey] ?? null)
      if (version === null) continue
      const content: Record<string, SqlValue> = {}
      for (const column of meta.storedColumns)
        content[column] = row[column] ?? null
      version.content = content
      versions.push(version)
    }
    if (!hasTombstone) continue
    const deletes = db.prepare(
      `SELECT * FROM "_tombstone" WHERE "tableName" = ?`
    )
    deletes.safeIntegers(true)
    for (const row of deletes.all(table) as Record<string, SqlValue>[]) {
      const version = versionOf(row, table, row['recordId'] ?? null)
      if (version === null) continue
      version.kind = 'delete'
      versions.push(version)
    }
  }
  return versions
}

function versionOf(
  row: Record<string, SqlValue>,
  table: string,
  id: SqlValue
): RowVersion | null {
  const lamport = row[VERSION_COLUMNS.lamport]
  const instance = row[VERSION_COLUMNS.instance]
  if (lamport === null || lamport === undefined) return null
  if (typeof instance !== 'string') return null
  return {
    table,
    id,
    kind: 'row',
    ts: row[VERSION_COLUMNS.ts] ?? null,
    lamport: Number(lamport),
    instance,
  }
}

/* ------------------------------------------------------------------ *
 * 範囲と順序
 * ------------------------------------------------------------------ */

/**
 * 適用する表（設計書 §3.7）。`_sns_dirty` の表とその**子孫**。
 *
 * 祖先は表示値のために計算するが、適用はしない。
 */
function resolveTargets(
  db: Database.Database,
  tables: readonly string[],
  order: readonly string[],
  options: RebuildPlanOptions
): Set<string> {
  const excluded = new Set(options.excluded ?? [])
  const known = new Set(tables)
  const seeds =
    options.targets ??
    (
      db.prepare(`SELECT tableName FROM _sns_dirty`).all() as {
        tableName: string
      }[]
    ).map((row) => row.tableName)
  const targets = new Set<string>()
  const children = childrenOf(db, tables)
  const visit = (name: string): void => {
    if (!known.has(name) || targets.has(name) || excluded.has(name)) return
    targets.add(name)
    for (const child of children.get(name) ?? []) visit(child)
  }
  for (const seed of seeds) visit(seed)
  return new Set(order.filter((name) => targets.has(name)))
}

/**
 * 適用する表とその祖先。`tables` の並びのまま返す（設計書 §3.7）。
 *
 * `derive`（`src/rows/derive.ts`）が表を計算するときに読むのは、次のものだけである。
 *
 * | 読むもの | どこで |
 * | --- | --- |
 * | その表の版と削除の版 | `Max` と候補 |
 * | 外部キーの親の表の `Res` | `resolveParent`。`SET DEFAULT` の既定値の指す親も同じ |
 * | 外部キーの親の表の削除と、親が削除されているので置かない行 | `goneParent` |
 * | 同じ表の置く行 | 隠れた行の勝者、自己参照の親 |
 *
 * 子の表の結果は読まない。
 * 親の表が先に計算されるので、適用する表の結果は、その表と祖先の版だけで決まる。
 *
 * 親を辿るのは、同期する表のうち `_sns_rows_<表>` のある表だけである。
 * `derive` は、そうでない表を指す外部キーを読み替えず、真の値のまま置くので、その先の祖先は結果に効かない。
 * 同期しない表をはさんだ先にある同期する表も辿らない。
 * 外部キーの親の表の名前は `PRAGMA foreign_key_list` の綴りのまま突き合わせる。
 * `derive` も同じ綴りで突き合わせるので、突き合わない表は両方で同期しない表として扱われる。
 * 対象から外した表（`excluded`）も、祖先なら計算する。
 */
function withAncestors(
  db: Database.Database,
  tables: readonly string[],
  targets: ReadonlySet<string>
): string[] {
  const known = new Set(tables)
  const computed = new Set<string>()
  const visit = (name: string): void => {
    if (!known.has(name) || computed.has(name)) return
    computed.add(name)
    for (const key of foreignKeysOf(db, name)) visit(key.parentTable)
  }
  for (const target of targets) visit(target)
  return tables.filter((table) => computed.has(table))
}

/** 表 → その表を親として参照している同期する表。 */
function childrenOf(
  db: Database.Database,
  tables: readonly string[]
): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const table of tables) {
    for (const key of foreignKeysOf(db, table)) {
      if (key.parentTable === table) continue
      const list = children.get(key.parentTable) ?? []
      if (!list.includes(table)) list.push(table)
      children.set(key.parentTable, list)
    }
  }
  return children
}

/** 外部キーの依存の順（親が先）。設計書の前提 P2 より循環しない。 */
export function dependencyOrder(
  db: Database.Database,
  tables: readonly string[]
): string[] {
  const known = new Set(tables)
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string): void => {
    const mark = state.get(name)
    if (mark === 'done') return
    if (mark === 'visiting') {
      throw new Error(
        `同期する表の外部キーが循環している: ${name}。同期する表どうしの外部キーは循環させられない`
      )
    }
    state.set(name, 'visiting')
    for (const key of foreignKeysOf(db, name)) {
      if (known.has(key.parentTable) && key.parentTable !== name) {
        visit(key.parentTable)
      }
    }
    state.set(name, 'done')
    order.push(name)
  }
  for (const table of tables) visit(table)
  return order
}

/** 外部キー1本（`PRAGMA foreign_key_list` の1組）。 */
interface ForeignKeyMeta {
  columns: string[]
  parentTable: string
  /** 親側の列（省略されていれば親の主キー） */
  parentColumns: string[]
  onDelete: string
}

/** 表の外部キーを読む。 */
export function foreignKeysOf(
  db: Database.Database,
  table: string
): ForeignKeyMeta[] {
  const rows = db.pragma(`foreign_key_list(${escapeIdentifier(table)})`) as {
    id: number
    seq: number
    table: string
    from: string
    to: string | null
    on_delete: string
  }[]
  const grouped = new Map<number, typeof rows>()
  for (const row of rows) {
    const list = grouped.get(row.id) ?? []
    list.push(row)
    grouped.set(row.id, list)
  }
  return [...grouped.values()].map((entries) => {
    const sorted = [...entries].sort((a, b) => a.seq - b.seq)
    return {
      columns: sorted.map((row) => row.from),
      parentTable: sorted[0].table,
      parentColumns: sorted.every((row) => row.to === null)
        ? []
        : sorted.map((row) => row.to as string),
      onDelete: sorted[0].on_delete.toUpperCase(),
    }
  })
}

/* ------------------------------------------------------------------ *
 * 小道具
 * ------------------------------------------------------------------ */

/**
 * 候補1つから、`_sns_shown` / `_sns_hidden` / `_sns_unplaceable` の行を作る。
 *
 * `_sns_shown` に載せるのは、**表示している id が真の id と違う候補だけ**である
 * （同じものを全部載せると、1:1 でない表でも表が行数ぶん膨らむ）。
 */
function collectOutputs(
  values: ValueOrdering,
  meta: TableMeta,
  candidate: CandidateResult,
  shown: RebuildPlanShown[],
  hidden: RebuildPlanHidden[],
  unplaceable: RebuildPlanUnplaceable[]
): void {
  if (candidate.placement === 'placed') {
    const displayed = values.idKey(candidate.display[meta.primaryKey] ?? null)
    if (displayed !== candidate.key) {
      shown.push({
        table: meta.name,
        trueId: candidate.key,
        shownId: displayed,
      })
    }
    return
  }
  if (candidate.placement === 'hidden') {
    hidden.push({
      table: meta.name,
      trueId: candidate.key,
      winnerId: candidate.winner ?? null,
    })
    return
  }
  // 置かない行と、親が削除されているので置かない行（原則4）。どちらも版は残る
  unplaceable.push({
    table: meta.name,
    trueId: candidate.key,
    reason: candidate.reason ?? null,
    causeTable: candidate.cause?.table ?? null,
    causeId: candidate.cause?.key ?? null,
  })
}

/** アプリの表の行に添えて読む、主キーの格納の形（列名は `_sns_` で始まるのでアプリの列と重ならない）。 */
const KEY_TYPE = '_sns_key_type'
const KEY_BYTES = '_sns_key_bytes'

/**
 * 計画の行とアプリの表の差を作る（設計書 §3.7.2）。
 *
 * 行は真の id の正規形（`CAST(<主キー> AS TEXT)`）で突き合わせる。
 * 中身は格納されたものまで同じときだけ同じとみなす（{@link StoredRows.same}）。違えば入れ直すので、
 * 適用したあとのアプリの表は、計画の行を全部入れ直したときと同じになる。
 *
 * 同じ正規形を持つ行がアプリの表に2つ以上ある（`'1'` と `X'31'` など）ときは、
 * 中身の同じ1つだけを残し、残りは消す。
 */
function diffAgainstApplication(
  db: Database.Database,
  meta: TableMeta,
  rows: readonly Record<string, SqlValue>[],
  values: ValueOrdering
): Pick<RebuildPlanTable, 'deletes' | 'inserts' | 'counts'> {
  const key = escapeIdentifier(meta.primaryKey)
  const statement = db.prepare(
    `SELECT ${meta.storedColumns.map(escapeIdentifier).join(', ')},
            typeof(${key}) AS ${escapeIdentifier(KEY_TYPE)},
            CAST(${key} AS BLOB) AS ${escapeIdentifier(KEY_BYTES)}
       FROM ${escapeIdentifier(meta.name)}`
  )
  statement.safeIntegers(true)
  const stored = new StoredRows(db, meta)
  const present = new Map<string, Record<string, SqlValue>[]>()
  for (const row of statement.iterate() as Iterable<Record<string, SqlValue>>) {
    const id = values.idKey(row[meta.primaryKey] ?? null)
    const same = present.get(id)
    if (same === undefined) present.set(id, [row])
    else same.push(row)
  }
  const deletes: RebuildPlanDelete[] = []
  const inserts: Record<string, SqlValue>[] = []
  const counts: RebuildPlanCounts = { inserted: 0, updated: 0, deleted: 0 }
  for (const row of rows) {
    const id = values.idKey(row[meta.primaryKey] ?? null)
    const same = present.get(id)
    if (same === undefined || same.length === 0) {
      counts.inserted += 1
      inserts.push(row)
      continue
    }
    const at = same.findIndex((other) => stored.same(row, other))
    if (at >= 0) {
      same.splice(at, 1)
      continue
    }
    counts.updated += 1
    deletes.push(deleteOf(same.shift() as Record<string, SqlValue>))
    inserts.push(row)
  }
  for (const same of present.values()) {
    for (const row of same) {
      counts.deleted += 1
      deletes.push(deleteOf(row))
    }
  }
  return { deletes, inserts, counts }
}

function deleteOf(row: Record<string, SqlValue>): RebuildPlanDelete {
  return {
    text: row[KEY_TYPE] === 'text',
    bytes: row[KEY_BYTES] as Buffer,
  }
}

/**
 * アプリの表の行が、計画の行と格納されたものまで同じかを答える。
 *
 * 値はまず JS の値で比べる（{@link sameValue}）。
 * ただし、UTF-8 として正しくない TEXT は、JS の文字列にした時点で U+FFFD に置き換わるので、JS の値が同じでも格納されたバイト列は違いうる。
 * アプリの表の文字列に U+FFFD があるときだけ、格納されたバイト列を SQLite で比べ直す。
 */
class StoredRows {
  /** 列と主キーの格納の形 → 格納されたバイト列を比べる文 */
  private readonly statements = new Map<string, Database.Statement>()

  constructor(
    private readonly db: Database.Database,
    private readonly meta: TableMeta
  ) {}

  same(
    planned: Record<string, SqlValue>,
    present: Record<string, SqlValue>
  ): boolean {
    for (const column of this.meta.storedColumns) {
      const value = planned[column] ?? null
      const held = present[column] ?? null
      if (!sameValue(value, held)) return false
      if (
        typeof held === 'string' &&
        held.includes('\uFFFD') &&
        !this.sameBytes(column, value as string, present)
      ) {
        return false
      }
    }
    return true
  }

  private sameBytes(
    column: string,
    value: string,
    present: Record<string, SqlValue>
  ): boolean {
    const text = present[KEY_TYPE] === 'text'
    const token = `${column}\u0000${String(text)}`
    let statement = this.statements.get(token)
    if (statement === undefined) {
      statement = this.db.prepare(
        `SELECT CAST(${escapeIdentifier(column)} AS BLOB) = CAST(? AS BLOB)
           FROM ${escapeIdentifier(this.meta.name)}
          WHERE ${escapeIdentifier(this.meta.primaryKey)} = ${
            text ? 'CAST(? AS TEXT)' : '?'
          }`
      )
      statement.pluck()
      this.statements.set(token, statement)
    }
    return statement.get(value, present[KEY_BYTES]) === 1
  }
}

/**
 * 値が型まで同じか。
 *
 * 整数（`bigint`）と実数（`number`）は、値が等しくても別とみなす。
 * 計画の行もアプリの表の行も、同じ宣言の表から `safeIntegers(true)` で読んでいるので、
 * 同じ値なら型も同じになる。型が違えば格納の形が違うので、入れ直す。
 */
function sameValue(a: SqlValue, b: SqlValue): boolean {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b)
  }
  if (typeof a !== typeof b) return false
  return typeof a === 'number' ? Object.is(a, b) : a === b
}

function pick(
  row: Record<string, SqlValue>,
  columns: readonly string[]
): Record<string, SqlValue> {
  const picked: Record<string, SqlValue> = {}
  for (const column of columns) picked[column] = row[column] ?? null
  return picked
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}
