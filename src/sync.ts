/**
 * コア同期オーケストレーション。
 *
 * **v0.20.0（案A）から、既定の経路は `sync/rows-sync` である。**
 * 1回の `performSync` はこう進む（設計書 `docs/rows-table-design.md` §4.1）:
 *
 * 1. 取り込みより前に、復元・巻き戻りと仕掛けの欠けを見る（§3.10）
 * 2. NAS への写し（印 → `backup()` → 取り合いの確認）
 * 3. 相手ごとに `_sns_rows_*` と `_tombstone` を突き合わせて取り込む（§4.3）
 * 4. **別のトランザクション**でアプリの表を作り直す（§3.7）
 * 5. `cleanupChangelog`、`onAfterSync`
 *
 * 旧経路（`sync/entries`・`sync/full-merge`・`sync/pull`・`conflict/*` の畳み）は
 * **段階6 で消した**。
 *
 * @module sync
 */
import Database from 'better-sqlite3'
import { SyncConfig, SyncResult, TableConfig } from './types'
import { RowsSyncRuntime, performRowsSync } from './sync/rows-sync'

export type { RowsSyncRuntime } from './sync/rows-sync'
export type { RowsRebuildHooks } from './rows/rebuild'

/**
 * 同期処理を1回実行する（案A）。
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
