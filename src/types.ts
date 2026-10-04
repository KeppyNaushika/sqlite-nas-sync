/**
 * 公開型の定義と、設定の既定値。
 *
 * 利用者が渡すのは {@link SyncConfig} と、{@link discoverTables} に渡す {@link DiscoverOptions} である。
 * 受け取るのは {@link setupSync} が返す {@link SyncInstance} と、そのメソッドが返す {@link SyncResult}・{@link SyncStatus}、イベントの型（{@link SyncEvent}・{@link SyncEventCallback}）である。
 * 残りはそれらの中身である。
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
   * 値はクライアントをまたいで一意（uuid / cuid 等）であること。
   * 理由は {@link SyncConfig.primaryKey} にある。
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
   * 指定しないテーブルはデフォルト動作（`updatedAt`）。
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
   * **主キーの値はクライアントをまたいで一意でなければならない（uuid / cuid 等）。**
   * 連番（AUTOINCREMENT）は使えない。
   * 別々のクライアントが同じ値を作るため、別の行どうしが同じ行と見なされる。
   *
   * この列は、テーブルで `PRIMARY KEY` と宣言された列でなければならない。
   * 違う列が主キーと宣言されていれば、{@link setupSync} は例外を投げる。
   * 列名の大文字と小文字は区別しない。
   *
   * 主キーは1列で、`TEXT` と宣言し、`NOT NULL` を宣言するかテーブルを `WITHOUT ROWID` にすること。
   * 素の `TEXT PRIMARY KEY` は SQLite では NULL を許すので通らない。
   * `INTEGER PRIMARY KEY` も通らない。
   * 複合主キーは扱えない。
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
   * `_changelog` テーブルの行を残す日数。
   *
   * 同期の終わりに、この日数より古い行を消す。
   * ただし消すのは id の小さい方から続く古い行だけで、途中にまだ新しい行や `changedAt` を時刻として読めない行があれば、そこから先は消さない。
   * 時刻として読めない行のために消せない行があれば、`warnings` に出る。
   * NAS 上の自分のコピーを別のクライアントが書いていると分かって同期を止めた回は、消さない。
   *
   * 他のクライアントがこの日数より長くこのクライアントと同期しなかったときは、そのクライアントは次の同期でこのクライアントのコピーを丸ごと読み直す（フルマージ）。
   * 時間はかかるが、データは失われない。
   *
   * 負の数や `NaN` など日数として使えない値は、既定値に戻して `warnings` に出す。
   *
   * @defaultValue `7`
   */
  changelogRetentionDays?: number
  /**
   * 同期の終わりに呼ばれるコールバック。
   *
   * 同期が最後まで進んだ回は、`_changelog` の掃除の後に呼ばれる。
   * NAS 上の自分のコピーを別のクライアントが書いていると分かって同期を途中で止めた回も呼ばれるが、そのときは掃除をしていない。
   * 同期が例外で終わった回は呼ばれない。
   */
  onAfterSync?: (localDb: Database.Database, result: SyncResult) => void
  /**
   * アプリケーションのスキーマバージョン。
   *
   * 未指定なら、同期するテーブルの列の定義から計算したハッシュを使う。
   * どちらの場合も、このバージョンを `_sync_meta` テーブルに記録し、同期のたびに他のクライアントのものと比べる。
   * バージョンが一致しないクライアントは同期せず、{@link SyncResult.skippedRemotes} に載せる。
   *
   * @example `"20260324_002"` や `"v2.0.0"` など任意の文字列
   */
  schemaVersion?: string

  /**
   * テーブル自動検出時の警告ログコールバック。
   *
   * `id` を持つが `updatedAt` が無いテーブルが見つかった際に呼ばれる。
   * 未指定なら `console.warn` に出力される。
   */
  onDiscoveryWarning?: (message: string) => void

  /**
   * 同期する表を検出し終えたときに呼ばれる。
   *
   * 「同期するつもりの表が入っているか」「入れるつもりの無い表が混ざっていないか」を
   * 起動時に確かめるための通知で、異常ではない。**指定しなければ何も出力されない。**
   * ライブラリが利用者に断りなく標準出力へ書くことはない。
   *
   * @example
   * ```typescript
   * setupSync({
   *   …,
   *   onTablesDiscovered: (tables) => log.info(`同期する表: ${tables.join(', ')}`),
   * })
   * ```
   */
  onTablesDiscovered?: (tableNames: string[]) => void

  /**
   * 結果の変わらない転送を省くかどうか。
   *
   * `true`（既定）のとき、1回の同期で次を省く。
   *
   * - 他のクライアントのコピーを読むこと。省くのは、そのファイルが前に読んだときから変わっておらず、前に読んだときに「もう一度読んでも取り込むものが無い」と確かめてあるクライアントだけである
   * - NAS 上の自分のコピーを書き直すこと。省くのは、前に書き直してから、他のクライアントが読む内部テーブルが変わっていないときだけである。ユーザーテーブルだけが変わったときは、そこへの書き込みが内部テーブルにも記録されるので省かない
   * - バックアップからの復元を見つけるために、NAS 上の自分のコピーを読むこと。省くのは、そのファイルが自分の前回コピーしたままのときだけである
   *
   * ファイルが変わったかどうかは、ファイルの inode・大きさ・更新時刻で判断する。
   * inode を返さないファイルシステムでは判断できないので、省かない。
   *
   * 省くのは、行っても結果が変わらない転送だけで、同期の結果は変わらない。
   *
   * 次の回は、この設定に関わらず省かない。
   *
   * - `setupSync` の後の最初の同期と、そこから20回に1回の同期
   * - 前回の同期でそのクライアントの読み込みが失敗した後（そのクライアントを読む）
   * - 復元を見つけた回、NAS 上に自分のコピーが無い回、自分のコピーを別のクライアントが書き換えていた回（NAS へコピーする）
   *
   * 実際に転送した量は {@link SyncResult.transfers} で確かめられる。
   *
   * @defaultValue `true`
   */
  suppressIdleSync?: boolean
}

