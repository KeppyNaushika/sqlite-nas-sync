/**
 * 相手1人ぶんの取り込み（設計書 `docs/rows-table-design.md` §4.3）。
 *
 * 1つの `BEGIN IMMEDIATE` … `COMMIT` の中で、キーごとに次を行う。
 *
 * 1. 相手の `_sns_rows_<t>` の行（`rW`）と `_tombstone` の行（`rD`）を読む
 * 2. 手元の `lW` / `lD` と見比べ、**強い方**を採る（`W'` / `D'`）
 * 3. `W'` が `D'` より強ければ `_sns_rows_<t>` を `W'` にし、**そうでなければ
 *    手元の行を同じトランザクションで消す**（負けた側を残さない）
 * 4. `Max` が変わったキーだけ `_changelog` と `_sns_dirty` に載せる
 *
 * ここで守っている決まりごと:
 *
 * - **受け取った版は書き換えずにそのまま格納する**（§4.3）。`_sns_ts`・
 *   `_sns_lamport`・`_sns_instance` に触ると、その版を第三の端末へ中継したときに
 *   別の版になり、鍵と中身の対応が壊れる。`lamport` の引き上げは `_sns_clock` に
 *   対してだけ行う
 * - **`Max` が変わったかは JS で比べる**（§4.3）。`ON CONFLICT … DO UPDATE …
 *   WHERE` の `changes()` は退けた行も数えるので、通知の有無を賭けられない
 * - **事実を作らない**。アプリの表には一切書かないので、トリガーは1本も走らない。
 *   `_tombstone` と `_changelog` に増えるのは、相手の主張から来た行だけである
 * - **相手の形が違っても例外にしない**（§4.3 の G）。表が無ければ主張なし、
 *   相手に無い列は自分の既定値、相手にしかない列は無視、`sns-format` が
 *   `rows1` でなければ相手を丸ごと見送る
 *
 * @module rows/import
 * @internal
 */
import Database from 'better-sqlite3'
import { NOW_SQL, escapeIdentifier, foldIdentifier } from '../setup/sql'
import {
  RowsColumn,
  RowsTableSpec,
  VERSION_COLUMNS,
  primaryKeyColumn,
  rowsTableName,
  syncedColumns,
} from './schema'
import { canonicalTableSpecs } from './table-name'
import { strongerSql } from './triggers'
import { RowVersion, SqlValue, ValueOrdering } from './versions'

/** `_sync_meta.schemaVersion` に書く形式の名前（設計書 §3.8）。 */
export const ROWS_FORMAT = 'rows1'

/** 取り込む範囲 `S` の要素（設計書 §4.3）。 */
export interface RowsImportKey {
  /** 自分の綴りの表名 */
  table: string
  /** 真の id の正規形（`CAST(<主キー> AS TEXT)`） */
  key: string
}

/** {@link importFromPeer} の設定。 */
interface RowsImportOptions {
  /** 同期する表 */
  tables: (RowsTableSpec | string)[]
  /**
   * 範囲 `S`。省略すると**フルマージ**（相手の `_sns_rows_<t>` の全 id と
   * `_tombstone` の全 `(表, id)`）になる
   */
  keys?: RowsImportKey[]
  /** 相手の `sns-format` の確認を飛ばす（試験用） */
  skipFormatCheck?: boolean
}

/** `Max` が変わったキー1つ。 */
interface RowsImportChange {
  table: string
  key: string
  /** `_changelog` に載せた操作 */
  operation: 'UPDATE' | 'DELETE'
}

