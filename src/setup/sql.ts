/**
 * セットアップ側で使う SQL の小道具と、**時刻の書式の決め事**。
 *
 * `NOW_SQL` をここに置いているのは、これが単なるヘルパではなく
 * **「このライブラリが刻む時刻の書式」そのもの**だからである。トリガーも、
 * 削除の記録（`_tombstone.deletedAt`）も、`_changelog.changedAt` も、
 * すべてこの1つの式から時刻を得る。
 *
 * @module setup/sql
 * @internal
 */

/**
 * SQLiteの識別子は大文字小文字を区別しないため、名前を畳んで比較する。
 *
 * `PRAGMA` は宣言どおりの綴りを返し、設定は利用者が書いた綴りを持つ。
 * **字面で突き合わせると、綴りが違うだけで判断が丸ごと素通りする。**
 *
 * 畳むのは **ASCII の A–Z だけ**。SQLite の既定の照合順序（`BINARY` / `NOCASE`）が
 * そうだからで、`toLowerCase()` を使うと全 Unicode を畳んでしまい、SQLite にとっては
 * **別の識別子**である組（ケルビン記号 `K` U+212A と `k` など）を同じものと答える。
 * ここでの答えは「SQLiteがこの2つを同じ列とみなすか」でなければならない。
 *
 * 識別子の比較は**1か所だけ**に置く。同じ規則の実装が2つあると、片方だけ直したときに
 * もう片方が古い意味のまま残る（この規則を1か所へ集めるための変更で、実装を2つに
 * 増やしてしまったことがある）。
 * @internal
 */
export function isSameIdentifier(a: string, b: string): boolean {
  return foldIdentifier(a) === foldIdentifier(b)
}

/**
 * 識別子を、比較や**マップのキー**に使える形へ畳む。
 *
 * 畳む範囲は {@link isSameIdentifier} と同じ ASCII の A–Z だけ。
 * キーの作り方と比較の仕方が食い違うと、「マップでは同じ、比較では別」という
 * ねじれが生まれるので、**どちらもここを通す**。
 * @internal
 */
export function foldIdentifier(value: string): string {
  return value.replace(/[A-Z]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 32)
  )
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
export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
export function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}
