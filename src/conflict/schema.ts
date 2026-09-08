/**
 * スキーマの読み取り（`PRAGMA` 系）と、その結果のキャッシュ。
 *
 * 外部キー・カラム定義・既定値など、**DBのスキーマが答えること**だけをここに置く。
 * 競合解決の判断（誰が勝つか）は持たない。
 *
 * @module conflict/schema
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

/**
 * 外部キー1本ぶんの参照関係。
 *
 * SQLiteの `PRAGMA foreign_key_list` が返す行を、複合外部キー（同一 `id` の複数行）
 * ごとにまとめた形。
 * @internal
 */
export interface ForeignKeyRef {
  /** 外部キーを宣言している側（子）のテーブル名 */
  childTable: string
  /** 参照されている側（親）のテーブル名 */
  parentTable: string
  /** 子の列と、それが指す親の列の対応 */
  columns: { childColumn: string; parentColumn: string }[]
  /**
   * 親の行が消えたときに子へ及ぶ動作。
   * `NO ACTION` / `RESTRICT` / `CASCADE` / `SET NULL` / `SET DEFAULT`。
   *
   * **`PRAGMA defer_foreign_keys` はこの動作を遅らせない**（遅れるのは検査だけ）。
   * 畳みで敗者行を消す前に、これを見て子を守る必要がある（{@link carryChildrenThroughDelete}）。
   */
  onDelete: string
}

/** @internal SQLiteの `PRAGMA foreign_key_list` が返す行 */
export interface ForeignKeyListRow {
  id: number
  seq: number
  table: string
  from: string
  /** 親の列。`REFERENCES parent` のように省略された場合は null（＝親の主キー） */
  to: string | null
  /** 親の行が消えたときの動作（`NO ACTION` / `CASCADE` / `SET NULL` 等） */
  on_delete: string
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
 * SQLiteの識別子は大文字小文字を区別しないため、名前を畳んで比較する。
 *
 * `PRAGMA` は宣言どおりの綴りを返し、設定は利用者が書いた綴りを持つ。
 * **字面で突き合わせると、綴りが違うだけで判断が丸ごと素通りする。**
 *
 * 畳むのは **ASCII の A–Z だけ**。SQLite の既定の照合順序（`BINARY` / `NOCASE`）が
 * そうだからで、`toLowerCase()` を使うと全 Unicode を畳んでしまい、SQLite にとっては
 * **別の識別子**である組（ケルビン記号 `K` U+212A と `k` など）を同じものと答える。
 * ここでの答えは「SQLiteがこの2つを同じ列とみなすか」でなければならない。
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

/**
 * レコード（`SELECT *` の1行）から、**設定に書かれた綴り**で列の値を取り出す。
 *
 * SQLの側は識別子の大小を区別しないので `WHERE` もトリガも綴り違いで動くが、
 * `SELECT *` が返すオブジェクトの**キーは表が宣言したとおりの綴り**である。
 * 設定の `primaryKey` / `timestampColumn` をそのままキーにすると、綴りが違うだけで
 * `undefined` になり、しかも**例外にならない**:
 *
 * - 時刻列を取り逃がすと両辺が空文字になり、LWWの比較が常に偽 ——
 *   **届いた更新が全部黙って捨てられ、カーソルだけ進む**
 * - 主キーを取り逃がすと `.get(undefined)` が例外になり、その相手ぶんの取り込みが
 *   丸ごと巻き戻る
 *
 * 綴りが合っていれば直接引く（ほぼ全ての呼び出しがこちら）。合わないときだけ
 * キーを走査して畳んで探す。
 * @internal
 */
export function readColumn(
  record: Record<string, unknown>,
  columnName: string
): unknown {
  if (columnName in record) return record[columnName]
  const key = Object.keys(record).find((candidate) =>
    isSameIdentifier(candidate, columnName)
  )
  return key === undefined ? undefined : record[key]
}

/**
 * DB接続ごとに「スキーマから導かれる情報」を覚えておく（`PRAGMA` の往復を減らす）。
 *
 * 畳みが一度でも起きたDBでは {@link remapMergedForeignKeys} が毎回の
 * {@link applyInsert}/{@link applyUpdate} から外部キーを走査し、
 * {@link findReferencingForeignKeys} に至っては畳み1回ごとにDB内の全テーブルへ
 * `PRAGMA` を投げる。同期の最中にスキーマは変わらないので使い回せる。
 *
 * 世代の判定には `PRAGMA schema_version`（SQLiteがスキーマ変更のたびに進める値）を使う。
 * 利用者側のマイグレーションでもフルマージ中のトリガー付け外しでも進むため、
 * 古い形のまま答え続けることはない。
 * @internal
 */
const schemaCache = new WeakMap<
  Database.Database,
  { schemaVersion: number; entries: Map<string, unknown> }
>()

/**
 * スキーマが変わっていない間だけ結果を使い回す。
 * @internal
 */
export function cachedBySchema<T>(
  db: Database.Database,
  key: string,
  compute: () => T
): T {
  const schemaVersion = db.pragma('schema_version', {
    simple: true,
  }) as number

  let cache = schemaCache.get(db)
  if (!cache || cache.schemaVersion !== schemaVersion) {
    cache = { schemaVersion, entries: new Map<string, unknown>() }
    schemaCache.set(db, cache)
  }

  if (cache.entries.has(key)) return cache.entries.get(key) as T
  const value = compute()
  cache.entries.set(key, value)
  return value
}

/**
 * テーブルが存在するか。
 *
 * 同期用の内部テーブル（`_changelog` / `_tombstone` など）は、利用者のDBが
 * `setupChangelog` を通していない場合や、旧バージョン由来の場合に無い。触る前に確かめる。
 * @internal
 */
export function hasTable(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(tableName) !== undefined
  )
}