/** {@link importFromPeer} の結果。 */
interface RowsImportResult {
  /** `skipped` なら相手を丸ごと見送った（`_sns_clock` にも触っていない） */
  status: 'imported' | 'skipped'
  /** 見送った理由 */
  reason?: string
  /** `Max` が変わったキー */
  changed: RowsImportChange[]
  /** `_sns_dirty` に載せた表 */
  dirtyTables: string[]
  /** 読めなかった表と、その理由（例外にはしない） */
  skippedTables: { table: string; reason: string }[]
  /**
   * 相手が主張したのに `Max` が変わらなかったキーの数
   * （＝手元の版の方が強かった。設計書 §4.4 の `skipped`）
   */
  skipped: number
  /**
   * 手元にも版があったキーで、相手の版に入れ替わった数
   * （設計書 §4.4 の `conflictsResolved`）
   */
  conflicts: number
  /** 引き上げたあとの `_sns_clock.lamport` */
  lamport: number
}

/**
 * `_sync_meta.schemaVersion` の `sns-format=` を読む。
 *
 * 書式は `<アプリの版>;sns-format=rows1`（設計書 §3.8）。`_sync_meta` が無い・
 * 鍵が無い・`sns-format` が書かれていない相手では `null`。
 */
export function readSnsFormat(db: Database.Database): string | null {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sync_meta'`
    )
    .get()
  if (exists === undefined) return null
  const row = db
    .prepare(`SELECT value FROM _sync_meta WHERE key = 'schemaVersion'`)
    .get() as { value: string | null } | undefined
  if (row === undefined || row.value === null) return null
  for (const field of row.value.split(';')) {
    const at = field.indexOf('=')
    if (at < 0) continue
    if (field.slice(0, at).trim() === 'sns-format') {
      return field.slice(at + 1).trim()
    }
  }
  return null
}

/**
 * 相手の主張しているキーを全部集める（フルマージの範囲 `S`）。
 *
 * 相手に `_sns_rows_<t>` が無ければ、その表については何も集めない
 * （**削除ではなく「主張が無い」**として読む。設計書 §4.3 の G）。
 */
export function collectPeerKeys(
  peerDb: Database.Database,
  tables: (RowsTableSpec | string)[]
): RowsImportKey[] {
  const keys: RowsImportKey[] = []
  const seen = new Set<string>()
  const add = (table: string, key: string): void => {
    const token = `${table} ${key}`
    if (seen.has(token)) return
    seen.add(token)
    keys.push({ table, key })
  }
  const hasTombstone = tableExists(peerDb, '_tombstone')
  // 相手の綴りではなく**相手の `sqlite_master` の綴り**で引く。前提 P4
  // （全端末で同じスキーマ）より、畳んだ綴りは自分のものと一致する
  for (const spec of canonicalTableSpecs(peerDb, tables)) {
    const name = spec.name
    const rowsTable = rowsTableName(name)
    if (tableExists(peerDb, rowsTable)) {
      const pk = peerPrimaryKey(peerDb, rowsTable)
      if (pk !== null) {
        const statement = peerDb.prepare(
          `SELECT CAST(${escapeIdentifier(pk)} AS TEXT) AS "k"
             FROM ${escapeIdentifier(rowsTable)}`
        )
        statement.safeIntegers(true)
        for (const row of statement.all() as { k: string | null }[]) {
          if (row.k !== null) add(name, row.k)
        }
      }
    }
    if (!hasTombstone) continue
    for (const row of peerDb
      .prepare(`SELECT recordId FROM _tombstone WHERE tableName = ?`)
      .all(name) as { recordId: string }[]) {
      add(name, row.recordId)
    }
  }
  return keys
}

/**
 * 相手1人ぶんを取り込む（設計書 §4.3）。1つのトランザクションで行う。
 *
 * @param db 自分のローカル DB（書き込む側）
 * @param peerDb 相手の DB（読むだけ。`readonly` で開いてよい）
 */
