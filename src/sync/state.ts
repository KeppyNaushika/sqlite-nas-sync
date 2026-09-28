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
 * `_sync_state` テーブルから、その相手をどこまで読んだか（`lastSeenId`）を取得する。
 *
 * 行が無ければ `null` を返す。
 * **「まだ一度も読んでいない」と「0 まで読んだ」は別の状態である。**
 * 一度も書いていない相手は `_changelog` が空なので、読み終えたあとのカーソルも 0 になる。
 * 行の有無で分けないと、その相手を読むたびに「初回」と判断してフルマージを繰り返す。
 * @internal
 */
export function getSyncState(
  localDb: Database.Database,
  remoteClientId: string
): number | null {
  const row = localDb
    .prepare(`SELECT lastSeenId FROM _sync_state WHERE remoteClientId = ?`)
    .get(remoteClientId) as { lastSeenId: number } | undefined

  return row === undefined ? null : row.lastSeenId
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
 * スキーマのバージョンが違うので見送ったリモートを結果に記録する。
 *
 * `skippedRemotes` に載せ、`warnings` にも1行足す。
 * 同一クライアントは1回の同期につき1エントリのみ記録する。
 *
 * @param remoteVersion - 相手のスキーマのバージョン。読めなければ `null`
 * @param localVersion - 自分のスキーマのバージョン
 * @param formatDiffers - スキーマのバージョンは同じで、ライブラリのデータの形式だけが違う
 * @internal
 */
export function recordSkippedRemote(
  result: SyncResult,
  clientId: string,
  remoteVersion: string | null,
  localVersion: string,
  formatDiffers = false
): void {
  if (result.skippedRemotes.some((s) => s.clientId === clientId)) return
  result.skippedRemotes.push({ clientId, remoteVersion, localVersion })
  result.warnings.push(
    `Skipping client ${clientId}: schema version mismatch (local=${localVersion}, remote=${remoteVersion ?? 'unknown'})` +
      (formatDiffers
        ? ` — the schema versions match but the library data format differs; update sqlite-nas-sync on both clients to the same version`
        : '')
  )
}
