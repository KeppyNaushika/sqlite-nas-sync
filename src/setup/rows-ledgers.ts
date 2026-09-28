/**
 * `setupSync` が要る、表ごとでない帳簿を作る。
 *
 * **アプリの表に付くトリガーは `src/rows/triggers.ts` の4本だけ**である。
 *
 * ここで作るのは、**表に触らない**帳簿だけ:
 *
 * | 表 | 使うところ |
 * | --- | --- |
 * | `_sync_state` | 相手ごとの `lastSeenId`（§4.3） |
 * | `_changelog_prune` | 掃除した位置（隙間の検出） |
 * | `_sync_meta` | `schemaVersion` と `sns.*` の鍵（§3.8・§3.10） |
 *
 * `_changelog` と `_tombstone` は `createRowsTables` が作る。
 *
 * @module setup/rows-ledgers
 * @internal
 */
import Database from 'better-sqlite3'
import { sweepStaleRemoteCopies } from '../nas'

/**
 * 帳簿を冪等に作る。アプリの表には触らない。
 *
 * 旧版はここで `_heartbeat` の表と、そこから `_changelog` へ書くトリガーを
 * 作っていた（「変更が1件も無い日に `_changelog` が保持期間で空になる」のを
 * 防ぐため）。`_changelog` が空でも `_changelog_prune.prunedThroughId` で
 * 隙間は正しく判定できる（`hasChangelogGap`）ので、この仕掛けは廃止した。
 * 旧 DB に残っている表とトリガーは `migrateToRows` が撤去する。
 */
export function setupRowsLedgers(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_state (
      remoteClientId TEXT    PRIMARY KEY,
      lastSeenId     INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog_prune (
      onlyRow         INTEGER PRIMARY KEY CHECK (onlyRow = 0),
      prunedThroughId INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.pragma('journal_mode = WAL')

  // 起動のついでに、一時領域の残骸を回収する（旧方式と同じ理由。
  // 実測で60GB超まで育ったことがある）。失敗しても同期は続けられる。
  try {
    sweepStaleRemoteCopies()
  } catch {
    /* 掃除できなくても同期そのものは続けられる */
  }
}