/**
 * 指定テーブルが宣言している外部キー（＝このテーブルから他テーブルへの参照）を返す。
 * @internal
 */
export function readForeignKeys(
  db: Database.Database,
  childTable: string,
  primaryKey: string
): ForeignKeyRef[] {
  return cachedBySchema(
    db,
    `fk:${foldIdentifier(childTable)}:${primaryKey}`,
    () => {
      const rows = db
        .prepare(`PRAGMA foreign_key_list(${escapeIdentifier(childTable)})`)
        .all() as ForeignKeyListRow[]

      const byId = new Map<number, ForeignKeyRef>()
      for (const row of rows) {
        const existing = byId.get(row.id)
        const column = {
          childColumn: row.from,
          // `to` が null のときは親の主キーを指す
          parentColumn: row.to ?? primaryKey,
        }
        if (existing) {
          existing.columns.push(column)
        } else {
          byId.set(row.id, {
            childTable,
            parentTable: row.table,
            columns: [column],
            onDelete: row.on_delete.toUpperCase(),
          })
        }
      }
      return Array.from(byId.values())
    }
  )
}

/**
 * 指定テーブルを指している外部キー（＝他テーブルからこのテーブルへの参照）を返す。
 *
 * `PRAGMA foreign_key_list` は「このテーブルが何を指しているか」しか答えないため、
 * DB内の全テーブルを走査して逆向きに集める。スキーマの事前知識は要らない。
 * @internal
 */
export function findReferencingForeignKeys(
  db: Database.Database,
  parentTable: string,
  primaryKey: string
): ForeignKeyRef[] {
  return cachedBySchema(
    db,
    `refs:${foldIdentifier(parentTable)}:${primaryKey}`,
    () => {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]

      const refs: ForeignKeyRef[] = []
      for (const { name } of tables) {
        for (const foreignKey of readForeignKeys(db, name, primaryKey)) {
          if (isSameIdentifier(foreignKey.parentTable, parentTable)) {
            refs.push(foreignKey)
          }
        }
      }
      return refs
    }
  )
}

/**
 * テーブルのカラム定義（`PRAGMA table_info`）を返す。
 * @internal
 */
export function readColumnInfo(
  db: Database.Database,
  tableName: string
): ColumnInfo[] {
  return cachedBySchema(db, `colinfo:${foldIdentifier(tableName)}`, () => {
    return db
      .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
      .all() as ColumnInfo[]
  })
}

/**
 * テーブルのカラム名一覧を返す。
 * @internal
 */
export function getTableColumns(
  db: Database.Database,
  tableName: string
): string[] {
  return cachedBySchema(db, `cols:${foldIdentifier(tableName)}`, () =>
    readColumnInfo(db, tableName).map((column) => column.name)
  )
}

/**
 * 指定した列がすべて NULL を取れるか。
 *
 * `NOT NULL` 宣言だけを見る。`CHECK (column IS NOT NULL)` のように別の書き方で
 * NULL を禁じている表は見分けられないため、実際に NULL を入れる側（
 * {@link carryChildrenThroughDelete}）が失敗を拾えるようにしてある。
 * @internal
 */
