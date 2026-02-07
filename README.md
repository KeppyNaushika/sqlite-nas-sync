# sqlite-nas-sync

複数クライアント間でNASを経由してSQLiteデータベースを安全に同期するためのnpmパッケージです。

## 概要

NAS環境で複数のクライアント（PC、サーバー、Electronアプリなど）が同じSQLiteデータベースを共有したい場合、直接同じファイルにアクセスするとロック競合やデータ破損のリスクがあります。

`sqlite-nas-sync`は、各クライアントがローカルのSQLiteファイルで作業し、任意のタイミングでNASと同期することで、これらの問題を解決します。

## 特徴

- **ローカルファーストアーキテクチャ**: 各クライアントはローカルDBで高速に読み書き
- **柔軟な同期タイミング**: プッシュ/プル/同期を任意のタイミングで実行
- **自動競合解決**: `updated_at`による Last Write Wins 方式
- **論理削除対応**: `deleted_at`カラムがある場合は削除も同期
- **テーブル自動検出**: UUID主キーと`updated_at`を持つテーブルのみ同期
- **リトライ機能**: ファイルロック時の自動リトライ

## インストール

```bash
npm install sqlite-nas-sync
```

## クイックスタート

```typescript
import { SqliteNasSync } from 'sqlite-nas-sync';

const sync = new SqliteNasSync({
  localPath: './data/local.sqlite',
  nasDir: '/mnt/nas/shared-db/',
  clientId: 'client-abc123', // 省略時は自動生成
});

// NASへプッシュ
await sync.push();

// NASからプル
await sync.pull();

// プッシュ→プルを一度に実行
await sync.sync();

// 初回セットアップ（NAS上の全DBからローカルを初期化）
await sync.init();
```

## インタラクティブデモ

実際の動作を確認したい場合は、対話的なデモを実行できます：

```bash
npm run demo
```

このデモでは、以下の内容を段階的に確認できます：

1. **環境のセットアップ** - デモ用のデータベースとディレクトリを作成
2. **クライアントAからプッシュ** - ローカルDBをNASにプッシュ
3. **クライアントBでプル** - NAS上のデータをマージ
4. **競合解決** - Last Write Wins方式での競合解決を確認
5. **新しいクライアントの初期化** - init()で全データを取得

各ステップでEnterキーを押すと次に進み、データベースの内容を確認しながら進められます。

## テーブル要件

マージ対象となるテーブルは以下の条件を満たす必要があります：

### 必須条件

1. **主キーが単一カラム**
2. **主キーがString型**（UUID、cuid等）
3. **`updated_at`カラムが存在**（DateTime型）

### 推奨条件

- **`deleted_at`カラムの追加**（論理削除用）

### Prismaスキーマ例

```prisma
model User {
  id        String    @id @default(uuid())
  name      String
  email     String
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime? // 論理削除用（推奨）
}

model Post {
  id        String    @id @default(cuid())
  title     String
  content   String
  userId    String
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?
}
```

### スキップされるテーブル

以下のテーブルは自動的にスキップされ、警告ログが出力されます：

- **Integer型の自動採番主キー**: クライアント間でID衝突リスクがあるため
- **複合主キー**: 現在サポートされていません
- **`updated_at`カラムなし**: 競合解決ができないため
- **システムテーブル**: `sqlite_*`, `_prisma_migrations`等

## API リファレンス

### `new SqliteNasSync(options)`

#### オプション

| オプション | 型 | デフォルト | 説明 |
|----------|-----|----------|------|
| `localPath` | `string` | **必須** | ローカルSQLiteファイルのパス |
| `nasDir` | `string` | **必須** | NAS上の共有ディレクトリパス |
| `clientId` | `string` | 自動生成 | クライアント識別子（省略時は自動生成して永続化） |
| `excludeTables` | `string[]` | `[]` | マージ対象から除外するテーブル名 |
| `retryCount` | `number` | `3` | ファイルロック時のリトライ回数 |
| `retryDelay` | `number` | `1000` | リトライ間隔（ミリ秒） |
| `logLevel` | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'` | `'info'` | ログレベル |

### メソッド

#### `async push(): Promise<void>`

ローカルDBをNASにプッシュします（`local.sqlite` → `NAS/client-xxx.sqlite`）。

```typescript
await sync.push();
```

#### `async pull(): Promise<void>`

NAS上の他クライアントのDBからデータをプルしてローカルにマージします。

```typescript
await sync.pull();
```

#### `async sync(): Promise<void>`

`push()`と`pull()`を順番に実行します。