export function importFromPeer(
  db: Database.Database,
  peerDb: Database.Database,
  options: RowsImportOptions
): RowsImportResult {
  const empty: RowsImportResult = {
    status: 'skipped',
    changed: [],
    dirtyTables: [],
    skippedTables: [],
    skipped: 0,
    conflicts: 0,
    lamport: readLamport(db),
  }
  if (options.skipFormatCheck !== true) {
    const format = readSnsFormat(peerDb)
    if (format !== ROWS_FORMAT) {
      return {
        ...empty,
        reason:
          format === null
            ? `相手の _sync_meta に sns-format が無い`
            : `相手の sns-format が ${format}（こちらは ${ROWS_FORMAT}）`,
      }
    }
  }

  // 表の名前は**入り口で1回だけ**畳む（`src/rows/table-name.ts`）。畳まずに
  // 持ち回ると、綴りの違う2端末で `_tombstone` の版の鍵が割れる
  const specs = canonicalTableSpecs(db, options.tables)
  const values = new ValueOrdering()
  try {
    const io = new ImportIo(db, peerDb, specs, values)
    const keys = options.keys ?? collectPeerKeys(peerDb, specs)
    const result: RowsImportResult = {
      status: 'imported',
      changed: [],
      dirtyTables: [],
      skippedTables: io.skippedTables,
      skipped: 0,
      conflicts: 0,
      lamport: empty.lamport,
    }
    // 1つのトランザクション。途中で落ちたら、その相手ぶんだけ丸ごと戻る。
    // `BEGIN IMMEDIATE`（`.immediate()`）にするのは、書き込みのロックを最初に
    // 取るためである。`BEGIN`（DEFERRED）だと、読みのあとで書き込みへ上がる
    // ところで `SQLITE_BUSY` になり、取り込みの途中で落ちうる
    const run = db.transaction(() => {
      let highestLamport = 0
      const dirty = new Set<string>()
      for (const entry of keys) {
        const table = io.table(entry.table)
        if (table === null) continue
        const outcome = importOneKey(io, table, entry.key)
        if (outcome === null) continue
        highestLamport = Math.max(highestLamport, outcome.lamport)
        // 見え方が動いたなら、`Max` が動いていなくても作り直しは要る
        if (outcome.changed) dirty.add(table.name)
        if (!outcome.changed) {
          // 相手は主張したが、手元の版の方が強かった（§4.4 の `skipped`）
          result.skipped += 1
          continue
        }
        // 手元にも版があったのに入れ替わったなら、突き合わせて相手が勝った
        if (outcome.contested) result.conflicts += 1
        result.changed.push({
          table: table.name,
          key: entry.key,
          operation: outcome.operation,
        })
        dirty.add(table.name)
      }
      for (const name of dirty) io.markDirty(name)
      result.dirtyTables = [...dirty]
      io.raiseLamport(highestLamport)
      io.bumpImportTick()
    })
    run.immediate()
    result.lamport = readLamport(db)
    return result
  } finally {
    values.close()
  }
}

/* ------------------------------------------------------------------ *
 * キー1つ
 * ------------------------------------------------------------------ */

/** キー1つを取り込んだ結果。 */
interface KeyOutcome {
  changed: boolean
  /** 手元にも版があった（＝突き合わせが起きた） */
  contested: boolean
  operation: 'UPDATE' | 'DELETE'
  /** 相手が主張した版の `_sns_lamport` の最大 */
  lamport: number
}

/**
 * キー1つを取り込む（設計書 §4.3 の擬似コード）。
 *
 * `before` と `after` は**行の版と削除の版の強い方**（`Max`）で、両方 JS で決める。
 */
