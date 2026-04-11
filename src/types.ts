import Database from 'better-sqlite3';

/**
 * テーブル別の同期設定。
 *
 * `discoverTables` の戻り値、および内部の同期処理で利用される。
 * ユーザーが直接構築することは通常無く、{@link SyncConfig.tableOptions}
 * 経由で部分指定する。
 */
export interface TableConfig {
  /** テーブル名 */
  name: string;
  /**
   * LWW比較に使うタイムスタンプカラム名。
   * @defaultValue `'updatedAt'`
   */
  timestampColumn?: string;
  /**
   * trueの場合、sync時にこのテーブルへのDELETE操作を適用しない（tombstone保護）。
   */
  deleteProtected?: boolean;
}

/**
 * テーブル別のオプション指定。
 *
 * {@link SyncConfig.tableOptions} で利用する、{@link TableConfig} から
 * `name` を除いた形。
 */
export type TableOptions = Omit<TableConfig, 'name'>;

/**
 * {@link discoverTables} に渡す検出オプション。
 */
export interface DiscoverOptions {
  /**
   * 主キーカラム名。このカラムが存在するテーブルだけが検出対象になる。
   * @defaultValue `'id'`
   */
  primaryKey?: string;
  /**
   * 検出から除外するテーブル名の配列。
   * ローカル専用キャッシュ等を持つ場合に使用。
   * @defaultValue `[]`
   */
  excludeTables?: string[];
  /**
   * テーブル別の追加オプション。
   * 指定しないテーブルはデフォルト動作（`updatedAt` / `deleteProtected: false`）。
   * @defaultValue `{}`
   */
  tableOptions?: Record<string, TableOptions>;
  /**
   * `id` を持つが `updatedAt`（または指定 `timestampColumn`）が無いテーブルを
   * 検出した際の警告コールバック。指定しなければ `console.warn` に出力される。
   *
   * 警告はあくまで「同期対象から外しました」の通知であり、エラーではない。
   * 意図的に除外したい場合は {@link excludeTables} を使えば警告も抑制される。
   */
  onWarning?: (message: string) => void;
}

/**
 * 同期の設定オプション。
 *
 * {@link setupSync} に渡してSyncインスタンスを生成する。
 *
 * 同期対象テーブルはDBから自動検出される（明示指定不要）。
 * 検出条件: `_*` / `sqlite_*` 以外で、`id` カラムと `updatedAt` カラムを持つテーブル。
 *
 * @example
 * ```ts
 * const config: SyncConfig = {
 *   dbPath: './data/local.sqlite',
 *   nasPath: '/mnt/nas/shared-db/',
 *   clientId: 'client-abc123',
 *   // tables は不要 — DB から自動検出
 * };
 * ```
 *
 * @example 一部テーブルを除外する
 * ```ts
 * const config: SyncConfig = {
 *   // ...
 *   excludeTables: ['LocalCache', 'TempLog'],
 * };
 * ```
 *
 * @example 一部テーブルにオプションを指定する
 * ```ts
 * const config: SyncConfig = {
 *   // ...
 *   tableOptions: {
 *     User: { deleteProtected: true },
 *     Audit: { timestampColumn: 'modifiedAt' },
 *   },
 * };
 * ```
 */
