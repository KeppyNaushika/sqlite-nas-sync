/**
 * 相手1人ぶんの取り込み —— 通常の差分同期と、隙間があるときのフルマージ。
 *
 * どちらの経路も**1つのトランザクション**で行う。途中で失敗したら、その相手ぶんの
 * 取り込みだけが巻き戻り、`_sync_state` のカーソルも進まない（次回やり直せる）。
 *
 * @module sync/pull
 * @internal
 */
import Database from 'better-sqlite3'
import { SyncConfig, SyncResult, TableConfig } from '../types'
import {
  cleanupChangelog,
  getMaxChangelogId,
  hasChangelogGap,
  readChangelog,
} from '../changelog'
import { openRemoteDbViaLocalCopy } from '../nas'
import { readSchemaVersion } from '../setup'
import {
  deduplicateEntries,
  getSyncState,
  recordSkippedRemote,
  updateSyncState,
} from './state'
import { processChangelogEntries } from './entries'
import {
  applyTombstones,
  mergeChangelog,
  performFullMergeData,
} from './full-merge'
import { disableTriggers, reEnableTriggers } from './triggers'

/**
 * 通常のchangelogベース差分同期を実行する。
 *
 * @internal
 */
export function pullNormal(
  localDb: Database.Database,
  remoteClients: { clientId: string; filePath: string }[],
  config: SyncConfig,
  tables: TableConfig[],
  primaryKey: string,
  result: SyncResult
): void {
  for (const remote of remoteClients) {
    let handle: ReturnType<typeof openRemoteDbViaLocalCopy> = null

    try {
      handle = openRemoteDbViaLocalCopy(remote.filePath)
      if (!handle) {
        result.warnings.push(
          `Failed to open remote database: ${remote.clientId}`
        )
        continue
      }
      const remoteDb = handle.db

      // schemaVersionチェック
      if (config.schemaVersion) {
        const remoteVersion = readSchemaVersion(remoteDb)
        if (remoteVersion !== config.schemaVersion) {
          recordSkippedRemote(
            result,
            remote.clientId,
            remoteVersion,
            config.schemaVersion
          )
          continue
        }
      }

      const { lastSeenId } = getSyncState(localDb, remote.clientId)

      // changelog読み取り
      const entries = readChangelog(remoteDb, lastSeenId)
      if (entries.length === 0) {
        result.clientsSynced++
        continue
      }

      // エントリの重複排除
      const deduplicated = deduplicateEntries(entries)
      const maxId = entries[entries.length - 1].id

      // 適用と lastSeenId 更新を 1 つのトランザクションで原子的に。
      // ここで例外が出れば全てロールバックされ、次回 sync で同じ差分を再試行できる。
      const transaction = localDb.transaction(() => {
        // 外部キーの検査をトランザクション終端まで遅らせる。
        // changelogのエントリは「変更が起きた順」に並ぶが、レコードの中身はリモートの
        // 「現在の姿」を読むため、親より先に子が現れることがある（競合解決で子が
        // 別の親へ付け替えられた場合など）。1文ずつ検査すると、その順序だけで
        // 取り込み全体が巻き戻り、その相手からの同期が永久に止まる。
        // 制約を切るのではなく検査を遅らせるだけなので、COMMIT時に矛盾が残っていれば
        // 通常どおり失敗する。この pragma はCOMMIT/ROLLBACKで自動的に戻る。
        localDb.pragma('defer_foreign_keys = ON')
        processChangelogEntries(
          localDb,
          remoteDb,
          deduplicated,
          primaryKey,
          tables,
          result
        )
        updateSyncState(localDb, remote.clientId, maxId)
      })
      transaction()

      result.clientsSynced++
    } catch (err) {
      result.warnings.push(`Sync failed for client ${remote.clientId}: ${err}`)
    } finally {
      if (handle) {
        handle.cleanup()
      }
    }
  }
}

/**
 * ギャップ検出時のフルマージを実行する。
 *
 * トリガーを無効化した状態で:
 * 1. リモートの全レコードをLWWでマージ
 * 2. リモートのtombstoneを適用
 * 3. リモートのchangelogをマージ（7日以内）
 *
 * @internal
 */
export function pullFullMerge(
  localDb: Database.Database,
  remoteClients: { clientId: string; filePath: string }[],
  config: SyncConfig,
  tables: TableConfig[],
  primaryKey: string,
  retentionDays: number,
  result: SyncResult
): void {
  result.warnings.push(
    'Changelog gap detected, performing full merge with tombstone support'
  )

  // トリガー無効化
  disableTriggers(localDb, tables)

  try {
    for (const remote of remoteClients) {
      let handle: ReturnType<typeof openRemoteDbViaLocalCopy> = null

      try {
        handle = openRemoteDbViaLocalCopy(remote.filePath)
        if (!handle) {
          result.warnings.push(
            `Failed to open remote database: ${remote.clientId}`
          )
          continue
        }
        const remoteDb = handle.db

        // schemaVersionチェック
        if (config.schemaVersion) {
          const remoteVersion = readSchemaVersion(remoteDb)
          if (remoteVersion !== config.schemaVersion) {
            recordSkippedRemote(
              result,
              remote.clientId,
              remoteVersion,
              config.schemaVersion
            )
            continue
          }
        }

        // フルマージ本体と lastSeenId 更新を 1 つのトランザクションで原子的に。
        // 途中で例外が出れば mergeChangelog の大量INSERTを含めて全てロールバックされ、
        // 次回 sync で同じギャップが再検出されてやり直せる。
        // これがないと、changelogが膨張したまま lastSeenId が更新されず、毎回ループする。
        const transaction = localDb.transaction(() => {
          // 外部キーの検査をトランザクション終端まで遅らせる（pullNormal と同じ理由。
          // フルマージはテーブル名順に全行を流し込むため、親より先に子を入れる場面が
          // 通常フローよりさらに多い）。
          localDb.pragma('defer_foreign_keys = ON')
          performFullMergeData(localDb, remoteDb, tables, primaryKey, result)
          applyTombstones(localDb, remoteDb, tables, primaryKey, result)
          mergeChangelog(localDb, remoteDb, retentionDays)
          const maxId = getMaxChangelogId(remoteDb)
          updateSyncState(localDb, remote.clientId, maxId)
        })
        transaction()

        result.clientsSynced++
      } catch (err) {
        result.warnings.push(
          `Full merge failed for client ${remote.clientId}: ${err}`
        )
      } finally {
        if (handle) {
          handle.cleanup()
        }
      }
    }
  } finally {
    // トリガー再有効化（必ず実行）
    reEnableTriggers(localDb, tables, primaryKey)
  }
}
