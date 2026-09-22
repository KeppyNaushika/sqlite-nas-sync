/**
 * 公開型の定義と、設定の既定値。
 *
 * 利用者が触れるのは {@link SyncConfig} と {@link SyncResult} の2つで、残りは
 * その中身か、結果に載る内訳（{@link RecordFold}）である。
 *
 * ここの doc は**利用者向けの説明そのもの**として読まれる（typedoc がそのまま
 * APIリファレンスへ出す）。実装の都合ではなく、「何が起きるか」「どう設定するか」を書く。
 *
 * @module types
 */
import Database from 'better-sqlite3'

/**
 * テーブル別の同期設定。
 *
 * `discoverTables` の戻り値、および内部の同期処理で利用される。
 * ユーザーが直接構築することは通常無く、{@link SyncConfig.tableOptions}
 * 経由で部分指定する。
 */
export interface TableConfig {
  /** テーブル名 */
  name: string
  /**
   * LWW比較に使うタイムスタンプカラム名。
   * @defaultValue `'updatedAt'`
   */
  timestampColumn?: string
  /**
   * `true` の場合、この表では**削除の版が表示の計算で勝たない**。
   *
   * 行の版がある限り、その行はアプリの表に置かれる。つまり**アプリがその行を消しても、
   * 次の作り直しで置き直される**（消した端末でも戻る）。削除の事実そのものは
   * `_tombstone` に格納されるので、設定を外せばそのとき初めて削除が効く。
   *
   * 旧方式（v0.19 まで）の「利用者操作による削除を**他端末から**適用しない」とは
   * 意味が違う。旧方式では消した端末ではその行は消えたままだった。
   *
   * **設定は全端末で同じであること。** 違うと、同じ事実の集まりから端末ごとに違う
   * 表示が出る。食い違いは取り込みのときに検出して `warnings` へ名指しで出すが、
   * 同期は止めない（止めると、設定を直すための版すら届かなくなる）。
   */
  deleteProtected?: boolean
}

/**
 * テーブル別のオプション指定。
 *
 * {@link SyncConfig.tableOptions} で利用する、{@link TableConfig} から
 * `name` を除いた形。
 */
export type TableOptions = Omit<TableConfig, 'name'>

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
  primaryKey?: string
  /**
   * 検出から除外するテーブル名の配列。
   * ローカル専用キャッシュ等を持つ場合に使用。
   * @defaultValue `[]`
   */
  excludeTables?: string[]
  /**
   * テーブル別の追加オプション。
   * 指定しないテーブルはデフォルト動作（`updatedAt` / `deleteProtected: false`）。
   * @defaultValue `{}`
   */
  tableOptions?: Record<string, TableOptions>
  /**
   * `id` を持つが `updatedAt`（または指定 `timestampColumn`）が無いテーブルを
   * 検出した際の警告コールバック。指定しなければ `console.warn` に出力される。
   *
   * 警告はあくまで「同期対象から外しました」の通知であり、エラーではない。
   * 意図的に除外したい場合は {@link excludeTables} を使えば警告も抑制される。
   */
  onWarning?: (message: string) => void
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
  dbPath: string
  /** NAS上の共有ディレクトリパス */
  nasPath: string
  /** このクライアントの一意識別子（UUID推奨） */
  clientId: string
  /**
   * 自動検出から除外するテーブル名の配列。
   * @defaultValue `[]`
   */
  excludeTables?: string[]
  /**
   * テーブル別の追加オプション。
   * 指定しないテーブルはデフォルト動作。
   * @defaultValue `{}`
   */
  tableOptions?: Record<string, TableOptions>
  /**
   * 主キーカラム名。全対象テーブルで共通。
   *
   * **主キーの値は端末をまたいで一意でなければならない（uuid / cuid 等）。**
   * 連番（AUTOINCREMENT）は使えない — 別々の端末が同じ値を作るため、
   * 別物どうしが同じ行と見なされる。
   *
   * 列は**1列で、`NOT NULL` を宣言していること**。素の `TEXT PRIMARY KEY` は
   * SQLite では NULL を許すので、これに当たらない（`INTEGER PRIMARY KEY` か
   * `WITHOUT ROWID` でも通る）。複合主キーは扱えない。
   *
   * @defaultValue `'id'`
   */
  primaryKey?: string
  /**
   * 定期sync間隔（ミリ秒）。{@link SyncInstance.start} で使用される。
   * @defaultValue `30000`
   */
  intervalMs?: number
  /**
   * `_changelog` テーブルの保持期間（日数）。
   * この日数より古いエントリはsync後に自動削除される。
   * @defaultValue `7`
   */
  changelogRetentionDays?: number
  /**
   * sync完了後に呼ばれるコールバック。
   * changelog掃除の後に実行される。
   */
  onAfterSync?: (localDb: Database.Database, result: SyncResult) => void
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
  schemaVersion?: string

  /**
   * heartbeat 機能を有効にするかどうか。
   *
   * `true` の場合、sync時に当日のheartbeatが未実行であれば
   * `_heartbeat` テーブルを更新し、changelogにエントリを追加する。
   * これによりchangelogが7日間で空になるのを防止する。
   *
   * @defaultValue `true`
   */
  heartbeatEnabled?: boolean

  /**
   * テーブル自動検出時の警告ログコールバック。
   *
   * `id` を持つが `updatedAt` が無いテーブルが見つかった際に呼ばれる。
   * 未指定なら `console.warn` に出力される。
   */
  onDiscoveryWarning?: (message: string) => void

  /**
   * 変わっていないときの転送を落とすかどうか。
   *
   * `true`（既定）のとき、1回の同期で次を省く:
   *
   * - 前に読んだときから**相手のファイルが変わっていない**なら、写さない
   * - 前に上げたときから**手元が変わっていない**なら、上げない
   * - NAS 上の自分の写しが自分の書いたままなら、復元の判定で読み直さない
   *
   * 省くのは「やっても何も変わらない回」だけで、同期の結果
   * （{@link SyncResult} の中身・最終的な収束）は変わらない。判断の根拠と
   * 見逃しへの備えは `src/sync/idle.ts` にある。
   *
   * **起動直後・前回の失敗・版や `deleteProtected` の変化・フルマージが要る相手・
   * 一定回数ごと**は、この設定に関わらず必ず読み・上げる。
   *
   * @defaultValue `true`
   */
  suppressIdleSync?: boolean
}

