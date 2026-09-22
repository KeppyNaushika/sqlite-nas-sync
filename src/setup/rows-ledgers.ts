/**
 * 案A の `setupSync` が要る、表ごとでない帳簿を作る（段階5）。
 *
 * 案A では**アプリの表に付くトリガーは `src/rows/triggers.ts` の4本だけ**である。
 * 旧方式の `setupChangelog`（段階6 で削除）は同じ表に `_changelog_after_*` を
 * 足していた。両方を通すと、1回の書き込みが旧方式と案A の両方で事実になり、
 * `_tombstone` の版の3列が旧 DELETE トリガーの `INSERT OR REPLACE` に塗り潰される。
 *
 * ここで作るのは、**表に触らない**帳簿だけ:
 *
 * | 表 | 使うところ |
 * | --- | --- |
 * | `_sync_state` | 相手ごとの `lastSeenId`（§4.3） |
 * | `_changelog_prune` | 掃除した位置（隙間の検出） |
 * | `_heartbeat` | `_changelog` の延命 |
 * | `_sync_meta` | `schemaVersion` と `sns.*` の鍵（§3.8・§3.10） |
 *
 * `_changelog` と `_tombstone` は `createRowsTables` が作る。
 *
 * @module setup/rows-ledgers
 * @internal
 */
import Database from 'better-sqlite3'
import { sweepStaleRemoteCopies } from '../nas'
import { NOW_SQL, dropStaleTrigger } from './sql'

/**
 * 案A の帳簿を冪等に作る。アプリの表には触らない。
 *
 * `_heartbeat` にだけは `_changelog` へ書くトリガーを付ける。`_heartbeat` は
 * 同期する表ではないので案A のトリガーが付かず、これが無いと
 * 「変更が1件も無い日は `_changelog` が保持期間で空になる」が戻ってくる。
 * 相手はこのキーを「同期しない表」として読み飛ばす（§4.3）。
 */
export function setupRowsLedgers(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_state (
      remoteClientId TEXT    PRIMARY KEY,
      lastSeenId     INTEGER NOT NULL DEFAULT 0,
      lastSyncedAt   TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog_prune (
      onlyRow         INTEGER PRIMARY KEY CHECK (onlyRow = 0),
      prunedThroughId INTEGER NOT NULL DEFAULT 0,
      prunedAt        TEXT    NOT NULL DEFAULT (${NOW_SQL})
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _heartbeat (
      id        TEXT PRIMARY KEY,
      updatedAt TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  dropStaleTrigger(db, '_changelog_after_insert__heartbeat')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_insert__heartbeat
    AFTER INSERT ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'INSERT', ${NOW_SQL});
    END
  `)
  dropStaleTrigger(db, '_changelog_after_update__heartbeat')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_update__heartbeat
    AFTER UPDATE ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'UPDATE', ${NOW_SQL});
    END
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
