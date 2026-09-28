/**
 * 表の名前を、**`sqlite_master` の綴り**へ正規化する。
 *
 * 案A では表の名前が版の鍵の一部である。`_tombstone.tableName`・
 * `_changelog.tableName`・`_sns_tick.tableName`・`_sns_dirty.tableName`・
 * `_sns_shown.tableName`、そしてトリガーの本体に埋め込まれる字面が、
 * **全端末で同じ綴りでなければならない**。利用者が `setupSync` に渡す綴りは
 * 端末ごとに違いうる（SQLite の表名は大小を区別しないので、`Notes` でも
 * `notes` でも同じ表が引ける）ので、**受け取った綴りをそのまま持ち回ると、
 * 綴りの違う2端末で版の鍵が割れる** —— 同じ行の削除の版が
 * `('Notes', 'k1')` と `('notes', 'k1')` の2つに分かれ、互いに効かない。
 *
 * そこで、**入り口で1回だけ `sqlite_master` に尋ねて畳む**。
 * 畳んだあとは、帳簿を引くときに `COLLATE NOCASE` を足す必要がない。
 *
 * @module rows/table-name
 * @internal
 */
import Database from 'better-sqlite3'
import { RowsTableSpec } from './schema'

/**
 * `sqlite_master` に載っている綴りを返す。表が無ければ渡された綴りのまま。
 *
 * 引くのは `name = ? COLLATE NOCASE` —— **ここだけは綴り違いに備える**。
 * ここで畳むからこそ、以後の帳簿は字面で引ける。
 */
function canonicalTableName(db: Database.Database, table: string): string {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = ? COLLATE NOCASE`
    )
    .get(table) as { name: string } | undefined
  return row === undefined ? table : row.name
}

/** 表の指定を丸ごと正規化する（名前だけ差し替える）。 */
export function canonicalTableSpecs(
  db: Database.Database,
  tables: readonly (RowsTableSpec | string)[]
): RowsTableSpec[] {
  return tables.map((table) => {
    const spec = typeof table === 'string' ? { name: table } : table
    return { ...spec, name: canonicalTableName(db, spec.name) }
  })
}
