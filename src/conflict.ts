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
 * UNIQUE制約エラーのメッセージから違反したカラム名を抽出する。
 *
 * better-sqlite3のエラーメッセージ形式:
 * `UNIQUE constraint failed: Table.colA, Table.colB`
 *
 * @returns 違反したカラム名の配列。解析できない場合は空配列。
 * @internal
 */
function parseUniqueConflictColumns(
  err: unknown,
  tableName: string
): string[] {
  const message = err instanceof Error ? err.message : String(err);
  const match = /UNIQUE constraint failed: (.+)$/.exec(message);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${tableName}.`))
    .map((part) => part.slice(tableName.length + 1));
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
  columns: string[],
  timestampColumn: string = 'updatedAt'
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
      const escapedPk = escapeIdentifier(primaryKey);
      const pkValue = record[primaryKey];
      const remoteUpdatedAt = String(record[timestampColumn] ?? '');

      // ケース1: 同一PKの行が存在する（PK重複）→ LWWでUPDATE
      const localRecord = localDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(pkValue) as Record<string, unknown> | undefined;

      if (localRecord) {
        const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

        if (remoteUpdatedAt > localUpdatedAt) {
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

      // ケース2: 別PK・同一ユニークキーの行が存在する（セカンダリUNIQUE違反）。
      // 各クライアントが独立に同じ論理エンティティの行を作成した場合に発生する。
      // 違反したカラムからローカルの競合行を特定し、LWWで一方に収束させる。
      const uniqueColumns = parseUniqueConflictColumns(err, tableName);
      const conflictRow =
        uniqueColumns.length > 0
          ? (localDb
              .prepare(
                `SELECT * FROM ${escapedTable} WHERE ${uniqueColumns
                  .map((c) => `${escapeIdentifier(c)} = ?`)
                  .join(' AND ')}`
              )
              .get(...uniqueColumns.map((c) => record[c])) as
              | Record<string, unknown>
              | undefined)
          : undefined;

      if (!conflictRow) {
        // 競合行を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
        throw err;
      }

      const localUpdatedAt = String(conflictRow[timestampColumn] ?? '');

      if (remoteUpdatedAt > localUpdatedAt) {
        // リモートが新しい → ローカルの競合行を削除してリモート行を挿入。
        // DELETEトリガーが発火するため、敗者行の削除はchangelog/tombstone経由で
        // 他クライアントにも伝播し、全体が勝者行に収束する。
        const escapedColumns = columns.map((c) => escapeIdentifier(c));
        const insertPlaceholders = columns.map(() => '?').join(', ');

        localDb
          .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
          .run(conflictRow[primaryKey]);
        localDb
          .prepare(
            `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${insertPlaceholders})`
          )
          .run(...values);

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

      // ローカルが新しい → リモート行は採用しない
      return {
        action: 'upserted',
        conflict: {
          table: tableName,
          recordId: String(conflictRow[primaryKey]),
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
  columns: string[],
  timestampColumn: string = 'updatedAt'
): { action: 'updated' | 'skipped' | 'inserted'; conflict?: ConflictInfo } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);
  const pkValue = remoteRecord[primaryKey];

  const localRecord = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(pkValue) as Record<string, unknown> | undefined;

  if (!localRecord) {
    // ローカルに存在しない → INSERT（リモートでINSERT後UPDATEされた場合など）。
    // セカンダリUNIQUE違反（別PK・同一ユニークキー）の可能性があるため、
    // 競合解決込みのapplyInsertを経由する。
    const insertResult = applyInsert(
      localDb,
      tableName,
      primaryKey,
      remoteRecord,
      columns,
      timestampColumn
    );
    if (insertResult.action === 'inserted') {
      return { action: 'inserted' };
    }
    return {
      action:
        insertResult.conflict?.resolution === 'remote_wins'
          ? 'updated'
          : 'skipped',
      conflict: insertResult.conflict,
    };
  }

  // LWW比較
  const remoteUpdatedAt = String(remoteRecord[timestampColumn] ?? '');
  const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

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
