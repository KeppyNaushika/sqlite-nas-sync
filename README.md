# sqlite-nas-sync

複数クライアント間でNASを経由してSQLiteデータベースを安全に同期するためのnpmパッケージです。

## 概要

NAS環境で複数のクライアント（PC、サーバー、Electronアプリなど）が同じSQLiteデータベースを共有したい場合、直接同じファイルにアクセスするとロック競合やデータ破損のリスクがあります。

`sqlite-nas-sync`は、各クライアントがローカルのSQLiteファイルで作業し、`_changelog`テーブルとSQLiteトリガーによる差分追跡で効率的に同期を行います。

## 特徴

- **ローカルファーストアーキテクチャ**: 各クライアントはローカルDBで高速に読み書き
- **テーブル自動検出**: DBから同期対象テーブルを自動的に検出（手書きリスト不要）
- **changelog差分同期**: SQLiteトリガーで変更を自動記録し、差分のみを同期
- **自動競合解決**: タイムスタンプカラムによる Last Write Wins 方式
- **テーブル単位の設定**: タイムスタンプカラム名やDELETE保護をテーブルごとに指定可能
- **イベントシステム**: 同期の開始・完了・エラー・競合をイベントで購読
- **定期同期**: `start()`/`stop()`による自動定期同期
- **アトミックコピー**: `backup()` APIでNASへの安全な書き込み

## インストール

```bash
npm install sqlite-nas-sync
```

**注意**: `better-sqlite3`がpeerDependencyです。別途インストールしてください：

```bash
npm install better-sqlite3
```

## クイックスタート

```typescript
import { setupSync } from 'sqlite-nas-sync';

const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  // tables の指定は不要 — DBから自動検出されます
});

// 手動同期
const result = await sync.syncNow();
console.log(`${result.inserted} inserted, ${result.updated} updated`);

// 定期同期（デフォルト30秒間隔）
sync.start();

// 停止
sync.stop();
```

## テーブル自動検出

`setupSync` は DB を introspect して同期対象テーブルを自動的に決定します。
明示的なテーブル一覧の指定は不要です。

### 検出条件

以下を**全て**満たすテーブルが同期対象になります：

1. テーブル名が `_` または `sqlite_` プレフィックスでない（内部テーブルを除外）
2. {@link SyncConfig.excludeTables} に含まれていない
3. **主キーカラム（既定: `id`）が存在し、TEXT型である**（UUID、cuid等）
4. **タイムスタンプカラム（既定: `updatedAt`）が存在する**

### 警告される条件

`id` カラムを持つが `updatedAt` が無いテーブルは「同期したかったのに updatedAt
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

## API リファレンス

### `setupSync(config): SyncInstance`

同期インスタンスを作成します。以下の初期化処理を行います：

1. ローカルDBをオープンし、WALモードを有効化
2. `discoverTables` で同期対象テーブルを自動検出
3. テーブル構造をバリデーション（PK型、タイムスタンプカラム等）
4. `_changelog` / `_sync_state` テーブルとトリガーを作成

検出されたテーブル数が0件の場合はエラーをスローします。

#### `SyncConfig`

| オプション | 型 | デフォルト | 説明 |
|----------|-----|----------|------|
| `dbPath` | `string` | **必須** | ローカルSQLiteファイルのパス |
| `nasPath` | `string` | **必須** | NAS上の共有ディレクトリパス |
| `clientId` | `string` | **必須** | クライアント識別子（UUID推奨） |
| `excludeTables` | `string[]` | `[]` | 自動検出から除外するテーブル名 |
| `tableOptions` | `Record<string, TableOptions>` | `{}` | テーブル別のオプション（下記参照） |
| `primaryKey` | `string` | `'id'` | 主キーカラム名（全テーブル共通） |
| `intervalMs` | `number` | `30000` | 定期sync間隔（ミリ秒） |
| `changelogRetentionDays` | `number` | `7` | changelogの保持期間（日数） |
| `schemaVersion` | `string` | 自動算出 | スキーマバージョン（未指定時はテーブル構造のSHA-256） |
| `heartbeatEnabled` | `boolean` | `true` | heartbeatによるchangelog延命を有効化 |
| `onAfterSync` | `(localDb, result) => void` | - | sync完了後のコールバック |
| `onDiscoveryWarning` | `(message) => void` | `console.warn` | テーブル自動検出時の警告ハンドラ |

#### `TableOptions`

`tableOptions` のバリューに指定する型。テーブル別の追加設定。

