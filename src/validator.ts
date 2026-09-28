/**
 * DBスキーマのバリデーションおよび同期対象テーブルの自動検出機能。
 *
 * - {@link validateDatabase}: 与えられたテーブル群が必要な構造（設定の主キー列が宣言された主キーでTEXT型、updatedAtカラム）を満たすか検証
 * - {@link discoverTables}: SQLiteの `sqlite_master` から同期可能なテーブルを自動検出
 *
 * @module validator
 */
import Database from 'better-sqlite3'
import { DiscoverOptions, TableConfig, TableOptions, DEFAULTS } from './types'
import {
  ColumnInfo,
  escapeIdentifier,
  foldIdentifier,
  isSameIdentifier,
} from './setup/sql'

/**
 * バリデーションエラーの詳細。
 *
 * テーブルごとに発生したエラーを表す。
 */
interface ValidationError {
  /** エラーが発生したテーブル名 */
  table: string
  /** エラーの詳細メッセージ */
  message: string
}

/**
 * データベースのスキーマをバリデーションする。
 *
 * 各テーブルに対して以下をチェックする:
 * 1. 指定された主キーカラムが存在し、TEXT型であるか
 * 2. 表が主キーを1列だけ宣言しているなら、それが指定された主キーカラムであるか
 * 3. `updatedAt` カラムが存在するか
 *
 * 2 が要るのは、同期が使う主キーは表で宣言された主キーであって、設定の名前ではないからである。
 * 一致を確かめないと、`id TEXT` と `uuid TEXT PRIMARY KEY` を持つ表が、設定では `id` を指しているのに `uuid` をキーにして同期される。
 * 大文字小文字の違いは同じ列とみなす。
 * 主キーが無い表と複合主キーの表は、`setupSync` の前提の確認（`src/setup/rows-preflight.ts`）が例外にする。
 *
 * テーブルが存在するかは見ない。
 * 呼び出し元の `setupSync` は {@link discoverTables} が `sqlite_master` から見つけた表だけを渡す。
 *
 * @param db - 検証対象のSQLiteデータベース接続
 * @param tables - 検証するテーブル設定の配列
 * @param primaryKey - 主キーカラム名
 * @returns バリデーションエラーの配列。空配列なら全テーブルが有効。
 *
 * @example
 * ```ts
 * const errors = validateDatabase(db, [{ name: 'users' }, { name: 'posts' }], 'id');
 * if (errors.length > 0) {
 *   console.error('バリデーション失敗:', errors);
 * }
 * ```
 */
export function validateDatabase(
  db: Database.Database,
  tables: TableConfig[],
  primaryKey: string
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const tableConfig of tables) {
    const table = tableConfig.name
    const timestampColumn =
      tableConfig.timestampColumn ?? DEFAULTS.timestampColumn

    // カラム情報取得
    const columns = db
      .prepare(`PRAGMA table_info(${escapeIdentifier(table)})`)
      .all() as ColumnInfo[]

    // PKカラム確認
    const pkColumn = columns.find((col) =>
      isSameIdentifier(col.name, primaryKey)
    )
    if (!pkColumn) {
      errors.push({
        table,
        message: `Primary key column '${primaryKey}' does not exist`,
      })
      continue
    }

    // 宣言された主キーが設定の主キー列であること
    const declared = columns.filter((col) => col.pk > 0)
    if (
      declared.length === 1 &&
      !isSameIdentifier(declared[0].name, primaryKey)
    ) {
      errors.push({
        table,
        message:
          `Primary key column '${primaryKey}' is not the declared PRIMARY KEY ` +
          `(the table declares '${declared[0].name}'). Set primaryKey to the ` +
          `declared primary key column, or declare '${primaryKey}' as the PRIMARY KEY`,
      })
      continue
    }

    // PK型チェック（TEXT型であること）
    if (pkColumn.type.toUpperCase() !== 'TEXT') {
      errors.push({
        table,
        message: `Primary key column '${primaryKey}' must be TEXT type, got '${pkColumn.type}'`,
      })
    }

    // タイムスタンプカラム確認
    const hasTimestamp = columns.some((col) =>
      isSameIdentifier(col.name, timestampColumn)
    )
    if (!hasTimestamp) {
      errors.push({
        table,
        message: `Column '${timestampColumn}' does not exist`,
      })
    }
  }

  return errors
}

