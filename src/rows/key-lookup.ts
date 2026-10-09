/**
 * 真の id（`CAST(<主キー> AS TEXT)`）で行を引く条件を作る。
 *
 * 突き合わせの**意味**は `CAST(<主キー> AS TEXT) = <キー>` である（真の id の正規形。
 * 設計書 §1.11）。ただし、これをそのまま書くと主キーの索引が使えず、1件引くたびに
 * 表を全部なめる。取り込みはキーの数だけ引くので、フルマージは「行数 × 行数」になり、
 * 9,000 行の表で 9〜20 秒、その間ずっと呼んだスレッドが止まっていた。アプリが
 * 行を1つ `DELETE` するたびに動くトリガーの文も、同じ形で表を全部なめていた。
 *
 * そこで、**主キーが TEXT 親和性の表に限り**、索引で候補を絞ってから同じ条件を課す:
 *
 * ```sql
 * WHERE (pk = <キー> OR pk >= X'') AND CAST(pk AS TEXT) = <キー>
 * ```
 *
 * 答えが `CAST(pk AS TEXT) = <キー>` だけの場合と**同じ集合**になる理由:
 *
 * - 余計な行は入らない —— 最後に元の条件をそのまま課している
 * - 落とす行も無い —— TEXT 親和性の列に入る値は TEXT・BLOB・NULL だけである
 *   （数値は入れたときに文字列へ変わる。STRICT 表の TEXT 列は TEXT と NULL だけ）。
 *   - TEXT の値 `v` は `CAST(v AS TEXT)` が `v` そのものなので、元の条件を満たすなら
 *     `pk = <キー>` も満たす。どちらの比較も、列の照合順序（`CAST` の外側でも列の
 *     照合順序が効く）と、列の親和性で行うからである
 *   - BLOB の値はすべて `pk >= X''` で拾う。SQLite の並びでは BLOB が TEXT より後ろに
 *     まとまるので、主キーの索引の末尾の範囲になる。ふつうの表には1つも無い
 *   - NULL はどちらにも一致しない
 *
 * BLOB を `CAST(<キー> AS BLOB)` との一致で拾う形（以前の形）は使わない。`CAST(BLOB AS TEXT)` は
 * バイト列を DB の文字コードで読むだけで、照合順序（NOCASE・RTRIM）も、UTF-16 の DB での
 * 奇数長のバイト列の切り捨ても反映されないので、元の条件と答えが変わる。
 *
 * 主キーが TEXT 親和性でない表（`setupSync` は断るが、内部の関数は受け取りうる）では、
 * 整数・実数・型名なしで上の等式が崩れる（実数は `CAST` で 15 桁に丸まる）ので、
 * 元の `CAST` だけの形を残す。
 *
 * @module rows/key-lookup
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, isSameIdentifier } from '../setup/sql'

/** {@link keyLookup} の結果。`sql` を `WHERE` の後ろに置き、`bind(key)` を束縛する。 */
export interface KeyLookup {
  sql: string
  bind: (key: string) => string[]
}

/**
 * 型名から SQLite の親和性が TEXT になるか（SQLite の「型名から親和性を決める規則」の 1・2 番目）。
 *
 * `INT` を含めば INTEGER が先に勝つ（例: `"CHARINT"` は INTEGER）。
 */
export function hasTextAffinity(declaredType: string): boolean {
  const type = declaredType.toUpperCase()
  if (type.includes('INT')) return false
  return type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')
}

/**
 * 列 `column` の真の id が `key` と一致する条件の SQL。
 *
 * @param column 主キーの列（`"id"`、`"r"."id"` など、引用済みの列の参照）
 * @param key 比べる値の式（`?`、`"h"."trueId"` など）。2回現れるので、`?` なら2回束縛する
 * @param textAffinity 主キーの列が TEXT 親和性か（{@link hasTextAffinity}）
 */
export function keyMatchSql(
  column: string,
  key: string,
  textAffinity: boolean
): string {
  const exact = `CAST(${column} AS TEXT) = ${key}`
  if (!textAffinity) return exact
  return `(${column} = ${key} OR ${column} >= X'') AND ${exact}`
}

/**
 * 列 `column` の真の id が、副問い合わせ `subquery` の返す値のどれかと一致する条件の SQL。
 *
 * {@link keyMatchSql} の `IN` 版。副問い合わせは2回現れる。
 */
export function keyInSql(
  column: string,
  subquery: string,
  textAffinity: boolean
): string {
  const exact = `CAST(${column} AS TEXT) IN (${subquery})`
  if (!textAffinity) return exact
  return `(${column} IN (${subquery}) OR ${column} >= X'') AND ${exact}`
}

/**
 * `db` の表 `table` を、列 `primaryKey` の真の id で引く条件を作る。
 *
 * 親和性は**その DB の表の宣言**で決める（相手の写しと手元で宣言が違っても、
 * それぞれの表で正しい形になる）。
 */
export function keyLookup(
  db: Database.Database,
  table: string,
  primaryKey: string
): KeyLookup {
  const columns = db
    .prepare(`SELECT name, type FROM pragma_table_xinfo(?)`)
    .all(table) as { name: string; type: string }[]
  const column = columns.find((candidate) =>
    isSameIdentifier(candidate.name, primaryKey)
  )
  const textAffinity = column !== undefined && hasTextAffinity(column.type)
  return {
    sql: keyMatchSql(escapeIdentifier(primaryKey), '?', textAffinity),
    bind: textAffinity ? (key) => [key, key] : (key) => [key],
  }
}
