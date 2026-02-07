/**
 * changelog テーブル・トリガーのセットアップ機能を提供するモジュール。
 *
 * `_changelog` テーブル、`_sync_state` テーブル、
 * および対象テーブルごとのINSERT/UPDATE/DELETEトリガーを作成する。
 *
 * @module setup
 */
import Database from 'better-sqlite3';

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * changelog追跡に必要なテーブルとトリガーをセットアップする。
 *
 * 以下を冪等に（`IF NOT EXISTS`で）作成する:
 * - `_changelog` テーブル: 全変更操作のログを記録
 * - `_sync_state` テーブル: リモートクライアントごとの同期進捗を管理
 * - 各テーブルに3つのトリガー（AFTER INSERT / UPDATE / DELETE）
 * - WALジャーナルモードの有効化
 *
 * @param db - セットアップ対象のSQLiteデータベース接続
 * @param tables - トリガーを作成する対象テーブル名の配列
 * @param primaryKey - 主キーカラム名（トリガーで `NEW.{pk}` / `OLD.{pk}` として参照）
 *
 * @example
 * ```ts
 * const db = new Database('./local.sqlite');
 * setupChangelog(db, ['users', 'posts'], 'id');
 * // _changelog, _sync_state テーブルと6つのトリガーが作成される
 * ```
 */
export function setupChangelog(
  db: Database.Database,
  tables: string[],
  primaryKey: string
): void {
  // _changelog テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tableName TEXT    NOT NULL,
      recordId  TEXT    NOT NULL,
      operation TEXT    NOT NULL,
      changedAt TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_changelog_id ON _changelog(id)`
  );

  // _sync_state テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_state (
      remoteClientId TEXT    PRIMARY KEY,
      lastSeenId     INTEGER NOT NULL DEFAULT 0,
      lastSyncedAt   TEXT
    )
  `);

  // テーブルごとにトリガーを作成
  const escapedPk = escapeIdentifier(primaryKey);

  for (const table of tables) {
    const escapedTable = escapeIdentifier(table);

    // INSERT トリガー
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_insert_${table}
      AFTER INSERT ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('${table}', NEW.${escapedPk}, 'INSERT');
      END
    `);

    // UPDATE トリガー
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_update_${table}
      AFTER UPDATE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('${table}', NEW.${escapedPk}, 'UPDATE');
      END
    `);

    // DELETE トリガー
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_delete_${table}
      AFTER DELETE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('${table}', OLD.${escapedPk}, 'DELETE');
      END
    `);
  }

  // WALモード設定
  db.pragma('journal_mode = WAL');
}