/**
 * 1回の同期で実際に動かしたファイルの数と量（{@link SyncResult.transfers}）。
 *
 * 抑制が効いているかを**測る**ための数え上げである。
 */
export interface SyncTransfers {
  /** NAS へ自分の DB を上げた回数（0 か 1） */
  uploads: number
  /** 手元が変わっていないので上げずに済ませた回数（0 か 1） */
  uploadsSkipped: number
  /** 相手の写しを手元へ写した回数 */
  peerReads: number
  /** 相手が変わっていないので写さずに済ませた回数 */
  peerReadsSkipped: number
  /** NAS 上の**自分の**写しを手元へ写した回数（復元・取り合いの確認） */
  selfReads: number
  /** 上げた・写したファイルの大きさの合計（バイト） */
  bytes: number
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
   * ローカルDBのNASコピー → リモートの `_sns_rows_*` / `_tombstone` の取り込み
   * → アプリの表の作り直し、の一連の処理を行う。
   *
   * @returns 同期結果の統計情報
   * @throws 同期中に再度呼び出した場合、またはNASアクセス不可時
   */
  syncNow(): Promise<SyncResult>
  /**
   * 定期syncを開始する。
   *
   * {@link SyncConfig.intervalMs} 間隔で {@link syncNow} を繰り返し実行する。
   * 既に開始済みの場合は何もしない。
   */
  start(): void
  /**
   * 定期syncを停止する。
   *
   * {@link start} で開始したインターバルをクリアする。
   */
  stop(): void
  /**
   * 現在の同期状態を取得する。
   * @returns 同期状態のスナップショット
   */
  getStatus(): SyncStatus
  /**
   * このインスタンスが同期対象として認識しているテーブル名の一覧を返す。
   *
   * `setupSync` 時に `discoverTables` で検出された結果のスナップショット。
   * マージ処理など、ライブラリ外で同じテーブル集合を扱いたい場合に利用する。
   */
  getSyncedTables(): string[]
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
  on(event: SyncEvent, callback: SyncEventCallback): void
}

/**
 * スキーマバージョン不一致によりスキップされたリモートクライアントの情報。
 *
 * アプリ側でユーザー通知（「他のクライアントが別バージョンを使用中」等）に利用する。
 */
