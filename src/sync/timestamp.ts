/**
 * 時刻の比較。
 *
 * LWW（Last-Write-Wins）の物差しをここへ集める。書式の違う時刻をどう比べるか、
 * という問いに答えるのはこのファイルだけである（`julianday()` による正規化が
 * 2か所に分かれると、片方だけ直したときにもう片方が古い意味のまま残る）。
 *
 * @module sync/timestamp
 * @internal
 */
import Database from 'better-sqlite3'

/**
 * 2つのタイムスタンプを時刻として比べ、**比べられたかどうかも返す**。
 *
 * 比べる値は書き手によって書式が違う。`updatedAt` はアプリが書くISO-T形式
 * （例: `2026-05-13T23:17:35.111+00:00`）。`_tombstone.deletedAt` /
 * `_changelog.changedAt` は 0.19.0 以降 {@link NOW_SQL} による同じ精度のISO-T形式だが、
 * **それ以前に書かれた行は `datetime('now')` による秒精度のスペース形式**
 * （例: `2026-05-02 02:19:56`）で残っており、両者は混在する。
 * 書式が違うと文字列としては比較できない
 * （同日でも ' '(0x20) < 'T'(0x54) となり古い書式の側が常に小さく扱われる）。
 * SQLiteの `julianday()` で正規化して数値比較する。
 *
 * 解析できないときは `null` —— つまり「時刻としては比べられない」。**字面の順序へ
 * 落とさずに呼び出し元へ返す**のは、読めない値どうしの字面順には意味が無く、
 * 決着の付け方は場面ごとに違うからである（{@link deduplicateEntries} は
 * 時刻で決まらないぶんを id で決めたい）。
 *
 * @returns `a` が後なら正、`b` が後なら負、同時刻なら 0、比べられなければ `null`
 * @internal
 */
export function compareTimestamps(
  db: Database.Database,
  a: string,
  b: string
): number | null {
  const row = db
    .prepare(`SELECT julianday(?) AS ja, julianday(?) AS jb`)
    .get(a, b) as { ja: number | null; jb: number | null }
  if (row.ja == null || row.jb == null) return null
  if (row.ja === row.jb) return 0
  return row.ja > row.jb ? 1 : -1
}
