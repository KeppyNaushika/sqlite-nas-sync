/**
 * 同期モジュールの中でだけ使う、SQLiteの小さな道具。
 *
 * 競合解決側（`conflict/schema`）にも同じ形の関数があるが、あちらは
 * `PRAGMA schema_version` を鍵にした**キャッシュ付き**で、畳みの最中に何度も引かれる
 * ことを前提にしている。こちらは表ごとに一度読めば足りる場面でしか使わないので、
 * キャッシュを持たない素の問い合わせにしてある（同期は**取り込み元のDBを開き直す**ため、
 * 接続に紐づくキャッシュが効きにくい）。
 *
 * @module sync/sql
 * @internal
 */
import Database from 'better-sqlite3'

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
export function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/** @internal SQLiteの `PRAGMA table_info` が返すカラム情報 */
export interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

/**
 * テーブルのカラム名一覧を取得する。
 * @internal
 */
export function getTableColumns(
  db: Database.Database,
  tableName: string
): string[] {
  const columns = db
    .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
    .all() as ColumnInfo[]
  return columns.map((c) => c.name)
}
