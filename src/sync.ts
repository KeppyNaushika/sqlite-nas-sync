/**
 * コア同期オーケストレーション。
 *
 * 中身は `sync/rows-sync` にある。
 * 1回の `performSync` はこう進む（設計書 `docs/rows-table-design.md` §4.1）:
 *
 * 1. 取り込みより前に、復元・巻き戻りと仕掛けの欠けを見る（§3.10）
 * 2. 相手を列挙し、隙間があるかを見る
 * 3. 相手ごとの取り込み（§4.3）→ **別のトランザクション**でのアプリの表の作り直し（§3.7）→ NAS への写し（印 → `backup()` → 取り合いの確認）。作り直しが例外で止まっても、写しを上げてから投げ直す
 * 4. `cleanupChangelog`、`onAfterSync`
 *
 * @module sync
 */
import Database from 'better-sqlite3'
import { SyncConfig, SyncResult, TableConfig } from './types'
import { RowsSyncRuntime, performRowsSync } from './sync/rows-sync'

export type { RowsSyncRuntime } from './sync/rows-sync'

/**
 * 同期処理を1回実行する。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param config - 同期設定
 * @param tables - 同期対象テーブル設定の配列
 * @param runtime - `SyncInstance` が持ち回る記憶（作り直しの見送り回数など）。
 *   省略すると毎回まっさらになる（見送りが続いても合流経路へ入れないので、
 *   `setupSync` からは必ず渡す）
 * @returns 同期結果の統計情報
 */
export async function performSync(
  localDb: Database.Database,
  config: SyncConfig,
  tables: TableConfig[],
  runtime?: RowsSyncRuntime
): Promise<SyncResult> {
  return performRowsSync(localDb, config, tables, runtime)
}