export interface SkippedRemote {
  /** スキップされたリモートのクライアントID */
  clientId: string
  /** リモート側のスキーマバージョン。読み取れなかった場合は `null` */
  remoteVersion: string | null
  /** ローカル側のスキーマバージョン */
  localVersion: string
}

/**
 * 同じ重複禁止の値でかぶった行のうち、**アプリの表に置かれなくなった行**の記録
 * （{@link SyncResult.folds}）と、**置かれるように戻った行**の記録
 * （{@link SyncResult.restores}）。
 *
 * 案A では行を1つへ畳まない。かぶった行は版の順序の強い順に置き、置けなかった行は
 * 隠れた行になるだけで、**事実（版）は残り続ける**。勝者が消えたり版の順序が
 * 入れ替わったりすれば、次の作り直しで表へ戻る。
 *
 * 何が隠れた／戻ったのかは利用者に伝わる必要がある
 * （例:「小計『知識・技能』が2つあったので、片方だけを表示しています」）。
 */
export interface RecordFold {
  /** かぶりが起きたテーブル名 */
  tableName: string
  /** 隠れた側（`folds`）／隠れていた側（`restores`）のid */
  losingId: string
  /** アプリの表に置かれている勝者のid */
  winningId: string
}

/**
 * 同期実行の結果統計。
 *
 * {@link SyncInstance.syncNow} の戻り値として返される。
 */
export interface SyncResult {
  /** 今回の同期で処理したリモートクライアント数 */
  clientsSynced: number
  /**
   * **作り直し**でアプリの表へ入れた行数（v0.20.0 で意味が変わった）。
   *
   * 案A では、取り込みは `_sns_rows_*` などの帳簿にしか書かず、アプリの表は
   * そのあとの**作り直し**が丸ごと入れ替える。数えるのは入れ替える前の
   * アプリの表と計画の突き合わせで、「計画にあって表に無かった行」である。
   * 作り直しを見送った回は 0 になる（事実は取り込めているので、次の回に出る）。
   */
  inserted: number
  /**
   * 作り直しで**中身が入れ替わった**行数（v0.20.0 で意味が変わった）。
   *
   * 主キーは同じで、いずれかの列の値が違っていた行を数える。
   */
  updated: number
  /**
   * 作り直しでアプリの表から**消えた**行数（v0.20.0 で意味が変わった）。
   *
   * 削除の版が勝った行のほか、**隠れた行**（同じユニークキーで負けた行）も
   * ここに入る。案A では隠れた行の**事実は消えない** —— アプリの表に
   * 置かれないだけで、勝った行が消えれば次の作り直しで戻ってくる。
   */
  deleted: number
  /**
   * 取り込みで**手元の版の方が強かった**キーの数（v0.20.0 で意味が変わった）。
   *
   * 相手が主張したのに `Max`（行の版と削除の版の強い方）が変わらなかった数。
   */
  skipped: number
  /**
   * 取り込みで、**手元にも版があったのに相手の版に入れ替わった**キーの数
   * （v0.20.0 で意味が変わった）。
   *
   * 案A に UNIQUE 違反の解決は無い（かぶりは畳まず、勝者以外を隠す）。
   * ここに出るのは「同じキーを2つの端末が別々に書いていて、版の順序で決着した」数である。
   */
  conflictsResolved: number
  /**
   * この回に**新しく隠れた行**の一覧（v0.20.0 で意味が変わった）。
   *
   * 案A は行を畳まない。同じユニークキーでかぶった行は、版の順序の弱い方が
   * アプリの表に置かれなくなる（`_sns_hidden`）だけで、事実は残り続ける。
   * `losingId` が隠れた行、`winningId` が置かれている勝者である。
   */
  folds: RecordFold[]
  /**
   * この回に**隠れなくなった行**の一覧（v0.20.0 で追加）。
   *
   * 勝者が消えた・版の順序が入れ替わったなどで、隠れていた行がアプリの表へ
   * 戻ったもの。`folds` と同じ形で、`winningId` は隠れていたときの勝者。
   */
  restores?: RecordFold[]
  /**
   * 致命的でない警告メッセージの配列。
   *
   * 同期そのものは続いているが、**利用者に伝えないと黙って消えることになる**ものが
   * ここに載る。出るのは次のとおり:
   *
   * - `Unplaceable <表>:<id>: <理由>` — その行は NOT NULL・CHECK・親の不在などで
   *   アプリの表に置けなかった。**事実は残っている**ので、原因が解ければ次の
   *   作り直しで置かれる
   * - `Rebuild deferred: …` — 計算のあいだに書き込みがあったので作り直しを見送った。
   *   次の同期で当たる。3回続くと、計算と適用を1つのトランザクションで行う経路へ落ちる
   * - `Rebuild failed: …` — 外部キーの違反が残るので、その表を作り直しの対象から外した
   * - `Skipped remote <id>: …` / `Skipped table <表>: …` — その相手・その表を
   *   今回は読めなかった
   * - `deleteProtected が <id> と食い違っている …` — 設定は全端末で揃えること
   *   （違うと同じ事実から端末ごとに違う表示が出る）
   * - 復元・巻き戻り・仕掛けの欠け・写しの取り合いの検出。
   *   **写しの取り合いは同期を止める**
   * - `changelogRetentionDays: … is not a usable number of days …` — 設定を
   *   既定値へ戻した
   */
  warnings: string[]
  /**
   * スキーマバージョン不一致でスキップされたリモートクライアントの一覧。
   *
   * {@link SyncConfig.schemaVersion} 指定時のみ記録される。
   * 同一クライアントは1回のsyncにつき1エントリ。
   */
  skippedRemotes: SkippedRemote[]
  /**
   * この回に、フルマージ（相手の `_sns_rows_*` と `_tombstone` を丸ごと読み直す）
   * へ落ちた相手が居たかどうか。
   *
   * `_changelog` に隙間があった相手のほか、**まだ一度も読んでいない相手（初回）**も
   * フルマージで読むので `true` になる。
   */
  hadChangelogGap: boolean
  /**
   * この回に実際に動かしたファイルの数と量（v0.20.1 で追加）。
   *
   * 無駄な転送の抑制が効いているかを測るために載せている。
   */
  transfers?: SyncTransfers
}