```typescript
await sync.sync();
```

#### `async init(): Promise<void>`

初回セットアップ用。NAS上の全DBからローカルDBを初期化します。

```typescript
await sync.init();
```

#### `getClientId(): string`

現在のクライアントIDを取得します。

```typescript
const clientId = sync.getClientId();
console.log(`Client ID: ${clientId}`);
```

## 動作の仕組み

### アーキテクチャ

```
NAS共有ディレクトリ/
├── client-abc123.sqlite    # クライアントAのDB
├── client-def456.sqlite    # クライアントBのDB
└── client-ghi789.sqlite    # クライアントCのDB

ローカル/
└── local.sqlite            # Prismaが参照するDB
```

### マージロジック

```
各テーブルについて：
  NAS上の他クライアントDBからレコードを読み込み
  各レコードについて：
    ローカルに同一主キーが存在しない → INSERT
    ローカルに同一主キーが存在する：
      リモートの updated_at > ローカルの updated_at → UPDATE
      それ以外 → スキップ（ローカルが最新）
```

### 論理削除の同期

`deleted_at`カラムが存在する場合：

- `deleted_at`に値があるレコードは削除済みとして扱われます
- 削除も`updated_at`で同期されます
- 物理削除されたレコードは同期で復活する可能性があるため、**論理削除の使用を強く推奨**します

## 使用例

### Electronアプリでの定期同期

```typescript
import { SqliteNasSync } from 'sqlite-nas-sync';

const sync = new SqliteNasSync({
  localPath: './data/local.sqlite',
  nasDir: '/mnt/nas/shared-db/',
});

// 起動時に初回プル
await sync.pull();

// 5分ごとに同期
setInterval(async () => {
  try {
    await sync.sync();
    console.log('Sync completed');
  } catch (error) {
    console.error('Sync failed:', error);
  }
}, 5 * 60 * 1000);

// アプリ終了時に最後のプッシュ
process.on('beforeExit', async () => {
  await sync.push();
});
```

### 特定のテーブルを除外

```typescript
const sync = new SqliteNasSync({
  localPath: './data/local.sqlite',
  nasDir: '/mnt/nas/shared-db/',
  excludeTables: ['logs', 'cache', 'temp_data'],
});
```

### デバッグログの有効化

```typescript
const sync = new SqliteNasSync({
  localPath: './data/local.sqlite',
  nasDir: '/mnt/nas/shared-db/',
  logLevel: 'debug',
});
```

## ログ出力例

```
[sqlite-nas-sync] === Pull started ===
[sqlite-nas-sync] Found 2 remote databases: client-def456, client-ghi789
[sqlite-nas-sync]
[sqlite-nas-sync] Processing table: users
[sqlite-nas-sync]   ✓ users: 3 inserted, 5 updated, 0 skipped
[sqlite-nas-sync] Processing table: posts
[sqlite-nas-sync]   ✓ posts: 12 inserted, 2 updated, 8 skipped
[sqlite-nas-sync]
[sqlite-nas-sync] Skipped tables:
[sqlite-nas-sync]   - _prisma_migrations (system table)
[sqlite-nas-sync]   - counters (no updated_at column)
[sqlite-nas-sync]
[sqlite-nas-sync] === Pull completed ===
```

## エラーハンドリング

```typescript
try {
  await sync.sync();
} catch (error) {
  if (error.message.includes('NAS directory does not exist')) {
    console.error('NASディレクトリにアクセスできません');
  } else if (error.message.includes('Failed to copy file')) {
    console.error('ファイルコピーに失敗しました（ロック競合の可能性）');
  } else {
    console.error('同期エラー:', error);
  }
}
```

## 制限事項

1. **Integer型の自動採番主キーは非対応**: クライアント間でID衝突が発生するため、UUID/cuidを使用してください
2. **複合主キーは非対応**: 単一カラムの主キーのみサポート
3. **SQLite専用**: PostgreSQL等の他のデータベースには対応していません
4. **ファイルシステムベース**: NAS（NFSやSMB等）でのファイル共有が前提

## ベストプラクティス

1. **論理削除の使用**: `deletedAt`カラムを追加し、物理削除を避ける
2. **定期的な同期**: 長時間同期しないとコンフリクトが増えるため、定期的に`sync()`を実行
3. **エラーハンドリング**: NASの接続エラー等に備えて適切なエラーハンドリングを実装
4. **ログレベルの調整**: 本番環境では`'warn'`または`'error'`、開発時は`'debug'`を推奨

## ライセンス

MIT
