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
 * @example
 * ```ts
 * import { setupSync } from 'sqlite-nas-sync';
 *
 * const sync = setupSync({
 *   dbPath: './data/local.sqlite',
 *   nasPath: '/mnt/nas/shared-db/',
 *   clientId: 'client-abc123',
 *   tables: [{ name: 'users' }, { name: 'posts' }],
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
import { validateDatabase } from './validator';
import { setupChangelog, writeSchemaVersion, computeSchemaHash } from './setup';
import { performSync } from './sync';

/**
 * 同期インスタンスを作成する。
 *
 * 以下の初期化処理を行い、{@link SyncInstance} を返す:
 * 1. ローカルDBをオープンし、WALモードを有効化
 * 2. テーブル構造をバリデーション（PK型、updatedAtカラム等）
 * 3. `_changelog` / `_sync_state` テーブルとトリガーを作成
 *
 * @param config - 同期設定
 * @returns 同期操作を行うインスタンス
 * @throws バリデーション失敗時（テーブル不在、PK型不正等）
 *
 * @example
 * ```ts
 * const sync = setupSync({
 *   dbPath: './data/local.sqlite',
 *   nasPath: '/mnt/nas/shared-db/',
 *   clientId: 'client-abc123',
 *   tables: [{ name: 'users' }, { name: 'posts' }],
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

  // バリデーション
  const errors = validateDatabase(db, config.tables, primaryKey);
  if (errors.length > 0) {
    db.close();
    throw new Error(
      `Validation failed:\n${errors.map((e) => `  ${e.table}: ${e.message}`).join('\n')}`
    );
  }

  // _changelog / _sync_state / _sync_meta / トリガー 作成
  setupChangelog(db, config.tables, primaryKey);

  // schemaVersion: 明示指定がなければテーブルスキーマから自動生成
  const resolvedSchemaVersion =
    config.schemaVersion ?? computeSchemaHash(db, config.tables);
  writeSchemaVersion(db, resolvedSchemaVersion);

  // configにresolved値を反映（performSyncで参照される）
  const resolvedConfig: SyncConfig = { ...config, schemaVersion: resolvedSchemaVersion };

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
        const result = await performSync(db, resolvedConfig);
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

    on(event: SyncEvent, callback: SyncEventCallback): void {
      const existing = listeners.get(event) ?? [];
      existing.push(callback);
      listeners.set(event, existing);
    },
  };

  return instance;
}

// 公開型のre-export
export type {
  TableConfig,
  SyncConfig,
  SyncInstance,
  SyncResult,
  SyncStatus,
  SyncEvent,
  SyncEventCallback,
} from './types';