export function areColumnsNullable(
  db: Database.Database,
  tableName: string,
  columnNames: string[]
): boolean {
  const columnInfo = readColumnInfo(db, tableName)
  return columnNames.every((columnName) => {
    const column = columnInfo.find((candidate) =>
      isSameIdentifier(candidate.name, columnName)
    )
    return column !== undefined && column.notnull === 0
  })
}

/**
 * 指定した列に、その表の**主キーの一部**が含まれるか。
 *
 * `PRAGMA table_info` の `notnull` では見分けられない。SQLite は
 * `id TEXT PRIMARY KEY` に対して `notnull: 0` を返し、**実際に `id = NULL` の行を
 * 受け入れる**（実測）。判定材料は `pk`（主キーなら 1、複合主キーなら 1,2,… ）。
 *
 * 主キーを書き換えることは、このライブラリにはできない。行の同定が主キーに全面的に
 * 依存しているためで、実測では次のように壊れた:
 *
 * - `NULL` にすると `_changelog.recordId` の NOT NULL に触れて例外になり、
 *   **その相手ぶんの取り込みが丸ごと巻き戻る**（同期がその相手から永久に止まる）
 * - 既定値にすると**その行が別のidの行に化ける**（同じidの別の行を上書きしうる）
 * @internal
 */
export function includesPrimaryKeyColumn(
  db: Database.Database,
  tableName: string,
  columnNames: string[]
): boolean {
  const columnInfo = readColumnInfo(db, tableName)
  return columnNames.some((columnName) =>
    columnInfo.some(
      (column) => isSameIdentifier(column.name, columnName) && column.pk > 0
    )
  )
}

/**
 * 指定した列の既定値を、**SQLite に評価させて**取り出す。
 *
 * `PRAGMA table_info` の `dflt_value` は**SQLの字面**であって値ではない
 * （`DEFAULT 'p-default'` はクォート込みの `'p-default'`、`DEFAULT (lower('ABC'))` は
 * `lower('ABC')` という式が返る。実測）。そのまま列へ入れるとクォートごと書き込む。
 * スキーマが宣言した式をそのまま `SELECT` して、SQLite自身に評価させる。
 *
 * 既定値の宣言が無い列は `NULL`（SQLite の `ON DELETE SET DEFAULT` もそうする。実測）。
 *
 * @returns 列と同じ並びの値。式が評価できないときは null（＝再現できない）
 * @internal
 */
export function evaluateColumnDefaults(
  db: Database.Database,
  tableName: string,
  columnNames: string[]
): unknown[] | null {
  const columnInfo = readColumnInfo(db, tableName)
  const expressions = columnNames.map((columnName) => {
    const column = columnInfo.find((candidate) =>
      isSameIdentifier(candidate.name, columnName)
    )
    const declared = column?.dflt_value
    return declared === null || declared === undefined
      ? 'NULL'
      : String(declared)
  })

  try {
    const row = db
      .prepare(
        `SELECT ${expressions
          .map((expression, index) => `(${expression}) AS d${index}`)
          .join(', ')}`
      )
      .get() as Record<string, unknown>
    return columnNames.map((_, index) => row[`d${index}`])
  } catch {
    // 壊れた式・利用者定義関数など、こちらでは評価できない形。
    // 憶測で値を入れず「再現できない」と答える
    return null
  }
}

/**
 * この接続で外部キーが実際に効いているか（`PRAGMA foreign_keys`）。
 *
 * 切られていれば `ON DELETE` の動作も起きないので、子を守る細工は要らない。
 * スキーマではなく接続ごとの設定なので {@link cachedBySchema} には載せない。
 * @internal
 */
export function foreignKeysEnforced(db: Database.Database): boolean {
  return db.pragma('foreign_keys', { simple: true }) === 1
}

/**
 * その表で1行を指すための列。宣言された主キー、無ければ `rowid`。
 *
 * 同期の主キー（`id`）とは別に引くのは、外部キーの子が同期対象テーブルとは
 * 限らないため（複合主キーの中間テーブルなど）。
 * @internal
 */
export function rowKeyColumns(
  db: Database.Database,
  tableName: string
): string[] {
  return cachedBySchema(db, `rowkey:${foldIdentifier(tableName)}`, () => {
    const keyColumns = readColumnInfo(db, tableName)
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name)
    return keyColumns.length > 0 ? keyColumns : ['rowid']
  })
}
