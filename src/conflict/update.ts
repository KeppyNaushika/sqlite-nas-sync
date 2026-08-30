/**
 * リモートの UPDATE / DELETE をローカルDBへ適用する。
 *
 * UPDATE は LWW で時刻を比べ、リモートの方が新しいときだけ書く。ローカルに行が
 * 無ければ {@link applyInsert} へ委ねる（作成の衝突と同じ解決が要るため）。
 *
 * @module conflict/update
 */
import Database from 'better-sqlite3';
import { ConflictInfo, RecordFold } from '../types';
import { escapeIdentifier } from './schema';
import {
  isLaterTimestamp,
  isSameTimestamp,
  TimestampColumnFor,
} from './timestamp';
import { describeStalemate } from './stalemate';
import { ResurrectionProbe } from './tombstone';
import { remapMergedForeignKeys } from './remap';
import { overwriteExistingRow } from './overwrite';
import { applyInsert } from './insert';

/**
 * {@link applyUpdate} の返り値。
 */
export interface ApplyUpdateResult {
  action: 'updated' | 'skipped' | 'inserted';
  conflict?: ConflictInfo;
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[];
  /** 利用者へ伝えるべきこと（{@link ApplyInsertResult.warnings} と同じ） */
  warnings: string[];
}

/**
 * リモートのUPDATE操作をローカルDBに適用する。
 *
 * LWW（Last-Write-Wins）方式で `updatedAt` を比較し、
 * リモートの方が新しい場合のみローカルを更新する。
 * ローカルにレコードが存在しない場合はINSERTする。
 *
 * 書き込み自体は内部の共通経路（`overwriteExistingRow`）に任せる（{@link applyInsert} が
 * 同一PKの行に当たったときと**同じ状況・同じ壊れ方**なので、同じ場所に置く）。
 * 書き込みがローカルの**別の行**のセカンダリUNIQUEに当たれば、そこでLWWで1行へ畳まれる。
 * 作成の衝突と違い**更新対象の行はローカルに既に在る**ため、どちらが負けても実際に
 * 行が1つ消える — 届いた更新が負けた場合は `skipped` を返すが、`folds` には
 * 「更新対象の行が畳まれて消えた」ことが載る（`action` だけ見ると実態に合わない）。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - リモート側のレコードデータ
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`updated` / `skipped` / `inserted`）と競合情報、
 *   畳んだ記録（{@link RecordFold}）、および利用者へ伝える文言（`warnings`）
 */
export function applyUpdate(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt',
  isResurrected?: ResurrectionProbe,
  timestampColumnFor?: TimestampColumnFor
): ApplyUpdateResult {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す。
  // 向け直した先が消えていれば、その外部キーの `ON DELETE` に従う。
  //
  // **この判定は `applyInsert` へ委譲する経路とは別に、ここにも要る。** 委譲するのは
  // 「ローカルに行が無いとき」だけなので、行が在るときの上書きは素通りしてしまう。
  const remap = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord,
    timestampColumn,
    isResurrected,
    timestampColumnFor
  );
  const warnings = remap.warnings;
  if (remap.record === null) {
    return { action: 'skipped', folds: [], warnings };
  }

  const record = remap.record;
  const pkValue = record[primaryKey];

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
      record,
      columns,
      timestampColumn,
      isResurrected,
      timestampColumnFor
    );
    if (insertResult.action === 'inserted') {
      return {
        action: 'inserted',
        folds: insertResult.folds,
        warnings: [...warnings, ...insertResult.warnings],
      };
    }
    return {
      action:
        insertResult.conflict?.resolution === 'remote_wins'
          ? 'updated'
          : 'skipped',
      conflict: insertResult.conflict,
      folds: insertResult.folds,
      warnings: [...warnings, ...insertResult.warnings],
    };
  }

  // LWW比較
  const remoteUpdatedAt = String(record[timestampColumn] ?? '');
  const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

  if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
    const outcome = overwriteExistingRow(
      localDb,
      tableName,
      primaryKey,
      record,
      localRecord,
      columns,
      timestampColumn
    );
    return {
      // 届いた更新を採らなかった場合でも、更新対象の行は畳まれて消えている
      // （呼び出し元は `folds` の側でそれを数える）。
      action: outcome.resolution === 'remote_wins' ? 'updated' : 'skipped',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: outcome.resolution,
      },
      folds: outcome.folds,
      warnings,
    };
  }

  // 同じ時刻で中身が違うなら、どちらも勝てない。解けないので**報告する**
  // （同時刻かどうかは字面ではなく時刻として見る）
  if (isSameTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
    const stalemate = describeStalemate(
      tableName,
      String(pkValue),
      localUpdatedAt,
      record,
      localRecord,
      columns,
      timestampColumn
    );
    if (stalemate !== null) warnings.push(stalemate);
  }

  return {
    action: 'skipped',
    conflict: !isSameTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)
        ? {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'local_wins',
          }
        : undefined,
    folds: [],
    warnings,
  };
}

/**
 * リモートのDELETE操作をローカルDBに適用する。
 *
 * 指定された主キーのレコードをローカルDBから削除する。
 * レコードが存在しない場合はスキップする。
 *
 * **畳まれて消えた行のidは読み替えない。** 敗者行の削除が勝者行の削除に化けてしまう。
 * 敗者idの削除はローカルでは対象が無く、そのままスキップされるのが正しい。
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