| オプション | 型 | デフォルト | 説明 |
|----------|-----|----------|------|
| `timestampColumn` | `string` | `'updatedAt'` | LWW比較に使うタイムスタンプカラム名 |
| `deleteProtected` | `boolean` | `false` | trueの場合、DELETE操作を適用しない（※ユニーク制約の競合で行が1行に統合される「畳み」は対象外） |

### `discoverTables(db, options?): TableConfig[]`

DBから同期可能なテーブルを自動検出します。`setupSync` が内部で利用しますが、
マージ処理など外部から同じテーブル集合を扱いたい場合にも公開APIとして利用できます。

```typescript
import Database from 'better-sqlite3';
import { discoverTables } from 'sqlite-nas-sync';

const db = new Database('./local.sqlite');
const tables = discoverTables(db, {
  excludeTables: ['LocalCache'],
  tableOptions: { User: { deleteProtected: true } },
});
// → [{ name: 'Post' }, { name: 'User', deleteProtected: true }, ...]
```

#### `DiscoverOptions`

| オプション | 型 | デフォルト | 説明 |
|----------|-----|----------|------|
| `primaryKey` | `string` | `'id'` | 主キーカラム名 |
| `excludeTables` | `string[]` | `[]` | 検出から除外するテーブル名 |
| `tableOptions` | `Record<string, TableOptions>` | `{}` | テーブル別のオプション |
| `onWarning` | `(message) => void` | `console.warn` | `id` を持つが `updatedAt` が無い時の警告ハンドラ |

### `applyInsert` / `applyUpdate` / `applyDelete`

`syncNow` が内部で使うレコードレベルのLWW競合解決を、公開APIとして利用できます。
アプリ側で手動マージ（例: 同期無効化時のクライアントDB統合、管理スクリプトでの
複数DB統合）を行う際に、同期本体と同一の競合解決ロジックを再利用するための関数です。

- `applyInsert(db, tableName, primaryKey, record, columns, timestampColumn?)` —
  INSERTを試み、UNIQUE制約違反時はLWWでフォールバック。同一PKの重複は
  `updatedAt` 比較でUPDATE、別PK・同一ユニークキー（セカンダリUNIQUE違反）も
  `updatedAt` 比較で一方に収束させる（敗者行の子は勝者行へ付け替えてから削除する）
- `applyUpdate(db, tableName, primaryKey, record, columns, timestampColumn?)` —
  LWWでUPDATE。ローカルに行が無ければ `applyInsert` 経由でINSERT。書き込みが
  ローカルの**別の行**のセカンダリUNIQUEに当たる場合も、`applyInsert` と同じ畳みで
  1行へ収束させる
- `applyDelete(db, tableName, primaryKey, recordId)` — 主キー指定でDELETE

```typescript
import Database from 'better-sqlite3';
import { applyInsert, discoverTables } from 'sqlite-nas-sync';

// 例: クライアントDBをメインDBへLWWマージする
const mainDb = new Database('./main.sqlite');
mainDb.exec(`ATTACH DATABASE './client.sqlite' AS remote`);
for (const table of discoverTables(mainDb)) {
  const rows = mainDb
    .prepare(`SELECT * FROM remote."${table.name}"`)
    .all() as Record<string, unknown>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  for (const row of rows) {
    applyInsert(mainDb, table.name, 'id', row, columns);
  }
}
mainDb.exec('DETACH DATABASE remote');
```

戻り値には実行されたアクション（`inserted` / `upserted` 等）と、競合があった場合は
`ConflictInfo`（`resolution: 'local_wins' | 'remote_wins'` を含む）が入ります。

### `SyncInstance`

#### `syncNow(): Promise<SyncResult>`

同期を即時実行します。

```typescript
const result = await sync.syncNow();
console.log(result);
// {
//   clientsSynced: 2,
//   inserted: 5,
//   updated: 3,
//   deleted: 1,
//   skipped: 10,
//   conflictsResolved: 1,
//   folds: [{ tableName: 'Tag', losingId: 't2', winningId: 't1', removedLocalRow: true, movedChildren: 3 }],
//   warnings: []
// }
```

#### `start(): void`

`intervalMs`間隔での定期同期を開始します。

#### `stop(): void`

定期同期を停止します。

#### `getSyncedTables(): string[]`

このインスタンスが同期対象として認識しているテーブル名の一覧を返します。
`setupSync` 時に `discoverTables` で検出された結果のスナップショットです。

```typescript
const tables = sync.getSyncedTables();
// → ['Post', 'User', ...]
```

#### `getStatus(): SyncStatus`

現在の同期状態を取得します。

