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
| `deleteProtected` | `boolean` | `false` | trueの場合、DELETE操作を適用しない |

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
  `updatedAt` 比較で一方に収束させる
- `applyUpdate(db, tableName, primaryKey, record, columns, timestampColumn?)` —
  LWWでUPDATE。ローカルに行が無ければ `applyInsert` 経由でINSERT
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
//   conflictsResolved: 0,
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
    └── _sync_state          # リモートごとの同期進捗
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

1. **INTEGER型の自動採番主キーは非対応**: クライアント間でID衝突が発生するため、UUID/cuidを使用してください
2. **SQLite専用**: PostgreSQL等の他のデータベースには対応していません
3. **ファイルシステムベース**: NAS（NFSやSMB等）でのファイル共有が前提
4. **WALモード必須**: インメモリDBでは使用できません

## ライセンス

MIT
