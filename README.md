# sqlite-nas-sync

複数クライアント間でNASを経由してSQLiteデータベースを安全に同期するためのnpmパッケージです。

## 概要

NAS環境で複数のクライアント（PC、サーバー、Electronアプリなど）が同じSQLiteデータベースを共有したい場合、直接同じファイルにアクセスするとロック競合やデータ破損のリスクがあります。

`sqlite-nas-sync`は、各クライアントがローカルのSQLiteファイルで作業し、`_changelog`テーブルとSQLiteトリガーによる差分追跡で効率的に同期を行います。

## 特徴

- **ローカルファーストアーキテクチャ**: 各クライアントはローカルDBで高速に読み書き
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
  tables: [{ name: 'users' }, { name: 'posts' }],
});

// 手動同期
const result = await sync.syncNow();
console.log(`${result.inserted} inserted, ${result.updated} updated`);

// 定期同期（デフォルト30秒間隔）
sync.start();

// 停止
sync.stop();
```

## テーブル要件

sync対象テーブルは以下の条件を満たす必要があります：

### 必須条件

1. **主キーがTEXT型**（UUID、cuid等）
2. **タイムスタンプカラムが存在**（デフォルト: `updatedAt`）

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
2. テーブル構造をバリデーション（PK型、タイムスタンプカラム等）
3. `_changelog` / `_sync_state` テーブルとトリガーを作成

#### `SyncConfig`

| オプション | 型 | デフォルト | 説明 |
|----------|-----|----------|------|
| `dbPath` | `string` | **必須** | ローカルSQLiteファイルのパス |
| `nasPath` | `string` | **必須** | NAS上の共有ディレクトリパス |
| `clientId` | `string` | **必須** | クライアント識別子（UUID推奨） |
| `tables` | `TableConfig[]` | **必須** | sync対象テーブルの設定配列 |
| `primaryKey` | `string` | `'id'` | 主キーカラム名（全テーブル共通） |
| `intervalMs` | `number` | `30000` | 定期sync間隔（ミリ秒） |
| `changelogRetentionDays` | `number` | `7` | changelogの保持期間（日数） |
| `onAfterSync` | `(localDb, result) => void` | - | sync完了後のコールバック |

#### `TableConfig`

| オプション | 型 | デフォルト | 説明 |
|----------|-----|----------|------|
| `name` | `string` | **必須** | テーブル名 |
| `timestampColumn` | `string` | `'updatedAt'` | LWW比較に使うタイムスタンプカラム名 |
| `deleteProtected` | `boolean` | `false` | trueの場合、DELETE操作を適用しない |

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
  tables: [
    { name: 'users' },
    { name: 'posts' },
    { name: 'settings', deleteProtected: true },
  ],
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

### テーブルごとのカスタム設定

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  tables: [
    { name: 'users', timestampColumn: 'updated_at' },
    { name: 'posts', timestampColumn: 'modified_at' },
    { name: 'master_data', deleteProtected: true },
  ],
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
  tables: [{ name: 'users' }],
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