export interface SyncConfig {
  /** ローカルSQLite DBのファイルパス */
  dbPath: string;
  /** NAS上の共有ディレクトリパス */
  nasPath: string;
  /** このクライアントの一意識別子（UUID推奨） */
  clientId: string;
  /**
   * 自動検出から除外するテーブル名の配列。
   * @defaultValue `[]`
   */
  excludeTables?: string[];
  /**
   * テーブル別の追加オプション。
   * 指定しないテーブルはデフォルト動作。
   * @defaultValue `{}`
   */
  tableOptions?: Record<string, TableOptions>;
  /**
   * 主キーカラム名。全対象テーブルで共通。
   * @defaultValue `'id'`
   */
  primaryKey?: string;
  /**
   * 定期sync間隔（ミリ秒）。{@link SyncInstance.start} で使用される。
   * @defaultValue `30000`
   */
  intervalMs?: number;
  /**
   * `_changelog` テーブルの保持期間（日数）。
   * この日数より古いエントリはsync後に自動削除される。
   * @defaultValue `7`
   */
  changelogRetentionDays?: number;
  /**
   * sync完了後に呼ばれるコールバック。
   * changelog掃除の後に実行される。
   */
  onAfterSync?: (localDb: Database.Database, result: SyncResult) => void;
  /**
   * アプリケーションのスキーマバージョン。
   *
   * 指定すると `_sync_meta` テーブルにバージョンを記録し、
   * sync時にリモートDBのバージョンと比較する。
   * バージョンが一致しないリモートクライアントはスキップされる。
   *
   * 未指定の場合はテーブルスキーマから自動でハッシュが生成される。
   *
   * @example `"20260324_002"` や `"v2.0.0"` など任意の文字列
   */
  schemaVersion?: string;

  /**
   * heartbeat 機能を有効にするかどうか。
   *
   * `true` の場合、sync時に当日のheartbeatが未実行であれば
   * `_heartbeat` テーブルを更新し、changelogにエントリを追加する。
   * これによりchangelogが7日間で空になるのを防止する。
   *
   * @defaultValue `true`
   */
  heartbeatEnabled?: boolean;

  /**
   * テーブル自動検出時の警告ログコールバック。
   *
   * `id` を持つが `updatedAt` が無いテーブルが見つかった際に呼ばれる。
   * 未指定なら `console.warn` に出力される。
   */
  onDiscoveryWarning?: (message: string) => void;
}

/**
 * {@link setupSync} が返す同期インスタンス。
 *
 * 手動sync、定期sync、状態取得、イベント購読を提供する。
 */
export interface SyncInstance {
  /**
   * 同期を即時実行する。
   *
   * ローカルDBのNASコピー → リモートDBのchangelog読み取り → 差分適用
   * の一連の処理を行う。
   *
   * @returns 同期結果の統計情報
   * @throws 同期中に再度呼び出した場合、またはNASアクセス不可時
   */
  syncNow(): Promise<SyncResult>;
  /**
   * 定期syncを開始する。
   *
   * {@link SyncConfig.intervalMs} 間隔で {@link syncNow} を繰り返し実行する。
   * 既に開始済みの場合は何もしない。
   */
  start(): void;
  /**
   * 定期syncを停止する。
   *
   * {@link start} で開始したインターバルをクリアする。
   */
  stop(): void;
  /**
   * 現在の同期状態を取得する。
   * @returns 同期状態のスナップショット
   */
  getStatus(): SyncStatus;
  /**
   * このインスタンスが同期対象として認識しているテーブル名の一覧を返す。
   *
   * `setupSync` 時に `discoverTables` で検出された結果のスナップショット。
   * マージ処理など、ライブラリ外で同じテーブル集合を扱いたい場合に利用する。
   */
  getSyncedTables(): string[];
  /**
   * イベントリスナーを登録する。
   *
   * @param event - 購読するイベント種別
   * @param callback - イベント発火時に呼ばれるコールバック
   *
   * @example
   * ```ts
   * sync.on('sync:complete', (result) => {
   *   console.log(`Synced: ${result.inserted} inserted`);
   * });
   * ```
   */
  on(event: SyncEvent, callback: SyncEventCallback): void;
}

/**
 * 同期実行の結果統計。
 *
 * {@link SyncInstance.syncNow} の戻り値として返される。
 */
export interface SyncResult {
  /** 今回の同期で処理したリモートクライアント数 */
  clientsSynced: number;
  /** リモートから挿入したレコード数 */
  inserted: number;
  /** LWW比較でリモートが新しかったため更新したレコード数 */
  updated: number;
  /** リモートのDELETE操作により削除したレコード数 */
  deleted: number;
  /** LWW比較でローカルが新しかったためスキップしたレコード数 */
  skipped: number;
  /** UNIQUE制約違反をUPSERTで解決したレコード数 */
  conflictsResolved: number;
  /** 致命的でない警告メッセージの配列 */
  warnings: string[];
  /**
   * changelogギャップが検出されたかどうか。
   *
   * `true` の場合、このクライアントは長期間同期しておらず、
   * pull-first モードで同期が行われた（NASアップロードはpull完了後）。
   */
  hadChangelogGap: boolean;
}

