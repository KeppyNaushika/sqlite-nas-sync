/**
 * レコードレベルの競合解決ロジックを提供するモジュール。
 *
 * INSERT（UPSERT fallback）、UPDATE（LWW）、DELETE の3つの操作を処理する。
 *
 * @module conflict
 */
import Database from 'better-sqlite3';
import { ConflictInfo } from './types';

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * リモートのINSERT操作をローカルDBに適用する。
 *
 * 通常のINSERTを試み、UNIQUE制約違反（PK重複やユニークカラム重複）が
 * 発生した場合はLWW（Last-Write-Wins）でUPSERTにフォールバックする。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param record - 挿入するリモートレコード
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`inserted` or `upserted`）と競合情報
 * @throws UNIQUE制約以外のSQLiteエラー
 */
export function applyInsert(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  record: Record<string, unknown>,
  columns: string[]
): { action: 'inserted' | 'upserted'; conflict?: ConflictInfo } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedColumns = columns.map((c) => escapeIdentifier(c));
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map((c) => record[c]);

  try {
    localDb
      .prepare(
        `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`
      )
      .run(...values);
    return { action: 'inserted' };
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (
      sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      // UNIQUE違反 → LWWでUPSERT
      const escapedPk = escapeIdentifier(primaryKey);
      const pkValue = record[primaryKey];

      const localRecord = localDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(pkValue) as Record<string, unknown> | undefined;

      const remoteUpdatedAt = String(record['updatedAt'] ?? '');
      const localUpdatedAt = localRecord
        ? String(localRecord['updatedAt'] ?? '')
        : '';

      if (!localRecord || remoteUpdatedAt > localUpdatedAt) {
        // リモートが新しい → UPDATE
        const updateColumns = columns.filter((c) => c !== primaryKey);
        const setClause = updateColumns
          .map((c) => `${escapeIdentifier(c)} = ?`)
          .join(', ');
        const updateValues = [
          ...updateColumns.map((c) => record[c]),
          pkValue,
        ];

        localDb
          .prepare(
            `UPDATE ${escapedTable} SET ${setClause} WHERE ${escapedPk} = ?`
          )
          .run(...updateValues);

        return {
          action: 'upserted',
          conflict: {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'remote_wins',
          },
        };
      }

      return {
        action: 'upserted',
        conflict: {
          table: tableName,
          recordId: String(pkValue),
          localUpdatedAt,
          remoteUpdatedAt,
          resolution: 'local_wins',
        },
      };
    }

    throw err;
  }
}

/**
 * リモートのUPDATE操作をローカルDBに適用する。
 *
 * LWW（Last-Write-Wins）方式で `updatedAt` を比較し、
 * リモートの方が新しい場合のみローカルを更新する。
 * ローカルにレコードが存在しない場合はINSERTする。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - リモート側のレコードデータ
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`updated` / `skipped` / `inserted`）と競合情報
 */
export function applyUpdate(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[]
): { action: 'updated' | 'skipped' | 'inserted'; conflict?: ConflictInfo } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);
  const pkValue = remoteRecord[primaryKey];

  const localRecord = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(pkValue) as Record<string, unknown> | undefined;

  if (!localRecord) {
    // ローカルに存在しない → INSERT（リモートでINSERT後UPDATEされた場合など）
    const escapedColumns = columns.map((c) => escapeIdentifier(c));
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((c) => remoteRecord[c]);

    localDb
      .prepare(
        `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`
      )
      .run(...values);
    return { action: 'inserted' };
  }

  // LWW比較
  const remoteUpdatedAt = String(remoteRecord['updatedAt'] ?? '');
  const localUpdatedAt = String(localRecord['updatedAt'] ?? '');

  if (remoteUpdatedAt > localUpdatedAt) {
    const updateColumns = columns.filter((c) => c !== primaryKey);
    const setClause = updateColumns
      .map((c) => `${escapeIdentifier(c)} = ?`)
      .join(', ');
    const values = [...updateColumns.map((c) => remoteRecord[c]), pkValue];

    localDb
      .prepare(
        `UPDATE ${escapedTable} SET ${setClause} WHERE ${escapedPk} = ?`
      )
      .run(...values);

    return {
      action: 'updated',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: 'remote_wins',
      },
    };
  }

  return {
    action: 'skipped',
    conflict:
      remoteUpdatedAt !== localUpdatedAt
        ? {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'local_wins',
          }
        : undefined,
  };
}

/**
 * リモートのDELETE操作をローカルDBに適用する。
 *
 * 指定された主キーのレコードをローカルDBから削除する。
 * レコードが存在しない場合はスキップする。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param recordId - 削除対象レコードの主キー値
 * @returns 実行されたアクション（`deleted` or `skipped`）
 */
export function applyDelete(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  recordId: string
): { action: 'deleted' | 'skipped' } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  const result = localDb
    .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .run(recordId);

  return { action: result.changes > 0 ? 'deleted' : 'skipped' };
}
