/**
 * `_changelog` テーブルの読み取り・掃除・ギャップ検出を提供するモジュール。
 *
 * @module changelog
 */
import Database from 'better-sqlite3';
import { ChangelogEntry } from './types';

/**
 * 指定IDより後のchangelogエントリを取得する。
 *
 * @param db - 読み取り対象のSQLiteデータベース接続
 * @param sinceId - この値より大きいIDのエントリを返す。0を指定すると全件。
 * @returns changelogエントリの配列（ID昇順）
 */
export function readChangelog(
  db: Database.Database,
  sinceId: number
): ChangelogEntry[] {
  return db
    .prepare(`SELECT id, tableName, recordId, operation, changedAt FROM _changelog WHERE id > ? ORDER BY id`)
    .all(sinceId) as ChangelogEntry[];
}

/**
 * `_changelog` テーブルの最大IDを取得する。
 *
 * changelogが空の場合は `0` を返す。
 *
 * @param db - 読み取り対象のSQLiteデータベース接続
 * @returns 最大のchangelog ID。空の場合は `0`
 */
export function getMaxChangelogId(db: Database.Database): number {
  const row = db
    .prepare(`SELECT MAX(id) as maxId FROM _changelog`)
    .get() as { maxId: number | null };
  return row.maxId ?? 0;
}

/**
 * changelogにギャップ（欠落）があるかを判定する。
 *
 * 定期的な掃除（{@link cleanupChangelog}）により古いエントリが削除されると、
 * `lastSeenId` が指す位置より前のエントリが存在しなくなる。
 * この場合、changelog差分ベースの同期ができないため、
 * フルテーブルスキャンへのフォールバックが必要になる。
 *
 * @param db - チェック対象のSQLiteデータベース接続
 * @param lastSeenId - 前回同期時に記録した最後のchangelog ID
 * @returns ギャップがある場合は `true`
 *
 * @remarks
 * - `lastSeenId === 0`（初回同期）の場合は常に `false`
 * - `_changelog` が空で `lastSeenId > 0` の場合は `true`（全掃除済み）
 */
export function hasChangelogGap(
  db: Database.Database,
  lastSeenId: number
): boolean {
  if (lastSeenId === 0) {
    return false;
  }

  const row = db
    .prepare(`SELECT MIN(id) as minId FROM _changelog`)
    .get() as { minId: number | null };

  // _changelogが空の場合もギャップ（掃除で全エントリ削除済み）
  if (row.minId === null) {
    return true;
  }

  return row.minId > lastSeenId;
}

/**
 * 保持期間を過ぎた古いchangelogエントリを削除する。
 *
 * `changedAt` が現在時刻から `retentionDays` 日以上前のエントリを削除する。
 *
 * @param db - 操作対象のSQLiteデータベース接続
 * @param retentionDays - エントリを保持する日数
 * @returns 削除されたエントリ数
 */
export function cleanupChangelog(
  db: Database.Database,
  retentionDays: number
): number {
  const result = db
    .prepare(`DELETE FROM _changelog WHERE changedAt < datetime('now', '-' || ? || ' days')`)
    .run(retentionDays);
  return result.changes;
}