/**
 * 同期対象として扱うべきでないテーブルかを判定する。
 * @internal
 */
function isInternalTable(name: string): boolean {
  return name.startsWith('_') || name.startsWith('sqlite_')
}

/**
 * 与えられたデータベースから同期対象テーブルを自動検出する。
 *
 * `sqlite_master` を走査して以下の条件を満たすテーブルを返す:
 * 1. `_*` / `sqlite_*` プレフィックスでない（内部テーブルは除外）
 * 2. {@link DiscoverOptions.excludeTables} に含まれない
 * 3. 主キーカラム（既定: `id`）が存在する
 * 4. タイムスタンプカラム（既定: `updatedAt`）が存在する
 *
 * 条件 3 を満たすが条件 4 を満たさないテーブルは「同期したかったのに updatedAt
 * を付け忘れた」可能性があるため、{@link DiscoverOptions.onWarning} で警告を発火する。
 * 意図的にスキップしたい場合は `excludeTables` に追加すれば警告も止まる。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @param options - 検出オプション
 * @returns 検出された {@link TableConfig} の配列（テーブル名昇順）
 *
 * @example
 * ```ts
 * const tables = discoverTables(db);
 * // → [{ name: 'Post' }, { name: 'User' }, ...]
 * ```
 *
 * @example 除外と個別オプション
 * ```ts
 * const tables = discoverTables(db, {
 *   excludeTables: ['LocalCache'],
 *   tableOptions: { User: { timestampColumn: 'modifiedAt' } },
 * });
 * ```
 */
export function discoverTables(
  db: Database.Database,
  options: DiscoverOptions = {}
): TableConfig[] {
  const primaryKey = options.primaryKey ?? DEFAULTS.primaryKey
  // **表名の照合も大小を畳む。** `sqlite_master` は宣言どおりの綴りを返し、
  // `excludeTables` / `tableOptions` は利用者が書いた綴りを持つ。字面で突き合わせると
  // `excludeTables: ['Users']` が `users` を除外できず、その表の `tableOptions`
  // （`timestampColumn` の指定など）も黙って効かないまま既定値で同期される。
  const excludeSet = new Set((options.excludeTables ?? []).map(foldIdentifier))
  const tableOptions = options.tableOptions ?? {}
  const optionsFor = (name: string): TableOptions | undefined => {
    const key = Object.keys(tableOptions).find((candidate) =>
      isSameIdentifier(candidate, name)
    )
    return key === undefined ? undefined : tableOptions[key]
  }
  const warn =
    options.onWarning ??
    ((msg: string) => {
      // eslint-disable-next-line no-console
      console.warn(`[sqlite-nas-sync] ${msg}`)
    })

  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[]

  const result: TableConfig[] = []

  for (const { name } of rows) {
    if (isInternalTable(name)) continue
    if (excludeSet.has(foldIdentifier(name))) continue

    const columns = db
      .prepare(`PRAGMA table_info(${escapeIdentifier(name)})`)
      .all() as ColumnInfo[]

    // 主キーカラムが無いテーブルは静かにスキップ
    // （複合キー等で同期対象外を意図しているケースを尊重）
    const hasPk = columns.some((c) => isSameIdentifier(c.name, primaryKey))
    if (!hasPk) continue

    // tableOptions で timestampColumn が上書きされていればそれを優先
    const overrides = optionsFor(name)
    const timestampColumn =
      overrides?.timestampColumn ?? DEFAULTS.timestampColumn

    // **表が宣言している綴りへ解決してから載せる。** 以降の処理は、この名前を
    // SQLにも**レコードのキーにも**使う。`SELECT *` が返すキーは宣言どおりの綴りな
    // ので、設定の綴りのまま運ぶと値が取れず、版の順序（`rows/versions.ts`）が
    // 黙って壊れる。**綴りを揃えるのは入口のここだけ**にする。
    const declaredTimestamp = columns.find((c) =>
      isSameIdentifier(c.name, timestampColumn)
    )
    if (!declaredTimestamp) {
      warn(
        `Table "${name}" has "${primaryKey}" but no "${timestampColumn}" column — ` +
          `excluded from sync. Add the column or list it in excludeTables to silence this warning.`
      )
      continue
    }

    const config: TableConfig = { name }
    if (overrides?.timestampColumn !== undefined) {
      config.timestampColumn = declaredTimestamp.name
    }
    result.push(config)
  }

  return result
}
