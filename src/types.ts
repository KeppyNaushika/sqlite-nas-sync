/**
 * 公開型の定義と、設定の既定値。
 *
 * 利用者が触れるのは {@link SyncConfig} と {@link SyncResult} の2つで、残りは
 * その中身か、結果に載る内訳（{@link ConflictInfo} / {@link RecordFold}）である。
 *
 * ここの doc は**利用者向けの説明そのもの**として読まれる（typedoc がそのまま
 * APIリファレンスへ出す）。実装の都合ではなく、「何が起きるか」「どう設定するか」を書く。
 *
 * @module types
 */
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
   *
   * 対象になるのは利用者操作による削除だけで、**畳み**（別の主キー・同一ユニークキーの
   * 行を1行へ統合した結果の削除）は保護しない。畳みはユニーク制約が強制する統合であり、
   * 見送っても行は救えないため（勝者行が届いた時点で同じ統合が起きるだけで、
   * それまでのあいだ子が宙に浮き、両者が同じユニークキーを送り合い続ける）。
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
   *
   * 値は端末をまたいで一意（uuid / cuid 等）であること
   * — 理由は {@link SyncConfig.primaryKey}。
   *
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
   *
   * **主キーの値は端末をまたいで一意でなければならない（uuid / cuid 等）。**
   * 連番（AUTOINCREMENT）は使えない — 別々の端末が同じ値を作るため、
   * 別物どうしが同じ行と見なされる。
   *
   * この前提は同期の同定だけでなく、**タイムスタンプが同点になったときの
   * 勝敗判定**にも効く。同点は主キーの辞書順で決めるため、両端末が同じ2つの
   * idを見て**同じ答え**に達する必要がある（違う答えに達すると、互いに相手を
   * 畳んで生き残るidが毎周入れ替わり、永久に収束しない）。
   *
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
 * スキーマバージョン不一致によりスキップされたリモートクライアントの情報。
 *
 * アプリ側でユーザー通知（「他のクライアントが別バージョンを使用中」等）に利用する。
 */
export interface SkippedRemote {
  /** スキップされたリモートのクライアントID */
  clientId: string;
  /** リモート側のスキーマバージョン。読み取れなかった場合は `null` */
  remoteVersion: string | null;
  /** ローカル側のスキーマバージョン */
  localVersion: string;
}

/**
 * 別id・同一ユニークキーの行を1つへ畳んだ記録。
 *
 * このライブラリは「ぶつかったら黙って畳む」ため、**何と何が1つになったのかを
 * 利用者へ伝えられる必要がある**（例:「小計『知識・技能』が2つあったので1つにまとめました」）。
 *
 * 三つ組（表名・消えた id・残った id）は `_id_merge` テーブルに永続化されるものと
 * 同じ形なので、あとから見返す口も同じデータから作れる。
 */