function importOneKey(
  io: ImportIo,
  table: TableIo,
  key: string
): KeyOutcome | null {
  const remoteRow = io.readPeerRow(table, key)
  const remoteDelete = io.readPeerTombstone(table, key)
  if (remoteRow === null && remoteDelete === null) return null

  const localRow = io.readLocalRow(table, key)
  const localDelete = io.readLocalTombstone(table, key)

  const before = io.strongest(localRow, localDelete)
  const nextRow = io.strongest(localRow, remoteRow)
  const nextDelete = io.strongest(localDelete, remoteDelete)
  const after = io.strongest(nextRow, nextDelete)
  if (after === null) return null

  if (nextDelete !== null && nextDelete !== localDelete) {
    io.writeTombstone(table, key, nextDelete)
  }
  const rowWins =
    nextRow !== null && io.strongest(nextRow, nextDelete) === nextRow
  if (nextRow !== null && rowWins) {
    // 行の版が勝っている。手元に無い、または相手の版が強いときだけ書く
    if (nextRow !== localRow) io.writeRow(table, nextRow)
  } else if (localRow !== null) {
    // 負けた側の行を、同じトランザクションで消す（設計書 §4.3）
    io.deleteRow(table, key)
  }

  // `before` / `after` は版の強い方（`Max`）で、見え方の計算（`derive`）も
  // 同じ `Max` を見る。だから「`Max` が変わった」がそのまま「作り直しが要る」
  const changed = before === null || !io.sameVersion(before, after)
  const operation = after.version.kind === 'delete' ? 'DELETE' : 'UPDATE'
  if (changed) io.writeChangelog(table, key, operation)
  return {
    changed,
    contested: before !== null,
    operation,
    lamport: Math.max(
      remoteRow === null ? 0 : remoteRow.version.lamport,
      remoteDelete === null ? 0 : remoteDelete.version.lamport
    ),
  }
}

/* ------------------------------------------------------------------ *
 * 読み書きの道具
 * ------------------------------------------------------------------ */

/** 1つの版と、その元の行（そのまま格納するために生の値を持ち歩く）。 */
interface Claim {
  version: RowVersion
  /** `_sns_rows_<t>` に書く値（列名 → 値）。削除の版では使わない */
  row?: Record<string, SqlValue>
  /** `_tombstone` に書く値。行の版では使わない */
  tombstone?: Record<string, SqlValue>
}

/** 表1つ分の、読み書きに要る材料。 */
interface TableIo {
  name: string
  primaryKey: string
  /** `_sns_rows_<t>` に写すアプリの列 */
  columns: string[]
  /** 相手の `_sns_rows_<t>` にある列（相手に無い列は既定値で埋める） */
  peerColumns: Set<string> | null
  /** 列 → 既定値の SQL の字面（相手に無い列を埋めるのに使う） */
  defaults: Map<string, string | null>
  rowsTable: string
}

/** 取り込みの読み書きを1か所にまとめる。文はすべて使い回す。 */
class ImportIo {
  readonly skippedTables: { table: string; reason: string }[] = []
  private readonly tables = new Map<string, TableIo | null>()
  private readonly statements = new Map<string, Database.Statement>()
  /** `_tombstone` にある列（版の列を足す前の DB には版の列が無い） */
  private readonly tombstoneColumns: Set<string>
  private readonly peerHasTombstone: boolean

  constructor(
    private readonly db: Database.Database,
    private readonly peerDb: Database.Database,
    specs: RowsTableSpec[],
    private readonly values: ValueOrdering
  ) {
    this.tombstoneColumns = new Set(
      (db.pragma(`table_info(_tombstone)`) as RowsColumn[]).map(
        (column) => column.name
      )
    )
    this.peerHasTombstone = tableExists(peerDb, '_tombstone')
    for (const spec of specs) {
      this.tables.set(foldIdentifier(spec.name), this.readTable(spec))
    }
  }

  /**
   * 表の材料。読めない表は `null`（理由は {@link skippedTables} に積む）。
   *
   * 引くときに綴りを畳むのは、範囲 `S` が相手の `_changelog` から来るからである
   * （相手のトリガーが埋め込んだ字面がそのまま載っている）。
   */
  table(name: string): TableIo | null {
    return this.tables.get(foldIdentifier(name)) ?? null
  }