```typescript
const status = sync.getStatus();
// {
//   isSyncing: false,
//   lastSyncedAt: Date | null,
//   lastResult: SyncResult | null,
//   isRunning: true
// }
```

#### `on(event, callback): void`

イベントリスナーを登録します。

| イベント | 発火タイミング | コールバック引数 |
|---------|-------------|--------------|
| `sync:start` | sync開始時 | なし |
| `sync:complete` | sync正常完了時 | `SyncResult` |
| `sync:error` | syncエラー時 | `Error` |
| `sync:conflict` | 競合発生時 | `ConflictInfo` |

```typescript
sync.on('sync:complete', (result) => {
  console.log(`Synced: ${result.inserted} inserted`);
});

sync.on('sync:error', (error) => {
  console.error('Sync failed:', error);
});
```

## 動作の仕組み

### アーキテクチャ

```
NAS共有ディレクトリ/
├── client-abc123.sqlite    # クライアントAのDB（backup APIでコピー）
├── client-def456.sqlite    # クライアントBのDB
└── client-ghi789.sqlite    # クライアントCのDB

ローカル/
└── local.sqlite            # アプリが参照するDB
    ├── _changelog           # SQLiteトリガーで変更を自動記録
    ├── _sync_state          # リモートごとの同期進捗
    ├── _tombstone           # DELETEの記録（削除 vs 更新のLWW判定 + 畳み先）
    ├── _id_merge            # 畳んだ「敗者id → 勝者id」のローカル索引
    └── _heartbeat           # changelog延命用
```

### 同期フロー

```
syncNow() 実行時：
  1. ローカルDBをNASにアトミックコピー（backup API）
  2. NAS上の他クライアントDBを列挙
  3. 各リモートクライアントについて：
     - _sync_state から lastSeenId を取得
     - changelogギャップをチェック
       → ギャップあり: フルテーブルスキャンでフォールバック
       → ギャップなし: _changelog から差分エントリを読み取り
     - 同一レコードの重複を最新のみに縮約
     - トランザクション内でINSERT/UPDATE/DELETEを適用（LWW）
     - _sync_state を更新
  4. 古い _changelog エントリを掃除
  5. onAfterSync コールバックを実行
```

### 競合解決（Last Write Wins）

```
各レコードについて：
  ローカルに同一主キーが存在しない → INSERT
  ローカルに同一主キーが存在する：
    リモートのタイムスタンプ > ローカルのタイムスタンプ → UPDATE
    それ以外 → スキップ（ローカルが最新）
```

