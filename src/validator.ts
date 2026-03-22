/**
 * DBスキーマのバリデーション機能を提供するモジュール。
 *
 * sync対象テーブルが必要な構造（TEXT型PK、updatedAtカラム）を
 * 満たしているかを検証する。
 *
 * @module validator
 */
import Database from 'better-sqlite3';
import { TableConfig } from './types';

/**
 * バリデーションエラーの詳細。
 *
 * テーブルごとに発生したエラーを表す。
 */
export interface ValidationError {
  /** エラーが発生したテーブル名 */
  table: string;
  /** エラーの詳細メッセージ */
  message: string;
}

/** @internal SQLiteの `PRAGMA table_info` が返すカラム情報 */
interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * データベースのスキーマをバリデーションする。
 *
 * 各テーブルに対して以下をチェックする:
 * 1. テーブルが存在するか
 * 2. 指定された主キーカラムが存在し、TEXT型であるか
 * 3. `updatedAt` カラムが存在するか
 *
 * @param db - 検証対象のSQLiteデータベース接続
 * @param tables - 検証するテーブル名の配列
 * @param primaryKey - 主キーカラム名
 * @returns バリデーションエラーの配列。空配列なら全テーブルが有効。
 *
 * @example
 * ```ts
 * const errors = validateDatabase(db, ['users', 'posts'], 'id');
 * if (errors.length > 0) {
 *   console.error('バリデーション失敗:', errors);
 * }
 * ```
 */
export function validateDatabase(
  db: Database.Database,
  tables: TableConfig[],
  primaryKey: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const tableConfig of tables) {
    const table = tableConfig.name;
    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt';

    // テーブル存在確認
    const exists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      )
      .get(table);

    if (!exists) {
      errors.push({ table, message: `Table does not exist` });
      continue;
    }

    // カラム情報取得
    const columns = db
      .prepare(`PRAGMA table_info(${escapeIdentifier(table)})`)
      .all() as ColumnInfo[];

    // PKカラム確認
    const pkColumn = columns.find((col) => col.name === primaryKey);
    if (!pkColumn) {
      errors.push({
        table,
        message: `Primary key column '${primaryKey}' does not exist`,
      });
      continue;
    }

    // PK型チェック（TEXT型であること）
    if (pkColumn.type.toUpperCase() !== 'TEXT') {
      errors.push({
        table,
        message: `Primary key column '${primaryKey}' must be TEXT type, got '${pkColumn.type}'`,
      });
    }

    // タイムスタンプカラム確認
    const hasTimestamp = columns.some((col) => col.name === timestampColumn);
    if (!hasTimestamp) {
      errors.push({
        table,
        message: `Column '${timestampColumn}' does not exist`,
      });
    }
  }

  return errors;
}
