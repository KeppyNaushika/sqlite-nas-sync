/**
 * セットアップ側で使う SQL の小道具と、**時刻の書式の決め事**。
 *
 * `NOW_SQL` をここに置いているのは、これが単なるヘルパではなく
 * **「このライブラリが刻む時刻の書式」そのもの**だからである。トリガーも、
 * 畳みの帳簿も、削除の記録も、すべてこの1つの式から時刻を得る。
 *
 * @module setup/sql
 * @internal
 */
import Database from 'better-sqlite3';

/** @internal SQLiteの `PRAGMA table_info` が返すカラム情報 */
export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * 「今」をユーザーレコードの `updatedAt` と同じ精度・同じ書式で得るSQL式。
 *
 * `datetime('now')` は**秒に切り捨てた**スペース形式（`2026-05-02 02:19:56`）を返す。
 * これを削除や畳みの時刻に使うと、同じ秒の中で起きた更新との前後が失われる:
 * 12:00:00.800 の削除が `12:00:00`（= .000）として記録されるので、その前に起きた
 * 12:00:00.400 の更新の方が新しいと判定され、**消したはずの行が復活する**。
 * アプリが書く `updatedAt` はふつうミリ秒まで持つ（`toISOString()` 等）ので、
 * こちらだけ粗いと比較が成り立たない。
 *
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now')` はミリ秒までのISO-T形式
 * （`2026-05-02T02:19:56.111Z`）を返し、`updatedAt` とそのまま比べられる。
 *
 * 古いDBに残る秒精度・スペース形式の値と混在しても、比較はすべて
 * `julianday()` で正規化しているので前後は正しく決まる。
 * @internal
 */
export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/**
 * 秒精度の `datetime('now')` で作られた古いトリガを落とす（冪等）。
 *
 * トリガは `CREATE TRIGGER IF NOT EXISTS` で作るため、**既に在るDBでは中身が
 * 古いまま残る**。時刻の精度を上げても、旧版で作られたトリガが動いているかぎり
 * `_changelog.changedAt` と `_tombstone.deletedAt` は秒のままになる。
 * 定義そのものを見て、古い書き方をしているものだけ作り直す
 * （新しい定義で作られていれば何もしないので、毎回の起動でスキーマは動かない）。
 *
 * @internal
 */
export function dropStaleTrigger(db: Database.Database, name: string): void {
  const stale = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = ? AND sql LIKE '%datetime(''now'')%'`
    )
    .get(name);
  if (stale) db.exec(`DROP TRIGGER ${escapeIdentifier(name)}`);
}

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
export function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