**別々の主キーの行どうし**を比べるとき（下記「畳む」）は、タイムスタンプが同点になった
ぶんを**主キーの辞書順**で決めます。これが成り立つのは**主キーが端末をまたいで一意
（uuid / cuid）だから**で、両端末が同じ2つのidを見て同じ答えに達します。同点を端末ごとに
違う向きで決めると、互いに相手を畳んで生き残るidが毎周入れ替わり、永久に収束しません
（→ 前提は [制限事項](#制限事項) 1）。

### 別ID・同一ユニークキーの行を畳む

各クライアントが独立に同じ論理エンティティの行を作ると、**中身は同じで主キーだけ違う行**が
2つできます（例: 2人が同じ生徒を同じ試験に追加する）。セカンダリUNIQUE違反を捕まえ、
タイムスタンプのLWWで1行へ畳みます。

```
INSERT → UNIQUE制約違反（別PK・同一ユニークキー）
  リモートが新しい：
    1. 敗者行を指している子を勝者行へ付け替える
       （PRAGMA foreign_key_list で辿るのでスキーマの事前知識は不要）
    2. 敗者行を削除する（先に削除するとカスケードで子が道連れになる）
    3. 「敗者id → 勝者id」を記録する
    4. 勝者行を挿入する
  ローカルが新しい：
    リモート行は採用せず、「敗者id → 勝者id」だけを記録する
    → あとから届く相手の子は、この記録を使って勝者へ向け直してから挿入される
```

作成だけでなく**改名**でも起こります。利用者が編集できる名前の列（`Tag.name` /
`Student.studentNumber` など）で、2つの端末が独立に同じ名前へ辿り着く場合です。
このとき**更新対象の行はローカルに既に在る**ので、どちらが負けても実際に行が1つ消えます。

```
UPDATE → UNIQUE制約違反（ローカルの別の行と同一ユニークキー）
  届いた更新が新しい：
    1. 邪魔なローカル行を、更新される行へ畳む（子は先に付け替える）
    2. 改めて書き込む
  ローカル行が新しい：
    更新対象の行の方を、そのローカル行へ畳む
    → 届いた更新を黙って捨てると、相手は送り続けこちらは断り続けて
      分岐したまま収束しない。畳んだ事実は下記の mergedInto で相手へ伝わる
```

ユニークが**2本以上**ある表（`User(username UNIQUE, email UNIQUE)` など）では、1回の
書き込みが索引ごとに別々の相手へぶつかります。ぶつかった相手は `PRAGMA index_list` /
`PRAGMA index_xinfo` で**索引から先に全部引ける**ので、**1つも畳む前に全員ぶんの勝敗を
決めます**。1人でも勝てない相手が居れば何も畳まずに拒み、更新対象の行だけを勝った相手へ
畳んで収束させます（「先に見えた相手を畳んでから次の相手に負け、更新は拒まれたのに
畳んだ行だけが消えたまま」という穴が、そもそも開かない形です）。

ユニークの宣言はスキーマそのものから読むので、**設定で重ねて教える必要はありません**。
索引の一覧は `PRAGMA schema_version` が変わるまで使い回します（`CREATE INDEX` /
`DROP INDEX` / `ALTER TABLE` はいずれもこの値を進めるため、索引が変わったまま古い答えを
返し続けることはありません）。

ただし次の2種は「先に数える」対象から外れます。列の値だけでは相手を引けないためで、
残った違反は畳まずにそのまま例外として返します（誤った相手を畳んで行を失うより、
止まって知らせる方を採ります）。

- **部分索引**（`CREATE UNIQUE INDEX … WHERE …`）— どの行が索引に載っているかは述語を
  評価しないと決められない
- **式索引**（`CREATE UNIQUE INDEX … ON t(lower(name))`）— 引くべき値が列に無い

畳んだ結果は **`_tombstone.mergedInto`（畳み先のid）として他クライアントへ伝わります**。
これが無いと、**その競合を経験しなかったクライアント**には「敗者行が消えた」という事実だけが
届き、そのクライアントは自分が持っている子をカスケードで失います（さらにその削除が伝播して、
他のクライアントで正しく付け替え済みの子まで消します）。

削除の事実と畳み先が `_tombstone` の同じ1行に載っているため、削除を適用する側は
**消すと決めるその場で畳み先を必ず見る**ことになります。

勝った側（`local_wins`）のクライアントは敗者行を持たないため、DELETEトリガーによる
`_changelog` の記録が生まれません。そのままでは畳み先がフルマージ経路でしか渡らず、
**行儀よく毎日同期しているクライアントほど受け取れない**ことになるため、この側では
`_changelog` へ DELETE を1行だけ手で書いて通常の差分経路にも載せます
（`changedAt` は tombstone の `deletedAt` に揃えます）。

畳み先が更に畳まれた場合は記録を終端へ張り替えるので、**参照は常に1段で解けます**
（`bbb → aaa` のあとに `aaa → ccc` が起きれば `bbb → ccc` になります）。
畳む向きが後から反転した場合に生まれる「自分自身を指す記録」は捨てられます。

```
リモートの tombstone に mergedInto がある：
  1. 「敗者id → 勝者id」をローカルに記録する（＝あとから届く子を向け直せるようにする）
  2. 敗者行を指している子を畳み先へ付け替える
  3. 敗者行を削除する
  ※ 畳み先の行がローカルに無ければリモートから読んで先に入れる。
    リモートにも無ければ敗者行は消さない（勝者行が届いた時点で同じ畳みが起きる）
mergedInto が無い（＝利用者操作による普通の削除）：
  従来どおり「削除 vs 更新」のLWWで判定する
```

畳む処理と1回ぶんの取り込みは、**外部キーの検査をトランザクション終端まで遅らせた**状態で
実行されます（`PRAGMA defer_foreign_keys`）。制約を切っているのではなく検査を遅らせている
だけなので、COMMIT時に矛盾が残っていれば通常どおり失敗します。

付け替えた子が**子自身のユニーク制約**にぶつかる場合（勝者側に「同じもの」が既にある場合）は、
子どうしを同じLWWで1行へ畳みます。時刻で決まらないときは主キーの辞書順で決めるため、
どのクライアントで解決しても同じ側が残ります。

### 畳んだことを利用者へ伝える

「ぶつかったら黙って畳む」以上、**何と何が1つになったのかを利用者へ伝えられる**必要が
あります。`SyncResult.folds` に畳みの一覧（表名・消えたid・残ったid・付け替えた子の数）が
載るので、アプリ側で「小計『知識・技能』が2つあったので1つにまとめ、設問 47 件を
付け替えました」のように通知できます。

```typescript
const result = await sync.syncNow();
for (const fold of result.folds) {
  // { tableName: 'SubtotalGroup', losingId: '…', winningId: '…',
  //   removedLocalRow: true, movedChildren: 47 }
  console.log(
    `${fold.tableName}: ${fold.losingId} を ${fold.winningId} へまとめ、` +
      `子 ${fold.movedChildren} 行を付け替えました`
  );
}
```

同じ三つ組は `_id_merge` テーブルにも永続化されるので、**あとから見返す口**も同じデータから
作れます。`removedLocalRow` は「この端末で実際に行が消えたか」で、`false` は敗者行を
そもそも持っていなかった場合（届いた行が負けたとき）です。

`movedChildren` は、その畳みで消えた行から残った行へ**付け替えた子行の数**です。
数えるのは**直接の子だけ**で、孫は入りません。子自身も畳まれて消えた場合（子どうしも
ユニークでぶつかった場合）は、その子ぶんの `RecordFold` が別に1件出て、孫の数はそちらに
載ります。つまり**一覧を合計してよい**（同じ行を二度数えません）。

`lostChildren` は、残った行へ**引き継げずに失われた**子行の数です。ふつうは0で、0で
なくなるのは子が親を**主キー以外のユニーク列の値**で握っている場合（`REFERENCES
parent(code)` の形）だけです。この形では消える行と残る行がその値を受け渡すので子の列を
書き換えようが無く、消える行の `ON DELETE CASCADE` が子に及んでしまいます
（**`PRAGMA defer_foreign_keys` が遅らせるのは制約の検査であって、カスケードの動作では
ありません**）。ライブラリは子の参照列を一旦NULLにして消える行から外し、削除のあとに
元の値へ戻すことでこれを避けますが、**外せない形**（参照列が `NOT NULL` / 子自身の主キーを
兼ねている / `CHECK` でNULLを禁じている）では守り切れません。数は削除の前後を実測した
差です。0でない値を受け取ったら、利用者へ知らせてください。

## 使用例

### Electronアプリでの定期同期

```typescript
import { setupSync } from 'sqlite-nas-sync';

const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  tableOptions: {
    settings: { deleteProtected: true },
  },
  intervalMs: 5 * 60 * 1000, // 5分間隔
});

// イベント監視
sync.on('sync:complete', (result) => {
  console.log('Sync completed:', result);
});

sync.on('sync:error', (error) => {
  console.error('Sync failed:', error);
});

// 定期同期を開始
sync.start();

// アプリ終了時に停止＆最後の同期
process.on('beforeExit', async () => {
  sync.stop();
  await sync.syncNow();
});
```

### 一部テーブルを除外する

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  excludeTables: ['LocalCache', 'TempLog'],
});
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
});
```

### sync後のカスタム処理

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  onAfterSync: (localDb, result) => {
    if (result.inserted > 0 || result.updated > 0) {
      // 例: キャッシュのインバリデーション
      console.log('Data changed, invalidating cache...');
    }
  },
});
```

