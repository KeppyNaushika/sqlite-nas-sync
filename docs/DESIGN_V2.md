# sqlite-nas-sync v2 設計ドキュメント

## 背景と課題

### v1の問題: zombie問題

changelogは7日間で掃除される。7日以上同期していなかったクライアント（staleクライアント）が復帰した時:

1. AがレコードXを削除 → `_changelog` にDELETEエントリ記録
2. 7日経過 → `_changelog` のエントリが掃除で消える
3. Bが復帰 → full-table fallbackでAからデータを取り込む
4. しかしfallbackではDELETE操作を検知できない（レコードが「ない」ことは分からない）
5. BのローカルにはXが残ったまま → NASにアップロード → 他クライアントに拡散

### v1の問題: changelog汚染

フルマージ時にトリガーが発火し、全レコード分のchangelogエントリが生成される。
これにより他クライアントが大量の不要なエントリを処理することになり、
changelogベースの差分同期の効率性が失われる。

### v1の問題: 連鎖フルマージ

フルマージ後にchangelogをクリアすると、他クライアントがギャップを検出し、
連鎖的にフルマージが発動する。

## v2 設計方針

### 原則

- **staleクライアントのローカルデータが他クライアントに悪影響を与えてはならない**
- staleクライアント自身のデータが失われるのは許容
- changelogベースの差分同期の効率性を維持する

### 新規テーブル

#### `_tombstone` テーブル（zombie対策）

DELETEされたレコードの記録を長期保持する。changelogとは独立。

```sql
CREATE TABLE IF NOT EXISTS _tombstone (
  tableName TEXT NOT NULL,
  recordId  TEXT NOT NULL,
  deletedAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tableName, recordId)
);
```

- DELETEトリガーで `_tombstone` にINSERT OR REPLACE
- **無期限保持**（pruningなし）
- フルマージ時にリモートの `_tombstone` を確認し、ローカルから該当レコードを削除
- サイズは「削除されたレコード数 × 数十バイト」程度で、無期限保持でも問題ない

#### `_heartbeat` テーブル（changelog延命）

changelog が7日間の掃除で空になることを防ぐための仕組み。

```sql
CREATE TABLE IF NOT EXISTS _heartbeat (
  id        TEXT PRIMARY KEY DEFAULT 'singleton',
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- アプリ起動中に定時（例: 毎日正午）で `updatedAt` を更新
- この更新がトリガーで `_changelog` に1エントリとして記録される
- 他クライアントに伝播し、全員のchangelogが延命される
- **アプリが起動していれば、変更がなくてもchangelogは空にならない**
- フルマージ後にも `_heartbeat` を更新 → changelog延命 → 連鎖フルマージ防止

### DELETEトリガーの変更

DELETEトリガーに `_tombstone` への記録を追加:

```sql
CREATE TRIGGER IF NOT EXISTS _changelog_after_delete_{TableName}
AFTER DELETE ON {TableName} FOR EACH ROW
BEGIN
  INSERT INTO _changelog (tableName, recordId, operation)
  VALUES ('{TableName}', OLD.{primaryKey}, 'DELETE');
  INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
  VALUES ('{TableName}', OLD.{primaryKey}, datetime('now'));
END;
```

## 同期フロー

### 通常sync（ギャップなし）

従来通り。変更なし。

```
1. ローカルDBをNASにコピー
2. リモートクライアント列挙
3. 各リモートの _changelog から差分読み取り → LWWで適用
4. lastSeenId 更新
5. 古い _changelog 掃除（7日）
```

### ギャップ検出時のフルマージ

```
1. NASへのアップロードをスキップ（pull-first）
2. 各リモートに対して:
   a. トリガー無効化
   b. リモートの全レコードをLWWでマージ
   c. リモートの _tombstone を確認し、ローカルから該当レコードを削除
      （deletedAt > ローカルのupdatedAt の場合のみ）
   d. リモートの _changelog をローカルにマージ（7日以内のエントリのみ）
   e. トリガー有効化
   f. lastSeenId 更新