/**
 * 同期インスタンスの現在の状態。
 *
 * {@link SyncInstance.getStatus} で取得する。
 */
export interface SyncStatus {
  /** 現在syncが実行中かどうか */
  isSyncing: boolean
  /** 最後にsyncが正常完了した時刻。未実行の場合は `null` */
  lastSyncedAt: Date | null
  /** 最後のsync結果。未実行の場合は `null` */
  lastResult: SyncResult | null
  /** {@link SyncInstance.start} による定期syncが有効かどうか */
  isRunning: boolean
}

/**
 * 同期イベントの種別。
 *
 * | イベント | 発火タイミング | コールバック引数 |
 * |---|---|---|
 * | `sync:start` | sync開始時 | なし |
 * | `sync:complete` | sync正常完了時 | {@link SyncResult} |
 * | `sync:error` | syncエラー時 | `Error` |
 */
export type SyncEvent = 'sync:start' | 'sync:complete' | 'sync:error'

/**
 * {@link SyncInstance.on} に渡すイベントコールバック関数の型。
 * @param data - イベントに応じたデータ。イベント種別により型が異なる。
 */
export type SyncEventCallback = (data?: unknown) => void

// --- 内部型 ---

/**
 * `_changelog` テーブルの1行を表す内部型。
 *
 * SQLiteトリガーによりINSERT/UPDATE/DELETE操作ごとに自動記録される。
 * @internal
 */
export interface ChangelogEntry {
  /** changelogのオートインクリメントID */
  id: number
  /** 変更が発生したテーブル名 */
  tableName: string
  /** 変更されたレコードの主キー値 */
  recordId: string
  /** 操作種別 */
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  /** 変更日時（ISO 8601形式、ミリ秒まで。`updatedAt` と同じ精度・書式で記録される） */
  changedAt: string
}

/**
 * `_sync_state` テーブルの1行を表す内部型。
 *
 * リモートクライアントごとにどこまでchangelogを処理したかを記録する。
 * @internal
 */
export interface SyncStateEntry {
  /** リモートクライアントの識別子 */
  remoteClientId: string
  /** 最後に処理したchangelog ID */
  lastSeenId: number
  /** 最後にsyncした日時 */
  lastSyncedAt: string | null
}

/**
 * NAS上のリモートクライアントDB情報。
 * @internal
 */
export interface RemoteClient {
  /** クライアント識別子（ファイル名から抽出） */
  clientId: string
  /** DBファイルの絶対パス */
  filePath: string
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
} as const