export interface RecordFold {
  /** 畳みが起きたテーブル名 */
  tableName: string;
  /** 吸収されて消えた側のid */
  losingId: string;
  /** 残った側のid */
  winningId: string;
  /**
   * この端末で実際に行が消えたかどうか。
   *
   * `false` は「敗者行をそもそもローカルに持っていなかった」場合
   * （届いた行が負けたとき）。畳みの事実は記録されるが、ローカルの行数は変わらない。
   */
  removedLocalRow: boolean;
  /**
   * この畳みで、消えた行から残った行へ**付け替えた子行の数**。
   *
   * 「2つを1つにまとめました」だけでは影響範囲が伝わらないので、数を添える
   * （例:「小計『知識・技能』を1つにまとめ、設問 47 件を付け替えました」）。
   *
   * **数えるのは自分の直接の子だけ。孫は数に入らない。**
   * 子自身が畳まれて消えた場合（付け替え先に「同じもの」が既に在り、子どうしも
   * ユニークでぶつかった場合）は、その子ぶんの {@link RecordFold} が別に1件出て、
   * 孫の数はそちらに載る。**この一覧は合計してよい**（同じ行を二度数えない）。
   *
   * 数え落としが1つだけある: 外部キーが子の主キーを兼ねる1:1のテーブルでは、
   * 付け替えで子のid自体が動く。このとき道連れで付け替わる孫は、どの `RecordFold`
   * にも載らない（行が消えたのではなく1行のidが動いただけなので、畳みとして
   * 記録されないため）。
   *
   * ローカルに敗者行が無かった場合（`removedLocalRow` が `false`）は付け替える子も
   * 居ないので 0。
   *
   * 子が親を**主キー以外のユニーク列の値**で握っている場合は、消える行と残る行が
   * その値を受け渡すため子の列を書き換えない。親が入れ替わったことに変わりはないので、
   * 引き継げた子はここに数える（引き継げなかったぶんは {@link lostChildren}）。
   */
  movedChildren: number;
  /**
   * この畳みで、残った行へ**引き継げずに失われた**直接の子の行数。
   *
   * ふつうは 0。0 でなくなるのは、子が親を**主キー以外のユニーク列の値**で
   * 握っている場合に限る。この形では、消える行と残る行がその値を受け渡すため
   * 子の列を書き換えようが無く（子は既に正しい値を持っている）、消える行の
   * `ON DELETE CASCADE` / `SET NULL` / `SET DEFAULT` が子に及んでしまう
   * （`PRAGMA defer_foreign_keys` が遅らせるのは制約の**検査**であって、
   * カスケードの**動作**ではない）。
   *
   * ライブラリは、子の参照列を一旦 NULL にして消える行から外し、削除のあとに
   * 元の値へ戻すことでこれを避ける。**外せないとき**（参照列が `NOT NULL`、
   * 子自身の主キーを兼ねている、など）だけ子が失われ、その数がここに出る。
   * 数は**削除の前後を実測した差**であり、憶測ではない。
   *
   * `movedChildren` と同じく**直接の子だけ**を数える（カスケードで一緒に消えた
   * 孫は数に入らない）。0 でない値を受け取ったら、利用者へ知らせること。
   */
  lostChildren: number;
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
  /**
   * ローカルから消えたレコード数。
   *
   * リモートのDELETE操作によるものと、ユニークキーの衝突で別の行へ**畳まれた**
   * ぶんの両方を数える（畳みも行が1つ消える）。畳んだ相手をローカルに
   * 持っていなかった場合は行が消えないので数えない。
   */
  deleted: number;
  /** LWW比較でローカルが新しかったためスキップしたレコード数 */
  skipped: number;
  /**
   * UNIQUE制約違反をLWWで解決して取り込んだレコード数。
   *
   * 同一idのUPSERTと、別id・同一ユニークキーの行を1つへ畳んだぶんの両方を、
   * **届いたレコード1件につき1** 数える（1件の取り込みが連鎖的に複数の行を
   * 畳むことがあるが、その内訳は {@link folds} を見ること）。
   */
  conflictsResolved: number;
  /**
   * 別id・同一ユニークキーの行を1つへ畳んだ一覧。
   *
   * 件数だけでは「何と何が1つになったか」を利用者へ説明できないため、
   * 畳みの中身をそのまま載せる。同じ内容は `_id_merge` にも永続化される。
   */
  folds: RecordFold[];
  /**
   * 致命的でない警告メッセージの配列。
   *
   * 同期そのものは続いているが、**利用者に伝えないと黙って消えることになる**ものが
   * ここに載る。とくに次の2つは行そのものの話なので、アプリ側で拾うこと:
   *
   * - `Dropped <表>:<id>: parent <表>:<id> is gone (ON DELETE …)` —
   *   遅れて届いた子の親（畳み先）が既に消えていたため、その子を**採らなかった**。
   *   **この行は二度と届かない** — 取り込みのカーソルはそのまま進むので、あとで親が
   *   復活しても再送はされない。しかも `REFERENCES parent(id)` と書いただけの
   *   外部キーは `NO ACTION` として報告されるため、`CASCADE` を宣言していなくても
   *   この経路に入る。**必要な行なら、この文言を拾って作り直すこと**
   * - `Kept <表>:<id> with <列> set to NULL: …` — 同じ状況で `ON DELETE SET NULL` に
   *   従い、その外部キーの**全列を NULL にして**採った
   * - `Stalemate on <表>:<id>: both sides are at <時刻> but <列> differ …` —
   *   同一主キー・同時刻で中身が割れており、**どちらも勝てない**。どちらが正しいかは
   *   ドメインの意味で決まるのでライブラリは解かない（勝手に選べば必ず片方の編集が
   *   消える）。人へ見せること。どちらかの行に触れば時刻が動いて決着する
   *
   * どちらも「その子が手元に居たら何が起きていたか」の再現であり、スキーマの
   * `ON DELETE` 宣言がそのまま扱いを決める（README「遅れて届いた子と、消えた畳み先」）。
   */
  warnings: string[];
  /**
   * スキーマバージョン不一致でスキップされたリモートクライアントの一覧。
   *
   * {@link SyncConfig.schemaVersion} 指定時のみ記録される。
   * 同一クライアントは1回のsyncにつき1エントリ。
   */
  skippedRemotes: SkippedRemote[];
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
  /** 変更日時（ISO 8601形式、ミリ秒まで。`updatedAt` と同じ精度・書式で記録される） */
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
