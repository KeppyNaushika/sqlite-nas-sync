/**
 * sqlite-nas-sync - NAS環境でのSQLite分散同期ライブラリ。
 *
 * 各クライアントのローカル DB を NAS 上の共有ディレクトリにコピーし、互いのコピーを読んで、ユーザーテーブルへの変更を LWW で統合する。
 * 同期の仕様は `docs/principles.md` にある。
 *
 * アプリケーションがユーザーテーブルに書き込むと、トリガーがそのバージョンを内部テーブル（`_sns_rows_<テーブル>` と `_tombstone`）に記録する。
 * 他のクライアントとやり取りするのはこの内部テーブルだけで、ユーザーテーブルは内部テーブルのバージョンから作り直す。
 * そのため、取り込みがユーザーテーブルの制約（`UNIQUE`・外部キー・`NOT NULL`）で失敗することはない。
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
import { computeSchemaHash, readSchemaVersion } from './setup/schema-version'
import { setupRowsLedgers } from './setup/rows-ledgers'
import { checkRowsPreconditions } from './setup/rows-preflight'
import { migrateToRows } from './rows/migrate'
import { newInstanceId } from './rows/meta'
import { clearRebuildingFlag } from './rows/restore-detect'
import { createRebuildState } from './rows/rebuild'
import { RowsSyncRuntime, performSync } from './sync'
import { createIdleMemory } from './sync/idle'

/**
 * 同期インスタンスを作成する。
 *
 * 次の順に準備して、{@link SyncInstance} を返す。
 *
 * 1. ローカル DB を開き、WAL モードにする
 * 2. {@link discoverTables} で同期するテーブルを検出する
 * 3. テーブルと DB が前提を満たすかを確かめる。満たさなければ例外を投げる。気になる点は警告として最初の同期の `warnings` に載せる
 * 4. 同期に使う内部テーブルとトリガーを作る。以前のバージョンのライブラリの形式の DB は移行し、テーブルの列の増減にも追従する
 *
 * 呼ぶたびにこのクライアントを識別する乱数を作り直す。
 * 同じ `clientId` を使う別のクライアントが NAS 上のコピーを書き換えていないかを、これで見分ける。
 *
 * @param config - 同期設定
 * @returns 同期操作を行うインスタンス
 * @throws 次のいずれかに当たる場合。
 * - 同期するテーブルが1つも見つからない
 * - 同期するテーブルが次のどれかに当たる（`Validation failed` またはそれぞれの文面）
 *   - `primaryKey` の列が無い、`TEXT` でない、テーブルで宣言された主キーでない
 *   - 主キーが無い、複合主キーである、`NOT NULL` でも `WITHOUT ROWID` でもない、主キーが NULL の行がある
 *   - 時刻列に ISO-8601 の文字列でない値がある行がある
 *   - `CHECK` 制約・部分索引の条件・式索引の式に、決定的でない関数・独自に登録した関数・組み込みでない照合順序がある、または索引の定義を読めない
 *   - 列名が `_sns_` で始まる
 * - 同期するテーブルを親とする外部キーが、親の主キー以外の列を参照している（子が同期しないテーブルでも同じ）
 * - テーブルに増えた列が `NOT NULL` で既定値が定数でなく、ユーザーテーブルから埋め直せない行がある
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
      '_sns_rebuilding に行が残っていたので消した（前回の同期がユーザーテーブルへの反映の途中で止まった可能性がある）'
    )
  }

  // 端末の id は毎回作り直す（§3.2）
  const instanceId = newInstanceId()
  const migration = migrateToRows(db, {
    tables: tables.map((t) => ({
      name: t.name,
      timestampColumn: t.timestampColumn,
    })),
    instanceId,
    appSchemaVersion,
  })
  setupWarnings.push(...migration.warnings)

  // 表に触らない帳簿（`_sync_state` / `_changelog_prune` / `_sync_meta`）。
  // 移行が `_sync_state` を空にすることがあるので、そのあとで作る
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
  /** 実行中の同期。`close` が終わりを待つために持つ */
  let currentSync: Promise<SyncResult> | null = null
  let isClosed = false
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
      if (isClosed) {
        throw new Error('Sync instance is closed')
      }
      if (isSyncing) {
        throw new Error('Sync already in progress')
      }

      isSyncing = true
      emit('sync:start')

      try {
        currentSync = performSync(db, resolvedConfig, tables, runtime)
        const result = await currentSync
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
        currentSync = null
      }
    },

    start(): void {
      if (isClosed) {
        throw new Error('Sync instance is closed')
      }
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

    async close(): Promise<void> {
      if (isClosed) return
      isClosed = true
      instance.stop()
      if (currentSync) {
        try {
          await currentSync
        } catch {
          // 同期の例外は syncNow の呼び出し元へ返っている。ここでは閉じることだけを行う
        }
      }
      db.close()
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

// 公開API: 同期の仕組みを取り除く
export { removeSync } from './teardown'

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
  ParentDeletedRecord,
  SyncStatus,
  SyncEvent,
  SyncEventCallback,
} from './types'
