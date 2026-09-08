/**
 * リモートの `_changelog` エントリを1件ずつローカルへ適用する（通常の差分同期）。
 *
 * 操作の種類（INSERT / UPDATE / DELETE）で `conflict` 側の入口を選び、結果を
 * `SyncResult` へ数え上げる。**削除は無条件には適用しない** —— 処理順で勝敗が
 * 変わらないよう、削除時刻を使ったLWWで判断する。
 *
 * @module sync/entries
 * @internal
 */
import Database from 'better-sqlite3'
import { ChangelogEntry, RecordFold, SyncResult, TableConfig } from '../types'
import {
  applyInsert,
  applyMergedDelete,
  applyUpdate,
  isLaterTimestamp,
} from '../conflict'
import type { ResurrectionProbe, TimestampColumnFor } from '../conflict'
import { ensureTombstoneMergedIntoColumn } from '../setup'
import { escapeIdentifier, getTableColumns } from './sql'
import {
  getRemoteTombstone,
  makeTableConfigLookup,
  makeResurrectionProbe,
  makeTimestampColumnFor,
  readRemoteRecord,
  resolveFoldTarget,
} from './remote'

/**
 * 畳みの記録を同期結果へ写す。
 *
 * 畳みは**行が1つ消える**ので、削除として数える（畳んだ相手をそもそも持っていなかった
 * 場合は行が消えないため数えない）。件数だけでは「何と何が1つになったか」を利用者へ
 * 説明できないので、中身もそのまま載せる。
 * @internal
 */
export function recordFolds(result: SyncResult, folds: RecordFold[]): void {
  for (const fold of folds) {
    result.folds.push(fold)
    if (fold.removedLocalRow) result.deleted++
  }
}

/**
 * tombstoneに基づく削除をローカルに適用する。
 *
 * - ローカル `_tombstone` に max(deletedAt) と畳み先を記録する（以降の挿入/更新による
 *   復活を抑止する根拠となる。{@link applyInsert} がこれを参照する）。
 * - **畳み先（`mergedInto`）がある場合**は、消す前に子を畳み先へ付け替える
 *   （{@link applyMergedDelete}）。この分岐が無いと、競合を経験していないクライアントが
 *   敗者行をただ消し、自分の子をカスケードで失い、その削除がさらに他クライアントの
 *   付け替え済みの子まで殺す。畳みは「衝突していた版より新しい行には及ばせない」という
 *   LWWだけを見る（削除ではなくユニーク制約が強制する統合なので、削除保護の対象外）。
 * - 畳み先が無い（＝利用者操作による普通の削除）場合は、ローカル行が存在し
 *   `deletedAt` がその `updatedAt` より新しいときだけ削除する。
 *
 * 無条件削除ではなくLWWで判定するため、クライアントの処理順に依存せず
 * 「最新の更新 > 最新の削除なら存続、さもなくば削除」へ決定論的に収束する。
 * 比較はフォーマット差（ISO-T vs スペース形式）を吸収する {@link isLaterTimestamp} で行う。
 * @internal
 */
