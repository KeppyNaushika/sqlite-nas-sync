/**
 * 旧方式（v0.19 以前）の DB を**試験のためだけに**作る。
 *
 * 本体の `setupChangelog` は段階6 で消したが、`migrateToRows` は
 * 「旧方式の DB を案A へ移す」ことを仕事にしている（設計書 §3.9）。
 * その入力を用意する手立てが要るので、当時の DDL をここへ写した。
 *
 * **本体はこれを使わない。** 移行と復元の検出（`rows-migrate` /
 * `rows-restore-detect`）の入力を作るためだけに在る。
 *
 * 当時との違いは2つで、どちらも移行の入力には関係しない:
 * - `collapseIdMergeChains`（起動時の帳簿の手当て）は呼ばない
 * - `sweepStaleRemoteCopies`（一時領域の掃除）は呼ばない
 */
import Database from 'better-sqlite3'
import { NOW_SQL } from '../../src/setup'

/** 旧方式の表とトリガーを作る（当時の `setupChangelog` と同じ形）。 */
export function setupLegacyChangelog(
  db: Database.Database,
  tables: readonly { name: string }[],
  primaryKey = 'id'
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tableName TEXT    NOT NULL,
      recordId  TEXT    NOT NULL,
      operation TEXT    NOT NULL,
      changedAt TEXT    NOT NULL DEFAULT (${NOW_SQL})
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_changelog_id ON _changelog(id)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog_prune (
      onlyRow         INTEGER PRIMARY KEY CHECK (onlyRow = 0),
      prunedThroughId INTEGER NOT NULL DEFAULT 0,
      prunedAt        TEXT    NOT NULL DEFAULT (${NOW_SQL})
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_state (
      remoteClientId TEXT    PRIMARY KEY,
      lastSeenId     INTEGER NOT NULL DEFAULT 0,
      lastSyncedAt   TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tombstone (
      tableName  TEXT NOT NULL,
      recordId   TEXT NOT NULL,
      deletedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      mergedInto TEXT,
      revokedAt  TEXT,
      PRIMARY KEY (tableName, recordId)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _id_merge (
      tableName TEXT NOT NULL,
      losingId  TEXT NOT NULL,
      winningId TEXT NOT NULL,
      mergedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      PRIMARY KEY (tableName, losingId)
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

  const pk = `"${primaryKey.replace(/"/g, '""')}"`

  for (const { name } of tables) {
    const t = `"${name.replace(/"/g, '""')}"`
    dropTrigger(db, `_changelog_after_insert_${name}`)
    db.exec(`
      CREATE TRIGGER _changelog_after_insert_${name}
      AFTER INSERT ON ${t} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${name}', NEW.${pk}, 'INSERT', ${NOW_SQL});
      END
    `)
    dropTrigger(db, `_changelog_after_update_${name}`)
    db.exec(`
      CREATE TRIGGER _changelog_after_update_${name}
      AFTER UPDATE ON ${t} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${name}', NEW.${pk}, 'UPDATE', ${NOW_SQL});
      END
    `)
    dropTrigger(db, `_changelog_after_delete_${name}`)
    db.exec(`
      CREATE TRIGGER _changelog_after_delete_${name}
      AFTER DELETE ON ${t} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${name}', OLD.${pk}, 'DELETE', ${NOW_SQL});
        INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
        VALUES ('${name}', OLD.${pk}, ${NOW_SQL});
      END
    `)
  }

  dropTrigger(db, '_changelog_after_insert__heartbeat')
  db.exec(`
    CREATE TRIGGER _changelog_after_insert__heartbeat
    AFTER INSERT ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'INSERT', ${NOW_SQL});
    END
  `)
  dropTrigger(db, '_changelog_after_update__heartbeat')
  db.exec(`
    CREATE TRIGGER _changelog_after_update__heartbeat
    AFTER UPDATE ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'UPDATE', ${NOW_SQL});
    END
  `)

  db.pragma('journal_mode = WAL')
}

function dropTrigger(db: Database.Database, name: string): void {
  db.exec(`DROP TRIGGER IF EXISTS "${name.replace(/"/g, '""')}"`)
}