3. _heartbeat.updatedAt を更新（トリガーON → changelog に1件記録）
4. ローカルDBをNASにアップロード（クリーンな状態）
5. 古い _changelog 掃除（7日）
```

#### ポイント

- **トリガー無効化**: フルマージ中のデータ適用でchangelogが汚染されるのを防止
- **changelogマージ**: リモートのchangelogエントリをローカルにコピー（7日以内）。
  これにより他クライアントとの差分同期が維持される。
- **tombstone適用**: DELETEを検知できない問題を解決。zombie防止。
- **heartbeat更新**: フルマージ後にchangelogが1件記録され、7日間延命。
  連鎖フルマージを防止。
- **pull-first**: staleデータのNAS拡散を防止。

## ギャップ検出ロジック

現行のまま変更なし。

```typescript
function hasChangelogGap(db, lastSeenId) {
  if (lastSeenId === 0) return false;           // 初回sync → ギャップなし
  const minId = SELECT MIN(id) FROM _changelog;
  if (minId === null) return true;               // changelog空 → ギャップ
  return minId > lastSeenId;                     // 読むべきエントリが消えた → ギャップ
}
```

### 誤判定について

- **変更なしで7日経過**: 全員のchangelogが空 → 全員ギャップ判定 → 全員フルマージ
  - これは必要なコスト。データは正しいので影響はパフォーマンスのみ
  - `_heartbeat` の定時更新により、アプリ起動中はこの状況を回避できる

## tombstone の LWW

tombstone適用時は `deletedAt` と `updatedAt` を比較する:

```
if (tombstone.deletedAt > localRecord.updatedAt) {
  → ローカルレコードを削除（削除の方が新しい）
}

if (tombstone.deletedAt < localRecord.updatedAt) {
  → ローカルレコードを保持（削除後に再作成された）
}
```

これにより「削除→再作成」のケースも正しく処理される。

## 公開API の変更

### SyncConfig に追加

```typescript
export interface SyncConfig {
  // ... 既存フィールド ...

  /**
   * _heartbeat の定時更新を有効にするかどうか。
   * true の場合、intervalMs ごとのsync時に _heartbeat も更新チェックする。
   * @defaultValue true
   */
  heartbeatEnabled?: boolean;

  /**
   * _heartbeat の更新間隔（ミリ秒）。
   * 最後の更新からこの時間が経過していれば _heartbeat.updatedAt を更新する。
   * @defaultValue 86400000 (24時間)
   */
  heartbeatIntervalMs?: number;
}
```

### SyncResult に追加

```typescript
export interface SyncResult {
  // ... 既存フィールド ...

  /** changelogギャップが検出されフルマージが実行されたか */
  hadChangelogGap: boolean;
}
```

## シナリオ別動作

### シナリオ1: Bがstale復帰（他は正常稼働中）

```
B: ギャップ検出 → pull-first → フルマージ(トリガーOFF)
   + tombstone適用 + changelogマージ
   → トリガーON → heartbeat更新 → NASアップロード
A: B とのchangelogにギャップなし（Bのchangelogにはマージされたエントリがある）
   → 通常の差分sync
```

→ **Aはフルマージ不要。zombie も防止。**

### シナリオ2: 全員7日間放置後に復帰

```
B: 全員とギャップ → フルマージ（差分なし）→ heartbeat更新
A: 全員とギャップ → フルマージ（差分なし）→ heartbeat更新
C: 全員とギャップ → フルマージ（差分なし）→ heartbeat更新
D: 全員とギャップ → フルマージ（差分なし）→ heartbeat更新
```

→ **全員1回ずつフルマージ（コスト）。以降はheartbeatで延命。**

### シナリオ3: 日常運用（全員アプリ起動中）

```
heartbeatが毎日更新 → changelogにエントリが常に存在
→ ギャップ発生なし → 通常の差分sync
```

→ **フルマージ不発。効率的な差分sync。**

## 変更対象ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/types.ts` | SyncConfig に heartbeat設定追加、SyncResult に hadChangelogGap 追加 |
| `src/setup.ts` | `_tombstone`, `_heartbeat` テーブル作成、DELETEトリガー変更 |
| `src/sync.ts` | フルマージフロー実装、pull-first、tombstone適用、changelogマージ、heartbeat更新 |
| `src/changelog.ts` | changelogマージ関数追加 |
| `src/nas.ts` | 変更なし |
| `src/conflict.ts` | 変更なし |
| `src/validator.ts` | 変更なし |
| `src/index.ts` | heartbeat定期更新ロジック追加 |
| `__tests__/sync.test.ts` | フルマージ、tombstone、heartbeat、pull-firstのテスト追加 |
| `__tests__/setup.test.ts` | tombstone、heartbeatテーブル・トリガーのテスト追加 |
