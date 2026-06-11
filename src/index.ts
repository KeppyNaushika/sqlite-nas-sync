/**
 * sqlite-nas-sync - NAS環境でのSQLite分散同期ライブラリ。
 *
 * `_changelog` テーブルとSQLiteトリガーによる差分追跡で、
 * 複数クライアント間のSQLiteデータベースを効率的に同期する。
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
import Database from 'better-sqlite3';
import {
  SyncConfig,
  SyncInstance,
  SyncResult,
  SyncStatus,
  SyncEvent,
  SyncEventCallback,
  DEFAULTS,
} from './types';
import { discoverTables, validateDatabase } from './validator';
import { setupChangelog, writeSchemaVersion, computeSchemaHash } from './setup';
import { performSync } from './sync';

/**
 * 同期インスタンスを作成する。
 *
 * 以下の初期化処理を行い、{@link SyncInstance} を返す:
 * 1. ローカルDBをオープンし、WALモードを有効化
 * 2. {@link discoverTables} で同期対象テーブルを自動検出
 * 3. テーブル構造をバリデーション（PK型、updatedAtカラム等）
 * 4. `_changelog` / `_sync_state` テーブルとトリガーを作成
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
  const primaryKey = config.primaryKey ?? DEFAULTS.primaryKey;

  // ローカルDB接続
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  // 同期対象テーブルを自動検出
  const tables = discoverTables(db, {
    primaryKey,
    excludeTables: config.excludeTables,
    tableOptions: config.tableOptions,
    onWarning: config.onDiscoveryWarning,
  });

  if (tables.length === 0) {
    db.close();
    throw new Error(
      `No sync tables discovered in ${config.dbPath}. ` +
        `Ensure tables exist with "${primaryKey}" and "updatedAt" columns ` +
        `(or pass tableOptions to use a different timestamp column).`
    );
  }

  // 検出結果をログ出力（デバッグおよび「想定とのズレ」の早期発見用）
  // eslint-disable-next-line no-console
  console.log(
    `[sqlite-nas-sync] Auto-detected ${tables.length} sync table(s): ${tables
      .map((t) => t.name)
      .join(', ')}`
  );

  // バリデーション（discoverTablesは存在チェック済みだが、PK型まではチェックしない）
  const errors = validateDatabase(db, tables, primaryKey);
  if (errors.length > 0) {
    db.close();
    throw new Error(
      `Validation failed:\n${errors.map((e) => `  ${e.table}: ${e.message}`).join('\n')}`
    );
  }

  // _changelog / _sync_state / _sync_meta / トリガー 作成
  setupChangelog(db, tables, primaryKey);

  // schemaVersion: 明示指定がなければテーブルスキーマから自動生成
  const resolvedSchemaVersion =
    config.schemaVersion ?? computeSchemaHash(db, tables);
  writeSchemaVersion(db, resolvedSchemaVersion);

  // configにresolved値を反映（performSyncで参照される）
  const resolvedConfig: SyncConfig = { ...config, schemaVersion: resolvedSchemaVersion };

  // 検出済みテーブル名のスナップショット
  const syncedTableNames = tables.map((t) => t.name);

  // 内部状態
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let isSyncing = false;
  let lastSyncedAt: Date | null = null;
  let lastResult: SyncResult | null = null;
  const listeners = new Map<SyncEvent, SyncEventCallback[]>();

  function emit(event: SyncEvent, data?: unknown): void {
    const cbs = listeners.get(event) ?? [];
    for (const cb of cbs) {
      try {
        cb(data);
      } catch {
        // リスナーのエラーは飲み込む
      }
    }
  }

  const instance: SyncInstance = {
    async syncNow(): Promise<SyncResult> {
      if (isSyncing) {
        throw new Error('Sync already in progress');
      }

      isSyncing = true;
      emit('sync:start');

      try {
        const result = await performSync(db, resolvedConfig, tables);
        lastResult = result;
        lastSyncedAt = new Date();
        emit('sync:complete', result);
        return result;
      } catch (error) {
        emit('sync:error', error);
        throw error;
      } finally {
        isSyncing = false;
      }
    },

    start(): void {
      if (intervalHandle) return;
      const ms = resolvedConfig.intervalMs ?? DEFAULTS.intervalMs;
      intervalHandle = setInterval(async () => {
        try {
          await instance.syncNow();
        } catch {
          // エラーは sync:error イベントで通知済み
        }
      }, ms);
    },

    stop(): void {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },

    getStatus(): SyncStatus {
      return {
        isSyncing,
        lastSyncedAt,
        lastResult,
        isRunning: intervalHandle !== null,
      };
    },

    getSyncedTables(): string[] {
      return [...syncedTableNames];
    },

    on(event: SyncEvent, callback: SyncEventCallback): void {
      const existing = listeners.get(event) ?? [];
      existing.push(callback);
      listeners.set(event, existing);
    },
  };

  return instance;
}

// 公開API: テーブル自動検出
export { discoverTables } from './validator';

// 公開型のre-export
export type {
  TableConfig,
  TableOptions,
  DiscoverOptions,
  SyncConfig,
  SyncInstance,
  SyncResult,
  SkippedRemote,
  SyncStatus,
  SyncEvent,
  SyncEventCallback,
} from './types';
