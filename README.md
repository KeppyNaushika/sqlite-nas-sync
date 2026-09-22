# sqlite-nas-sync

複数クライアント間でNASを経由してSQLiteデータベースを安全に同期するためのnpmパッケージです。

## 概要

NAS環境で複数のクライアント（PC、サーバー、Electronアプリなど）が同じSQLiteデータベースを共有したい場合、直接同じファイルにアクセスするとロック競合やデータ破損のリスクがあります。

`sqlite-nas-sync` では、各クライアントがローカルのSQLiteファイルで作業します。同期する表ごとに
**行の版の表**（`_sns_rows_<表>`）を持ち、アプリの書き込みをトリガーがそこへ版として写します。
他の端末とやり取りするのはこの版の表と削除の記録だけで、アプリの表そのものは**版から作り直します**。

## 特徴

- **ローカルファーストアーキテクチャ**: 各クライアントはローカルDBで高速に読み書き
- **テーブル自動検出**: DBから同期対象テーブルを自動的に検出（手書きリスト不要）
- **事実と表示の分離**: 同期が触るのは版の表と削除の記録だけ。アプリの制約（UNIQUE・外部キー・NOT NULL）で取り込みが失敗しません
- **行を畳みません**: 重複禁止の値がかぶった行は、片方が表に置かれなくなるだけで、事実は消えません
- **決定論的に収束**: 版の順序（時刻 → Lamport → 端末id）は全端末で同じ答えになります
- **定期同期**: `start()` / `stop()` による自動定期同期
- **アトミックコピー**: `backup()` APIでNASへの安全な書き込み

## インストール

```bash
npm install sqlite-nas-sync
```

**注意**: `better-sqlite3` がpeerDependencyです。別途インストールしてください。

```bash
npm install better-sqlite3
```

## クイックスタート

```typescript
import { setupSync } from 'sqlite-nas-sync'

const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  // tables の指定は不要 — DBから自動検出されます
})

// 手動同期
const result = await sync.syncNow()
console.log(`${result.inserted} inserted, ${result.updated} updated`)

// 定期同期（デフォルト30秒間隔）
sync.start()

// 停止
sync.stop()
```

## 動作の仕組み

### 同期する表ごとに「行の版の表」を持つ

`setupSync` は、同期する表 `t` ごとに `_sns_rows_t` を作ります。中身はアプリの列（生成列を除く）に、
版を表す3つの列を足したものです。

| 列              | 意味                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `_sns_ts`       | 順序に使う時刻。アプリが時刻列へ書いた値か、**それ以上に強い値へ引き上げた値** |
| `_sns_lamport`  | その端末の論理時計                                                             |
| `_sns_instance` | `setupSync` のたびに作り直す端末の識別子                                       |

版の強さは `_sns_ts` → `_sns_lamport` → `_sns_instance` の順に比べます。この3つ組はどの端末で比べても
同じ答えになるので、同じ事実の集まりからは同じ結論が出ます。

### トリガーが版を書く

同期する表には4本のトリガー（INSERT / UPDATE×2 / BEFORE DELETE）が付きます。アプリが表へ書くと、
その内容が `_sns_rows_<表>` へ版として写り、削除なら `_tombstone` へ**削除の版**が書かれます。

原因は問いません。利用者の削除も、`ON DELETE CASCADE` で消えた子・孫も、`SET NULL` / `SET DEFAULT` /
`ON UPDATE` による書き換えも、`INSERT OR REPLACE` が追い出した行も、すべて等しく事実になります。