## 制限事項

1. **主キーは端末をまたいで一意（UUID/cuid）であること**: 自動採番（INTEGER AUTOINCREMENT）は
   別々の端末が同じ値を作るため使えません。この前提は行の同定だけでなく、**タイムスタンプが
   同点になったときの勝敗判定**（主キーの辞書順で決める）にも効きます — 破ると、互いに相手を
   畳んで生き残るidが毎周入れ替わり、永久に収束しません
2. **SQLite専用**: PostgreSQL等の他のデータベースには対応していません
3. **ファイルシステムベース**: NAS（NFSやSMB等）でのファイル共有が前提
4. **WALモード必須**: インメモリDBでは使用できません
5. **畳んだ敗者行の属性はマージされない**: 別ID・同一ユニークキーの行を1行へ畳むとき、
   列の意味はライブラリからは分からないため、勝者行が全ての列を総取りします
   （例: 「表に出す」のような真偽値の列は、本来なら両者のORを取りたい場面があります）
6. **主キー以外を指す外部キーは向け直さない**: 覚えているのは主キーの対応だけです。
   衝突したユニーク列の値は敗者と勝者で同一なので、その列を指す参照は向け直す必要が
   ありません
7. **畳み先を書けない旧クライアントとの混在**: v0.14.0以前のクライアントが畳んだ場合、
   その tombstone には畳み先が載りません。受け取った側は普通の削除として扱うため、
   その行の子は失われます（自分のDBの `_tombstone` は起動時に自動で移行されます）

## ライセンス

MIT
