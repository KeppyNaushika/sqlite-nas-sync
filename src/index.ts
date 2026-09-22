/**
 * sqlite-nas-sync - NAS環境でのSQLite分散同期ライブラリ。
 *
 * 同期する表ごとに**行の版の表**（`_sns_rows_<表>`）を持ち、アプリの書き込みを
 * トリガーがそこへ版として写す。他の端末とやり取りするのはこの版の表と削除の記録
 * （`_tombstone`）だけで、アプリの表そのものは**版から作り直す**。
 * したがって取り込みがアプリの制約（UNIQUE・外部キー・NOT NULL）で失敗しない。
 *
 * @remarks
 * 主なエントリポイントは {@link setupSync} 関数。
 * この関数に {@link SyncConfig} を渡すと、同期操作を行う
 * {@link SyncInstance} が返される。
 *
 * 同期対象テーブルはDBから自動検出されるため、明示的な指定は不要。
 * `id` カラムと `updatedAt` カラムを持つ非内部テーブルが対象となる。
 *
 * @example
 * ```ts
 * import { setupSync } from 'sqlite-nas-sync';
 *
 * const sync = setupSync({
 *   dbPath: './data/local.sqlite',
 *   nasPath: '/mnt/nas/shared-db/',
 *   clientId: 'client-abc123',
 * });
 *
 * // 手動同期
 * const result = await sync.syncNow();
 * console.log(`${result.inserted} inserted, ${result.updated} updated`);
 *
 * // 定期同期（30秒間隔）
 * sync.start();
 *
 * // 停止
 * sync.stop();
 * ```
 *
 * @packageDocumentation
 */
import Database from 'better-sqlite3'
import {
  SyncConfig,
  SyncInstance,
  SyncResult,
  SyncStatus,
  SyncEvent,
  SyncEventCallback,
  DEFAULTS,
} from './types'
import { discoverTables, validateDatabase } from './validator'
import { computeSchemaHash, readSchemaVersion } from './setup'
import { setupRowsLedgers } from './setup/rows-ledgers'
import { checkRowsPreconditions } from './setup/rows-preflight'
import { migrateToRows } from './rows/migrate'
import { newInstanceId, writeDeleteProtected } from './rows/meta'
import { clearRebuildingFlag } from './rows/restore-detect'
import { createRebuildState } from './rows/rebuild'
import { RowsSyncRuntime, performSync } from './sync'
import { createIdleMemory } from './sync/idle'

/**
 * 同期インスタンスを作成する。
 *
 * 以下の初期化処理を行い、{@link SyncInstance} を返す（案A。設計書 §3.9）:
 * 1. ローカルDBをオープンし、WALモードを有効化
 * 2. {@link discoverTables} で同期対象テーブルを自動検出
 * 3. テーブル構造をバリデーション（PK型、updatedAtカラム等）
 * 4. **前提の確認**（`checkRowsPreconditions`。§1.8 の P1〜P8）
 * 5. **`_sns_rebuilding` の残りを消す**（§3.10 の I。**トリガーを作る前に**）
 * 6. **移行**（`migrateToRows`）—— `_sns_rows_<表>`・`_sns_clock`・4本のトリガー・
 *    `_tombstone` と `_changelog` の作り直し・列の増減への追従
 *
 * `instanceId` は**呼ぶたびに作り直す**（§3.2）。前回の自分と区別が付かないと、
 * NAS 上の写しの取り合い（§3.10）を見抜けない。
 *
 * @param config - 同期設定
 * @returns 同期操作を行うインスタンス
 * @throws バリデーション失敗時、または検出された同期対象テーブルが0件の場合
 *
 * @example
 * ```ts
 * const sync = setupSync({
 *   dbPath: './data/local.sqlite',
 *   nasPath: '/mnt/nas/shared-db/',
 *   clientId: 'client-abc123',
 *   intervalMs: 60000,         // 1分間隔
 *   changelogRetentionDays: 14 // 14日間保持
 * });
 * ```
 */