このため **アプリの表を書くすべての接続で `PRAGMA recursive_triggers = ON` が必要です**
（[利用者が守ること](#利用者が守ること前提)）。

### 他の端末は版の表と削除の記録だけを読む

取り込みは、相手の `_sns_rows_*` と `_tombstone` を突き合わせ、キーごとに**行の版と削除の版の強い方**を
取って手元の帳簿へ書きます。書き込む先はライブラリの表だけなので、アプリの UNIQUE・外部キー・NOT NULL で
取り込みが失敗することはありません。

`_changelog` は事実そのものではなく、**読み直すキーの通知**です。保持期間を過ぎたぶんは刈られますが、
取りこぼした相手は隙間の検出でフルマージ（相手の `_sns_rows_*` を丸ごと読み直す）に落ちるため、
刈っても事実は失われません。

### アプリの表は作り直す

取り込みが終わったあと、**別のトランザクション**でアプリの表を版から組み直します。計算は
`worker_threads` で行い、適用は「その表の消す行と入れる行をまとめて当てる」形（実質は表全体の入れ替え）です。
UNIQUE の値の入れ替え（`A=t1, B=t2` → `A=t2, B=t1`）が通るのはこのためです。

- 取り込みと作り直しは別のトランザクションなので、**作り直しが失敗しても取り込んだ事実は残ります**
- 計算の途中でアプリが書き込むと、その回の作り直しは見送られます（`Rebuild deferred …`）。次の同期で当たります
- 適用の間、**アプリのトリガーは外されます**（[制限事項](#制限事項) 7）

### 重複禁止の値がかぶっても畳みません

2つの端末が別々の id で「同じもの」を作ると、`id` は違うのに UNIQUE の値が同じ行が2つできます。
このライブラリは**片方を消しません**。版の順序の強い順にアプリの表へ置き、置けなかった行を
**隠れた行**にします。

- 隠れた行の事実（版）は残り続けます。勝者が消えたり、版の順序が入れ替わったりすれば、
  次の作り直しで表へ戻ります
- どちらが置かれるかは版の順序だけで決まるので、**全端末で同じ行が置かれます**
- 新しく隠れた行は `SyncResult.folds` に、隠れなくなった行は `SyncResult.restores` に出ます。
  利用者へ見せてください
- NOT NULL や CHECK、親の不在などで表に置けなかった行は `Unplaceable <表>:<id>: <理由>` として
  `SyncResult.warnings` に出ます。これも事実は残るので、原因が解ければ次の作り直しで置かれます

### 削除は id で行う

削除は「その id を消す」であって「その UNIQUE の値のものを消す」ではありません。隠れた行は
その端末のアプリの表に見えないので消せません。見えている端末で消せばその id の削除の版ができ、
他の端末でも同じ id の `Max` が削除になります。

### DB に増える表

```
ローカル/
└── local.sqlite            # アプリが参照するDB
    ├── _sns_rows_<表>       # 同期する表ごとの、生きている id の最強の版（他端末が読む）
    ├── _tombstone           # 削除の版（他端末が読む）
    ├── _changelog           # 読み直すキーの通知（他端末が読む）
    ├── _changelog_prune     # どこまで刈ったか（他端末が読む）
    ├── _heartbeat           # 生存（他端末が読む）
    ├── _sync_meta           # スキーマ版・端末id・世代（他端末が読む）
    ├── _sync_state          # リモートごとの同期進捗
    └── _sns_clock / _sns_tick / _sns_shown / _sns_hidden /
        _sns_unplaceable / _sns_dirty / _sns_rebuilding   # 時計・作り直しの出力・対象・旗
```

NAS 上には `<clientId>.sqlite` というファイル名で各端末の写しが並びます。

### 同期フロー

```
syncNow() 実行時：
  1. 復元・巻き戻り・仕掛けの欠けを見る（取り込みより前に）
  2. NAS 上の自分の写しに印を付け、backup() で書き、写しの取り合いが無いか確かめる
  3. NAS 上の他クライアントDBを列挙
  4. 各リモートクライアントについて：
     - スキーマ版が違う相手は丸ごと見送る
     - _sync_state の lastSeenId から読む範囲を決める
       → 初回・隙間あり: フルマージ（相手の _sns_rows_* と _tombstone の全部）
       → それ以外: _changelog が通知したキーだけ
     - 行の版と削除の版の Max を取って帳簿へ書く（1トランザクション）
  5. 別のトランザクションでアプリの表を作り直す
  6. heartbeat、古い _changelog の掃除、onAfterSync
```

#### 一時領域の使い方

NAS上のDBファイルは**直接開きません**。他クライアントが atomic copy の rename を
している最中に読むと、I/Oエラーや「database is locked」になるためです。代わりに
`os.tmpdir()/sqlite-nas-sync/remote-<PID>-<時刻>-<乱数>.sqlite` へコピーし、
そのコピーを読み取り専用で開きます。

コピーは読み終えた時点で、WALの副ファイル（`-wal` / `-shm`）まで含めて消します。
置き場所を変えたい場合は環境変数 `TMPDIR`（Windowsでは `TEMP` / `TMP`）で指定できます
—— Node.js の `os.tmpdir()` がそれを見ます。

`SIGKILL` や電源断で終了するとコピーが残りますが、`setupSync()` が起動時に
「PIDが既に死んでいるもの」を掃除します。同じ機械で複数のクライアントを動かしても、
**生きているプロセスが使っている最中のコピーは消しません**。

## テーブル自動検出

`setupSync` は DB を introspect して同期対象テーブルを自動的に決定します。
明示的なテーブル一覧の指定は不要です。

### 検出条件

以下を**全て**満たすテーブルが同期対象になります。

1. テーブル名が `_` または `sqlite_` プレフィックスでない（内部テーブルを除外）
2. `excludeTables` に含まれていない
3. **主キーカラム（既定: `id`）が存在し、TEXT型である**（UUID、cuid等）
4. **タイムスタンプカラム（既定: `updatedAt`）が存在する**

### 警告される条件

`id` カラムを持つが `updatedAt` が無いテーブルは「同期したかったのに `updatedAt`
を付け忘れた」可能性があるため、検出時に警告ログが出力されます。
意図的に除外したい場合は `excludeTables` に追加すると警告も止まります。

### Prismaスキーマ例

```prisma
model User {
  id        String    @id @default(uuid())
  name      String
  email     String
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Post {
  id        String    @id @default(cuid())
  title     String
  content   String
  userId    String
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

Prisma の `@id` は `NOT NULL` を宣言するので、[利用者が守ること](#利用者が守ること前提) 2 を満たします。

## 利用者が守ること（前提）

`setupSync` は起動時にこれらを確かめ、**破れていれば例外**、気がかりなら `SyncResult.warnings` で
知らせます。ここで断るのは「通してしまうと後から直せない」種類の破れです。

1. **アプリの表を書くすべての接続で `PRAGMA recursive_triggers = ON`。**
   ライブラリは自分が開いた接続でこれを立てますが、**接続ごとの設定**なので、アプリが別の接続で
   同じDBを書くならそちらでも立ててください。立てないと `INSERT OR REPLACE` が追い出した行の
   DELETE トリガーが発火せず、その削除が事実になりません
2. **同期する表の主キーは1列で、`NOT NULL` であること。**
   素の `TEXT PRIMARY KEY` は SQLite では NULL を許すので、これに当たりません。`NOT NULL` を
   宣言するか、`INTEGER PRIMARY KEY` か `WITHOUT ROWID` にしてください。複合主キーは扱えません
3. **主キーの値は端末をまたいで一意（UUID / cuid）であること。**
   自動採番（AUTOINCREMENT）は別々の端末が同じ値を作るため使えません
4. **アプリの列名を `_sns_` で始めないこと。** ライブラリが版の列に使う接頭辞です
5. **決定的でない関数を CHECK 制約・部分索引の述語・式索引の式に書かないこと**
   （`random()` / `datetime('now')` など）。作り直しは一時DBに同じ索引と制約を作って SQLite に
   判定させるので、呼ぶたびに答えが変わる関数があると、同じ行が端末や時刻によって
   置ける・置けないに分かれます。独自に登録した関数・照合順序も同じ理由で使えません
6. **全端末で同じスキーマ・同じ設定であること。** とくに `deleteProtected` は全端末で揃えてください
   （違うと同じ事実から端末ごとに違う表示が出ます。食い違いは `warnings` で名指しします）
7. **表の依存が循環しないこと**（自己参照は構いません）
8. **WALモード。** インメモリDBでは使用できません
9. **時刻列に BLOB を入れないこと。** 値の種類がいちばん強い群なので、入れると以後その行の順序が
   ほぼ書き込み順だけで決まります。大きく未来の時刻も同じ理由で警告します

## API リファレンス

公開されているのは `setupSync` と `discoverTables`、および型だけです。

### `setupSync(config): SyncInstance`

同期インスタンスを作成します。以下の初期化処理を行います。

1. ローカルDBをオープンし、WALモードと `recursive_triggers` を有効化
2. `discoverTables` で同期対象テーブルを自動検出
3. テーブル構造をバリデーション
4. [前提](#利用者が守ること前提)を確認（破れていれば例外）
5. `_sns_rows_<表>`・`_sns_clock`・4本のトリガー・帳簿を作る（既にあれば追従させる）

検出されたテーブル数が0件の場合はエラーをスローします。

旧方式（`_changelog` にレコード単位の変更を積む形）のDBを渡すと、**その場で移行が走ります**
（[制限事項](#制限事項) 1）。

#### `SyncConfig`

| オプション               | 型                             | デフォルト     | 説明                                                  |
| ------------------------ | ------------------------------ | -------------- | ----------------------------------------------------- |
| `dbPath`                 | `string`                       | **必須**       | ローカルSQLiteファイルのパス                          |
| `nasPath`                | `string`                       | **必須**       | NAS上の共有ディレクトリパス                           |
| `clientId`               | `string`                       | **必須**       | クライアント識別子（UUID推奨）                        |
| `excludeTables`          | `string[]`                     | `[]`           | 自動検出から除外するテーブル名                        |
| `tableOptions`           | `Record<string, TableOptions>` | `{}`           | テーブル別のオプション（下記参照）                    |
| `primaryKey`             | `string`                       | `'id'`         | 主キーカラム名（全テーブル共通）                      |
| `intervalMs`             | `number`                       | `30000`        | 定期sync間隔（ミリ秒）                                |
| `changelogRetentionDays` | `number`                       | `7`            | `_changelog` の保持期間（日数）                       |
| `schemaVersion`          | `string`                       | 自動算出       | スキーマバージョン（未指定時はテーブル構造のSHA-256） |
| `heartbeatEnabled`       | `boolean`                      | `true`         | heartbeatによるchangelog延命を有効化                  |
| `suppressIdleSync`       | `boolean`                      | `true`         | 変わっていないときの転送を省く（下記）                |
| `onAfterSync`            | `(localDb, result) => void`    | -              | sync完了後のコールバック                              |
| `onDiscoveryWarning`     | `(message) => void`            | `console.warn` | テーブル自動検出時の警告ハンドラ                      |

`_sync_meta.schemaVersion` へ実際に書かれるのは `<アプリの版>;sns-format=rows1` です。相手を
見送るかどうかは**この文字列ぜんたいの一致**で決めるため、旧方式の端末とは互いに丸ごと見送ります。

##### `suppressIdleSync`（変わっていないときの転送を省く）

既定は30秒ごとの同期です。変更が1つも無い回に、DBファイル全体をやり取りしても何も
変わりません。そこで既定では次を省きます。

- 前に読んだときから**相手のファイルが変わっていなければ**、写さない
- 前に上げたときから**手元が変わっていなければ**、上げない
- NAS 上の自分の写しが自分の書いたままなら、復元の判定で読み直さない

省くのは「やっても何も変わらない回」だけで、同期の結果も最終的な収束も変わりません。
**起動直後・前回の失敗・版や `deleteProtected` の変化・フルマージが要る相手・
自分の写しを他の端末が書き換えたとき・20回に1度**は、必ず読み・上げます。
判断はファイルの inode と更新時刻と大きさ（`stat`）で行い、素性が分からなければ読みます。

1回の同期で実際に動かしたファイルの数と量は `SyncResult.transfers` で見られます。
3端末・変更なしで同期を30回した実測では、手元へ写す回数が 180 回から 0 回、
転送量が 44.3 MB から 0 MB、所要時間が 343 ms から 14 ms になりました。

#### `TableOptions`

`tableOptions` のバリューに指定する型。テーブル別の追加設定です。

| オプション        | 型        | デフォルト    | 説明                                                             |
| ----------------- | --------- | ------------- | ---------------------------------------------------------------- |
| `timestampColumn` | `string`  | `'updatedAt'` | 版の順序に使うタイムスタンプカラム名                             |
| `deleteProtected` | `boolean` | `false`       | trueの場合、**その表では削除の版が表示の計算で勝たない**（下記） |

`deleteProtected` の表では、行の版がある限りその行はアプリの表に置かれます。**アプリがその行を
消しても、次の作り直しで置き直されます**（消した端末でも戻ります）。削除の事実そのものは
`_tombstone` に残るので、設定を外せばそのとき初めて削除が効きます。
旧方式の「他端末から届いた削除を適用しない」とは意味が違います（[制限事項](#制限事項) 3）。

**設定は全端末で揃えてください。** 揃っていないと同じ事実から端末ごとに違う表示が出ます。
食い違いは取り込みのときに検出して `warnings` へ名指しで出しますが、同期は止めません。

### `discoverTables(db, options?): TableConfig[]`

DBから同期可能なテーブルを自動検出します。`setupSync` が内部で利用しますが、
外部から同じテーブル集合を扱いたい場合にも公開APIとして利用できます。

```typescript
import Database from 'better-sqlite3'
import { discoverTables } from 'sqlite-nas-sync'

const db = new Database('./local.sqlite')
const tables = discoverTables(db, {
  excludeTables: ['LocalCache'],
  tableOptions: { User: { deleteProtected: true } },
})
// → [{ name: 'Post' }, { name: 'User', deleteProtected: true }, ...]
```

#### `DiscoverOptions`

| オプション      | 型                             | デフォルト     | 説明                                             |
| --------------- | ------------------------------ | -------------- | ------------------------------------------------ |
| `primaryKey`    | `string`                       | `'id'`         | 主キーカラム名                                   |
| `excludeTables` | `string[]`                     | `[]`           | 検出から除外するテーブル名                       |
| `tableOptions`  | `Record<string, TableOptions>` | `{}`           | テーブル別のオプション                           |
| `onWarning`     | `(message) => void`            | `console.warn` | `id` を持つが `updatedAt` が無い時の警告ハンドラ |

### 手動マージの口はありません

レコード1件ずつを当てる `applyInsert` / `applyUpdate` / `applyDelete` は公開していません。
取り込みは行の版と削除の版の `Max` を取るだけで、1レコードずつ適用を選り好みする場所がないためです。

同期を切った状態のクライアント DB を統合したい場合は、**その DB を NAS に見立てたディレクトリへ
置いて `setupSync` で1回同期してください。** 同じ規則（版の順序・隠れた行・削除の版）が
そのまま当たります。

### `SyncInstance`

#### `syncNow(): Promise<SyncResult>`

同期を即時実行します。

```typescript
const result = await sync.syncNow()
console.log(result)
// {
//   clientsSynced: 2,
//   inserted: 5,
//   updated: 3,
//   deleted: 1,
//   skipped: 10,
//   conflictsResolved: 1,
//   folds: [{ tableName: 'Tag', losingId: 't2', winningId: 't1' }],
//   restores: [],
//   warnings: [],
//   skippedRemotes: [],
//   hadChangelogGap: false
// }
```

##### `SyncResult` の各欄

| 欄                  | 意味                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `clientsSynced`     | この回に処理したリモートクライアント数                                                                 |
| `inserted`          | **作り直し**でアプリの表へ入れた行数（計画にあって表に無かった行）                                     |
| `updated`           | 作り直しで**中身が入れ替わった**行数（主キーが同じで列の値が違っていた行）                             |
| `deleted`           | 作り直しでアプリの表から**消えた**行数。削除が勝った行のほか、**隠れた行**も入る                       |
| `skipped`           | 取り込みで**手元の版の方が強かった**キーの数                                                           |
| `conflictsResolved` | 取り込みで、**手元にも版があったのに相手の版へ入れ替わった**キーの数                                   |
| `folds`             | この回に**新しく隠れた行**の一覧。`losingId` が隠れた行、`winningId` が置かれている勝者                |
| `restores`          | この回に**隠れなくなった行**の一覧（勝者が消えた等で表へ戻った行）                                     |
| `warnings`          | 下記                                                                                                   |
| `skippedRemotes`    | スキーマ版の不一致で丸ごと見送った相手の一覧                                                           |
| `hadChangelogGap`   | フルマージに落ちた相手が居たか。**まだ一度も読んでいない相手（初回）も**フルマージなので `true` になる |

作り直しを見送った回（`Rebuild deferred …`）は `inserted` / `updated` / `deleted` が 0 になります。
事実は取り込めているので、次の同期で出ます。

`warnings` に出るのは次のものです。**利用者へ見せてください。**

- `Unplaceable <表>:<id>: <理由>` — NOT NULL・CHECK・親の不在などでアプリの表に置けなかった。
  **事実は残っている**ので、原因が解ければ次の作り直しで置かれます
- `Rebuild deferred: …` — 計算のあいだに書き込みがあったので作り直しを見送った。次の同期で当たります
  （3回続くと、計算と適用を1つのトランザクションで行う経路へ落ちます）
- `Rebuild failed: …` — 外部キーの違反が残るので、その表を作り直しの対象から外しました
- `Skipped remote <id>: …` / `Skipped table <表>: …` — その相手・その表を今回は読めませんでした
- `deleteProtected が <id> と食い違っている …` — 設定を揃えてください
- 復元・巻き戻り・仕掛けの欠けの検出。**写しの取り合い**（同じ `clientId` を名乗る端末が他に居る）は
  その回の同期を止めます
- `changelogRetentionDays: … is not a usable number of days …` — 設定を既定値へ戻しました

#### `start(): void`

`intervalMs` 間隔での定期同期を開始します。

#### `stop(): void`

定期同期を停止します。

#### `getSyncedTables(): string[]`

このインスタンスが同期対象として認識しているテーブル名の一覧を返します。

```typescript
const tables = sync.getSyncedTables()
// → ['Post', 'User', ...]
```

#### `getStatus(): SyncStatus`

現在の同期状態を取得します。

```typescript
const status = sync.getStatus()
// {
//   isSyncing: false,
//   lastSyncedAt: Date | null,
//   lastResult: SyncResult | null,
//   isRunning: true
// }
```

#### `on(event, callback): void`

イベントリスナーを登録します。

| イベント        | 発火タイミング | コールバック引数 |
| --------------- | -------------- | ---------------- |
| `sync:start`    | sync開始時     | なし             |
| `sync:complete` | sync正常完了時 | `SyncResult`     |
| `sync:error`    | syncエラー時   | `Error`          |

```typescript
sync.on('sync:complete', (result) => {
  console.log(`Synced: ${result.inserted} inserted`)
})

sync.on('sync:error', (error) => {
  console.error('Sync failed:', error)
})
```

## ライブラリが保証すること／しないこと

同期の難しさは、**技術で決まる部分**と**そのデータが何を意味するかで決まる部分**に分かれます。
このライブラリは前者だけを引き受けます。列の値からは「この採点は同じ採点か」
「この生徒は同じ生徒か」を決められないからです。

**保証すること**

1. **同じ事実の集まりからは、どの端末でも同じ表示になる** — 版の順序（時刻 → Lamport → 端末id）は
   端末ごとに違う情報を使いません
2. **同期は事実を作りません** — 取り込みも作り直しも版を作らず、受け取った版はそのまま格納します
3. **書かれたデータを黙って捨てません** — 表に置けなかった行も隠れた行も、事実（版）は残り続けます。
   置けなかったことは `warnings` に、隠れたことは `folds` に出ます

**保証しないこと（ドメインの意味の判断）**

- 別idの2行が「同じもの」かどうか — 判断材料は**あなたが宣言した重複禁止の宣言**だけです。
  かぶった2行は1行にまとめず、片方を隠します
- 同じ id を2つの端末が別々の中身へ更新したとき、どちらが正しいか — 版の順序で決めます
- **「同じ操作の集まりなら、同期をいつ挟んでも同じ結果」は成り立ちません**（[制限事項](#制限事項) 8）

**アプリが決めること**

- **報告をどう人へ見せるか。** `warnings` と `folds` / `restores` は出しっぱなしにせず、
  利用者へ届けてください

## 制限事項

1. **旧方式のDBは、`setupSync` の最初の1回で移行されます。** `_sns_rows_<表>`・`_sns_clock` と
   トリガーを作り、`_tombstone` と `_changelog` を作り直します。このとき旧方式の「畳み」の事実
   （`_id_merge`・`_tombstone.mergedInto` / `revokedAt`）は**捨てられます**。捨てた結果、畳まれていた
   敗者 id の行が他端末から届くことがありますが、案A では**両方そのまま残り**、片方が隠れるだけです。
   移行は1つのトランザクションで行い、`_sync_state` を空にして全表を作り直しの対象にします
2. **作り直しで `rowid` が変わります。** 作り直しは表全体の入れ替えなので、`rowid` /
   `INTEGER PRIMARY KEY` でない暗黙の行番号は保存されません。アプリが `rowid` を外へ持ち出して
   いる場合（キャッシュの鍵、FTS の `content_rowid` など）は作り直しのたびに壊れます。
   行の同定には主キーを使ってください
3. **`deleteProtected` の意味が旧方式から変わりました。** 旧方式は「利用者操作による削除を
   他端末から適用しない」で、消した端末ではその行は消えたままでした。案A では
   「**削除の版が表示の計算で勝たない**」なので、**消した端末でも次の作り直しでその行が戻ります**。
   設定を外せばそのとき削除が効きます
4. **アプリの列名は `_sns_` で始められません**（版の列に使う接頭辞です）
5. **CHECK 制約・部分索引の述語・式索引の式に、決定的でない関数を書けません**
   （`random()` / `datetime('now')` など。独自に登録した関数・照合順序も同じ）。
   `setupSync` が見つけて例外にします
6. **主キーは1列で `NOT NULL`、値は端末をまたいで一意（UUID / cuid）**。複合主キーは扱えません
7. **作り直しの適用中、アプリのトリガーは発火しません。** 適用はトリガーを外して行うためです
   （外さないと、ライブラリが版から組み直した行に対してアプリのトリガーがもう一度副作用を起こします）。
   アプリのトリガーで別の表を保守している場合、その表は同期で運ばれる行については更新されません
8. **同期の最中の書き込みでは「同じ操作の集まりなら同じ結果」が成り立ちません。**
   `_sns_ts` は引き上げがあるため、**他端末の版を取り込んだあとに、より古い時刻でその行を書くと、
   取り込んでいなかった場合より強い版になります**。例: a が `X` を 10:00 で書き、b がそれを
   取り込んでから `X` を 09:00 で書くと、b の版は `_sns_ts = 10:00`（引き上げ）＋ b の Lamport で
   a に勝ちます。b が取り込む前に 09:00 で書いていれば a に負けます
9. **取り込みの窓でアプリが一部の列だけを編集すると、その端末でしか見たことのない内容の行が
   全端末へ渡ります。** 取り込みが `_sns_rows_*` の行を消した直後（＝ `Max` が削除になった直後）に
   アプリがその行の一部の列を UPDATE すると、書かなかった列はアプリの表に残っていた古い値に落ちます。
   その版は取り込んだ削除より強くなりうるので、行が復活し、他端末が一度も見ていない中身が広まります
10. **容量が約1.5〜2倍になります。** 同期する表の内容を `_sns_rows_*` にもう一部持つためです
    （実測: 52.0 MB → 約 89 MB、2.6 MB → 約 4.0 MB）。書き込みにもトリガーのぶんの負担が乗ります
    （2,000行・WAL のファイルDB・1トランザクションでの1行あたりの増分: INSERT 8.3 µs /
    UPDATE 21.5 µs / DELETE 44.9 µs）
11. **SQLite専用**: PostgreSQL等の他のデータベースには対応していません
12. **ファイルシステムベース**: NAS（NFSやSMB等）でのファイル共有が前提
13. **NAS への写しは `backup()` で作ります。** WAL のDBを `copyFile` で写すと `-wal` が付いてこないので、
    写しから最近の書き込みが見えません。自前で写しを配る場合は同じことに注意してください
14. **掃除を経由しない `_changelog` の消え方は見抜けません。** `cleanupChangelog` が消したぶんは
    `_changelog_prune` の記録で分かりますが、記録に載らない消え方（直に打つ `DELETE FROM _changelog`、
    DBファイルの差し替え）は、途中だけが欠けていると分かりません。その形は `MIN(id)` の規則が
    頭の欠けを拾えたときにだけ見つかります。なお、事実そのものは `_sns_rows_*` にあるので、
    フルマージに落ちれば復旧します

## 使用例

### Electronアプリでの定期同期

```typescript
import { setupSync } from 'sqlite-nas-sync'

const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  tableOptions: {
    settings: { deleteProtected: true },
  },
  intervalMs: 5 * 60 * 1000, // 5分間隔
})

