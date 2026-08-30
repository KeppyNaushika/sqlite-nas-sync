/**
 * changelog テーブル・トリガーのセットアップ機能を提供するモジュール。
 *
 * `_changelog` / `_sync_state` / `_tombstone` / `_id_merge` / `_heartbeat` の各テーブルと、
 * 対象テーブルごとの INSERT / UPDATE / DELETE トリガーを**冪等に**作る。
 * 何度呼んでも同じ形になるので、アプリの起動ごとに通してよい。
 *
 * 実装は役割ごとに分かれている:
 *
 * | モジュール | 受け持ち |
 * | --- | --- |
 * | `setup/sql` | 時刻の書式（`NOW_SQL`）と SQL の小道具 |
 * | `setup/tombstone` | 既存DBへの後付けの列 |
 * | `setup/id-merge-repair` | 起動時に帳簿の鎖と循環を畳み直す |
 * | `setup/schema-version` | スキーマの指紋の読み書き |
 *
 * @module setup
 */
import Database from 'better-sqlite3';
import { TableConfig } from '../types';
import { escapeIdentifier, dropStaleTrigger, NOW_SQL } from './sql';
import { ensureTombstoneMergedIntoColumn } from './tombstone';
import { collapseIdMergeChains } from './id-merge-repair';

export { NOW_SQL } from './sql';
export { ensureTombstoneMergedIntoColumn } from './tombstone';
export {
  computeSchemaHash,
  readSchemaVersion,
  writeSchemaVersion,
} from './schema-version';

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
      changedAt TEXT    NOT NULL DEFAULT (${NOW_SQL})
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

  // _tombstone テーブル（DELETE記録の長期保持）。
  // `mergedInto` は「この行は消えたのではなく、この行へ畳まれた」ことを表す。
  // 削除の事実と畳み先が同じ1行に載るので、削除を適用する側は**消すと決めるその場で
  // 畳み先を必ず見る**ことになり、「畳まれた行を、子を付け替えないまま消す」ことが
  // 構造的に起こらなくなる（別テーブルで配ると、届く順によっては見ずに消せてしまう）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tombstone (
      tableName  TEXT NOT NULL,
      recordId   TEXT NOT NULL,
      deletedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      mergedInto TEXT,
      PRIMARY KEY (tableName, recordId)
    )
  `);
  // 既存DBには CREATE TABLE IF NOT EXISTS では列が増えないため、明示的に足す
  ensureTombstoneMergedIntoColumn(db);

  // _id_merge テーブル（畳んだ「敗者id → 勝者id」のローカル索引）。
  // 自分が勝った側のクライアントには敗者行が入らないため、あとから届く相手の子が
  // 存在しない親を指す。この記録を使って外部キーを勝者へ向け直す。
  // 自分で畳んだぶんも、リモートの `_tombstone.mergedInto` から受け取ったぶんも
  // ここへ入る。同期対象にはしない（`_` 始まりなので自動検出から外れる）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _id_merge (
      tableName TEXT NOT NULL,
      losingId  TEXT NOT NULL,
      winningId TEXT NOT NULL,
      mergedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      PRIMARY KEY (tableName, losingId)
    )
  `);

  // 旧バージョンが書いた鎖（`A→C` と `C→B` が並ぶ形）をここで畳む。
  collapseIdMergeChains(db);

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
    dropStaleTrigger(db, `_changelog_after_insert_${table}`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_insert_${table}
      AFTER INSERT ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', NEW.${escapedPk}, 'INSERT', ${NOW_SQL});
      END
    `);

    // UPDATE トリガー
    dropStaleTrigger(db, `_changelog_after_update_${table}`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_update_${table}
      AFTER UPDATE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', NEW.${escapedPk}, 'UPDATE', ${NOW_SQL});
      END
    `);

    // DELETE トリガー（_tombstone にも記録）
    dropStaleTrigger(db, `_changelog_after_delete_${table}`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_delete_${table}
      AFTER DELETE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', OLD.${escapedPk}, 'DELETE', ${NOW_SQL});
        INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
        VALUES ('${table}', OLD.${escapedPk}, ${NOW_SQL});
      END
    `);
  }

  // _heartbeat のchangelogトリガー
  dropStaleTrigger(db, '_changelog_after_insert__heartbeat');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_insert__heartbeat
    AFTER INSERT ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'INSERT', ${NOW_SQL});
    END
  `);
  dropStaleTrigger(db, '_changelog_after_update__heartbeat');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_update__heartbeat
    AFTER UPDATE ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'UPDATE', ${NOW_SQL});
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