export function setupSync(config: SyncConfig): SyncInstance {
  const primaryKey = config.primaryKey ?? DEFAULTS.primaryKey

  // ローカルDB接続
  const db = new Database(config.dbPath)
  db.pragma('journal_mode = WAL')

  // 同期対象テーブルを自動検出
  const tables = discoverTables(db, {
    primaryKey,
    excludeTables: config.excludeTables,
    tableOptions: config.tableOptions,
    onWarning: config.onDiscoveryWarning,
  })

  if (tables.length === 0) {
    db.close()
    throw new Error(
      `No sync tables discovered in ${config.dbPath}. ` +
        `Ensure tables exist with "${primaryKey}" and "updatedAt" columns ` +
        `(or pass tableOptions to use a different timestamp column).`
    )
  }

  // 検出結果の通知（「想定とのズレ」の早期発見用）。**受け口が無ければ何も出さない。**
  // ライブラリが利用者に断りなく標準出力へ書くと、利用側のログが表名で埋まる
  config.onTablesDiscovered?.(tables.map((t) => t.name))

  // バリデーション（discoverTablesは存在チェック済みだが、PK型まではチェックしない）
  const errors = validateDatabase(db, tables, primaryKey)
  if (errors.length > 0) {
    db.close()
    throw new Error(
      `Validation failed:\n${errors.map((e) => `  ${e.table}: ${e.message}`).join('\n')}`
    )
  }

  // アプリ側のスキーマ版。明示指定がなければテーブルスキーマから自動生成する。
  // `_sync_meta` へ書かれるのは `<アプリの版>;sns-format=rows1`（§3.8）で、
  // 相手の見送りの判定はこの**文字列ぜんたい**の一致で行う（§4.2）
  const appSchemaVersion = config.schemaVersion ?? computeSchemaHash(db, tables)

  // 前提の確認（§1.8）。破れていれば例外、気がかりは警告として返る
  const preflight = checkRowsPreconditions(
    db,
    tables.map((t) => ({ name: t.name, timestampColumn: t.timestampColumn }))
  )
  const setupWarnings = [...preflight.warnings]

  // 旗の残りは**トリガーを作る前に**消す（§3.10 の I）。残っている間、
  // アプリの書き込みは1つも事実にならないのに、警告も例外も出ない
  if (clearRebuildingFlag(db)) {
    setupWarnings.push(
      '_sns_rebuilding に行が残っていたので消した（前回の作り直しが途中で落ちた可能性がある）'
    )
  }

  // 端末の id は毎回作り直す（§3.2）
  const instanceId = newInstanceId()
  const migration = migrateToRows(db, {
    tables: tables.map((t) => ({
      name: t.name,
      timestampColumn: t.timestampColumn,
      deleteProtected: t.deleteProtected,
    })),
    instanceId,
    appSchemaVersion,
  })
  setupWarnings.push(...migration.warnings)

  // `deleteProtected` は**この DB に書き残す**（§3.1 の鍵）。作り直しの計算は
  // ここから読み、相手の写しにも同じ鍵が載るので食い違いを見つけられる
  writeDeleteProtected(db, tables)

  // 表に触らない帳簿（`_sync_state` / `_changelog_prune` / `_heartbeat` /
  // `_sync_meta`）。移行が `_sync_state` を空にしたあとで作る
  setupRowsLedgers(db)

  // `migrateToRows` が書いた `<アプリの版>;sns-format=rows1` をそのまま持ち回る
  const resolvedSchemaVersion = readSchemaVersion(db) ?? appSchemaVersion

  // configにresolved値を反映（performSyncで参照される）
  const resolvedConfig: SyncConfig = {
    ...config,
    schemaVersion: resolvedSchemaVersion,
  }

  // 作り直しの記憶は `SyncInstance` が全体で1つ持つ（§3.7.4）。同期のたびに
  // 作り直すと、見送りがいくら続いても k 回目の合流経路へ入れない
  // 無駄な転送を落とすための覚えも、`SyncInstance` が1つ持つ（`src/sync/idle.ts`）。
  // **プロセスの中にしか無い**ので、立ち上げ直せば必ず1回は読み・上げる
  const runtime: RowsSyncRuntime = {
    rebuild: createRebuildState(),
    instanceId,
    idle: createIdleMemory(config.suppressIdleSync ?? true),
  }

  // 検出済みテーブル名のスナップショット
  const syncedTableNames = tables.map((t) => t.name)

  // 内部状態
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let isSyncing = false
  let lastSyncedAt: Date | null = null
  let lastResult: SyncResult | null = null
  const listeners = new Map<SyncEvent, SyncEventCallback[]>()

  function emit(event: SyncEvent, data?: unknown): void {
    const cbs = listeners.get(event) ?? []
    for (const cb of cbs) {
      try {
        cb(data)
      } catch {
        // リスナーのエラーは飲み込む
      }
    }
  }

  const instance: SyncInstance = {
    async syncNow(): Promise<SyncResult> {
      if (isSyncing) {
        throw new Error('Sync already in progress')
      }

      isSyncing = true
      emit('sync:start')

      try {
        const result = await performSync(db, resolvedConfig, tables, runtime)
        // `setupSync` で気づいたことは、最初の1回の結果に載せて持ち主へ渡す
        if (setupWarnings.length > 0) {
          result.warnings.unshift(...setupWarnings)
          setupWarnings.length = 0
        }
        lastResult = result
        lastSyncedAt = new Date()
        emit('sync:complete', result)
        return result
      } catch (error) {
        emit('sync:error', error)
        throw error
      } finally {
        isSyncing = false
      }
    },

    start(): void {
      if (intervalHandle) return
      const ms = resolvedConfig.intervalMs ?? DEFAULTS.intervalMs
      intervalHandle = setInterval(async () => {
        try {
          await instance.syncNow()
        } catch {
          // エラーは sync:error イベントで通知済み
        }
      }, ms)
    },

    stop(): void {
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
    },

    getStatus(): SyncStatus {
      return {
        isSyncing,
        lastSyncedAt,
        lastResult,
        isRunning: intervalHandle !== null,
      }
    },

    getSyncedTables(): string[] {
      return [...syncedTableNames]
    },

    on(event: SyncEvent, callback: SyncEventCallback): void {
      const existing = listeners.get(event) ?? []
      existing.push(callback)
      listeners.set(event, existing)
    },
  }

  return instance
}