// イベント監視
sync.on('sync:complete', (result) => {
  for (const warning of result.warnings) console.warn(warning)
  for (const fold of result.folds) {
    console.log(
      `${fold.tableName}: ${fold.losingId} は ${fold.winningId} の陰に隠れました`
    )
  }
})

sync.on('sync:error', (error) => {
  console.error('Sync failed:', error)
})

// 定期同期を開始
sync.start()

// アプリ終了時に停止＆最後の同期
process.on('beforeExit', async () => {
  sync.stop()
  await sync.syncNow()
})
```

アプリが**別の接続**で同じDBを書くなら、その接続でも忘れずに立ててください。

```typescript
const appDb = new Database('./data/local.sqlite')
appDb.pragma('recursive_triggers = ON')
```

### 一部テーブルを除外する

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  excludeTables: ['LocalCache', 'TempLog'],
})
```

### テーブルごとのカスタム設定

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  tableOptions: {
    users: { timestampColumn: 'updated_at' },
    posts: { timestampColumn: 'modified_at' },
    master_data: { deleteProtected: true },
  },
  primaryKey: 'id',
  changelogRetentionDays: 14,
})
```

`deleteProtected` は全端末で同じにしてください。

### sync後のカスタム処理

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  onAfterSync: (localDb, result) => {
    if (result.inserted > 0 || result.updated > 0 || result.deleted > 0) {
      // 例: キャッシュのインバリデーション
      console.log('Data changed, invalidating cache...')
    }
  },
})
```

## ライセンス

MIT