/**
 * 1回の同期で実際に転送したファイルの回数と量（{@link SyncResult.transfers}）。
 *
 * {@link SyncConfig.suppressIdleSync} で転送を省けているかを確かめるために使う。
 */
export interface SyncTransfers {
  /** NAS 上の自分のコピーを書き直した回数（0 か 1） */
  uploads: number
  /** 他のクライアントが読む内部テーブルが変わっていないので、NAS 上の自分のコピーの書き直しを省いた回数（0 か 1） */
  uploadsSkipped: number
  /** 他のクライアントのコピーを読んだ回数 */
  peerReads: number
  /** 他のクライアントのコピーが変わっていないので読むのを省いた回数 */
  peerReadsSkipped: number
  /** NAS 上の**自分の**コピーを読んだ回数（復元の確認と、同じ `clientId` を使う別のクライアントの確認） */
  selfReads: number
  /** 転送したファイルの大きさの合計（バイト） */
  bytes: number
}

/**
 * {@link setupSync} が返す同期インスタンス。
 *
 * 手動sync、定期sync、状態取得、イベント購読を提供する。
 */
export interface SyncInstance {
  /**
   * 同期を1回実行する。
   *
   * 次の順に行う。
   *
   * 1. NAS 上の自分のコピーを読み、バックアップからの復元を確かめる
   * 2. 他のクライアントのコピーを読み、変更を取り込む
   * 3. 取り込んだ変更をユーザーテーブルに反映する
   * 4. NAS 上の自分のコピーを書き直す。この回に取り込んだ変更もこれに載る。書き直したあと、同じ `clientId` を使う別のクライアントがそのコピーを書いていないかを確かめる
   *
   * 3 が例外になっても 4 を行ってから例外を投げる。
   *
   * 他のクライアントのコピーを開けない・読めないときは例外にせず、`warnings` に出してそのクライアントを飛ばす。
   *
   * @returns 同期結果の統計情報
   * @throws 同期の実行中に呼んだ場合（`Sync already in progress`）、NAS のディレクトリを作れない・NAS へコピーできない場合
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
   * 定期syncを止め、`setupSync` が開いた DB の接続を閉じる。
   *
   * `setupSync` は {@link SyncConfig.dbPath} を自分で開き、その接続はこのインスタンスが
   * 持ち続ける。閉じないと、プロセスが終わるまでファイルを開いたままになる（Windows では
   * そのファイルを消せない・置き換えられない）。
   *
   * 同期の実行中に呼んだときは、その同期が終わるのを待ってから閉じる。その同期が
   * 例外で終わっても、閉じることは行う（例外は {@link syncNow} の呼び出し元へ返る）。
   * 2回目以降の呼び出しは何もしない。
   *
   * 閉じたあとの {@link syncNow} と {@link start} は例外を投げる。
   */
  close(): Promise<void>
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
 * スキーマのバージョンが違うので同期しなかったクライアントの情報（{@link SyncResult.skippedRemotes}）。
 *
 * アプリケーションの利用者への通知（「他のクライアントが別のバージョンを使っている」など）に使う。
 *
 * `remoteVersion` と `localVersion` が同じなのに載ることがある。
 * そのときは、2つのクライアントが使っている sqlite-nas-sync のバージョンが違い、データの形式が合わない。
 */
export interface SkippedRemote {
  /** 同期しなかったクライアントの `clientId` */
  clientId: string
  /** そのクライアントのスキーマのバージョン（{@link SyncConfig.schemaVersion}）。読み取れなかった場合は `null` */
  remoteVersion: string | null
  /** このクライアントのスキーマのバージョン（{@link SyncConfig.schemaVersion}） */
  localVersion: string
}

/**
 * 統合された行の記録（{@link SyncResult.folds}）と、統合が解けた行の記録（{@link SyncResult.restores}）。
 *
 * 主キーの異なる2行が `UNIQUE` で衝突すると、LWW で勝った方だけをユーザーテーブルに入れる（統合）。
 * 負けた方の行はユーザーテーブルに入らないが、その行のバージョンは残る。
 * `UNIQUE` の列が別の値に変わるなどして衝突がなくなれば、統合は解け、負けていた行も次の同期でユーザーテーブルに入る。
 *
 * ユーザーテーブルに入っている方の行を `DELETE` したときは、統合されていた両方の主キーが削除される（原則3）。
 * このときは統合が解けてもユーザーテーブルに入らないので、`restores` には出ない。
 *
 * どの行が統合されたかは、アプリケーションの利用者に伝える必要がある（例:「小計『知識・技能』が2つあったので、片方だけを表示しています」）。
 */
export interface RecordFold {
  /** 衝突が起きたテーブル名 */
  tableName: string
  /** ユーザーテーブルに入らなくなった行の主キー。`restores` では、統合が解けて入るようになった行の主キー */
  losingId: string
  /**
   * ユーザーテーブルに入っている方の行の主キー。
   * `restores` では、統合されていた間にユーザーテーブルに入っていた方の行の主キー。
   * どの行と衝突したかを特定できなかったときは空文字列 `''` になる。
   */
  winningId: string
}

/**
 * 親行が削除されているためにユーザーテーブルに入らなくなった子行、または再び入った子行の記録（{@link SyncResult.parentDeleted}・{@link SyncResult.parentReturned}）。
 *
 * 親行の削除と並行に他のクライアントで書かれた子行は、どのアプリケーションも削除していないので削除しない（原則4、付則3）。
 * 親行が削除されている間は、宣言された `ON DELETE` に従ってユーザーテーブルに入らない。
 * 子行の変更は保持しているので、親行が同じ主キーで書き直されてその書き直しが勝てば、子行は元の形でユーザーテーブルに入る。
 */
export interface ParentDeletedRecord {
  /** 子行のテーブル名 */
  tableName: string
  /** 子行の主キー */
  recordId: string
  /** 子行の内容。列名から値への対応。同期の時点で保持している変更の内容である */
  content: Record<string, unknown>
  /** 削除されている親行のテーブル名。孫の行では、削除された大元の行のテーブル名になる */
  causeTable: string
  /** 削除されている親行の主キー。孫の行では、削除された大元の行の主キーになる */
  causeId: string
}

/**
 * 同期実行の結果統計。
 *
 * {@link SyncInstance.syncNow} の戻り値として返される。
 */
export interface SyncResult {
  /**
   * この回に同期した他のクライアントの数。
   *
   * 前回から変わっていないので読むのを省いたクライアントも数える。
   * スキーマのバージョンが違うクライアントと、開けなかった・同期に失敗したクライアントは数えない。
   */
  clientsSynced: number
  /**
   * この回にユーザーテーブルへ新しく入った行の数。
   *
   * 同期の途中でアプリケーションが書き込むと、その回はユーザーテーブルへの反映を見送り、0 になる。
   * 取り込んだ変更は次の同期で反映される。
   * `updated` と `deleted` も同じである。
   */
  inserted: number
  /**
   * この回にユーザーテーブルで内容が変わった行の数。
   *
   * 主キーが同じで、いずれかの列の値が変わった行を数える。
   */
  updated: number
  /**
   * この回にユーザーテーブルから外れた行の数。
   *
   * 削除された行のほか、統合されてユーザーテーブルに入らなくなった行と、親行が削除されているためにユーザーテーブルに入らなくなった子行も数える。
   * これらの行のバージョンは残っているので、統合が解けるか親行が書き直されれば、ユーザーテーブルに戻る（`restores`・`parentReturned`）。
   */
  deleted: number
  /**
   * 他のクライアントから届いた変更のうち、取り込まなかったものの数。
   *
   * 手元のバージョンが LWW で勝ったか、同じバージョンをすでに持っていたものを、主キーごとに数える。
   */
  skipped: number
  /**
   * 他のクライアントから届いた変更のうち、手元の同じ主キーのバージョンに LWW で勝って置き換えたものの数。
   *
   * 主キーごとに数える。
   * 手元にその主キーのバージョンが無かったものは数えない。
   */
  conflictsResolved: number
  /**
   * この回に新しく統合された行（{@link RecordFold}）。
   *
   * `losingId` がユーザーテーブルに入らなくなった行、`winningId` がユーザーテーブルに入っている方の行である。
   */
  folds: RecordFold[]
  /**
   * この回に統合が解けてユーザーテーブルに入った行（{@link RecordFold}）。
   *
   * `losingId` がユーザーテーブルに入るようになった行、`winningId` は統合されていた間にユーザーテーブルに入っていた方の行である。
   *
   * 統合が解けてもユーザーテーブルに入らなかった行は載らない。
   * ユーザーテーブルに入っていた方の行が `DELETE` されて両方の主キーが削除された場合（原則3）、`NOT NULL` などの制約でユーザーテーブルに入れられない場合（`warnings` の `Unplaceable`）、親行が削除されている場合（`parentDeleted`）がこれにあたる。
   */
  restores: RecordFold[]
  /**
   * この回に、親行が削除されているためにユーザーテーブルに入らなくなった子行（原則4。{@link ParentDeletedRecord}）。
   *
   * 親行の削除と並行に他のクライアントで書かれた子行がこれにあたる。
   * 親行を `DELETE` したクライアントにその時点であった子行は、SQLite が `ON DELETE` に従って削除または更新するので、ここには載らない。
   * `ON DELETE SET NULL` で列を NULL にできる子行や、`ON DELETE SET DEFAULT` で列を既定値にできる子行は、その形でユーザーテーブルに入るので載らない。
   *
   * 前回の同期からの変化だけを載せる。
   * 同じ子行が他のクライアントから再び届いても、入らないままであればもう一度は載らない。
   * 親行が削除される前にユーザーテーブルに入っていなかった子行も、この回に親行が削除されているとわかれば載る。
   */
  parentDeleted: ParentDeletedRecord[]
  /**
   * この回に、親行が同じ主キーで書き直されたので、再びユーザーテーブルに入った子行（原則4。{@link ParentDeletedRecord}）。
   *
   * `causeTable` と `causeId` は、それまで削除されていた親行である。
   * 親行が書き直されても、`NOT NULL` などの制約や統合でユーザーテーブルに入らない子行は載らない。
   * 入らなくなった子行そのものがその後に `DELETE` されたときも載らない。
   */
  parentReturned: ParentDeletedRecord[]
  /**
   * 致命的でない警告メッセージの配列。
   *
   * 同期は続いているが、利用者に伝えないと気づかれないまま残る問題がここに載る。
   * アプリケーションの利用者に見える場所へ出すこと。
   * 出るのは次のとおりである。
   *
   * `setupSync` で見つかったもの（`setupSync` の後の最初の同期の結果にだけ載る）:
   *
   * - 同期するテーブル、または同期するテーブルを親とするテーブルに、親行のない子行がある。この状態で同期を始めると、その子行はユーザーテーブルから外れる（バージョンは残る）
   * - 同期しないテーブルに、親行のない子行がある
   * - 時刻列に、現在より1年以上先の時刻がある
   * - `_sns_rebuilding` に行が残っていたので消した（前回の同期がユーザーテーブルへの反映の途中で止まった可能性がある）
   * - テーブルに増えた列が `NOT NULL` で、既定値が定数でない
   *
   * 同期のたびに調べるもの:
   *
   * - `changelogRetentionDays: … is not a usable number of days, falling back to …` — 設定値が使えないので既定値に戻した
   * - ローカルの DB がバックアップから戻された形跡がある（NAS 上の自分のコピーに記録した値より、ローカルの DB の値が小さい）。NAS 上の自分のコピーを読めず、これを確かめられなかったときも出る
   * - 同期の仕組み（内部テーブルの行・トリガー）が欠けていた。欠けていたものを作り直し、作り直したことも出る。作り直しに伴う警告も出る
   * - NAS 上の自分のコピーが、同じ `clientId` を使う別のクライアントに書き換えられている。**この警告が出た回は同期を途中で止める**
   * - `Failed to open remote database: <clientId>` — そのクライアントのコピーを開けなかった
   * - `Skipping client <clientId>: schema version mismatch (local=…, remote=…)` — スキーマのバージョンが違うので同期しなかった（`skippedRemotes` にも載る）
   * - `Skipped remote <clientId>: …` / `Skipped table <テーブル>: …` — そのクライアント、またはそのテーブルを今回は同期できなかった
   * - `Sync failed for client <clientId>: …` — そのクライアントからの取り込みが失敗した。次の同期で読み直す
   * - `Rebuild deferred: …` — 同期の途中でアプリケーションが書き込んだので、ユーザーテーブルへの反映を見送った。次の同期で反映する。3回続くと、次の同期では反映の計算と書き込みを1つのトランザクションで行うので、その間はアプリケーションの書き込みが待たされる
   * - `Rebuild failed: …` — 外部キーの違反が残るので、そのテーブルへの反映をやめた
   * - `Unplaceable <テーブル>:<主キー>: <理由>` — その行は `NOT NULL`・`CHECK`・親行がまだ届いていないことなどでユーザーテーブルに入らなかった。変更は保持しているので、原因がなくなれば次の同期でユーザーテーブルに入る。親行が削除されているために入らない子行は、ここではなく `parentDeleted` に出る
   * - `_changelog id=… has an unparseable changedAt …` — `changedAt` を時刻として読めない行があり、その先の古い行を `_changelog` から消せない
   */
  warnings: string[]
  /**
   * スキーマのバージョンが違うので同期しなかったクライアントの一覧（{@link SkippedRemote}）。
   *
   * {@link SyncConfig.schemaVersion} を指定していなくても、自動で計算したバージョンで比べて記録する。
   * 同じクライアントは1回の同期につき1エントリ。
   */
  skippedRemotes: SkippedRemote[]
  /**
   * この回に、フルマージ（他のクライアントのコピーのすべての行を読み直す）をしたクライアントがあったかどうか。
   *
   * `_changelog` だけでは足りなかったクライアントのほか、**まだ一度も読んでいないクライアント**もフルマージで読むので `true` になる。
   * `setupSync` の後の最初の同期では、すべてのクライアントを一度も読んでいない扱いにする。
   */
  hadChangelogGap: boolean
  /**
   * この回に実際に転送したファイルの回数と量（{@link SyncTransfers}）。
   *
   * {@link SyncConfig.suppressIdleSync} で転送を省けているかを確かめるために使う。
   */
  transfers: SyncTransfers
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
 * `_changelog` テーブルの1行のうち、同期が読む列。
 *
 * 表には `operation` と `changedAt` もあるが、差分の範囲を決めるのに要るのはこの3列だけである。
 * `changedAt` は掃除（`cleanupChangelog`）が SQL の中で読む。
 * @internal
 */
export interface ChangelogEntry {
  /** changelogのオートインクリメントID */
  id: number
  /** 変更が発生したテーブル名 */
  tableName: string
  /** 変更されたレコードの主キー値 */
  recordId: string
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
 * - `timestampColumn`: `'updatedAt'`
 */
export const DEFAULTS = {
  primaryKey: 'id',
  intervalMs: 30000,
  changelogRetentionDays: 7,
  timestampColumn: 'updatedAt',
} as const