  private readTable(spec: RowsTableSpec): TableIo | null {
    const rowsTable = rowsTableName(spec.name)
    if (!tableExists(this.db, rowsTable)) {
      this.skippedTables.push({
        table: spec.name,
        reason: `手元に ${rowsTable} が無い`,
      })
      return null
    }
    const columns = syncedColumns(this.db, spec.name)
    const primaryKey = primaryKeyColumn(this.db, spec.name)
    let peerColumns: Set<string> | null = null
    if (tableExists(this.peerDb, rowsTable)) {
      peerColumns = new Set(
        (
          this.peerDb.pragma(
            `table_info(${escapeIdentifier(rowsTable)})`
          ) as RowsColumn[]
        ).map((column) => column.name)
      )
      if (!peerColumns.has(primaryKey.name)) {
        // 主キーの列が無い相手の表は、キーを突き合わせられない
        this.skippedTables.push({
          table: spec.name,
          reason: `相手の ${rowsTable} に主キーの列 ${primaryKey.name} が無い`,
        })
        peerColumns = null
      }
    }
    return {
      name: spec.name,
      primaryKey: primaryKey.name,
      columns: columns.map((column) => column.name),
      peerColumns,
      defaults: new Map(
        columns.map((column) => [column.name, defaultOf(column)])
      ),
      rowsTable,
    }
  }

  /* -------------------- 読む -------------------- */

  /** 相手の `_sns_rows_<t>` の行。無ければ `null`。 */
  readPeerRow(table: TableIo, key: string): Claim | null {
    if (table.peerColumns === null) return null
    const statement = this.prepare(
      this.peerDb,
      `peer-row:${table.name}`,
      () => {
        const selected = table.columns.map((column) =>
          table.peerColumns?.has(column) === true
            ? escapeIdentifier(column)
            : `${defaultExpression(table, column)} AS ${escapeIdentifier(column)}`
        )
        for (const column of Object.values(VERSION_COLUMNS)) {
          selected.push(escapeIdentifier(column))
        }
        return `SELECT ${selected.join(', ')} FROM ${escapeIdentifier(table.rowsTable)}
                 WHERE CAST(${escapeIdentifier(table.primaryKey)} AS TEXT) = ?`
      }
    )
    const row = statement.get(key) as Record<string, SqlValue> | undefined
    return this.toRowClaim(table, row)
  }

  /** 手元の `_sns_rows_<t>` の行。 */
  readLocalRow(table: TableIo, key: string): Claim | null {
    const statement = this.prepare(
      this.db,
      `local-row:${table.name}`,
      () =>
        `SELECT * FROM ${escapeIdentifier(table.rowsTable)}
          WHERE CAST(${escapeIdentifier(table.primaryKey)} AS TEXT) = ?`
    )
    const row = statement.get(key) as Record<string, SqlValue> | undefined
    return this.toRowClaim(table, row)
  }

  /** 相手の `_tombstone` の行。 */
  readPeerTombstone(table: TableIo, key: string): Claim | null {
    if (!this.peerHasTombstone) return null
    const statement = this.prepare(
      this.peerDb,
      `peer-tombstone`,
      () => `SELECT * FROM _tombstone WHERE tableName = ? AND recordId = ?`
    )
    const row = statement.get(table.name, key) as
      Record<string, SqlValue> | undefined
    return this.toDeleteClaim(table, key, row)
  }

  /** 手元の `_tombstone` の行。 */
  readLocalTombstone(table: TableIo, key: string): Claim | null {
    const statement = this.prepare(
      this.db,
      `local-tombstone`,
      () => `SELECT * FROM _tombstone WHERE tableName = ? AND recordId = ?`
    )
    const row = statement.get(table.name, key) as
      Record<string, SqlValue> | undefined
    return this.toDeleteClaim(table, key, row)
  }

  /* -------------------- 比べる -------------------- */

  /** 強い方（同着なら `a`）。設計書 §1.2.5 の `≺`。 */
  strongest(a: Claim | null, b: Claim | null): Claim | null {
    if (a === null) return b
    if (b === null) return a
    return this.values.compareVersions(a.version, b.version) >= 0 ? a : b
  }

  /** 2つの版が同じものか（`Max` が変わったかの判定）。 */
  sameVersion(a: Claim, b: Claim): boolean {
    return this.values.compareVersions(a.version, b.version) === 0
  }

  /* -------------------- 書く -------------------- */

