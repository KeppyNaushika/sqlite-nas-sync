/**
 * changelog テーブル・トリガーのセットアップ機能を提供するモジュール。
 *
 * `_changelog` テーブル、`_sync_state` テーブル、`_tombstone` テーブル、
 * `_heartbeat` テーブル、および対象テーブルごとのINSERT/UPDATE/DELETEトリガーを作成する。
 *
 * @module setup
 */
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { TableConfig } from './types';

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
  tables: TableConfig[],
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

  // _tombstone テーブル（DELETE記録の長期保持）
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tombstone (
      tableName TEXT NOT NULL,
      recordId  TEXT NOT NULL,
      deletedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tableName, recordId)
    )
  `);

  // _heartbeat テーブル（changelog延命用）
  db.exec(`
    CREATE TABLE IF NOT EXISTS _heartbeat (
      id        TEXT PRIMARY KEY,
      updatedAt TEXT NOT NULL
    )
  `);

  // テーブルごとにトリガーを作成
  const escapedPk = escapeIdentifier(primaryKey);

  for (const tableConfig of tables) {
    const table = tableConfig.name;
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

    // DELETE トリガー（_tombstone にも記録）
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_delete_${table}
      AFTER DELETE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('${table}', OLD.${escapedPk}, 'DELETE');
        INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
        VALUES ('${table}', OLD.${escapedPk}, datetime('now'));
      END
    `);
  }

  // _heartbeat のchangelogトリガー
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_insert__heartbeat
    AFTER INSERT ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation)
      VALUES ('_heartbeat', NEW.id, 'INSERT');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_update__heartbeat
    AFTER UPDATE ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation)
      VALUES ('_heartbeat', NEW.id, 'UPDATE');
    END
  `);

  // _sync_meta テーブル（スキーマバージョン等のメタ情報）
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // WALモード設定
  db.pragma('journal_mode = WAL');
}

/**
 * `_sync_meta` テーブルにスキーマバージョンを書き込む。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @param schemaVersion - 書き込むスキーマバージョン文字列
 */
export function writeSchemaVersion(
  db: Database.Database,
  schemaVersion: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('schemaVersion', ?)`
  ).run(schemaVersion);
}

/**
 * `_sync_meta` テーブルからスキーマバージョンを読み取る。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @returns スキーマバージョン文字列。未設定の場合は `null`
 */
export function readSchemaVersion(
  db: Database.Database
): string | null {
  // _sync_meta テーブルが存在しない場合も考慮
  try {
    const row = db
      .prepare(`SELECT value FROM _sync_meta WHERE key = 'schemaVersion'`)
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** @internal PRAGMA table_info が返すカラム情報 */
interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * 同期対象テーブルのスキーマからハッシュ値を自動生成する。
 *
 * 各テーブルの `PRAGMA table_info` からカラム名・型・notnull・pk を取得し、
 * テーブル名でソートした上でSHA-256ハッシュを生成する。
 * スキーマが変更されると自動的に異なるハッシュが返るため、
 * 手動でバージョンを管理する必要がない。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @param tables - ハッシュ対象のテーブル設定配列
 * @returns スキーマのSHA-256ハッシュ（先頭16文字）
 */
export function computeSchemaHash(
  db: Database.Database,
  tables: TableConfig[]
): string {
  const parts: string[] = [];

  // テーブル名でソートして安定した順序にする
  const sortedTables = [...tables].sort((a, b) => a.name.localeCompare(b.name));

  for (const tableConfig of sortedTables) {
    const tableName = tableConfig.name;

    try {
      const columns = db
        .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
        .all() as ColumnInfo[];

      // カラムをcid順（定義順）で処理
      const colDescs = columns
        .sort((a, b) => a.cid - b.cid)
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`)
        .join(',');

      parts.push(`${tableName}(${colDescs})`);
    } catch {
      // テーブルが存在しない場合はスキップ
    }
  }

  const hash = crypto
    .createHash('sha256')
    .update(parts.join('|'))
    .digest('hex');

  return hash.slice(0, 16);
}
