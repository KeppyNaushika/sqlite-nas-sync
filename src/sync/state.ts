/**
 * 同期の進み具合を覚えておくテーブル（`_sync_state`）の読み書き。
 *
 * 「この相手のどこまで読んだか」を持つのが `_sync_state` である。同期そのものの
 * 状態であって、利用者のデータではない。スキーマの版が合わずに見送った相手を
 * 結果へ書き留めるのも、同じ「同期の進み具合」の話なのでここに置く。
 *
 * @module sync/state
 * @internal
 */
import Database from 'better-sqlite3'
import { SyncResult } from '../types'

/**
 * `_sync_state` テーブルからリモートクライアントの同期進捗を取得する。
 * @internal
 */
export function getSyncState(
  localDb: Database.Database,
  remoteClientId: string
): { lastSeenId: number } {
  const row = localDb
    .prepare(`SELECT lastSeenId FROM _sync_state WHERE remoteClientId = ?`)
    .get(remoteClientId) as { lastSeenId: number } | undefined

  return row ?? { lastSeenId: 0 }
}

/**
 * `_sync_state` テーブルのリモートクライアント同期進捗を更新する。
 * @internal
 */
export function updateSyncState(
  localDb: Database.Database,
  remoteClientId: string,
  lastSeenId: number
): void {
  localDb
    .prepare(
      `INSERT OR REPLACE INTO _sync_state (remoteClientId, lastSeenId)
       VALUES (?, ?)`
    )
    .run(remoteClientId, lastSeenId)
}

/**
 * スキーマバージョン不一致でスキップしたリモートを結果に記録する。
 *
 * 後方互換のため warnings にも文字列を追加する。
 * 同一クライアントは1回のsyncにつき1エントリのみ記録する。
 *
 * @internal
 */
export function recordSkippedRemote(
  result: SyncResult,
  clientId: string,
  remoteVersion: string | null,
  localVersion: string
): void {
  if (result.skippedRemotes.some((s) => s.clientId === clientId)) return
  result.skippedRemotes.push({ clientId, remoteVersion, localVersion })
  result.warnings.push(
    `Skipping client ${clientId}: schema version mismatch (local=${localVersion}, remote=${remoteVersion ?? 'unknown'})`
  )
}
