/**
 * スキーマの版を控えて、**形の違う相手を取り込まない**ようにする。
 *
 * 取り込み元のスキーマがこちらと違うと、列が足りない・型が違うといった形で
 * 取り込みが失敗する。失敗してから気づくのではなく、**開いた時点で見送る**ために、
 * 自分のスキーマの指紋を `_sync_meta` に書いておき、相手のそれと突き合わせる。
 *
 * @module setup/schema-version
 * @internal
 */
import * as crypto from 'crypto'
import Database from 'better-sqlite3'
import { TableConfig } from '../types'
import { ColumnInfo, escapeIdentifier } from './sql'

/**
 * `_sync_meta` テーブルにスキーマバージョンを書き込む。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @param schemaVersion - 書き込むスキーマバージョン文字列
 */
export function writeSchemaVersion(
  db: Database.Database,
  schemaVersion: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('schemaVersion', ?)`
  ).run(schemaVersion)
}

/**
 * `_sync_meta` テーブルからスキーマバージョンを読み取る。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @returns スキーマバージョン文字列。未設定の場合は `null`
 */
export function readSchemaVersion(db: Database.Database): string | null {
  // _sync_meta テーブルが存在しない場合も考慮
  try {
    const row = db
      .prepare(`SELECT value FROM _sync_meta WHERE key = 'schemaVersion'`)
      .get() as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

/**
 * 同期対象テーブルのスキーマからハッシュ値を自動生成する。
 *
 * 各テーブルの `PRAGMA table_info` からカラム名・型・notnull・pk を取得し、
 * テーブル名でソートした上でSHA-256ハッシュを生成する。
 * スキーマが変更されると自動的に異なるハッシュが返るため、
 * 手動でバージョンを管理する必要がない。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @param tables - ハッシュ対象のテーブル設定配列
 * @returns スキーマのSHA-256ハッシュ（先頭16文字）
 */
export function computeSchemaHash(
  db: Database.Database,
  tables: TableConfig[]
): string {
  const parts: string[] = []

  // テーブル名でソートして安定した順序にする
  const sortedTables = [...tables].sort((a, b) => a.name.localeCompare(b.name))

  for (const tableConfig of sortedTables) {
    const tableName = tableConfig.name

    try {
      const columns = db
        .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
        .all() as ColumnInfo[]

      // カラムをcid順（定義順）で処理
      const colDescs = columns
        .sort((a, b) => a.cid - b.cid)
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`)
        .join(',')

      parts.push(`${tableName}(${colDescs})`)
    } catch {
      // テーブルが存在しない場合はスキップ
    }
  }

  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex')

  return hash.slice(0, 16)
}
