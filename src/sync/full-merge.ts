/**
 * フルマージ —— changelog に隙間があって差分では追いつけないときの経路。
 *
 * リモートの**全レコード**をLWWで突き合わせ、`_tombstone` の削除を適用し、
 * リモートの changelog を自分の changelog へ複製する。トリガーは呼び出し元で
 * 外してあること（外さないと、取り込んだ行が自分の変更として記録され直す）。
 *
 * @module sync/full-merge
 * @internal
 */
import Database from 'better-sqlite3'
import { SyncResult, TableConfig } from '../types'
import { applyUpdate } from '../conflict'
import { escapeIdentifier, getTableColumns } from './sql'
import {
  hasMergedIntoColumn,
  makeTableConfigLookup,
  makeResurrectionProbe,
  makeTimestampColumnFor,
  resolveFoldTarget,
  TombstoneEntry,
} from './remote'
import { applyTombstoneDelete, recordFolds } from './entries'

/**
 * フルマージ: リモートの全レコードをLWWでローカルに適用する。
 *
 * トリガーは呼び出し元で無効化済みであること。
 *
 * @internal
 */
export function performFullMergeData(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tables: TableConfig[],
  primaryKey: string,
  result: SyncResult
): void {
  const timestampColumnFor = makeTimestampColumnFor(tables)
  const isResurrected = makeResurrectionProbe(
    remoteDb,
    primaryKey,
    timestampColumnFor
  )

  for (const tableConfig of tables) {
    const table = tableConfig.name
    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt'
    const escapedTable = escapeIdentifier(table)

    // リモートDBにテーブルが存在するか確認
    const exists = remoteDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table)
    if (!exists) continue

    const columns = getTableColumns(localDb, table)

    // 全レコードをスキャン
    const remoteRecords = remoteDb
      .prepare(`SELECT * FROM ${escapedTable}`)
      .all() as Record<string, unknown>[]

    for (const remoteRecord of remoteRecords) {
      const { action, folds, warnings } = applyUpdate(
        localDb,
        table,
        primaryKey,
        remoteRecord,
        columns,
        timestampColumn,
        isResurrected,
        timestampColumnFor
      )
      result.warnings.push(...warnings)
      if (action === 'updated') result.updated++
      if (action === 'inserted') result.inserted++
      if (action === 'skipped') result.skipped++
      if (folds.length > 0) result.conflictsResolved++
      recordFolds(result, folds)
    }
  }
}

/**
 * リモートの `_tombstone` テーブルからDELETE操作を適用する。
 *
 * `deletedAt > ローカルのupdatedAt` の場合のみローカルレコードを削除する。
 * トリガーは呼び出し元で無効化済みであること。
 *
 * @internal
 */
export function applyTombstones(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tables: TableConfig[],
  primaryKey: string,
  result: SyncResult
): void {
  // リモートに _tombstone テーブルが存在するか確認
  const exists = remoteDb
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get()
  if (!exists) return

  // 取り込み元の `_tombstone` が名乗る表名も**相手の綴り**なので、大小を畳んで引く
  const tableConfigFor = makeTableConfigLookup(tables)
  const timestampColumnFor = makeTimestampColumnFor(tables)
  const isResurrected = makeResurrectionProbe(
    remoteDb,
    primaryKey,
    timestampColumnFor
  )

  // mergedInto は v0.14.0以前のクライアントには無い列
  const mergedIntoColumn = hasMergedIntoColumn(remoteDb)
    ? 'mergedInto'
    : 'NULL AS mergedInto'
  const tombstones = remoteDb
    .prepare(
      `SELECT tableName, recordId, deletedAt, ${mergedIntoColumn} FROM _tombstone`
    )
    .all() as TombstoneEntry[]

  const columnCache = new Map<string, string[]>()

  for (const ts of tombstones) {
    const tableConfig = tableConfigFor(ts.tableName)
    if (!tableConfig) continue

    // 相手の綴りではなく、こちらの設定の綴りで扱う（`entries.ts` と同じ理由 ——
    // 帳簿の重複行をそもそも作らない）
    const table = tableConfig.name

    // 畳みは deleteProtected でも適用する（processChangelogEntries と同じ理由）
    const mergedInto = resolveFoldTarget(ts.recordId, ts.mergedInto)
    if (tableConfig.deleteProtected && mergedInto === null) continue

    // リモートにレコードが現存する場合は再作成されたものとみなし、tombstoneを無視する。
    // （削除後に同一ソースで再INSERTされたケース。削除時刻との大小に依らず存続させる）
    const escapedTable = escapeIdentifier(table)
    const escapedPk = escapeIdentifier(primaryKey)
    const remoteRecord = remoteDb
      .prepare(
        `SELECT ${escapedPk} FROM ${escapedTable} WHERE ${escapedPk} = ?`
      )
      .get(ts.recordId)
    if (remoteRecord) continue

    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt'

    let columns = columnCache.get(table)
    if (!columns) {
      columns = getTableColumns(localDb, table)
      columnCache.set(table, columns)
    }

    // フォーマット差(ISO-T vs スペース形式)を吸収したLWWで削除を適用する。
    applyTombstoneDelete(
      localDb,
      remoteDb,
      table,
      primaryKey,
      timestampColumn,
      columns,
      ts.recordId,
      ts.deletedAt,
      mergedInto,
      result,
      isResurrected,
      timestampColumnFor
    )
  }
}

/**
 * リモートの `_changelog` エントリをローカルにマージする（7日以内のもの）。
 *
 * トリガーは呼び出し元で無効化済みであること。
 * ローカルのchangelogに直接INSERTする（トリガー経由ではない）。
 *
 * @internal
 */
export function mergeChangelog(
  localDb: Database.Database,
  remoteDb: Database.Database,
  retentionDays: number
): void {
  // リモートの7日以内のchangelogエントリを取得
  const entries = remoteDb
    .prepare(
      // 書式が混在しても前後が正しく決まるよう、時刻としてそろえてから比べる
      // （{@link cleanupChangelog} と同じ理由）。
      `SELECT tableName, recordId, operation, changedAt FROM _changelog
       WHERE julianday(changedAt) >= julianday('now', '-' || ? || ' days')
       ORDER BY id`
    )
    .all(retentionDays) as {
    tableName: string
    recordId: string
    operation: string
    changedAt: string
  }[]

  if (entries.length === 0) return

  const insertStmt = localDb.prepare(
    `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
  )

  for (const entry of entries) {
    insertStmt.run(
      entry.tableName,
      entry.recordId,
      entry.operation,
      entry.changedAt
    )
  }
}
