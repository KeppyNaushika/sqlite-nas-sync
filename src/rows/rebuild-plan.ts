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
import { foldIdentifier } from '../conflict/schema'
import { escapeIdentifier } from '../setup/sql'
import { CandidateResult, RowsSchema, derive } from './derive'
import { readDeleteProtectedTables } from './meta'
import {
  RowsColumn,
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
export interface RebuildToken {
  /** 表 → `_sns_tick.tick` */
  ticks: Record<string, string>
  /** `_sns_clock.importTick` */
  importTick: string
}

/** 適用する表1つ分。 */
export interface RebuildPlanTable {
  name: string
  /** 主キーの列 */
  primaryKey: string
  /** 書き込む列（生成列を除く） */
  columns: string[]
  /** 入れる行（`columns` の値） */
  rows: Record<string, SqlValue>[]
}

/** 1:1 の表の「真の id ↔ 表示している id」（`_sns_shown`）。 */
export interface RebuildPlanShown {
  table: string
  trueId: string
  shownId: string
}

/** 隠れた行と勝者（`_sns_hidden`）。 */
export interface RebuildPlanHidden {
  table: string
  trueId: string
  winnerId: string | null
}

/** 置かない行（`_sns_unplaceable`）。 */
export interface RebuildPlanUnplaceable {
  table: string
  trueId: string
  reasonKind: string | null
  reason: string | null
}

/** {@link computeRebuildPlan} の結果。**構造化複製でそのまま渡せる形**。 */
export interface RebuildPlan {
  token: RebuildToken
  /** 適用する表（**親が先**の順） */
  apply: RebuildPlanTable[]
  shown: RebuildPlanShown[]
  hidden: RebuildPlanHidden[]
  unplaceable: RebuildPlanUnplaceable[]
  /** 計算の対象にしなかった表と、その理由 */
  skipped: { table: string; reason: string }[]
}

/** {@link computeRebuildPlan} の設定。 */
export interface RebuildPlanOptions {
  /** 同期する表の名前 */
  tables: string[]
  /**
   * 適用する表。省略すると `_sns_dirty` の表とその子孫（設計書 §3.7）。
   * 祖先は**計算はするが適用しない**
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
    const skipped: { table: string; reason: string }[] = []
    const known: string[] = []
    for (const table of options.tables) {
      if (tableExists(db, table) && tableExists(db, rowsTableName(table))) {
        known.push(table)
        continue
      }
      skipped.push({ table, reason: `表か ${rowsTableName(table)} が無い` })
    }
    const schema = readSchema(db, known)
    const metas = new Map(known.map((table) => [table, readMeta(db, table)]))
    const versions = readVersions(db, known, metas)
    const order = dependencyOrder(db, known)
    const targets = resolveTargets(db, known, order, options)

    const derived = derive(versions, schema)
    const values = new ValueOrdering()
    try {
      const apply: RebuildPlanTable[] = []
      const shown: RebuildPlanShown[] = []
      const hidden: RebuildPlanHidden[] = []
      const unplaceable: RebuildPlanUnplaceable[] = []
      for (const table of order) {
        if (!targets.has(table)) continue
        const meta = metas.get(table) as TableMeta
        const rows = derived.rows.get(table) ?? []
        apply.push({
          name: table,
          primaryKey: meta.primaryKey,
          columns: meta.storedColumns,
          rows: rows.map((row) => pick(row, meta.storedColumns)),
        })
        for (const candidate of (
          derived.candidates.get(table) ?? new Map<string, CandidateResult>()
        ).values()) {
          collectOutputs(values, meta, candidate, shown, hidden, unplaceable)
        }
      }
      return { token, apply, shown, hidden, unplaceable, skipped }
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
    for (const row of table.rows) {
      for (const [column, value] of Object.entries(row)) {
        if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
          row[column] = Buffer.from(value)
        }
      }
    }
  }
  return plan
}

/* ------------------------------------------------------------------ *
 * 読み取り
 * ------------------------------------------------------------------ */

/** 表1つ分の、計算と適用に要る姿。 */
export interface TableMeta {
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
  // `deleteProtected` は**この DB に書いてある設定**から読む（渡された設定では
  // ない）。ワーカーは `_sync_meta` しか見られないので、主スレッドで計算しても
  // ワーカーで計算しても同じ答えになる形はこれ1つである
  const protectedTables = readDeleteProtectedTables(db)
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
        deleteProtected: protectedTables.has(foldIdentifier(table)),
      }
    }),
  }
}

/**
 * 版を読む（`_sns_rows_<t>` と `_tombstone`）。
 *
 * **版の3つ組が欠けている行は読み飛ばす。** 旧版から移ってきたまま
 * `_sns_lamport` が NULL の行は順序が付かず、比べると全部が同着になる
 * （3つ組を埋めるのは段階4 の移行の受け持ちである）。
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
      const merged = row['mergedInto']
      if (merged !== null && merged !== undefined) version.mergedInto = merged
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
      throw new Error(`同期する表の外部キーが循環している（前提 P2）: ${name}`)
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
export interface ForeignKeyMeta {
  id: number
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
      id: sorted[0].id,
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
  unplaceable.push({
    table: meta.name,
    trueId: candidate.key,
    reasonKind: candidate.reasonKind ?? null,
    reason: candidate.reason ?? null,
  })
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

/** `PRAGMA table_xinfo` の1列（再輸出せずに使うための別名）。 */
export type RebuildColumn = RowsColumn
