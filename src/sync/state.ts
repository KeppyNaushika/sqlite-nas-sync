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
import { compareTimestamps } from '../conflict/timestamp'
import { NOW_SQL } from '../setup'
import { escapeIdentifier } from './sql'

/**
 * 同一レコード（tableName:recordId）の重複changelogエントリを、
 * **いちばん後に起きたもの**だけに縮約する。
 *
 * @remarks
 * 同一レコードに対してINSERT → UPDATE → UPDATE と複数のエントリがある場合、
 * 最後のUPDATEのみを処理すれば十分なため、この最適化を行う。
 *
 * **「後」を id の大小で決めてはいけない。** `_changelog.id` は
 * `AUTOINCREMENT` なので「そのDBが後から書いた」順ではあるが、
 * 「**出来事が後に起きた**」順ではない。{@link mergeChangelog} が
 * フルマージで取り込んだ相手のエントリを**元の `changedAt` のまま、
 * 新しく採番したid**で書き足すため、id順と時刻順はねじれる。
 *
 * 実際に起きた取りこぼし（3端末で再現）: C が行を消したあと、C が B から
 * フルマージで「その行の古い INSERT」を取り込むと、その INSERT は C 自身の
 * DELETE より**大きいid**に並ぶ。id で選ぶと INSERT が残り、しかもその行は
 * C のDBに既に無いので取り込み側は
 * `if (!remoteRecord) continue`（{@link processChangelogEntries}）で捨てる。
 * `lastSeenId` だけが進むので、**C の削除は他の端末へ永久に届かない**
 * （警告も出ない）。
 *
 * したがって時刻で比べる。書式が混在するので字面ではなく
 * {@link isLaterTimestamp} で（＝時刻として）比べる。
 *
 * **同時刻のときに id で決めるだけでは足りない。** `mergeChangelog` が写した
 * 相手のエントリは、元の `changedAt` のまま**自分の DELETE より大きい id**に並ぶ。
 * `changedAt` が同じミリ秒だと時刻では差が付かず、id で決めると
 * **写してきたエントリが自分の DELETE を覆い隠す**。実測（3端末）: A が
 * `decisions:d1` を更新し、同じミリ秒に B がその行を消し、B が A をフルマージすると、
 * B の changelog は `[... DELETE d1 @T(id 3) ... UPDATE d1 @T(id 6)]` になる。
 * C が B を読むと id で UPDATE が選ばれるが、**その行は B に無い**ので
 * `processChangelogEntries` の `if (!remoteRecord) continue` で捨てられ、
 * `lastSeenId` だけが進む —— **B の削除は C へ永久に届かない**（警告も出ない）。
 *
 * そこで同時刻のときは、まず**相手の現在の中身と話が合う方**を採る。
 * 相手にその行が無ければ DELETE の側、在れば INSERT/UPDATE の側が
 * 「相手で最後に起きたこと」である。話の合わない方を落としても何も失わない ——
 * 行が無いのに INSERT/UPDATE を選んでも上記のとおり捨てられるだけで、
 * 逆に DELETE を選べば相手の `_tombstone` から削除時刻が読めて LWW で決着する。
 * 現在の中身でも決まらない（両方が話に合う／合わない）ときだけ id を見る
 * （同じ瞬間に起きた出来事の順は、そのDBが書いた順しか手掛かりが無い）。
 *
 * @param db - **取り込み元のDB**。`julianday()` を借りるほか、同時刻の決着で
 *   「その行が今も在るか」を引く（{@link makeRowPresenceProbe}）
 * @param primaryKey - 主キー列名。行の有無を引くために要る
 * @internal
 */
export function deduplicateEntries(
  db: Database.Database,
  entries: ChangelogEntry[],
  primaryKey: string
): ChangelogEntry[] {
  const hasRow = makeRowPresenceProbe(db, primaryKey)
  const map = new Map<string, ChangelogEntry>()
  for (const entry of entries) {
    // 表名は大小を畳んで1件にまとめる（綴り違いで届いた同じ行を二度処理しない）。
    // id の方は**データ**なので畳まない
    const key = `${foldIdentifier(entry.tableName)}:${entry.recordId}`
    const kept = map.get(key)
    if (kept === undefined || happenedAfter(db, hasRow, entry, kept)) {
      map.set(key, entry)
    }
  }
  return Array.from(map.values())
}

/**
 * 「この表のこの行は、このDBに今も在るか」を答える手続きを作る。
 *
 * 表ごとに `prepare` を1度だけ行い、答えも覚える（1回の取り込みで同じ行が
 * 何度も問われる）。**表が無い・列が無いときは `null`（＝分からない）を返す。**
 * `mergeChangelog` が写したエントリには、こちらの設定に無い表や、相手が
 * 別の綴りで持っている表の名前が混じりうる。そこで例外を投げると、
 * その相手ぶんの取り込みが丸ごと止まる。
 * @internal
 */
function makeRowPresenceProbe(
  db: Database.Database,
  primaryKey: string
): (tableName: string, recordId: string) => boolean | null {
  const statements = new Map<string, Database.Statement | null>()
  const answers = new Map<string, boolean | null>()

  return (tableName: string, recordId: string): boolean | null => {
    const cacheKey = `${foldIdentifier(tableName)}:${recordId}`
    const cached = answers.get(cacheKey)
    if (cached !== undefined) return cached

    let statement = statements.get(tableName)
    if (statement === undefined) {
      try {
        statement = db.prepare(
          `SELECT 1 FROM ${escapeIdentifier(tableName)}
            WHERE ${escapeIdentifier(primaryKey)} = ?`
        )
      } catch {
        // 表が無い / 主キー列の綴りが違う —— 「分からない」として先へ進む
        statement = null
      }
      statements.set(tableName, statement)
    }

    const answer =
      statement === null ? null : statement.get(recordId) !== undefined
    answers.set(cacheKey, answer)
    return answer
  }
}

/**
 * 2つのエントリのうち、`candidate` の方が後に起きたか。
 *
 * 時刻が同じ（または時刻として読めない）ときは、相手の現在の中身 → id の順で決める
 * （理由は {@link deduplicateEntries}）。
 * @internal
 */
function happenedAfter(
  db: Database.Database,
  hasRow: (tableName: string, recordId: string) => boolean | null,
  candidate: ChangelogEntry,
  kept: ChangelogEntry
): boolean {
  const order = compareTimestamps(db, candidate.changedAt, kept.changedAt)
  if (order !== null && order !== 0) return order > 0

  // 時刻で決まらない（同時刻・または時刻として読めない）。相手の現在の中身と
  // 話が合う方を採る。**両方が合う／どちらも合わないときは決めない**（下の id へ）。
  const present = hasRow(candidate.tableName, candidate.recordId)
  if (present !== null) {
    const candidateAgrees = (candidate.operation === 'DELETE') !== present
    const keptAgrees = (kept.operation === 'DELETE') !== present
    if (candidateAgrees !== keptAgrees) return candidateAgrees
  }

  // 最後の手掛かりは「そのDBが後から書いた方」。**字面の大小へ落としてはいけない**
  // —— 読めない値どうしの字面順には意味が無い。
  return candidate.id > kept.id
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