export function applyTombstoneDelete(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tableName: string,
  primaryKey: string,
  timestampColumn: string,
  columns: string[],
  recordId: string,
  deletedAt: string,
  mergedInto: string | null,
  result: SyncResult,
  isResurrected: ResurrectionProbe,
  timestampColumnFor: TimestampColumnFor
): void {
  const hasTombstone = localDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get()
  // **畳み先が分かっている削除は、`deletedAt` もここでは書かない。**
  //
  // 「この畳みの主張を受け入れるか」は `foldClaimWins` が2つの帳簿を見て一度だけ
  // 決める。`mergedInto` だけを判断の下へ移しても、`deletedAt` を先に進めてしまうと
  // **主張の半分だけが公開される**。実測: 手元が `(deletedAt: 1月, mergedInto: W1)` の
  // ところへ `(deletedAt: 6月, mergedInto: W2)` が届き、W2 の鎖が動いていて
  // `applyMergedDelete` が見送ると、手元は `(6月, W1)` になる —— **新しい削除時刻と
  // 古い判断の畳み先の組**で、これがそのまま全端末へ渡る。畳み先が元々無ければ
  // 「6月にただ消された」となり、受け取った側は畳まずに DELETE して子を道連れにする。
  //
  // 畳みとして届いた削除の記録は、まるごと `applyMergedDelete` に任せる。
  if (mergedInto !== null && mergedInto !== recordId) {
    // 畳み先が分かっている削除。消す前に子を引き取る。
    // `deletedAt` を渡すのは、畳みより後に更新された行にまで及ばせないため
    // （判断は {@link applyMergedDelete} 側で行う）。
    const { folds, warnings } = applyMergedDelete(
      localDb,
      tableName,
      primaryKey,
      recordId,
      mergedInto,
      readRemoteRecord(remoteDb, tableName, primaryKey, mergedInto),
      columns,
      timestampColumn,
      deletedAt,
      isResurrected,
      timestampColumnFor
    )
    recordFolds(result, folds)
    result.warnings.push(...warnings)
    return
  }

  // ここから先は**畳み先の無い、ただの削除**。
  // 「この id は消えた」という事実は畳みの判断とは独立なので、新しいときだけ進める
  // （既存の畳み先には触らないので消えない）。
  if (hasTombstone) {
    ensureTombstoneMergedIntoColumn(localDb)
    localDb
      .prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(tableName, recordId) DO UPDATE SET
           deletedAt = CASE
             WHEN COALESCE(
                    julianday(excluded.deletedAt) > julianday(_tombstone.deletedAt),
                    excluded.deletedAt > _tombstone.deletedAt
                  )
             THEN excluded.deletedAt
             ELSE _tombstone.deletedAt
           END`
      )
      .run(tableName, recordId, deletedAt)
  }

  const escapedTable = escapeIdentifier(tableName)
  const escapedPk = escapeIdentifier(primaryKey)
  const escapedTs = escapeIdentifier(timestampColumn)

  const localRecord = localDb
    .prepare(
      `SELECT ${escapedTs} AS ts FROM ${escapedTable} WHERE ${escapedPk} = ?`
    )
    .get(recordId) as { ts: unknown } | undefined
  if (!localRecord) return

  const localUpdatedAt = String(localRecord.ts ?? '')
  if (isLaterTimestamp(localDb, deletedAt, localUpdatedAt)) {
    localDb
      .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .run(recordId)
    result.deleted++
  }
}

/**
 * changelogエントリをローカルDBに適用する。
 *
 * 各エントリのoperationに応じてINSERT/UPDATE/DELETEを実行し、
 * 結果カウンターを更新する。
 *
 * @internal
 */
export function processChangelogEntries(
  localDb: Database.Database,
  remoteDb: Database.Database,
  entries: ChangelogEntry[],
  primaryKey: string,
  configTables: TableConfig[],
  result: SyncResult
): void {
  // テーブルごとのカラム情報をキャッシュ
  const columnCache = new Map<string, string[]>()
  // テーブル名 → TableConfig のマップ
  // 表名は**相手の設定どおりの綴り**で届く。大小を畳んで引く
  // （{@link makeTableConfigLookup}）
  const tableConfigFor = makeTableConfigLookup(configTables)
  // 表をまたいで時刻列を引く手続きと、作り直し判定。**取り込み1回につき1つ**
  // （レコードごとに作り直すと、表ごとの `prepare` が毎回やり直しになる）
  const timestampColumnFor = makeTimestampColumnFor(configTables)
  const isResurrected = makeResurrectionProbe(
    remoteDb,
    primaryKey,
    timestampColumnFor
  )

  for (const entry of entries) {
    // _heartbeat エントリは特別扱い: 直接適用
    if (entry.tableName === '_heartbeat') {
      if (entry.operation === 'DELETE') continue
      const remoteRecord = remoteDb
        .prepare(`SELECT * FROM _heartbeat WHERE id = ?`)
        .get(entry.recordId) as Record<string, unknown> | undefined
      if (!remoteRecord) continue

      const columns =
        columnCache.get('_heartbeat') ?? getTableColumns(localDb, '_heartbeat')
      columnCache.set('_heartbeat', columns)

      applyUpdate(
        localDb,
        '_heartbeat',
        'id',
        remoteRecord,
        columns,
        'updatedAt'
      )
      continue
    }

    // config.tables に含まれないテーブルはスキップ
    const tableConfig = tableConfigFor(entry.tableName)
    if (!tableConfig) continue

    // **ここから先は、こちらの設定どおりの綴りだけを使う。**
    // `entry.tableName` は**相手の設定どおりの綴り**（相手のトリガが自分の設定を
    // 埋め込む）。そのまま帳簿へ書くと、綴りが違う相手が増えるたびに
    // `_id_merge` / `_tombstone` の重複行が増える（引く側の `COLLATE NOCASE` と
    // `ORDER BY` は、その後始末をしているにすぎない）。入口で自分の綴りへ揃えれば、
    // 重複はそもそも生まれない。
    const table = tableConfig.name

    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt'

    let columns = columnCache.get(table)
    if (!columns) {
      columns = getTableColumns(localDb, table)
      columnCache.set(table, columns)
    }

    if (entry.operation === 'DELETE') {
      // 無条件削除は処理順により「削除 vs より新しい更新」の勝敗が変わる（非決定的）。
      // 削除時刻（_tombstone優先・無ければchangelogのchangedAt）を用いたLWWで適用する。
      // tombstoneに畳み先が載っていれば、削除ではなく畳みとして適用される。
      const remoteTombstone = getRemoteTombstone(
        remoteDb,
        table,
        entry.recordId
      )
      const mergedInto = resolveFoldTarget(
        entry.recordId,
        remoteTombstone?.mergedInto
      )

      // deleteProtected は「利用者操作による削除を適用しない」ための設定。
      // 畳みはユニーク制約が強制する統合であって削除ではないので、その対象外とする。
      // 見送っても行は救えない — 勝者行が届いた時点で applyInsert が同じ畳みを行うだけで、
      // それまでのあいだ子が宙に浮き、両者が同じユニークキーを送り合い続ける。
      if (tableConfig.deleteProtected && mergedInto === null) continue

      applyTombstoneDelete(
        localDb,
        remoteDb,
        table,
        primaryKey,
        timestampColumn,
        columns,
        entry.recordId,
        remoteTombstone?.deletedAt ?? entry.changedAt,
        mergedInto,
        result,
        isResurrected,
        timestampColumnFor
      )
    } else {
      // INSERT or UPDATE: リモートからレコード取得
      const escapedTable = escapeIdentifier(table)
      const escapedPk = escapeIdentifier(primaryKey)
      const remoteRecord = remoteDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(entry.recordId) as Record<string, unknown> | undefined

      if (!remoteRecord) continue // レコードがリモートに存在しない（後続のDELETEで消えた等）

      if (entry.operation === 'INSERT') {
        const { action, conflict, folds, warnings } = applyInsert(
          localDb,
          table,
          primaryKey,
          remoteRecord,
          columns,
          timestampColumn,
          isResurrected,
          timestampColumnFor
        )
        if (action === 'inserted') result.inserted++
        if (action === 'skipped') result.skipped++
        // 畳みは「消えた行」でもある。届いた行を採用しなかった場合でも、同じPKの
        // ローカル行が畳まれて消えていることがある（UPDATE 側と同じ数え方）。
        // `upserted` 自体が畳みを伴うこともあるので、二重には数えない。
        if (action === 'upserted' || folds.length > 0)
          result.conflictsResolved++
        recordFolds(result, folds)
        result.warnings.push(...warnings)
        if (conflict) {
          result.warnings.push(
            `Conflict on ${table}:${entry.recordId} resolved as ${conflict.resolution}`
          )
        }
      } else {
        // UPDATE
        const { action, conflict, folds, warnings } = applyUpdate(
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
        // 畳みは「消えた行」でもある。届いた更新を採用しなかった場合でも、
        // 更新対象の行が畳まれて消えていることがある（skipped だけでは実態に合わない）。
        if (folds.length > 0) result.conflictsResolved++
        recordFolds(result, folds)
        if (conflict) {
          result.warnings.push(
            `Conflict on ${table}:${entry.recordId} resolved as ${conflict.resolution}`
          )
        }
      }
    }
  }
}
