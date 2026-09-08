/**
 * `_tombstone` の後付けの列を、既存のDBにも足す。
 *
 * `CREATE TABLE IF NOT EXISTS` では**既にあるDBに列は増えない**。バージョンを
 * 上げただけの利用者のDBにも同じ形を用意するために、明示的に足す必要がある。
 *
 * @module setup/tombstone
 * @internal
 */
import Database from 'better-sqlite3';
import { ColumnInfo, isSameIdentifier } from './sql';

/**
 * `_tombstone` に `mergedInto` 列が無ければ追加する（冪等）。
 *
 * `CREATE TABLE IF NOT EXISTS` は既存テーブルには列を足さないため、
 * v0.14.0以前に作られたDBはこの経路で移行する。
 * `_tombstone` そのものが無いDB（{@link setupChangelog} を通していない場合）では何もしない。
 *
 * @internal
 */
export function ensureTombstoneMergedIntoColumn(db: Database.Database): void {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get();
  if (!exists) return;

  const columns = db
    .prepare(`PRAGMA table_info(_tombstone)`)
    .all() as ColumnInfo[];
  if (columns.some((column) => isSameIdentifier(column.name, 'mergedInto'))) return;

  db.exec(`ALTER TABLE _tombstone ADD COLUMN mergedInto TEXT`);
}
