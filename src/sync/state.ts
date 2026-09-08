/**
 * 同期の進み具合を覚えておくテーブル（`_sync_state` / `_heartbeat`）の読み書き。
 *
 * 「この相手のどこまで読んだか」を持つのが `_sync_state`、「この端末はまだ生きている」を
 * 他端末へ伝えるのが `_heartbeat` である。どちらも同期そのものの状態であって、
 * 利用者のデータではない。
 *
 * @module sync/state
 * @internal
 */
import Database from 'better-sqlite3'
import { ChangelogEntry, SyncResult } from '../types'
import { foldIdentifier } from '../conflict/schema'
import { NOW_SQL } from '../setup'

/**
 * 同一レコード（tableName:recordId）の重複changelogエントリを、
 * 最新のもの（後に出現したもの）だけに縮約する。
 *
 * @remarks
 * 同一レコードに対してINSERT → UPDATE → UPDATE と複数のエントリがある場合、
 * 最後のUPDATEのみを処理すれば十分なため、この最適化を行う。
 *
 * @internal
 */
export function deduplicateEntries(
  entries: ChangelogEntry[]
): ChangelogEntry[] {
  const map = new Map<string, ChangelogEntry>()
  for (const entry of entries) {
    // 表名は大小を畳んで1件にまとめる（綴り違いで届いた同じ行を二度処理しない）。
    // id の方は**データ**なので畳まない
    const key = `${foldIdentifier(entry.tableName)}:${entry.recordId}`
    map.set(key, entry)
  }
  return Array.from(map.values())
}

/**
 * `_sync_state` テーブルからリモートクライアントの同期進捗を取得する。
 * @internal
 */
export function getSyncState(
  localDb: Database.Database,
  remoteClientId: string
): { lastSeenId: number; lastSyncedAt: string | null } {
  const row = localDb
    .prepare(
      `SELECT lastSeenId, lastSyncedAt FROM _sync_state WHERE remoteClientId = ?`
    )
    .get(remoteClientId) as
    { lastSeenId: number; lastSyncedAt: string | null } | undefined

  return row ?? { lastSeenId: 0, lastSyncedAt: null }
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
      `INSERT OR REPLACE INTO _sync_state (remoteClientId, lastSeenId, lastSyncedAt)
       VALUES (?, ?, ${NOW_SQL})`
    )
    .run(remoteClientId, lastSeenId)
}

/**
 * _heartbeat を更新する（当日の正午、全クライアント共通の確定的な値）。
 *
 * 既に同じ値であればUPDATEしない（トリガー不発）。
 *
 * @internal
 */
export function updateHeartbeat(localDb: Database.Database): void {
  const today = new Date().toISOString().slice(0, 10) // "2026-03-27"
  const noon = `${today}T12:00:00Z`
  const HEARTBEAT_ID = '00000000-0000-0000-0000-000000000000'

  localDb
    .prepare(
      `INSERT INTO _heartbeat (id, updatedAt) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET updatedAt = ? WHERE updatedAt < ?`
    )
    .run(HEARTBEAT_ID, noon, noon, noon)
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