  /** `_sns_rows_<t>` へ（**受け取った版をそのまま**）書く。 */
  writeRow(table: TableIo, claim: Claim): void {
    const statement = this.prepare(this.db, `write-row:${table.name}`, () => {
      const names = [...table.columns, ...Object.values(VERSION_COLUMNS)]
      const excluded = {
        ts: `"excluded".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
        lamport: `"excluded".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
        instance: `"excluded".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
      }
      const quoted = escapeIdentifier(table.rowsTable)
      const held = {
        ts: `${quoted}.${escapeIdentifier(VERSION_COLUMNS.ts)}`,
        lamport: `${quoted}.${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
        instance: `${quoted}.${escapeIdentifier(VERSION_COLUMNS.instance)}`,
      }
      const assignments = names
        .filter((column) => column !== table.primaryKey)
        .map(
          (column) =>
            `${escapeIdentifier(column)} = "excluded".${escapeIdentifier(column)}`
        )
      // `SELECT … WHERE true` の形（設計書 §4.3 の K）。`VALUES` では
      // `ON CONFLICT` の前に `WHERE` を置けず、`near "DO": syntax error` になる
      return `INSERT INTO ${quoted} (${names.map(escapeIdentifier).join(', ')})
              SELECT ${names.map(() => '?').join(', ')} WHERE true
              ON CONFLICT (${escapeIdentifier(table.primaryKey)}) DO UPDATE SET
                ${assignments.join(',\n                ')}
              WHERE ${strongerSql(excluded, held)}`
    })
    const row = claim.row as Record<string, SqlValue>
    statement.run(
      ...([...table.columns, ...Object.values(VERSION_COLUMNS)].map(
        (column) => row[column] ?? null
      ) as never[])
    )
  }

  /** `_sns_rows_<t>` から負けた行を消す。 */
  deleteRow(table: TableIo, key: string): void {
    this.prepare(
      this.db,
      `delete-row:${table.name}`,
      () =>
        `DELETE FROM ${escapeIdentifier(table.rowsTable)}
          WHERE CAST(${escapeIdentifier(table.primaryKey)} AS TEXT) = ?`
    ).run(key)
  }

  /** `_tombstone` へ（**受け取った版をそのまま**）書く。 */
  writeTombstone(table: TableIo, key: string, claim: Claim): void {
    const columns = this.tombstoneWriteColumns()
    const statement = this.prepare(this.db, `write-tombstone`, () => {
      const excluded = {
        ts: `"excluded".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
        lamport: `"excluded".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
        instance: `"excluded".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
      }
      const held = {
        ts: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
        lamport: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
        instance: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
      }
      const assignments = columns
        .filter((column) => column !== 'tableName' && column !== 'recordId')
        .map(
          (column) =>
            `${escapeIdentifier(column)} = "excluded".${escapeIdentifier(column)}`
        )
      return `INSERT INTO "_tombstone" (${columns.map(escapeIdentifier).join(', ')})
              SELECT ${columns.map(() => '?').join(', ')} WHERE true
              ON CONFLICT ("tableName", "recordId") DO UPDATE SET
                ${assignments.join(',\n                ')}
              WHERE ${strongerSql(excluded, held)}`
    })
    const source = claim.tombstone as Record<string, SqlValue>
    statement.run(
      ...(columns.map((column) => {
        if (column === 'tableName') return table.name
        if (column === 'recordId') return key
        return source[column] ?? null
      }) as never[])
    )
  }

  /** `_changelog` へ通知を書く。 */
  writeChangelog(
    table: TableIo,
    key: string,
    operation: 'UPDATE' | 'DELETE'
  ): void {
    this.prepare(
      this.db,
      `write-changelog`,
      () =>
        `INSERT INTO "_changelog" ("tableName", "recordId", "operation", "changedAt")
         VALUES (?, ?, ?, ${NOW_SQL})`
    ).run(table.name, key, operation)
  }

  /** `_sns_dirty` に表を載せる。 */
  markDirty(table: string): void {
    this.prepare(
      this.db,
      `mark-dirty`,
      () =>
        `INSERT INTO "_sns_dirty" ("tableName") VALUES (?)
         ON CONFLICT ("tableName") DO NOTHING`
    ).run(table)
  }

  /**
   * `_sns_clock.lamport` を、受け取った版の最大まで引き上げる。
   *
   * **格納した値には触らない**（設計書 §4.3）。引き上げるのは時計だけである。
   */
  raiseLamport(lamport: number): void {
    if (lamport <= 0) return
    this.prepare(
      this.db,
      `raise-lamport`,
      () =>
        `UPDATE "_sns_clock" SET "lamport" = ?
          WHERE "lamport" < ?`
    ).run(lamport, lamport)
  }

  /** `_sns_clock.importTick` を +1（作り直しの token の一部）。 */
  bumpImportTick(): void {
    this.db.exec(`UPDATE "_sns_clock" SET "importTick" = "importTick" + 1`)
  }

  /* -------------------- 内部 -------------------- */

  private tombstoneWriteColumns(): string[] {
    const wanted = [
      'tableName',
      'recordId',
      'deletedAt',
      ...Object.values(VERSION_COLUMNS),
    ]
    return wanted.filter((column) => this.tombstoneColumns.has(column))
  }

  private toRowClaim(
    table: TableIo,
    row: Record<string, SqlValue> | undefined
  ): Claim | null {
    if (row === undefined) return null
    const version = versionOf(row, table.name, row[table.primaryKey] ?? null)
    if (version === null) return null
    const content: Record<string, SqlValue> = {}
    for (const column of table.columns) content[column] = row[column] ?? null
    version.content = content
    return { version, row }
  }

  private toDeleteClaim(
    table: TableIo,
    key: string,
    row: Record<string, SqlValue> | undefined
  ): Claim | null {
    if (row === undefined) return null
    const version = versionOf(row, table.name, key)
    if (version === null) return null
    version.kind = 'delete'
    return { version, tombstone: row }
  }

  private prepare(
    db: Database.Database,
    token: string,
    sql: () => string
  ): Database.Statement {
    const cacheKey = `${db === this.db ? 'local' : 'peer'}:${token}`
    const cached = this.statements.get(cacheKey)
    if (cached !== undefined) return cached
    const statement = db.prepare(sql())
    // 2^53 を超える整数が潰れると、別の id や別の時刻が同着になり、
    // 書き戻したときに値が変わる（設計書 §3.7.1 の「値の受け渡し」）
    statement.safeIntegers(true)
    this.statements.set(cacheKey, statement)
    return statement
  }
}

/* ------------------------------------------------------------------ *
 * 小道具
 * ------------------------------------------------------------------ */

/** 行から版の3つ組を読む。3つ組が欠けていれば「主張が無い」。 */
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

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}

/** `_sns_rows_<t>` の主キーの列名（相手の表から読む）。 */
function peerPrimaryKey(db: Database.Database, table: string): string | null {
  const columns = db.pragma(
    `table_info(${escapeIdentifier(table)})`
  ) as RowsColumn[]
  const key = columns.find((column) => column.pk === 1)
  return key === undefined ? null : key.name
}

/** 既定値の SQL の字面（無ければ `null`）。 */
function defaultOf(column: RowsColumn): string | null {
  const text = column.dflt_value
  return typeof text === 'string' ? text : null
}

/**
 * 相手に無い列を埋める式（設計書 §4.3 の G）。
 *
 * 自分の表の既定値をそのまま使う。既定値が無ければ NULL。
 * 決定的でない既定値は前提 P8 の検査で断られているので、ここでは見ない。
 */
function defaultExpression(table: TableIo, column: string): string {
  const text = table.defaults.get(column)
  return text === null || text === undefined ? 'NULL' : `(${text})`
}

function readLamport(db: Database.Database): number {
  const row = db.prepare(`SELECT lamport FROM _sns_clock`).get() as
    { lamport: number } | undefined
  return row === undefined ? 0 : Number(row.lamport)
}