/**
 * 同期インスタンスの現在の状態。
 *
 * {@link SyncInstance.getStatus} で取得する。
 */
export interface SyncStatus {
  /** 現在syncが実行中かどうか */
  isSyncing: boolean;
  /** 最後にsyncが正常完了した時刻。未実行の場合は `null` */
  lastSyncedAt: Date | null;
  /** 最後のsync結果。未実行の場合は `null` */
  lastResult: SyncResult | null;
  /** {@link SyncInstance.start} による定期syncが有効かどうか */
  isRunning: boolean;
}

/**
 * 同期イベントの種別。
 *
 * | イベント | 発火タイミング | コールバック引数 |
 * |---|---|---|
 * | `sync:start` | sync開始時 | なし |
 * | `sync:complete` | sync正常完了時 | {@link SyncResult} |
 * | `sync:error` | syncエラー時 | `Error` |
 * | `sync:conflict` | 競合発生時 | `ConflictInfo` |
 */
export type SyncEvent =
  | 'sync:start'
  | 'sync:complete'
  | 'sync:error'
  | 'sync:conflict';

/**
 * {@link SyncInstance.on} に渡すイベントコールバック関数の型。
 * @param data - イベントに応じたデータ。イベント種別により型が異なる。
 */
export type SyncEventCallback = (data?: unknown) => void;

// --- 内部型 ---

/**
 * `_changelog` テーブルの1行を表す内部型。
 *
 * SQLiteトリガーによりINSERT/UPDATE/DELETE操作ごとに自動記録される。
 * @internal
 */
export interface ChangelogEntry {
  /** changelogのオートインクリメントID */
  id: number;
  /** 変更が発生したテーブル名 */
  tableName: string;
  /** 変更されたレコードの主キー値 */
  recordId: string;
  /** 操作種別 */
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  /** 変更日時（ISO 8601形式、SQLiteの `datetime('now')` で生成） */
  changedAt: string;
}

/**
 * `_sync_state` テーブルの1行を表す内部型。
 *
 * リモートクライアントごとにどこまでchangelogを処理したかを記録する。
 * @internal
 */
export interface SyncStateEntry {
  /** リモートクライアントの識別子 */
  remoteClientId: string;
  /** 最後に処理したchangelog ID */
  lastSeenId: number;
  /** 最後にsyncした日時 */
  lastSyncedAt: string | null;
}

/**
 * 競合解決の詳細情報。
 *
 * LWW（Last-Write-Wins）やUNIQUE制約違反の解決時に生成される。
 * `sync:conflict` イベントのコールバック引数として渡される。
 */
export interface ConflictInfo {
  /** 競合が発生したテーブル名 */
  table: string;
  /** 競合が発生したレコードの主キー値 */
  recordId: string;
  /** ローカル側の `updatedAt` 値 */
  localUpdatedAt: string;
  /** リモート側の `updatedAt` 値 */
  remoteUpdatedAt: string;
  /** 解決方法: ローカル保持 or リモート採用 */
  resolution: 'local_wins' | 'remote_wins';
}

/**
 * NAS上のリモートクライアントDB情報。
 * @internal
 */
export interface RemoteClient {
  /** クライアント識別子（ファイル名から抽出） */
  clientId: string;
  /** DBファイルの絶対パス */
  filePath: string;
}

/**
 * 設定のデフォルト値。
 *
 * @remarks
 * - `primaryKey`: `'id'`
 * - `intervalMs`: `30000`（30秒）
 * - `changelogRetentionDays`: `7`（7日間）
 */
export const DEFAULTS = {
  primaryKey: 'id',
  intervalMs: 30000,
  changelogRetentionDays: 7,
  heartbeatEnabled: true,
} as const;