// 公開API: テーブル自動検出
export { discoverTables } from './validator'

// v0.20.0（案A・段階6）で `applyInsert` / `applyUpdate` / `applyDelete` と、
// その引数・戻り値の型（`ApplyInsertResult` / `ApplyUpdateResult` /
// `ResurrectionProbe` / `TimestampColumnFor`）の公開をやめた。
// 案A の取り込みは行の版と削除の版の `Max` を取るだけで、1レコードずつ
// 「入れる・上書きする・消す」を判断する場所が無い（設計書 §4.3）。
// 手元での手動マージは、相手の DB を NAS に見立てて `setupSync` を通すこと。
//
// 段階7 で `ConflictInfo` 型と `sync:conflict` イベントの公開もやめた。案A には
// 「1レコードの競合を local_wins / remote_wins で解決する」場面が無く、この
// イベントは段階5 以降どこからも発火していなかった（購読しても永久に呼ばれない）。
// 版が入れ替わった数は `SyncResult.conflictsResolved` で分かる。

// 公開型のre-export
export type {
  TableConfig,
  TableOptions,
  DiscoverOptions,
  SyncConfig,
  SyncInstance,
  SyncResult,
  SyncTransfers,
  SkippedRemote,
  RecordFold,
  SyncStatus,
  SyncEvent,
  SyncEventCallback,
} from './types'
