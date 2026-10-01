# sqlite-nas-sync

複数のクライアントが、それぞれローカルに持つ SQLite データベースを、NAS 上の共有フォルダを経由して同期するための npm パッケージです。

1つの SQLite ファイルを NAS 上で複数のクライアントから直接開くと、ロックの競合やファイルの破損が起きます。このライブラリでは、各クライアントはローカルのファイルだけを読み書きし、同期のたびに他のクライアントのコピーを読んで変更を取り込み、そのあとで NAS 上の自分のコピーを更新します。

競合する変更は LWW で決めます。変更が止まれば、すべてのクライアントのユーザーテーブルの内容が一致します。

## インストール

```bash
npm install sqlite-nas-sync better-sqlite3
```

`better-sqlite3` は peerDependency なので、あわせてインストールしてください。

## クイックスタート

```typescript
import { setupSync } from 'sqlite-nas-sync'

const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
})

// 手動で1回同期する
const result = await sync.syncNow()
for (const warning of result.warnings) console.warn(warning)

// 定期同期を始める。既定の間隔は30秒
sync.start()

// 定期同期を止める
sync.stop()
```

同期するテーブルは DB から自動で見つけます。見つける条件は [テーブルの自動検出](#テーブルの自動検出) に、スキーマが満たすべき条件は [利用者が守ること](#利用者が守ること) にあります。

## 保証すること

同期の仕様は [`docs/principles.md`](docs/principles.md) に定めてあります。言葉の定義もそこにあります。この節はその要約です。

### 収束

変更が止まったあと、すべてのクライアントが同期を2周すると、すべてのクライアントのユーザーテーブルが一致します。

### 競合の決め方

同じ主キーの行に対する競合する変更は、次の順で勝ちを決めます。

1. 同じクライアントで後から実行した変更は、前の変更に勝ちます。相手の変更を同期で取り込んだあとに実行した変更も、その相手の変更に勝ちます。
2. どちらにも当てはまらない並行な変更は、アプリケーションが時刻列に書いた時刻の新しい方が勝ちます。
3. 時刻も同じなら、どのクライアントで比べても同じ答えになる規則で決めます。

同期がアプリケーションの代わりに行を作ったり書き換えたりすることはありません。ユーザーテーブルに起きることは、どこかのクライアントでアプリケーションが行った変更と、宣言された制約から決まります（原則1）。

### 削除した行は古い編集では戻らない

`DELETE` も1つの変更として、`INSERT` や `UPDATE` と同じ規則で比べます（原則2）。削除した行に対して、他のクライアントで並行に行われた、削除より古い時刻の編集があとから届いても、その行は戻りません。

削除の時刻には、削除を実行した時刻を使います。時刻列には ISO-8601 の文字列だけが入るので、この時刻と編集の時刻をそのまま比べられます ([利用者が守ること](#利用者が守ること))。

### UNIQUE が衝突した2行は統合される

主キーの違う2行が `UNIQUE` 制約で衝突したとき、LWW で勝った方だけがユーザーテーブルに入り、2行は1行として扱われます。これを統合と呼びます（原則3）。負けた方の行はユーザーテーブルに入りませんが、どちらが入るかはすべてのクライアントで同じです。統合が起きた行は `SyncResult.folds` に出ます。

統合された行をアプリケーションが `DELETE` すると、統合されていた両方の主キーが削除されます。ユーザーテーブルに見えている1行を消すと、見えていなかった側も消えるということです。削除した時点でそのクライアントがまだ取り込んでいなかった行は、この削除の対象になりません。

片方の行の `UNIQUE` 列が変わるなどして衝突がなくなると、統合は解け、両方の行がユーザーテーブルに入ります。統合が解けた行は `SyncResult.restores` に出ます。

### 子行は外部キーの宣言に従う

外部キーで他の行を参照する子行は、アプリケーションが宣言した外部キーに従います（原則4）。

- 親行が統合されたときは、子行はユーザーテーブルに入っている方の親行の子行になります。
- 親行が削除されたときは、宣言された `ON DELETE` に従います。

親行が削除されているとは、全てのクライアントの変更を合わせたとき、親行の主キーで勝っているのが `DELETE` であることをいいます。親行が同じ主キーで書き直され、その書き直しが勝てば、親行は削除されていません。

親行を `DELETE` したクライアントにその時点であった子行は、SQLite が `ON DELETE` に従って削除または更新し、その変更は他の変更と同じく他のクライアントへ伝わります。親行を書き直しても、この子行は戻りません。

親行の削除と並行に他のクライアントで書かれた子行は、どのアプリケーションも削除していないので削除しません。親行が削除されている間だけ、`ON DELETE` の種類に従って次のように扱います。

- `CASCADE` の子行はユーザーテーブルに入りません。子行の時刻が親行の削除より新しくても入りません。
- `RESTRICT` と `NO ACTION` では、外部キーを有効にした接続なら SQLite がローカルでの親行の削除を止めます。他のクライアントから親行の削除が届いたときはもう止められないので、`CASCADE` と同じく子行はユーザーテーブルに入りません。`ON DELETE` を書いていない外部キーは `NO ACTION` です。
- `SET NULL` の子行は、その列が NULL を許せば、列を NULL にした形でユーザーテーブルに入ります。許さなければ入りません。
- `SET DEFAULT` の子行は、既定値が定数で、その値が指す親行があれば、列を既定値にした形でユーザーテーブルに入ります。そうでなければ入りません。

ユーザーテーブルに入らない子行も、その変更は保持しています。親行が書き直されれば、子行は元の形でユーザーテーブルに入ります。孫行も同じように扱い、子行が入らなければ孫行も入りません。

この理由でユーザーテーブルに入らなくなった子行は `SyncResult.parentDeleted` に、再び入った子行は `SyncResult.parentReturned` に、その内容と原因の親行とともに出ます。孫行の原因には、削除された大元の行が入ります。どちらも前回の同期からの変化だけを出すので、同じ子行が他のクライアントから再び届いても、入らないままであればもう一度は出ません。

親行がまだ届いていないだけの子行も、ユーザーテーブルには入りません。こちらは `Unplaceable` の警告が `SyncResult.warnings` に出ます。親行が届けば、次の同期でユーザーテーブルに入ります。

### 保証しないこと

- 並行な変更のどちらが本当に後だったかは分かりません。比べるのはアプリケーションが時刻列に書いた値です。クライアントの時計がずれていれば、ずれた時刻のまま比べます。
- 一致する先の内容は、同期をいつ行ったかによって変わります。書き込むときの順序用の時刻は、アプリケーションが書いた時刻と、それまでに取り込んだ時刻のうち大きい方になるためです。たとえば、クライアント a が行 X を 10:00 の時刻で書き、クライアント b がそれを取り込んでから X を 09:00 の時刻で書くと、b の変更が勝ちます。b が取り込む前に 09:00 で書いていれば、a の変更が勝ちます。
- 主キーの違う2行が同じものを表しているかどうかは判断しません。判断に使うのは、アプリケーションが宣言した `UNIQUE` 制約だけです。

## 利用者が守ること

`setupSync` は起動時にスキーマとデータを調べます。守られていない項目があれば例外を投げ、例外にしない気がかりは最初の `syncNow()` の `SyncResult.warnings` に載せます。

1. **ユーザーテーブルを書くすべての接続で `PRAGMA recursive_triggers = ON` にしてください。** ライブラリは自分が開いた接続でこれを設定しますが、接続ごとの設定なので、アプリケーションが別の接続で同じ DB を書くならその接続でも設定が必要です。設定しないと、`INSERT OR REPLACE` が置き換えた行の削除が他のクライアントへ伝わりません。これは起動時に確かめられないので、例外も警告も出ません。
2. 同期するテーブルの主キーは1列で、型名を `TEXT` と宣言し、NULL を取らないようにしてください。SQLite では素の `TEXT PRIMARY KEY` は NULL を許すので、`NOT NULL` を宣言するか、テーブルを `WITHOUT ROWID` にしてください。複合主キー、`TEXT` 以外の型名、NULL を取れる主キー、主キーが NULL の既存の行は、どれも例外になります。
3. 主キーの値は、クライアントをまたいで一意にしてください。UUID や cuid を使います。自動採番では、別々のクライアントが同じ値を別の行に割り当て、その2行は同じ行として扱われます。`INTEGER PRIMARY KEY` は 2 の条件で例外になります。
4. **時刻列には ISO-8601 の文字列を書いてください。** 書き込むたびに時刻列を現在時刻にします。並行な変更は時刻列の値で決まり、削除は削除を実行した時刻で比べるので、時刻列はそれと比べられる形でなければなりません ([保証すること](#削除した行は古い編集では戻らない))。`2026-01-01T00:00:00.000Z` や `2026-01-01T00:00:00.000+00:00` のほか、日付と時刻をスペースで区切った `2026-01-01 00:00:01` や、日付だけの `2026-06-01` も使えます。Prisma の `@prisma/adapter-better-sqlite3` が既定で書く形はそのまま使えますが、`timestampFormat: "unixepoch-ms"` を指定すると数値になるので使えません。数値、ISO-8601 でない文字列、BLOB、NULL は使えません。`setupSync` は時刻列にそれらの値がある行を見つけると例外を投げ、導入したあとにそれらの値を書く `INSERT` と `UPDATE` は失敗します。現在より1年以上先の時刻がある場合は警告が出ます。
5. 列名を `_sns_` で始めないでください。ライブラリが使う接頭辞なので、例外になります。`_` で始まるテーブルは同期の対象になりません。
6. 同期するテーブルの `CREATE TABLE` 文とインデックスの定義に、決定的でない関数を書かないでください。`random()`、`randomblob()`、引数に `'now'` を含む `datetime()` などが当たります。`CHECK` 制約、式インデックス、部分インデックスの `WHERE` に加えて、列の `DEFAULT` の式も対象です。`DEFAULT CURRENT_TIMESTAMP` は関数呼び出しではないので使えます。アプリケーションが独自に登録した関数と照合順序も使えません。照合順序は `BINARY`、`NOCASE`、`RTRIM` だけが使えます。どれも例外になります。
7. すべてのクライアントで同じスキーマと同じ設定を使ってください。スキーマのバージョンが違うクライアントどうしは互いを同期しません。そのクライアントは `SyncResult.skippedRemotes` に出ます。`excludeTables`、`tableOptions`、`primaryKey` もすべてのクライアントで揃えてください。
8. 同期するテーブルどうしの外部キーを循環させないでください。自分自身を参照する外部キーは使えます。循環していると、同期のたびに失敗します。
9. 同期するテーブルを親とする外部キーは、親の主キーを参照してください。主キー以外の `UNIQUE` 列を参照すると、子行の親行が削除されたのか、まだ届いていないのかを区別できず、宣言された `ON DELETE` に従えません。子が同期しないテーブルでも同じで、どちらも例外になります。`REFERENCES parent` のように列を書かない外部キーは親の主キーを参照するので使えます。
10. 同期を始める前に、親行のない子行をなくしてください。`setupSync` は `PRAGMA foreign_key_check` を実行し、親行のない子行があるとテーブルごとに件数と親のテーブルを警告します。そのままでは、その子行は同期を始めた時点でユーザーテーブルから外れます。外部キーを有効にせずに書いてきた DB ではよく見つかるので、導入前に `PRAGMA foreign_key_check` で確かめてください。
11. **親行が削除されてもユーザーテーブルに残したい子行は、外部キーを `ON DELETE SET NULL` にしてください。** 監査ログや履歴のように、親行が削除されても残したい行は、外部キーの列を NULL 可にして `ON DELETE SET NULL` で宣言します。定数の既定値を持つ列を `ON DELETE SET DEFAULT` で宣言しても、その値が指す親行があれば残ります。`CASCADE`、`RESTRICT`、`NO ACTION` では、親行を削除したクライアントにあった子行は削除され、他のクライアントで並行に書かれた子行は親行が削除されている間ユーザーテーブルに入りません ([子行は外部キーの宣言に従う](#子行は外部キーの宣言に従う))。
12. ファイルの DB を使い、WAL モードで開いてください。`setupSync` は WAL モードに切り替えます。インメモリ DB では使えません。
13. `_` で始まる内部テーブルを書き換えないでください。内部テーブルはライブラリだけが読み書きします。アプリケーションのテーブルとビューに、内部テーブルと同じ名前を付けないでください。内部テーブルの名前は `_sync_meta`、`_sync_state`、`_changelog`、`_changelog_prune`、`_tombstone`、`_sns_` で始まる名前と、以前のバージョンが使っていた `_id_merge`、`_heartbeat` です。大文字と小文字は区別しません。同じ名前のテーブルにライブラリが読む列が無いとき、または同じ名前のビューがあるときは、`setupSync` が例外を投げます。
14. 1つの `clientId` を使うクライアントは1つだけにしてください。同じ `clientId` のクライアントが他にあると、それを検出したときに警告を出して同期を止めます。

## テーブルの自動検出

`setupSync` は DB を調べて、同期するテーブルを決めます。テーブルの一覧を指定する必要はありません。

次の条件をすべて満たすテーブルを同期します。

1. テーブル名が `_` または `sqlite_` で始まらない
2. `excludeTables` に含まれていない
3. 主キーの列がある。列名は `primaryKey` で指定し、既定は `id`
4. 時刻列がある。列名は `tableOptions` の `timestampColumn` で指定し、既定は `updatedAt`

主キーの列はあるのに時刻列がないテーブルは、同期から外したうえで警告します。時刻列を付け忘れた可能性があるためです。同期しないつもりのテーブルは `excludeTables` に入れると警告も出なくなります。`excludeTables` と `tableOptions` のテーブル名は、大文字と小文字を区別せずに照合します。

検出が見るのは列があるかどうかだけです。主キーの型などは、そのあと `setupSync` が確かめます ([利用者が守ること](#利用者が守ること))。

同期するテーブルが1つも見つからなければ、`setupSync` は例外を投げます。見つかったテーブルは `onTablesDiscovered` で受け取るか、`getSyncedTables()` で確かめられます。

### Prisma のスキーマの例

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

Prisma の `@id` は `NOT NULL` を宣言するので、[利用者が守ること](#利用者が守ること) の 2 を満たします。

## API リファレンス

公開している関数は `setupSync` と `discoverTables` の2つです。型は `TableConfig`、`TableOptions`、`DiscoverOptions`、`SyncConfig`、`SyncInstance`、`SyncResult`、`SyncTransfers`、`SkippedRemote`、`RecordFold`、`ParentDeletedRecord`、`SyncStatus`、`SyncEvent`、`SyncEventCallback` を公開しています。

### `setupSync(config: SyncConfig): SyncInstance`

ローカルの DB を開き、同期の準備をして、同期インスタンスを返します。

- DB を WAL モードにし、`recursive_triggers` を有効にします。
- 同期するテーブルを検出し、[利用者が守ること](#利用者が守ること) を確かめます。
- 変更を記録するトリガーと内部テーブルを作ります。すでにあれば、スキーマの変化に合わせて作り直します。

次の場合は例外を投げます。

- 同期するテーブルが1つも見つからない
- [利用者が守ること](#利用者が守ること) のうち、例外になる項目が守られていない

`setupSync` で見つかった警告は、最初の `syncNow()` が返す結果と `sync:complete` に渡る結果の `warnings` の先頭に入ります。`onAfterSync` に渡る結果には入りません。

#### `SyncConfig`

| オプション               | 型                                                         | 既定値         | 説明                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dbPath`                 | `string`                                                   | 必須           | ローカルの SQLite ファイルのパス                                                                                                                                                         |
| `nasPath`                | `string`                                                   | 必須           | NAS 上の共有フォルダのパス。各クライアントのコピーが `client-<clientId>.sqlite` の名前で置かれる                                                                                         |
| `clientId`               | `string`                                                   | 必須           | このクライアントの識別子。クライアントごとに一意にする。UUID を推奨                                                                                                                      |
| `excludeTables`          | `string[]`                                                 | `[]`           | 自動検出から外すテーブル名                                                                                                                                                               |
| `tableOptions`           | `Record<string, TableOptions>`                             | `{}`           | テーブルごとの設定                                                                                                                                                                       |
| `primaryKey`             | `string`                                                   | `'id'`         | 主キーの列名。すべてのテーブルで共通                                                                                                                                                     |
| `intervalMs`             | `number`                                                   | `30000`        | `start()` で始める定期同期の間隔。単位はミリ秒                                                                                                                                           |
| `changelogRetentionDays` | `number`                                                   | `7`            | 他のクライアントが差分を読むための変更の記録を保持する日数。これより古い記録は消す。記録を読み損ねたクライアントは相手のすべての行を読み直す。使えない値のときは既定値に戻し、警告を出す |
| `schemaVersion`          | `string`                                                   | 自動で計算     | スキーマのバージョン。値が違うクライアントどうしは同期しない。省略するとテーブルの構造から計算する                                                                                       |
| `suppressIdleSync`       | `boolean`                                                  | `true`         | 変わっていないファイルの転送を省く                                                                                                                                                       |
| `onAfterSync`            | `(localDb: Database.Database, result: SyncResult) => void` | なし           | 同期が終わったあとに呼ばれる。`localDb` はライブラリが開いている接続                                                                                                                     |
| `onDiscoveryWarning`     | `(message: string) => void`                                | `console.warn` | テーブルの自動検出で出た警告を受け取る                                                                                                                                                   |
| `onTablesDiscovered`     | `(tableNames: string[]) => void`                           | なし           | 同期するテーブルが決まったときに呼ばれる。指定しなければ何も出力しない                                                                                                                   |

`suppressIdleSync` が `true` のとき、前回から相手のコピーが変わっていなければ読まず、前回 NAS へ書いてから他のクライアントが読む内部テーブルが変わっていなければ NAS へ書きません。省くのは、行っても結果が変わらない転送だけです。起動直後、前回の同期が失敗したとき、20回に1回などは必ず読み書きします。実際に転送した量は `SyncResult.transfers` で確かめられます。

#### `TableOptions`

`tableOptions` の値に指定する型です。

| オプション        | 型       | 既定値        | 説明                         |
| ----------------- | -------- | ------------- | ---------------------------- |
| `timestampColumn` | `string` | `'updatedAt'` | 競合の決着に使う時刻列の列名 |

### `discoverTables(db, options?): TableConfig[]`

`setupSync` と同じ規則で、同期するテーブルを検出します。`db` は better-sqlite3 の接続です。戻り値はテーブル名の昇順です。

```typescript
import Database from 'better-sqlite3'
import { discoverTables } from 'sqlite-nas-sync'

const db = new Database('./local.sqlite')
const tables = discoverTables(db, {
  excludeTables: ['LocalCache'],
  tableOptions: { User: { timestampColumn: 'modifiedAt' } },
})
// → [{ name: 'Post' }, { name: 'User', timestampColumn: 'modifiedAt' }, ...]
```

`TableConfig` は `{ name: string; timestampColumn?: string }` です。`timestampColumn` は `tableOptions` で指定したテーブルにだけ入ります。

#### `DiscoverOptions`

| オプション      | 型                             | 既定値         | 説明                                                   |
| --------------- | ------------------------------ | -------------- | ------------------------------------------------------ |
| `primaryKey`    | `string`                       | `'id'`         | 主キーの列名                                           |
| `excludeTables` | `string[]`                     | `[]`           | 検出から外すテーブル名                                 |
| `tableOptions`  | `Record<string, TableOptions>` | `{}`           | テーブルごとの設定                                     |
| `onWarning`     | `(message: string) => void`    | `console.warn` | 主キーの列はあるが時刻列がないテーブルの警告を受け取る |

### `SyncInstance`

`setupSync` が返すオブジェクトです。

| メソッド                                                  | 説明                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `syncNow(): Promise<SyncResult>`                          | 同期を1回実行する。同期の実行中に呼ぶと `Sync already in progress` の例外になる |
| `start(): void`                                           | `intervalMs` の間隔で `syncNow()` を繰り返す。すでに始めていれば何もしない      |
| `stop(): void`                                            | 定期同期を止める                                                                |
| `getStatus(): SyncStatus`                                 | 現在の状態を返す                                                                |
| `getSyncedTables(): string[]`                             | 同期しているテーブル名の一覧を返す                                              |
| `on(event: SyncEvent, callback: SyncEventCallback): void` | イベントを受け取る関数を登録する                                                |

### `SyncResult`

`syncNow()` の戻り値です。

| 欄                  | 型                      | 意味                                                                                                                               |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `clientsSynced`     | `number`                | この回に同期した他のクライアントの数                                                                                               |
| `inserted`          | `number`                | この回にユーザーテーブルへ新しく入った行の数                                                                                       |
| `updated`           | `number`                | この回にユーザーテーブルで内容が変わった行の数                                                                                     |
| `deleted`           | `number`                | この回にユーザーテーブルから外れた行の数。削除された行のほか、統合された行と、親行が削除されているために入らなくなった子行も数える |
| `skipped`           | `number`                | 他のクライアントから届いた変更のうち、手元の変更が勝った数                                                                         |
| `conflictsResolved` | `number`                | 他のクライアントから届いた変更のうち、手元の変更に勝って置き換えた数                                                               |
| `folds`             | `RecordFold[]`          | この回に新しく統合された行                                                                                                         |
| `restores`          | `RecordFold[]`          | この回に統合が解けてユーザーテーブルに入った行                                                                                     |
| `parentDeleted`     | `ParentDeletedRecord[]` | この回に、親行が削除されているためにユーザーテーブルに入らなくなった子行                                                           |
| `parentReturned`    | `ParentDeletedRecord[]` | この回に、親行が書き直されたので再びユーザーテーブルに入った子行                                                                   |
| `warnings`          | `string[]`              | 警告。下の一覧を参照                                                                                                               |
| `skippedRemotes`    | `SkippedRemote[]`       | スキーマのバージョンが違うため同期しなかったクライアント                                                                           |
| `hadChangelogGap`   | `boolean`               | 変更の記録だけでは足りず、相手のすべての行を読み直したクライアントがあったか。初めて同期する相手がいたときも `true` になる         |
| `transfers`         | `SyncTransfers`         | この回に実際に転送したファイルの回数と量                                                                                           |

同期の途中でアプリケーションが書き込むと、その回はユーザーテーブルへの反映を見送り、`inserted`、`updated`、`deleted` は 0 になります。取り込んだ変更は次の同期で反映されます。

`RecordFold` は次の形です。

| 欄          | 型       | 意味                                                                                                |
| ----------- | -------- | --------------------------------------------------------------------------------------------------- |
| `tableName` | `string` | テーブル名                                                                                          |
| `losingId`  | `string` | ユーザーテーブルに入らなくなった行の主キー。`restores` では、統合が解けて入るようになった行の主キー |
| `winningId` | `string` | ユーザーテーブルに入っている方の行の主キー                                                          |

`ParentDeletedRecord` は次の形です。

| 欄           | 型                        | 意味                                                                     |
| ------------ | ------------------------- | ------------------------------------------------------------------------ |
| `tableName`  | `string`                  | 子行のテーブル名                                                         |
| `recordId`   | `string`                  | 子行の主キー                                                             |
| `content`    | `Record<string, unknown>` | 同期の時点で保持している子行の内容。列名から値への対応                   |
| `causeTable` | `string`                  | 削除されている親行のテーブル名。孫行では、削除された大元の行のテーブル名 |
| `causeId`    | `string`                  | 削除されている親行の主キー。孫行では、削除された大元の行の主キー         |

`parentDeleted` と `parentReturned` は、前回の同期からの変化だけを出します。同じ子行が他のクライアントから再び届いても、入らないままであればもう一度は出ません。親行を削除したクライアントにその時点であった子行は、SQLite が `ON DELETE` に従って削除するので、どちらにも出ません。`parentReturned` の `causeTable` と `causeId` は、それまで削除されていた親行です。親行が書き直されても、`NOT NULL` などの制約や統合でユーザーテーブルに入らない子行は `parentReturned` に出ません。入らなくなった子行そのものがその後に `DELETE` されたときも、`parentReturned` には出ません。

`SkippedRemote` は `{ clientId: string; remoteVersion: string | null; localVersion: string }` です。`remoteVersion` は、相手のバージョンを読めなかったときに `null` になります。

`SyncTransfers` は `{ uploads, uploadsSkipped, peerReads, peerReadsSkipped, selfReads, bytes }` で、どれも `number` です。NAS へ書いた回数と省いた回数、他のクライアントのコピーを読んだ回数と省いた回数、NAS 上の自分のコピーを読んだ回数、転送したバイト数です。

#### `warnings` に出るもの

警告は、アプリケーションの利用者に見える場所へ出してください。

- `Unplaceable <テーブル>:<主キー>: <理由>`: その行は `NOT NULL`、`CHECK`、親行がまだ届いていないことなどの理由でユーザーテーブルに入りませんでした。変更は保持しているので、原因がなくなれば次の同期でユーザーテーブルに入ります。親行が削除されているために入らない子行は、この警告ではなく `parentDeleted` に出ます。
- `Rebuild deferred: …`: 同期の途中でアプリケーションが書き込んだので、ユーザーテーブルへの反映を見送りました。次の同期で反映します。
- `Rebuild failed: …`: 外部キーの違反が残るため、そのテーブルへの反映をやめました。
- `Skipped remote <clientId>: …`、`Skipped table <テーブル>: …`、`Failed to open remote database: …`、`Sync failed for client <clientId>: …`: その相手、またはそのテーブルを今回は同期できませんでした。
- NAS 上の自分のコピーについての警告: ローカルの DB がバックアップから戻された形跡や、同じ `clientId` を使う別のクライアントを検出したときに出ます。同じ `clientId` を検出したときは、その回の同期を止めます。
- `setupSync` で見つかった警告: 親行のない子行、現在より大きく先の時刻などです ([利用者が守ること](#利用者が守ること))。
- `changelogRetentionDays: … is not a usable number of days …`: 設定値が使えないので既定値に戻しました。

### `SyncStatus`

`getStatus()` の戻り値です。

| 欄             | 型                   | 意味                                          |
| -------------- | -------------------- | --------------------------------------------- |
| `isSyncing`    | `boolean`            | 同期を実行中か                                |
| `lastSyncedAt` | `Date \| null`       | 最後に同期が成功した時刻。まだなければ `null` |
| `lastResult`   | `SyncResult \| null` | 最後に成功した同期の結果。まだなければ `null` |
| `isRunning`    | `boolean`            | `start()` による定期同期が動いているか        |

### イベント

`on(event, callback)` で登録します。`SyncEvent` は次の3つです。

| イベント        | 呼ばれるとき       | `callback` の引数 |
| --------------- | ------------------ | ----------------- |
| `sync:start`    | 同期を始めたとき   | なし              |
| `sync:complete` | 同期が成功したとき | `SyncResult`      |
| `sync:error`    | 同期が失敗したとき | 投げられた値      |

`SyncEventCallback` の型は `(data?: unknown) => void` なので、引数は受け取った側で型を付けてください。callback が投げた例外は無視されます。

```typescript
import type { SyncResult } from 'sqlite-nas-sync'

sync.on('sync:complete', (data) => {
  const result = data as SyncResult
  console.log(`${result.inserted} 行が入りました`)
})

sync.on('sync:error', (error) => {
  console.error('同期に失敗しました:', error)
})
```

## 制限事項

1. SQLite 専用です。他のデータベースには対応していません。
2. NAS 上のファイル共有が前提です。NFS や SMB などで、すべてのクライアントが同じフォルダを読み書きできる必要があります。
3. 容量が増えます。同期するテーブルの内容をライブラリの内部テーブルにもう1部持つので、DB ファイルはその分だけ大きくなります。さらに、同期するテーブル1つにつき、変更を記録するトリガーの定義が数十 KB 増えます。テーブルが多く行が少ない DB では、3 倍を超えることがあります。NAS へ転送するのは内部テーブルの分だけで、ユーザーテーブルとトリガーは含みません。書き込みにも、トリガーの分の時間がかかります。
4. 同期のたびに、他のクライアントのコピーを一時フォルダへコピーして読みます。一時フォルダは Node.js の `os.tmpdir()` で、環境変数 `TMPDIR` で変えられます。Windows では `TEMP` または `TMP` です。
5. ユーザーテーブルへの反映ではテーブル全体を入れ替えるので、`rowid` が変わります。`rowid` を外部に保存している場合、たとえばキャッシュのキーや FTS の `content_rowid` に使っている場合は、同期のたびに対応が壊れます。行は主キーで識別してください。
6. ユーザーテーブルへの反映の間、アプリケーションのトリガーは実行されません。アプリケーションのトリガーで別のテーブルを更新している場合、同期で届いた行についてはそのテーブルが更新されません。
7. 同期しないテーブルが同期するテーブルを外部キーで参照している場合、親行がユーザーテーブルから外れると、その子行も `ON DELETE` に従って変更されます。`CASCADE`、`RESTRICT`、`NO ACTION` では削除されます。同期しないテーブルの子行は変更を保持していないので、親行が戻っても戻りません。この子行は `SyncResult.parentDeleted` には出ません。
8. 他のクライアントの削除を取り込んでから、それがユーザーテーブルに反映されるまでの間に、アプリケーションがその行の一部の列だけを `UPDATE` すると、行が戻ることがあります。戻った行の、`UPDATE` で書かなかった列には、そのクライアントのユーザーテーブルに残っていた値が入り、その内容がすべてのクライアントへ伝わります。
9. NAS 上のコピーには、他のクライアントが読む内部テーブルだけが入ります。ユーザーテーブルは入らないので、NAS 上のコピーは DB のバックアップの代わりになりません。バックアップは別に取ってください。WAL モードの DB を `copyFile` でコピーすると、`-wal` ファイルの内容が含まれず、最近の書き込みが失われます。better-sqlite3 の `backup()` を使ってください。
10. 同期するテーブルの列は、`ALTER TABLE … DROP COLUMN` では削除できません。変更を記録するトリガーがすべての列を参照しているので、SQLite が `error in trigger … after drop column` で拒みます。トリガーが参照する列は SQLite の仕様で削除できないので、ライブラリの側では直せません。列を削除するときは、削除後の形のテーブルを別の名前で作り、行をコピーし、元のテーブルを `DROP TABLE` してから新しいテーブルの名前を元に戻してください。トリガーは元のテーブルと一緒に削除され、次の `setupSync` が新しい形で作り直します。列の追加と `RENAME COLUMN` は、そのまま使えます。
11. 以前のバージョンから上げたときは、最初の `setupSync` で DB を移行します。移行した DB は、以前のバージョンでは開けないことがあります。0.20.0 から上げる場合は、移行後の DB を 0.20.0 で開き直せません。詳しくは [CHANGELOG.md](CHANGELOG.md) を読んでください。

## 使用例

### 定期同期と警告の表示

```typescript
import { setupSync, type SyncResult } from 'sqlite-nas-sync'

const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  intervalMs: 5 * 60 * 1000,
})

sync.on('sync:complete', (data) => {
  const result = data as SyncResult
  for (const warning of result.warnings) console.warn(warning)
  for (const fold of result.folds) {
    console.log(
      `${fold.tableName}: ${fold.losingId} は ${fold.winningId} と統合されました`
    )
  }
})

sync.on('sync:error', (error) => {
  console.error('同期に失敗しました:', error)
})

sync.start()

process.on('beforeExit', async () => {
  sync.stop()
  await sync.syncNow()
})
```

アプリケーションが別の接続で同じ DB を書くなら、その接続でも `recursive_triggers` を有効にしてください。

```typescript
import Database from 'better-sqlite3'

const appDb = new Database('./data/local.sqlite')
appDb.pragma('recursive_triggers = ON')
```

### 親行が削除されているために入らない子行を一覧にする

親行が削除されているためにユーザーテーブルに入らなくなった子行は `SyncResult.parentDeleted` に、親行が書き直されて再び入った子行は `SyncResult.parentReturned` に出ます。どちらも前回の同期からの変化だけなので、いま入っていない子行の一覧はアプリケーションが持ちます。この例では `HiddenChildren` テーブルに、入らなくなった子行を足し、再び入った子行を消します。このテーブルは主キーの列 `id` を持たないので、同期の対象になりません。利用者はこの一覧を見て、親行を書き直すかどうかを決められます。

```typescript
import Database from 'better-sqlite3'
import { setupSync, type SyncResult } from 'sqlite-nas-sync'

const appDb = new Database('./data/local.sqlite')
appDb.pragma('recursive_triggers = ON')
appDb.exec(`
  CREATE TABLE IF NOT EXISTS HiddenChildren (
    tableName TEXT NOT NULL,
    recordId TEXT NOT NULL,
    content TEXT NOT NULL,
    causeTable TEXT NOT NULL,
    causeId TEXT NOT NULL,
    PRIMARY KEY (tableName, recordId)
  )
`)

const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
})

const hide = appDb.prepare(
  `INSERT INTO HiddenChildren VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (tableName, recordId) DO UPDATE SET
     content = excluded.content,
     causeTable = excluded.causeTable,
     causeId = excluded.causeId`
)
const show = appDb.prepare(
  `DELETE FROM HiddenChildren WHERE tableName = ? AND recordId = ?`
)

sync.on('sync:complete', (data) => {
  const result = data as SyncResult
  for (const row of result.parentDeleted) {
    hide.run(
      row.tableName,
      row.recordId,
      JSON.stringify(row.content),
      row.causeTable,
      row.causeId
    )
  }
  for (const row of result.parentReturned) {
    show.run(row.tableName, row.recordId)
  }
})
```

### 一部のテーブルを同期から外す

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  excludeTables: ['LocalCache', 'TempLog'],
})
```

### テーブルごとに時刻列を指定する

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  tableOptions: {
    users: { timestampColumn: 'updated_at' },
    posts: { timestampColumn: 'modified_at' },
  },
  changelogRetentionDays: 14,
})
```

この設定はすべてのクライアントで同じにしてください。

### 同期のあとにキャッシュを捨てる

```typescript
const sync = setupSync({
  dbPath: './data/local.sqlite',
  nasPath: '/mnt/nas/shared-db/',
  clientId: 'client-abc123',
  onAfterSync: (localDb, result) => {
    if (result.inserted > 0 || result.updated > 0 || result.deleted > 0) {
      invalidateCache()
    }
  },
})
```

## ライセンス

MIT

開発者向け: 実装の設計は、リポジトリの [docs/rows-table-design.md](https://github.com/KeppyNaushika/sqlite-nas-sync/blob/main/docs/rows-table-design.md) にあります。
