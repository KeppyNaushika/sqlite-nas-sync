/**
 * レコードレベルの競合解決ロジックを提供するモジュール。
 *
 * INSERT（UPSERT fallback）、UPDATE（LWW）、DELETE の3つの操作を処理する。
 *
 * @module conflict
 */
import Database from 'better-sqlite3';
import { ConflictInfo, RecordFold } from './types';
import { ensureTombstoneMergedIntoColumn, NOW_SQL } from './setup';

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * 外部キー1本ぶんの参照関係。
 *
 * SQLiteの `PRAGMA foreign_key_list` が返す行を、複合外部キー（同一 `id` の複数行）
 * ごとにまとめた形。
 * @internal
 */
interface ForeignKeyRef {
  /** 外部キーを宣言している側（子）のテーブル名 */
  childTable: string;
  /** 参照されている側（親）のテーブル名 */
  parentTable: string;
  /** 子の列と、それが指す親の列の対応 */
  columns: { childColumn: string; parentColumn: string }[];
  /**
   * 親の行が消えたときに子へ及ぶ動作。
   * `NO ACTION` / `RESTRICT` / `CASCADE` / `SET NULL` / `SET DEFAULT`。
   *
   * **`PRAGMA defer_foreign_keys` はこの動作を遅らせない**（遅れるのは検査だけ）。
   * 畳みで敗者行を消す前に、これを見て子を守る必要がある（{@link carryChildrenThroughDelete}）。
   */
  onDelete: string;
}

/** @internal SQLiteの `PRAGMA foreign_key_list` が返す行 */
interface ForeignKeyListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  /** 親の列。`REFERENCES parent` のように省略された場合は null（＝親の主キー） */
  to: string | null;
  /** 親の行が消えたときの動作（`NO ACTION` / `CASCADE` / `SET NULL` 等） */
  on_delete: string;
}

/** @internal SQLiteの `PRAGMA table_info` が返すカラム情報 */
interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * SQLiteの識別子は大文字小文字を区別しないため、テーブル名を畳んで比較する。
 * @internal
 */
function isSameIdentifier(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * DB接続ごとに「スキーマから導かれる情報」を覚えておく（`PRAGMA` の往復を減らす）。
 *
 * 畳みが一度でも起きたDBでは {@link remapMergedForeignKeys} が毎回の
 * {@link applyInsert}/{@link applyUpdate} から外部キーを走査し、
 * {@link findReferencingForeignKeys} に至っては畳み1回ごとにDB内の全テーブルへ
 * `PRAGMA` を投げる。同期の最中にスキーマは変わらないので使い回せる。
 *
 * 世代の判定には `PRAGMA schema_version`（SQLiteがスキーマ変更のたびに進める値）を使う。
 * 利用者側のマイグレーションでもフルマージ中のトリガー付け外しでも進むため、
 * 古い形のまま答え続けることはない。
 * @internal
 */
const schemaCache = new WeakMap<
  Database.Database,
  { schemaVersion: number; entries: Map<string, unknown> }
>();

/**
 * スキーマが変わっていない間だけ結果を使い回す。
 * @internal
 */
function cachedBySchema<T>(
  db: Database.Database,
  key: string,
  compute: () => T
): T {
  const schemaVersion = db.pragma('schema_version', {
    simple: true,
  }) as number;

  let cache = schemaCache.get(db);
  if (!cache || cache.schemaVersion !== schemaVersion) {
    cache = { schemaVersion, entries: new Map<string, unknown>() };
    schemaCache.set(db, cache);
  }

  if (cache.entries.has(key)) return cache.entries.get(key) as T;
  const value = compute();
  cache.entries.set(key, value);
  return value;
}

/**
 * テーブルが存在するか。
 *
 * 同期用の内部テーブル（`_changelog` / `_tombstone` など）は、利用者のDBが
 * `setupChangelog` を通していない場合や、旧バージョン由来の場合に無い。触る前に確かめる。
 * @internal
 */
function hasTable(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(tableName) !== undefined
  );
}

/**
 * 指定テーブルが宣言している外部キー（＝このテーブルから他テーブルへの参照）を返す。
 * @internal
 */
function readForeignKeys(
  db: Database.Database,
  childTable: string,
  primaryKey: string
): ForeignKeyRef[] {
  return cachedBySchema(
    db,
    `fk:${childTable.toLowerCase()}:${primaryKey}`,
    () => {
      const rows = db
        .prepare(`PRAGMA foreign_key_list(${escapeIdentifier(childTable)})`)
        .all() as ForeignKeyListRow[];

      const byId = new Map<number, ForeignKeyRef>();
      for (const row of rows) {
        const existing = byId.get(row.id);
        const column = {
          childColumn: row.from,
          // `to` が null のときは親の主キーを指す
          parentColumn: row.to ?? primaryKey,
        };
        if (existing) {
          existing.columns.push(column);
        } else {
          byId.set(row.id, {
            childTable,
            parentTable: row.table,
            columns: [column],
            onDelete: row.on_delete.toUpperCase(),
          });
        }
      }
      return Array.from(byId.values());
    }
  );
}

/**
 * 指定テーブルを指している外部キー（＝他テーブルからこのテーブルへの参照）を返す。
 *
 * `PRAGMA foreign_key_list` は「このテーブルが何を指しているか」しか答えないため、
 * DB内の全テーブルを走査して逆向きに集める。スキーマの事前知識は要らない。
 * @internal
 */
function findReferencingForeignKeys(
  db: Database.Database,
  parentTable: string,
  primaryKey: string
): ForeignKeyRef[] {
  return cachedBySchema(
    db,
    `refs:${parentTable.toLowerCase()}:${primaryKey}`,
    () => {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[];

      const refs: ForeignKeyRef[] = [];
      for (const { name } of tables) {
        for (const foreignKey of readForeignKeys(db, name, primaryKey)) {
          if (isSameIdentifier(foreignKey.parentTable, parentTable)) {
            refs.push(foreignKey);
          }
        }
      }
      return refs;
    }
  );
}

/**
 * テーブルのカラム定義（`PRAGMA table_info`）を返す。
 * @internal
 */
function readColumnInfo(
  db: Database.Database,
  tableName: string
): ColumnInfo[] {
  return cachedBySchema(db, `colinfo:${tableName.toLowerCase()}`, () => {
    return db
      .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
      .all() as ColumnInfo[];
  });
}

/**
 * テーブルのカラム名一覧を返す。
 * @internal
 */
function getTableColumns(db: Database.Database, tableName: string): string[] {
  return cachedBySchema(db, `cols:${tableName.toLowerCase()}`, () =>
    readColumnInfo(db, tableName).map((column) => column.name)
  );
}

/**
 * 指定した列がすべて NULL を取れるか。
 *
 * `NOT NULL` 宣言だけを見る。`CHECK (column IS NOT NULL)` のように別の書き方で
 * NULL を禁じている表は見分けられないため、実際に NULL を入れる側（
 * {@link carryChildrenThroughDelete}）が失敗を拾えるようにしてある。
 * @internal
 */
function areColumnsNullable(
  db: Database.Database,
  tableName: string,
  columnNames: string[]
): boolean {
  const columnInfo = readColumnInfo(db, tableName);
  return columnNames.every((columnName) => {
    const column = columnInfo.find((candidate) =>
      isSameIdentifier(candidate.name, columnName)
    );
    return column !== undefined && column.notnull === 0;
  });
}

/**
 * この接続で外部キーが実際に効いているか（`PRAGMA foreign_keys`）。
 *
 * 切られていれば `ON DELETE` の動作も起きないので、子を守る細工は要らない。
 * スキーマではなく接続ごとの設定なので {@link cachedBySchema} には載せない。
 * @internal
 */
function foreignKeysEnforced(db: Database.Database): boolean {
  return db.pragma('foreign_keys', { simple: true }) === 1;
}

/** @internal SQLiteの `PRAGMA index_list` が返す行 */
interface IndexListRow {
  seq: number;
  name: string;
  /** ユニーク索引なら 1 */
  unique: number;
  /**
   * 索引の出どころ。
   * `pk` = 主キー由来 / `u` = `UNIQUE` 宣言由来 / `c` = `CREATE UNIQUE INDEX` 由来。
   */
  origin: string;
  /** `WHERE` 付きの部分索引なら 1 */
  partial: number;
}

/**
 * @internal SQLiteの `PRAGMA index_xinfo` が返す行
 *
 * `index_info` ではなく `xinfo` を使うのは、照合順序（`coll`）まで返すため。
 * `name COLLATE NOCASE` で張られた索引を、列の既定照合順序で引くと相手を取り逃がす。
 */
interface IndexXInfoRow {
  seqno: number;
  /** 列番号。式で張られた索引の列は -2、末尾に付く rowid は -1 */
  cid: number;
  /** 列名。式で張られた索引の列は null */
  name: string | null;
  desc: number;
  /** その列の照合順序（`BINARY` / `NOCASE` / `RTRIM` / 利用者定義） */
  coll: string;
  /** 索引のキー列なら 1、参照用に付随しているだけなら 0 */
  key: number;
}

/**
 * ユニークキー1本ぶん。「この列の組が同じ行は、DB全体で1行しか居られない」という宣言。
 * @internal
 */
interface UniqueKey {
  /** 列名と、その列を索引が使っている照合順序 */
  columns: { name: string; collation: string }[];
}

/**
 * テーブルが宣言しているセカンダリUNIQUE（主キー以外のユニークキー）を列挙する。
 *
 * **スキーマのUNIQUE宣言がそのまま宣言**であり、設定ファイルや引数で重ねて教える必要は無い。
 * `PRAGMA index_list` で索引を数え、`unique` が立っていて `origin` が `pk` でないものについて
 * `PRAGMA index_xinfo` で列の組を引く。
 *
 * 主キー由来の索引（`origin = 'pk'`）は**外す**。主キーの衝突は同一行のLWWであって、
 * 別idの行を1つへ畳むセカンダリUNIQUEの衝突とは扱いが違う
 * （主キーの組が要る場面では {@link primaryKeyAsUniqueKey} を明示的に足すこと）。
 *
 * 次の2種は列の値から相手を引けないので**先に数える対象から外す**:
 *
 * - **部分索引**（`CREATE UNIQUE INDEX ... WHERE ...`）— どの行が索引に載っているかは
 *   述語を評価しないと分からない。列の値だけで引くと、実際にはぶつからない行を
 *   相手だと思い込んで畳んでしまう
 * - **式索引**（`CREATE UNIQUE INDEX ... ON t(lower(name))`）— 引くべき値が列に無い
 *
 * どちらも、残った違反はそのまま例外として呼び出し元へ抜ける（畳まずに投げる）。
 *
 * **キャッシュの寿命**: `PRAGMA schema_version` が変わるまで（{@link cachedBySchema}）。
 * `CREATE INDEX` / `DROP INDEX` / `ALTER TABLE` はいずれもこの値を進めるため、
 * 索引が変わったまま古い答えを返し続けることはない。
 * @internal
 */
function readSecondaryUniqueKeys(
  db: Database.Database,
  tableName: string
): UniqueKey[] {
  return cachedBySchema(db, `uniq:${tableName.toLowerCase()}`, () => {
    const indexes = db
      .prepare(`PRAGMA index_list(${escapeIdentifier(tableName)})`)
      .all() as IndexListRow[];

    const uniqueKeys: UniqueKey[] = [];
    for (const index of indexes) {
      if (index.unique !== 1) continue;
      if (index.origin === 'pk') continue;
      if (index.partial !== 0) continue;

      const indexColumns = (
        db
          .prepare(`PRAGMA index_xinfo(${escapeIdentifier(index.name)})`)
          .all() as IndexXInfoRow[]
      ).filter((indexColumn) => indexColumn.key === 1);

      // 式で張られた索引は列の値から引けない
      if (indexColumns.some((indexColumn) => indexColumn.name === null)) {
        continue;
      }

      uniqueKeys.push({
        columns: indexColumns.map((indexColumn) => ({
          name: String(indexColumn.name),
          collation: indexColumn.coll,
        })),
      });
    }
    return uniqueKeys;
  });
}

/**
 * 主キーの列を、ユニークキー1本として表す。
 *
 * `PRAGMA index_list` は rowid別名（`INTEGER PRIMARY KEY`）の主キーを索引として返さないので、
 * 主キーの占有相手まで引きたい場面（付け替えで行のidそのものが動く
 * {@link repointChild}）では、これを明示的に足す。
 * @internal
 */
function primaryKeyAsUniqueKey(primaryKey: string): UniqueKey {
  return { columns: [{ name: primaryKey, collation: 'BINARY' }] };
}

/**
 * 書き込もうとしている行が、ローカルのどの行とユニークキーでぶつかるかを**先に全部引く**。
 *
 * 例外を待たずに索引から数えるので、**1本目を畳んでから2本目の相手が見える**という
 * 順序が無くなる。呼び出し元は、相手を全部並べたうえで畳むかどうかを一度に決められる
 * （途中まで畳んでから拒否が決まる穴が塞がる）。
 *
 * - 値が NULL の列を含むキーは飛ばす（SQLiteのUNIQUEはNULL同士を衝突させない）
 * - `selfId` の行は相手に数えない（自分自身とは畳めない）
 * - 同じ行が複数のキーで挙がっても1件にまとめる
 *
 * @param selfId - 書き込む対象そのものの主キー値。UPDATE では更新される行のid、
 *   INSERT では入れようとしている行のid。付け替えでidが動く場合は**動く前のid**を渡す
 *   （動いた先のidを占めている行は、畳むべき相手だから）。
 * @param uniqueKeys - 照合するユニークキー。ふつうは
 *   {@link readSecondaryUniqueKeys} の結果をそのまま渡す。
 * @internal
 */
function findUniqueRivals(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  record: Record<string, unknown>,
  selfId: unknown,
  uniqueKeys: UniqueKey[]
): Record<string, unknown>[] {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);
  const rivalsById = new Map<string, Record<string, unknown>>();

  for (const uniqueKey of uniqueKeys) {
    const values = uniqueKey.columns.map((column) => record[column.name]);
    if (values.some((value) => value === null || value === undefined)) continue;

    const matchClause = uniqueKey.columns
      .map(
        (column) =>
          `${escapeIdentifier(column.name)} = ? COLLATE ${escapeIdentifier(column.collation)}`
      )
      .join(' AND ');

    const rows = db
      .prepare(
        `SELECT * FROM ${escapedTable} WHERE ${matchClause} AND ${escapedPk} IS NOT ?`
      )
      .all(...values, selfId) as Record<string, unknown>[];

    for (const row of rows) {
      rivalsById.set(String(row[primaryKey]), row);
    }
  }

  return Array.from(rivalsById.values());
}

/**
 * 衝突している相手のうち、生き残る1行を選ぶ。
 *
 * {@link isPreferredOverRival} は「時刻が新しい方、同時刻なら主キーの辞書順で小さい方」
 * という全順序なので、畳み込む順番によらず同じ行に決まる。
 * @internal
 */
function selectSurvivingRival(
  db: Database.Database,
  rivalRows: Record<string, unknown>[],
  timestampColumn: string | null,
  primaryKey: string
): Record<string, unknown> {
  return rivalRows.reduce((survivor, rivalRow) =>
    isPreferredOverRival(db, rivalRow, survivor, timestampColumn, primaryKey)
      ? rivalRow
      : survivor
  );
}

/**
 * 書き込もうとしている行が、衝突相手**全員**に勝つか。
 *
 * 1人でも勝てない相手が居れば、その書き込みは通せない。**1つも畳む前に**これを見るので、
 * 「先に見えた相手を畳んでから、次の相手に負ける」ことが起きない。
 * @internal
 */
function outranksAllRivals(
  db: Database.Database,
  record: Record<string, unknown>,
  rivalRows: Record<string, unknown>[],
  timestampColumn: string | null,
  primaryKey: string
): boolean {
  return rivalRows.every((rivalRow) =>
    isPreferredOverRival(db, record, rivalRow, timestampColumn, primaryKey)
  );
}

/**
 * LWW比較に使うタイムスタンプ列を決める。
 *
 * 畳んだ親の設定（`timestampColumn`）を優先し、子テーブルにその列が無ければ
 * ライブラリ既定の `updatedAt` を使う。どちらも無ければ null（時刻では決められない）。
 * @internal
 */
function resolveTimestampColumn(
  db: Database.Database,
  tableName: string,
  preferred: string
): string | null {
  const columns = getTableColumns(db, tableName);
  if (columns.includes(preferred)) return preferred;
  if (columns.includes('updatedAt')) return 'updatedAt';
  return null;
}

/**
 * `_id_merge` テーブルを作成する（冪等）。
 *
 * このテーブルは「セカンダリUNIQUE違反を畳んだ結果、どの行がどの行に吸収されたか」を
 * 記録する。あとから届く子の外部キーを、生き残った行へ向け直すために使う。
 * @internal
 */
function ensureIdMergeTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _id_merge (
      tableName TEXT NOT NULL,
      losingId  TEXT NOT NULL,
      winningId TEXT NOT NULL,
      mergedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      PRIMARY KEY (tableName, losingId)
    )
  `);
}

/**
 * 「敗者id → 勝者id」を、ローカル索引 `_id_merge` と、他クライアントへ伝わる
 * `_tombstone.mergedInto` の両方に記録する。
 *
 * 既存の記録が今回の敗者を勝者として指していた場合は、その記録も終端（今回の勝者）へ
 * 張り替える。こうすることで参照は常に1段で解決でき、鎖をたどる必要が無い。
 *
 * @param foldedAt - 畳みが決まった時刻。`_tombstone.deletedAt` に使う。
 *   敗者行の削除が実際には起きていない経路では**勝者行のタイムスタンプ**を渡すこと
 *   （理由は {@link recordTombstoneMerge}）。省略時は現在時刻。
 * @internal
 */
function recordMerge(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  foldedAt?: string
): void {
  if (losingId === winningId) return;
  ensureIdMergeTable(db);

  db.prepare(
    `UPDATE _id_merge SET winningId = ?, mergedAt = ${NOW_SQL}
     WHERE tableName = ? COLLATE NOCASE AND winningId = ?`
  ).run(winningId, tableName, losingId);

  db.prepare(
    `INSERT INTO _id_merge (tableName, losingId, winningId) VALUES (?, ?, ?)
     ON CONFLICT(tableName, losingId)
     DO UPDATE SET winningId = excluded.winningId, mergedAt = ${NOW_SQL}`
  ).run(tableName, losingId, winningId);

  // 畳む向きが後から反転した場合（敗者idの方に新しい更新が届き、勝者を畳んだ場合）、
  // 上の張り替えで自分自身を指す記録が生まれる。意味を持たないので捨てる。
  db.prepare(
    `DELETE FROM _id_merge WHERE tableName = ? COLLATE NOCASE AND losingId = winningId`
  ).run(tableName);

  recordTombstoneMerge(db, tableName, losingId, winningId, foldedAt);
}

/**
 * 呼び出し元へ返す畳みの一覧へ1件足す（`_id_merge` への記録と対になる）。
 *
 * `_id_merge` と同じく**畳み先の鎖を作らない**: 今回の敗者を勝者として持っていた
 * 記録は、今回の勝者へ張り替える。同じ敗者が二度畳まれた場合も、記録は1件のまま
 * 終端の勝者を指す（呼び出し元は行が消えた件数をこの一覧から数えるため、
 * 同じ行を二度数えてはいけない）。
 *
 * @param movedChildren - この畳みで付け替えた**直接の子**の行数。同じ敗者へ二度目の
 *   記録が来た場合は足し合わせる（子の付け替えは再入のたびには起きないので、
 *   ふつう二度目は 0）。
 * @param lostChildren - この畳みで**引き継げずに失われた**直接の子の行数
 *   （{@link RecordFold.lostChildren}）。
 * @internal
 */
function recordFold(
  folds: RecordFold[],
  tableName: string,
  losingId: string,
  winningId: string,
  removedLocalRow: boolean,
  movedChildren: number,
  lostChildren: number
): void {
  if (losingId === winningId) return;

  for (const fold of folds) {
    if (fold.tableName === tableName && fold.winningId === losingId) {
      fold.winningId = winningId;
    }
  }

  const existing = folds.find(
    (fold) => fold.tableName === tableName && fold.losingId === losingId
  );
  if (existing) {
    existing.winningId = winningId;
    existing.removedLocalRow = existing.removedLocalRow || removedLocalRow;
    existing.movedChildren += movedChildren;
    existing.lostChildren += lostChildren;
    return;
  }

  folds.push({
    tableName,
    losingId,
    winningId,
    removedLocalRow,
    movedChildren,
    lostChildren,
  });
}

/**
 * 畳み先を `_tombstone` に載せる（他クライアントへはこの列で伝わる）。
 *
 * - `remote_wins`（敗者行を削除した側）— DELETEトリガーが作った行に畳み先を書き込む。
 *   トリガーは `INSERT OR REPLACE` なので、**削除より後に**呼ぶこと。
 * - `local_wins`（敗者行を持っていない側）— 削除が起きないので行ごと新しく書く。
 *   敗者idは全クライアントで永久に死んでいるため、tombstoneとして正しい。
 *
 * `foldedAt` には「畳みが決まった時刻」を入れる（省略時は現在時刻）。
 * **敗者行の削除が実際には起きていない経路では、勝者行のタイムスタンプを渡すこと。**
 * 現在時刻を刻むと、実データの `updatedAt` は必ずそれより過去なので
 * {@link isShadowedByTombstone} がその id の到着を無条件に止め、ユニークキーが変わって
 * もう衝突しなくなった行まで黙って捨てることになる。勝者のタイムスタンプなら
 * 「畳みに負けた版より新しいものだけ通す」というLWWそのものの意味になる。
 *
 * 既存の行があれば `deletedAt` は**新しい方へ進める**。畳みは今下した判断なので、
 * 昔の削除記録（消えたあと再作成された行など）の古い時刻が残っていると、
 * 受け取った側のLWWがこの畳みを「古い決定」として捨ててしまう。
 *
 * `_tombstone` を持たないDBでは何もしない。
 * @internal
 */
function recordTombstoneMerge(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  foldedAt?: string
): void {
  if (!hasTable(db, '_tombstone')) return;
  ensureTombstoneMergedIntoColumn(db);

  // 畳み先の鎖を作らない（`_id_merge` と同じ扱い）
  db.prepare(
    `UPDATE _tombstone SET mergedInto = ?
     WHERE tableName = ? COLLATE NOCASE AND mergedInto = ?`
  ).run(winningId, tableName, losingId);

  // 時刻の大小はフォーマット差（ISO-T vs スペース形式）を吸収するため julianday で見る。
  // 解析できない値のときだけ文字列比較へ落とす（{@link isLaterTimestamp} と同じ方針）。
  db.prepare(
    `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
     VALUES (?, ?, COALESCE(?, ${NOW_SQL}), ?)
     ON CONFLICT(tableName, recordId) DO UPDATE SET
       mergedInto = excluded.mergedInto,
       deletedAt = CASE
         WHEN COALESCE(
                julianday(excluded.deletedAt) > julianday(_tombstone.deletedAt),
                excluded.deletedAt > _tombstone.deletedAt
              )
         THEN excluded.deletedAt
         ELSE _tombstone.deletedAt
       END`
  ).run(tableName, losingId, foldedAt ? foldedAt : null, winningId);

  // 自分自身を指す畳み先は意味を持たない（畳む向きが反転したときに生まれる）
  db.prepare(
    `UPDATE _tombstone SET mergedInto = NULL
     WHERE tableName = ? COLLATE NOCASE AND recordId = mergedInto`
  ).run(tableName);
}

/**
 * `_changelog` の現在の最大id。`_changelog` を持たないDBでは null。
 * @internal
 */
function maxChangelogId(db: Database.Database): number | null {
  if (!hasTable(db, '_changelog')) return null;
  const row = db.prepare(`SELECT MAX(id) AS maxId FROM _changelog`).get() as {
    maxId: number | null;
  };
  return row.maxId ?? 0;
}

/**
 * `_changelog` に、そのレコードのDELETEが載っているか。
 *
 * @param sinceId - 指定するとそのidより後のエントリだけを数える。「今起こした削除で
 *   トリガーが記録したか」を見るときに使う（ずっと前の削除と取り違えないように）。
 * @internal
 */
function hasChangelogDelete(
  db: Database.Database,
  tableName: string,
  recordId: string,
  sinceId: number = 0
): boolean {
  if (!hasTable(db, '_changelog')) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM _changelog
       WHERE tableName = ? COLLATE NOCASE AND recordId = ?
         AND operation = 'DELETE' AND id > ?`
    )
    .get(tableName, recordId, sinceId);
  return row !== undefined;
}

/**
 * 畳んで消えたidのDELETEを `_changelog` へ手で書く。
 *
 * 畳みは**通常の差分経路にも乗せる**必要がある。フルマージ（changelogの隙間を検出した
 * ときの経路）でしか渡らないと、隙間ができるのは保持期間を超えて同期しなかった端末だけ
 * なので、**行儀よく毎日同期している端末ほど受け取れない**という逆転になる。
 *
 * `_changelog` は既に「自分が自分の行に行った操作の記録」ではない
 * （フルマージが相手のエントリをそのまま自分の changelog へ複製する）ので、
 * 自分が持っていない行のエントリが載ること自体は元から起きている。
 *
 * `changedAt` は「記録した今」にする（トリガーと同じ）。畳みの時刻を入れると、それが
 * 保持期間より古いときに**生まれた直後の掃除で消え、二度と載らない**。受け取る側のLWWは
 * `_changelog.changedAt` ではなく `_tombstone.deletedAt` を見るので、判断はぶれない。
 *
 * tombstone を書けていない場合は書かない（畳み先の無い削除として届くと、
 * 受け取った側で子が道連れになる）。
 * @internal
 */
function writeFoldDeletion(
  db: Database.Database,
  tableName: string,
  losingId: string
): void {
  if (!hasTable(db, '_changelog')) return;
  if (!hasTable(db, '_tombstone')) return;

  const tombstone = db
    .prepare(
      `SELECT 1 FROM _tombstone
       WHERE tableName = ? COLLATE NOCASE AND recordId = ?`
    )
    .get(tableName, losingId);
  if (!tombstone) return;

  db.prepare(
    `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
     VALUES (?, ?, 'DELETE', ${NOW_SQL})`
  ).run(tableName, losingId);
}

/**
 * 敗者行をローカルに持っていない側（`local_wins`）で畳みを記録する。
 *
 * この側では敗者行のDELETEが起きないため、DELETEトリガーによる `_changelog` の記録も
 * 生まれない。{@link writeFoldDeletion} で1行だけ手書きし、通常の差分経路にも乗せる。
 *
 * @param winningTimestamp - 勝ち残ったローカル行のタイムスタンプ。tombstone の
 *   `deletedAt` に使う（理由は {@link recordTombstoneMerge}）。
 * @internal
 */
function recordMergeWithoutLocalRow(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  winningTimestamp?: string
): void {
  // 参照する前に用意する（`_id_merge` がまだ無いDBでも動くように）
  ensureIdMergeTable(db);
  const alreadyRecorded = lookupIdMerge(db, tableName, losingId) === winningId;

  recordMerge(db, tableName, losingId, winningId, winningTimestamp);

  // 同じエントリが増え続けないように、既に公開済みなら書かない。
  // 「`_id_merge` に記録済み」だけを根拠にはしない — 記録が残ったまま `_changelog` の側が
  // 掃除で消えていたり、`_changelog` がまだ無いDBで記録だけ先に入っていたりして、
  // それだと畳みが二度と差分経路に載らなくなる。
  if (alreadyRecorded && hasChangelogDelete(db, tableName, losingId)) return;

  writeFoldDeletion(db, tableName, losingId);
}

/**
 * `_id_merge` に1件でも記録があるか。
 *
 * 競合が一度も起きていないDB（大多数）ではここで打ち切り、外部キーの走査をしない。
 * @internal
 */
function hasIdMerges(db: Database.Database): boolean {
  if (!hasTable(db, '_id_merge')) return false;
  return db.prepare(`SELECT 1 FROM _id_merge LIMIT 1`).get() !== undefined;
}

/**
 * 畳まれて消えた行のidを、吸収先のidに読み替える。記録が無ければ null。
 * @internal
 */
function lookupIdMerge(
  db: Database.Database,
  tableName: string,
  losingId: string
): string | null {
  const row = db
    .prepare(
      `SELECT winningId FROM _id_merge
       WHERE tableName = ? COLLATE NOCASE AND losingId = ?`
    )
    .get(tableName, losingId) as { winningId: string } | undefined;
  return row ? String(row.winningId) : null;
}

/**
 * レコードの外部キーのうち、既に畳まれて消えた行を指しているものを、吸収先へ向け直す。
 *
 * 自分が勝った側（`local_wins`）のクライアントには敗者行が入らないため、あとから届く
 * 相手の子は存在しない親を指す。向け直さないと外部キー違反でその相手ぶんの取り込みが
 * 丸ごと巻き戻り、同期がその相手から永久に止まる。
 *
 * 親の主キー以外を指す外部キー（`REFERENCES parent(uniqueColumn)` の形）は対象外。
 * `_id_merge` が覚えているのは主キーの対応だけであり、また衝突したユニーク列の値は
 * 敗者と勝者で同一なので、その列を指す参照は向け直す必要が無い。
 * @internal
 */
function remapMergedForeignKeys(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  if (!hasIdMerges(db)) return record;

  let remapped: Record<string, unknown> | null = null;
  for (const foreignKey of readForeignKeys(db, tableName, primaryKey)) {
    for (const { childColumn, parentColumn } of foreignKey.columns) {
      if (parentColumn !== primaryKey) continue;
      const current = record[childColumn];
      if (current === null || current === undefined) continue;

      const winningId = lookupIdMerge(
        db,
        foreignKey.parentTable,
        String(current)
      );
      if (winningId === null || winningId === String(current)) continue;

      remapped = remapped ?? { ...record };
      remapped[childColumn] = winningId;
    }
  }
  return remapped ?? record;
}

/**
 * 2つの行のうち、どちらを生かすかをLWWで決める。
 *
 * タイムスタンプ列が無い（または同時刻の）場合は主キーの辞書順で決める。
 * どの端末で解決しても同じ側が残るように、端末ごとに異なる情報は使わない。
 *
 * **同点を主キーで決められるのは、主キーが端末をまたいで一意（uuid等）だから。**
 * 両端末が同じ2つのidを見て同じ答えに達するので、判定は対称で決定的になる
 * （前提そのものは {@link SyncConfig.primaryKey} に書いてある）。時刻で決まらない
 * ぶんを端末ごとに違う向きで決めると、互いに相手を畳んで生き残るidが毎周入れ替わり、
 * 永久に収束しない。**親（この行）と子（付け替えた先）で同じ規則を使うこと。**
 * @internal
 */
function isPreferredOverRival(
  db: Database.Database,
  row: Record<string, unknown>,
  rival: Record<string, unknown>,
  timestampColumn: string | null,
  primaryKey: string
): boolean {
  if (timestampColumn) {
    const rowTimestamp = String(row[timestampColumn] ?? '');
    const rivalTimestamp = String(rival[timestampColumn] ?? '');
    if (rowTimestamp !== rivalTimestamp) {
      return isLaterTimestamp(db, rowTimestamp, rivalTimestamp);
    }
  }
  return String(row[primaryKey]) < String(rival[primaryKey]);
}

/**
 * 敗者の子をどう引き取ったかの集計。
 *
 * 一部の子は**敗者行を消したあとでないと結末が決まらない**ため、`afterDelete` に
 * その後始末を積む。積んだ関数は {@link foldRowInto} が DELETE の直後に走らせ、
 * そのとき `movedChildren` / `lostChildren` を確定させる。
 * @internal
 */
interface ChildCarry {
  /** 敗者から勝者へ引き継げた直接の子の行数 */
  movedChildren: number;
  /** 引き継げずに失われた直接の子の行数（{@link RecordFold.lostChildren}） */
  lostChildren: number;
  /** 敗者行の DELETE 直後に走らせる後始末 */
  afterDelete: (() => void)[];
}

/** @internal */
function emptyChildCarry(): ChildCarry {
  return { movedChildren: 0, lostChildren: 0, afterDelete: [] };
}

/**
 * 敗者行を指している子を勝者行へ付け替える。
 *
 * 付け替えが子自身のユニーク制約にぶつかった場合（勝者側に「同じもの」が既にある場合）は、
 * 子どうしを同じLWWで1行に畳む。畳んで消える側の子には、その子の子（孫）が
 * ぶら下がっている可能性があるため、{@link foldRowInto} を再帰的に使う。
 *
 * @param deletesLosingRow - 呼び出し元がこのあと敗者行を **DELETE する** なら true。
 *   主キー以外のユニーク列を指す外部キーでは、敗者と勝者で参照先の値が同じになることが
 *   あり（勝者はまだその値を持っていない＝書き込みは畳みの後）、そのとき子は付け替え
 *   ようが無い。値が同じでも敗者の削除は子に及ぶので、削除する場合だけ子を守る
 *   （{@link carryChildrenThroughDelete}）。付け替えで敗者行のidが動くだけの経路
 *   （{@link repointChild} の再入）では削除が起きないため false。
 * @internal
 */
function repointChildren(
  db: Database.Database,
  parentTable: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  winningRow: Record<string, unknown>,
  timestampColumn: string,
  folded: Set<string>,
  folds: RecordFold[],
  deletesLosingRow: boolean
): ChildCarry {
  const carry = emptyChildCarry();
  for (const foreignKey of findReferencingForeignKeys(
    db,
    parentTable,
    primaryKey
  )) {
    const losingValues = foreignKey.columns.map(
      (column) => losingRow[column.parentColumn]
    );
    const winningValues = foreignKey.columns.map(
      (column) => winningRow[column.parentColumn]
    );

    // 敗者側の参照先がNULLなら、その参照で敗者を指している子は居ない
    if (losingValues.some((value) => value === null || value === undefined)) {
      continue;
    }
    // 勝者側の参照先がNULLなら、そこへは付け替えられない（付け替えると外部キーが壊れる）。
    // 衝突したユニーク列の値はNULLになり得ない（SQLiteのUNIQUEはNULL同士を衝突させない）ので、
    // 主キー以外を指す外部キーの、さらに限られた形でしか起こらない。
    if (winningValues.some((value) => value === null || value === undefined)) {
      if (deletesLosingRow) {
        // 付け替え先が無いまま敗者を消すので、`ON DELETE` の動作がそのまま子に及ぶ。
        // 黙らせず、実際に失われた数を数えて伝える。
        countChildrenLostToDelete(
          db,
          foreignKey,
          losingValues,
          countChildrenReferencing(db, foreignKey, losingValues),
          carry
        );
      }
      continue;
    }
    // 参照先の値が同じ。**「子は既に勝者を指している」とは限らない。**
    // 主キーを指す外部キーならその通りだが（敗者と勝者で主キーは必ず違うので、
    // そもそもここへ来ない）、主キー以外のユニーク列を指す外部キーでは、
    // 勝者はまだその値を持っていない — 書き込み（UPDATE / INSERT）は畳みの**あと**に
    // 走るため。子は敗者の行に繋がったままで、敗者を消せば道連れになる。
    if (losingValues.every((value, index) => value === winningValues[index])) {
      if (deletesLosingRow) {
        carryChildrenThroughDelete(db, foreignKey, losingValues, carry);
      }
      continue;
    }

    const escapedChildTable = escapeIdentifier(foreignKey.childTable);
    const matchClause = foreignKey.columns
      .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
      .join(' AND ');

    const childRows = db
      .prepare(`SELECT * FROM ${escapedChildTable} WHERE ${matchClause}`)
      .all(...losingValues) as Record<string, unknown>[];

    for (const childRow of childRows) {
      carry.movedChildren += repointChild(
        db,
        foreignKey,
        primaryKey,
        childRow,
        winningValues,
        timestampColumn,
        folded,
        folds
      );
    }
  }
  return carry;
}

/**
 * 敗者と勝者で参照先の値が同じ子を、敗者の DELETE を越えて勝者へ引き継ぐ。
 *
 * この形は**主キー以外のユニーク列を指す外部キー**でだけ起きる。値そのものが勝者へ
 * 移るので子の列は書き換えなくてよく、危ないのは敗者行の DELETE だけ:
 *
 * - `NO ACTION` — 何も起きない。外部キーの**検査**は
 *   {@link runDeferringForeignKeys} が終端まで遅らせてあり、そのときには勝者が
 *   この値を持っているので通る。子はそのまま勝者の子になる
 * - `CASCADE` / `SET NULL` / `SET DEFAULT` / `RESTRICT` — **子に及ぶ**。
 *   `PRAGMA defer_foreign_keys` が遅らせるのは検査であって動作ではない。
 *   参照列を一旦 NULL にして敗者から外し、削除後に元の値へ戻す（この間の
 *   宙ぶらりんは、遅延された検査が終端で見るときには解消している）
 *
 * 参照列が `NOT NULL` の場合は外せない。そのときは黙って消させず、**実際に何行
 * 失われたかを数えて** {@link RecordFold.lostChildren} で呼び出し元へ伝える。
 * @internal
 */
function carryChildrenThroughDelete(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[],
  carry: ChildCarry
): void {
  const childCount = countChildrenReferencing(db, foreignKey, referencedValues);
  if (childCount === 0) return;

  // 外部キーが効いていない接続、または削除が子に及ばない宣言なら、子は放っておいてよい
  // （検査は終端まで遅れており、そのときには勝者がこの値を持っている）
  if (foreignKey.onDelete === 'NO ACTION' || !foreignKeysEnforced(db)) {
    carry.movedChildren += childCount;
    return;
  }

  const detached = detachChildren(db, foreignKey, referencedValues);
  if (!detached) {
    countChildrenLostToDelete(db, foreignKey, referencedValues, childCount, carry);
    return;
  }

  carry.afterDelete.push(() => {
    detached.reattach();
    carry.movedChildren += childCount;
  });
}

/**
 * 子の参照列を一旦 NULL にして敗者から外す（`ON DELETE` の動作を空振りさせる）。
 *
 * 外せた場合は、敗者の削除後に元の値へ戻す手続きを返す。外せない形なら null を返す:
 *
 * - 参照列が `NOT NULL`
 * - 参照列が子自身の主キーを兼ねている（NULL にすると戻す行を指せなくなる）
 * - `CHECK (column IS NOT NULL)` のように、`NOT NULL` 以外の書き方で NULL を
 *   禁じている（実際に NULL を入れてみるまで分からないので、失敗を拾って null を返す）
 *
 * NULL にしても子のユニーク制約は壊れない（SQLiteのUNIQUEはNULL同士を衝突させない）。
 * @internal
 */
function detachChildren(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[]
): { reattach: () => void } | null {
  const childColumns = foreignKey.columns.map((column) => column.childColumn);
  if (!areColumnsNullable(db, foreignKey.childTable, childColumns)) return null;

  const keyColumns = rowKeyColumns(db, foreignKey.childTable);
  if (
    childColumns.some((childColumn) =>
      keyColumns.some((keyColumn) => isSameIdentifier(keyColumn, childColumn))
    )
  ) {
    return null;
  }

  const escapedChildTable = escapeIdentifier(foreignKey.childTable);
  const matchClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
    .join(' AND ');
  const escapedKeyColumns = keyColumns.map((keyColumn) =>
    escapeIdentifier(keyColumn)
  );

  // 戻す行を指すための鍵を、外す前に控える
  const keyRows = db
    .prepare(
      `SELECT ${escapedKeyColumns.join(', ')} FROM ${escapedChildTable} WHERE ${matchClause}`
    )
    .all(...referencedValues) as Record<string, unknown>[];

  try {
    db.prepare(
      `UPDATE ${escapedChildTable} SET ${childColumns
        .map((childColumn) => `${escapeIdentifier(childColumn)} = NULL`)
        .join(', ')} WHERE ${matchClause}`
    ).run(...referencedValues);
  } catch {
    // 外せないと分かっただけ。ここで投げて取り込みを止めてしまわない
    // （止めるとその相手からの同期が永久に止まる）。数えて伝える方へ落とす。
    return null;
  }

  const keyMatchClause = escapedKeyColumns
    .map((escapedKeyColumn) => `${escapedKeyColumn} = ?`)
    .join(' AND ');
  const reattachStatement = db.prepare(
    `UPDATE ${escapedChildTable} SET ${foreignKey.columns
      .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
      .join(', ')} WHERE ${keyMatchClause}`
  );

  return {
    reattach: (): void => {
      for (const keyRow of keyRows) {
        reattachStatement.run(
          ...referencedValues,
          ...keyColumns.map((keyColumn) => keyRow[keyColumn])
        );
      }
    },
  };
}

/**
 * 敗者の DELETE で子が実際に何行消えた（外された）かを、削除のあとに数える。
 *
 * `ON DELETE` の動作が本当に及ぶかを憶測で決めず、**削除の前後で数えて差を取る**。
 * まだ在って、まだ同じ値を指している子だけを引き継げたものとして数え、残りを
 * {@link RecordFold.lostChildren} に載せる。黙って消えるのがいちばん悪い。
 * @internal
 */
function countChildrenLostToDelete(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[],
  childCountBefore: number,
  carry: ChildCarry
): void {
  if (childCountBefore === 0) return;

  carry.afterDelete.push(() => {
    const after = countChildrenReferencing(db, foreignKey, referencedValues);
    carry.movedChildren += Math.min(after, childCountBefore);
    carry.lostChildren += Math.max(childCountBefore - after, 0);
  });
}

/**
 * その参照先の値を指している子の行数。
 * @internal
 */
function countChildrenReferencing(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[]
): number {
  const matchClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
    .join(' AND ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS childCount FROM ${escapeIdentifier(foreignKey.childTable)}
       WHERE ${matchClause}`
    )
    .get(...referencedValues) as { childCount: number };
  return row.childCount;
}

/**
 * その表で1行を指すための列。宣言された主キー、無ければ `rowid`。
 *
 * 同期の主キー（`id`）とは別に引くのは、外部キーの子が同期対象テーブルとは
 * 限らないため（複合主キーの中間テーブルなど）。
 * @internal
 */
function rowKeyColumns(db: Database.Database, tableName: string): string[] {
  return cachedBySchema(db, `rowkey:${tableName.toLowerCase()}`, () => {
    const keyColumns = readColumnInfo(db, tableName)
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    return keyColumns.length > 0 ? keyColumns : ['rowid'];
  });
}

/**
 * 既にある行の中身を、渡した行の値で上書きする（主キーは触らない）。
 *
 * 「席は1つしか無いが、そこに座るべき中身は別の行が持っている」場面で使う
 * （{@link repointChild} で、付け替え先の主キーを別の行が占めている場合）。
 * 行を消して入れ直すのではなく上書きするのは、消すとその行の子が
 * `ON DELETE` の動作で道連れになるため。
 *
 * 主キー以外に列が無い表では何もしない。
 * @internal
 */
function overwriteRow(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  row: Record<string, unknown>
): void {
  const updateColumns = getTableColumns(db, tableName).filter(
    (column) => !isSameIdentifier(column, primaryKey)
  );
  if (updateColumns.length === 0) return;

  db.prepare(
    `UPDATE ${escapeIdentifier(tableName)} SET ${updateColumns
      .map((column) => `${escapeIdentifier(column)} = ?`)
      .join(', ')} WHERE ${escapeIdentifier(primaryKey)} = ?`
  ).run(...updateColumns.map((column) => row[column]), row[primaryKey]);
}

/**
 * 子1行の外部キーを勝者へ向け直す。
 *
 * @returns 書き換えた行数（0 または 1）。この子自身が畳まれて消えた場合は 0
 *   （付け替えたのではないため。その子ぶんの {@link RecordFold} が別に出る）。
 * @internal
 */
function repointChild(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  primaryKey: string,
  childRow: Record<string, unknown>,
  winningValues: unknown[],
  timestampColumn: string,
  folded: Set<string>,
  folds: RecordFold[]
): number {
  const escapedChildTable = escapeIdentifier(foreignKey.childTable);
  const escapedPk = escapeIdentifier(primaryKey);
  const setClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
    .join(', ');
  const updateStatement = db.prepare(
    `UPDATE ${escapedChildTable} SET ${setClause} WHERE ${escapedPk} = ?`
  );

  // 付け替え後の姿
  const repointedRow = { ...childRow };
  foreignKey.columns.forEach((column, index) => {
    repointedRow[column.childColumn] = winningValues[index];
  });

  const runRepoint = (): number => {
    const changelogIdBefore = maxChangelogId(db) ?? 0;
    const { changes } = updateStatement.run(
      ...winningValues,
      childRow[primaryKey]
    );

    // 親と主キーを共有する1:1のテーブルでは、外部キーが主キーそのものなので
    // 付け替えで子のidが動く。孫は古いidを指したままになるため、ここで引き取る。
    const previousId = String(childRow[primaryKey]);
    const nextId = String(repointedRow[primaryKey]);
    if (previousId !== nextId) {
      // 孫がここで動いた数は、どの `RecordFold` にも載らない（行が消えたのではなく
      // 1行のidが動いただけなので、畳みとして記録されないため）。
      // この子1行を付け替えたことだけを数える（{@link RecordFold.movedChildren}）。
      repointChildren(
        db,
        foreignKey.childTable,
        primaryKey,
        childRow,
        repointedRow,
        timestampColumn,
        folded,
        folds,
        // この経路は行を消さない（1行のidが動くだけ）ので、
        // 子を削除から守る細工は要らないし、してはいけない
        false
      );
      // ここは行が1つ消えたのではなく、1行のidが動いただけなので `folds` には載せない
      // （利用者へ「2つを1つにまとめた」と伝える対象ではない）。
      recordMerge(db, foreignKey.childTable, previousId, nextId);

      // idが動いた＝古いidの行はもうどこにも無い。UPDATEトリガーが残すのは新しいidの
      // UPDATEだけなので、「古いid → 新しいid」の畳みは自分で差分経路へ載せる。
      if (
        !hasChangelogDelete(
          db,
          foreignKey.childTable,
          previousId,
          changelogIdBefore
        )
      ) {
        writeFoldDeletion(db, foreignKey.childTable, previousId);
      }
    }

    return changes;
  };

  try {
    return runRepoint();
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (
      sqliteErr.code !== 'SQLITE_CONSTRAINT_UNIQUE' &&
      sqliteErr.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      throw err;
    }

    // 勝者側に「同じもの」が既にある。子どうしを親と同じLWWで1行へ畳む。
    // 相手は索引から**先に全部**引く（1本目を畳んでから2本目が見える、が起きないように）。
    // 付け替えで子のidそのものが動く形（外部キーが主キーを兼ねる1:1）では、
    // 動いた先のidを占めている行も相手なので、主キーの組も足して引く。
    const rivalRows = findUniqueRivals(
      db,
      foreignKey.childTable,
      primaryKey,
      repointedRow,
      childRow[primaryKey],
      [
        primaryKeyAsUniqueKey(primaryKey),
        ...readSecondaryUniqueKeys(db, foreignKey.childTable),
      ]
    );

    // 衝突相手を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
    if (rivalRows.length === 0) throw err;

    const childTimestampColumn = resolveTimestampColumn(
      db,
      foreignKey.childTable,
      timestampColumn
    );

    // 付け替え先の主キーを既に占めている行（外部キーが子の主キーを兼ねる1:1で、
    // 付け替えによって子のidが動く場合にだけ現れる）。
    //
    // **これは畳みの候補にできない。** 畳みは「敗者idの行を消して勝者idへ寄せる」
    // ことだが、この相手のidは付け替え後の自分のidそのものなので、敗者idと勝者idが
    // 同じになる。{@link foldRowInto} は何もせずに戻り、そのあと同じ付け替えを
    // もう一度走らせて主キー違反を投げる（どの catch にも捕まらない）。
    //
    // 席は1つしか無いのだから、**どちらが勝っても残る行はこの席の行1つ**。
    // 勝敗が決めるのは中身であって、どちらの行が消えるかではない。
    const nextId = String(repointedRow[primaryKey]);
    const slotOccupant = rivalRows.find(
      (rivalRow) => String(rivalRow[primaryKey]) === nextId
    );
    const foldableRivals = rivalRows.filter(
      (rivalRow) => rivalRow !== slotOccupant
    );

    if (
      outranksAllRivals(
        db,
        repointedRow,
        rivalRows,
        childTimestampColumn,
        primaryKey
      )
    ) {
      // 付け替える側の中身が残る → 先に衝突相手を全員畳む
      const allFolded = foldableRivals
        .map((rivalRow) =>
          foldRowInto(
            db,
            foreignKey.childTable,
            primaryKey,
            rivalRow,
            repointedRow,
            timestampColumn,
            folded,
            folds
          )
        )
        .every((didFold) => didFold);

      // 畳めなかった相手が居るのに付け替えを走らせると、同じ違反をもう一度、
      // 今度は誰も受け取らない形で投げることになる。握りつぶさず呼び出し元へ渡す。
      if (!allFolded) throw err;

      if (!slotOccupant) return runRepoint();

      // 席が埋まっているので行そのものは動かせない。動かす側の行を席へ畳んでから、
      // 中身だけ席へ移す（孫は席の行へ引き取られる）。
      //
      // **この順序を逆にしてはいけない。** 明け渡す側の行がまだ在るうちに中身を席へ
      // 書くと、その行が握っているユニークな値（子自身のセカンダリUNIQUE）と衝突して
      // 投げる。畳んで消したあとなら、その値は空いている。
      foldRowInto(
        db,
        foreignKey.childTable,
        primaryKey,
        childRow,
        repointedRow,
        timestampColumn,
        folded,
        folds
      );
      overwriteRow(db, foreignKey.childTable, primaryKey, repointedRow);
      // 付け替えたのではなく畳まれて消えた（この子ぶんの `RecordFold` が別に1件出る）
      return 0;
    }

    // 衝突相手が残る → 付け替える側を衝突相手へ畳む（孫は衝突相手へ引き取られる）
    foldRowInto(
      db,
      foreignKey.childTable,
      primaryKey,
      childRow,
      selectSurvivingRival(
        db,
        rivalRows,
        childTimestampColumn,
        primaryKey
      ),
      timestampColumn,
      folded,
      folds
    );

    // この子は付け替えたのではなく畳まれて消えた。数えるのは付け替えた行だけなので 0
    // （この子ぶんの `RecordFold` が別に1件出ており、孫の数はそちらに載る）。
    return 0;
  }
}

/**
 * 敗者行を勝者行へ畳む。
 *
 * 1. 敗者を指している子を勝者へ付け替える（先に消すとカスケードで道連れになる）
 * 2. 敗者行を削除する
 * 3. 「敗者id → 勝者id」を `_id_merge` と `_tombstone.mergedInto` に記録する
 * 4. 畳みが `_changelog` に載っていなければ載せる（フルマージ中はトリガーが外れていて、
 *    2. のDELETEが何も記録しないため）
 *
 * **勝者行はこの時点でまだ存在していなくてよい。** 呼び出し元が外部キーの検査を
 * トランザクション終端まで遅延させているため（{@link foldAndReplace} を参照）。
 *
 * **敗者行の属性はマージしない。** 列の意味を知らないので、勝者が総取りする。
 * 既知の穴として据え置く（例: 「表に出す」「箱ひげ図に出す」のような真偽値の列は、
 * 本来なら両者のORを取るべきだが、ライブラリからはただの列にしか見えない）。
 *
 * **孫は動かさない。** 子の主キーは変わらないので、孫は子を指したままで正しい。
 * 子自身が畳まれて消える場合（ユニーク衝突）に限り、この関数が再帰して孫を引き取る。
 *
 * @param folded - 同じ行を二度たどらないための印（子の付け替えの再入防止）
 * @param folds - 畳んだ記録の集め先。呼び出し元を通って {@link SyncResult.folds} へ出る
 * @returns 畳んだか。**敗者idと勝者idが同じなら何もせず false**（畳みは
 *   「敗者idの行を消して勝者idへ寄せる」ことなので、同じidでは成り立たない）。
 *   呼び出し元は、畳めたつもりで先へ進まないためにこれを見ること。
 * @internal
 */
function foldRowInto(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  winningRow: Record<string, unknown>,
  timestampColumn: string,
  folded: Set<string>,
  folds: RecordFold[]
): boolean {
  const losingId = String(losingRow[primaryKey]);
  const winningId = String(winningRow[primaryKey]);
  if (losingId === winningId) return false;

  // 自己参照する外部キーがあると同じ行へ戻ってくる可能性があるため、
  // **子の付け替えだけ**は繰り返さない（無限再帰になる）。
  // 削除と記録は再入のたびに行う — ここへ再入するのは「この行は消える」と二度決まった
  // ときであり、何もせず戻ると、畳まれて消える親を指したままの子が残って
  // COMMIT時に外部キー違反になる（その相手ぶんの取り込みが丸ごと巻き戻る）。
  const marker = `${tableName.toLowerCase()}:${losingId}`;
  const revisited = folded.has(marker);
  folded.add(marker);

  // 付け替えた子の数は利用者へ返す（{@link RecordFold.movedChildren}）。
  // 再入したときは付け替えを繰り返さないので 0。
  const carry = revisited
    ? emptyChildCarry()
    : repointChildren(
        db,
        tableName,
        primaryKey,
        losingRow,
        winningRow,
        timestampColumn,
        folded,
        folds,
        // このあと敗者行を消す。値で繋がっている子は削除から守る必要がある
        true
      );

  const changelogIdBefore = maxChangelogId(db) ?? 0;

  db.prepare(
    `DELETE FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(primaryKey)} = ?`
  ).run(losingRow[primaryKey]);

  // 削除を越えて子を引き継ぐ後始末（外した参照を戻す・失われた数を数える）。
  // ここで `carry` の数が確定する。
  for (const finishCarry of carry.afterDelete) finishCarry();

  recordMerge(db, tableName, losingId, winningId);

  // 「この行とこの行が1つになった」を呼び出し元へ伝える（利用者への説明に使われる）。
  // この経路は行を消しているので removedLocalRow は true。
  recordFold(
    folds,
    tableName,
    losingId,
    winningId,
    true,
    carry.movedChildren,
    carry.lostChildren
  );

  // 通常はいま起こしたDELETEでトリガーが `_changelog` に記録している。フルマージは
  // トリガーを外して走るのでそれが無く、畳みが差分経路に載らないまま埋もれる。手で書く。
  if (!hasChangelogDelete(db, tableName, losingId, changelogIdBefore)) {
    writeFoldDeletion(db, tableName, losingId);
  }

  return true;
}

/**
 * 敗者行（複数可）を勝者行へ畳み、勝者行を挿入する。
 *
 * 1回の挿入がユニーク索引ごとに別々の行にぶつかることがあるため、敗者は**組で**受け取る。
 * 呼び出し元は全員ぶんの勝敗を先に決めてから渡すこと（途中で拒否が決まる形にしない）。
 *
 * 付け替えの時点では勝者行がまだ存在しないため、外部キーの**検査**をトランザクション
 * 終端まで遅らせる（`PRAGMA defer_foreign_keys`）。制約を切るのではなく検査を遅らせる
 * だけなので、COMMIT時に矛盾が残っていれば通常どおり失敗する。
 *
 * 畳みと挿入は1つの区切り（SAVEPOINT）で行う。想定していない制約で挿入が失敗したときに、
 * **畳んだぶんだけが残る**のを避けるため。
 * @internal
 */
function foldAndReplace(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingRows: Record<string, unknown>[],
  record: Record<string, unknown>,
  columns: string[],
  timestampColumn: string,
  folds: RecordFold[]
): void {
  runInSavepoint(db, () => {
    const folded = new Set<string>();
    for (const losingRow of losingRows) {
      foldRowInto(
        db,
        tableName,
        primaryKey,
        losingRow,
        record,
        timestampColumn,
        folded,
        folds
      );
    }
    db.prepare(
      `INSERT INTO ${escapeIdentifier(tableName)} (${columns
        .map((column) => escapeIdentifier(column))
        .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...columns.map((column) => record[column]));
  });
}

/**
 * 外部キーの検査をトランザクション終端まで遅らせて処理を実行する。
 *
 * 既にトランザクションの中ならそこへ相乗りする（pragmaは外側のCOMMITまで効く）。
 * トランザクションの外では pragma が効かない（文ごとに暗黙のCOMMITが起きる）ため、
 * ここで張る。
 * @internal
 */
function runDeferringForeignKeys<T>(
  db: Database.Database,
  apply: () => T
): T {
  const run = (): T => {
    db.pragma('defer_foreign_keys = ON');
    return apply();
  };

  if (db.inTransaction) return run();
  return db.transaction(run)();
}

/**
 * 自分だけの区切り（SAVEPOINT）を張って処理を実行する。外部キーの検査は終端まで遅らせる。
 *
 * {@link runDeferringForeignKeys} と違い、**既にトランザクションの中でも外側へ相乗り
 * しない**（better-sqlite3 の入れ子トランザクションは SAVEPOINT になる）。途中で例外を
 * 投げれば、この区切りで行ったぶんだけが巻き戻り、外側の取り込みはそのまま続けられる。
 *
 * 「畳んでから書き込む」ような、**途中でやめると片方だけ残る**処理に使う。
 * @internal
 */
function runInSavepoint<T>(db: Database.Database, apply: () => T): T {
  return db.transaction((): T => {
    db.pragma('defer_foreign_keys = ON');
    return apply();
  })();
}

/**
 * 「この行は消えたのではなく、あの行へ畳まれた」という削除をローカルへ適用する。
 *
 * リモートの `_tombstone.mergedInto` から呼ばれる。敗者行を消す前に、敗者を指している
 * 子を畳み先へ付け替えるため、**自分では競合を経験していないクライアントでも子を失わない**。
 *
 * 畳み先の行がローカルに無ければ `winningRow`（リモートから読んだ勝者行）を使って
 * 入れ替える。それも無い場合は**敗者行を消さない** — 消すと子が道連れになるためで、
 * 勝者行が届いた時点でセカンダリUNIQUE違反の解決が同じ畳みを行う。
 *
 * 敗者行に後から入った属性は勝者に取り込まれない（「勝者が総取り」の既知の穴のまま）。
 *
 * @param losingId - 畳まれて消えた側のid（`_tombstone.recordId`）
 * @param winningId - 畳み先のid（`_tombstone.mergedInto`）
 * @param winningRow - リモートから読んだ畳み先の行。読めなければ undefined
 * @param columns - ローカルテーブルのカラム名配列
 * @param foldedAt - 畳みが決まった時刻（`_tombstone.deletedAt`）。渡すと、ローカルの
 *   敗者行がそれより後に更新されている場合はこの畳みを適用しない。畳みは削除ではなく
 *   ユニーク制約が強制する統合なので、**衝突していた版**より新しい行にまで及ばせては
 *   いけない（例: 敗者行のユニークキーがその後変更され、もう衝突しない場合）。
 *   見送ってもデータは失われず、その行を送り返した時点で相手側が同じLWWを
 *   今度は逆向きに適用して収束する。
 * @returns 畳んだか（`folded`）、何もしなかったか（`skipped`）と、畳んだ記録
 * @internal
 */
export function applyMergedDelete(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  losingId: string,
  winningId: string,
  winningRow: Record<string, unknown> | undefined,
  columns: string[],
  timestampColumn: string = 'updatedAt',
  foldedAt?: string
): { action: 'folded' | 'skipped'; folds: RecordFold[] } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);
  const folds: RecordFold[] = [];

  const losingRow = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(losingId) as Record<string, unknown> | undefined;

  // 敗者行がこの畳みより後に更新されていれば、畳みは既に古い判断である。
  // `_id_merge` にも書かない（行が生きているので、その子は今のままで正しい）。
  if (
    losingRow &&
    foldedAt &&
    isLaterTimestamp(
      localDb,
      String(losingRow[timestampColumn] ?? ''),
      foldedAt
    )
  ) {
    return { action: 'skipped', folds };
  }

  // 畳みを実行できるかに関わらず、敗者idの読み替えは先に覚える。
  // これが無いと、あとから届く敗者の子が存在しない親を指したままになる。
  recordMerge(localDb, tableName, losingId, winningId, foldedAt);

  if (!losingRow) return { action: 'skipped', folds };

  const localWinningRow = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(winningId) as Record<string, unknown> | undefined;

  if (localWinningRow) {
    runDeferringForeignKeys(localDb, () => {
      foldRowInto(
        localDb,
        tableName,
        primaryKey,
        losingRow,
        localWinningRow,
        timestampColumn,
        new Set(),
        folds
      );
    });
    return { action: 'folded', folds };
  }

  if (winningRow) {
    // 勝者行もローカルに無い → 敗者を畳んでから勝者を入れる。
    // 勝者行の外部キーも、既に畳まれた行を指しているかもしれないので読み替える。
    foldAndReplace(
      localDb,
      tableName,
      primaryKey,
      [losingRow],
      remapMergedForeignKeys(localDb, tableName, primaryKey, winningRow),
      columns,
      timestampColumn,
      folds
    );
    return { action: 'folded', folds };
  }

  // 畳み先がどこにも無い → 敗者行はそのまま残す（消すと子が道連れになる）
  return { action: 'skipped', folds };
}

/**
 * 2つのタイムスタンプを「時刻」として比較する。
 *
 * 比べる値は書き手によって書式が違う。`updatedAt` はアプリが書くISO-T形式
 * （例: `2026-05-13T23:17:35.111+00:00`）。`_tombstone.deletedAt` /
 * `_changelog.changedAt` は 0.19.0 以降 {@link NOW_SQL} による同じ精度のISO-T形式だが、
 * **それ以前に書かれた行は `datetime('now')` による秒精度のスペース形式**
 * （例: `2026-05-02 02:19:56`）で残っており、両者は混在する。
 * 書式が違うと文字列としては比較できない
 * （同日でも ' '(0x20) < 'T'(0x54) となり古い書式の側が常に小さく扱われる）。
 * SQLiteの `julianday()` で正規化して数値比較し、解析不能時のみ文字列比較に
 * フォールバックする。
 *
 * @returns `a` が `b` より後（新しい）なら true
 * @internal
 */
export function isLaterTimestamp(
  db: Database.Database,
  a: string,
  b: string
): boolean {
  const row = db
    .prepare(`SELECT julianday(?) AS ja, julianday(?) AS jb`)
    .get(a, b) as { ja: number | null; jb: number | null };
  if (row.ja != null && row.jb != null) return row.ja > row.jb;
  return a > b;
}

/**
 * ローカル `_tombstone` に、指定レコードの削除が `recordTimestamp` と同時刻以降で
 * 記録されているか（＝そのレコードの挿入/更新はLWW上スキップすべきか）を返す。
 *
 * これにより「削除済みより古い（or 同時刻の）挿入/更新」による行の復活を防ぎ、
 * クライアント処理順に依存しない決定論的LWWを実現する。
 * `_tombstone` テーブルが無いDBでは常に false。
 *
 * @internal
 */
export function isShadowedByTombstone(
  localDb: Database.Database,
  tableName: string,
  recordId: string,
  recordTimestamp: string
): boolean {
  if (!hasTable(localDb, '_tombstone')) return false;

  const ts = localDb
    .prepare(
      `SELECT deletedAt FROM _tombstone WHERE tableName = ? AND recordId = ?`
    )
    .get(tableName, recordId) as { deletedAt: string } | undefined;
  if (!ts) return false;

  // record が削除より「厳密に新しい」場合のみ採用。さもなくば（同時刻含め）削除が勝つ。
  return !isLaterTimestamp(localDb, recordTimestamp, String(ts.deletedAt));
}

/**
 * {@link applyInsert} の返り値。
 * @internal
 */
interface ApplyInsertResult {
  action: 'inserted' | 'upserted' | 'skipped';
  conflict?: ConflictInfo;
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[];
}

/**
 * リモートのINSERT操作をローカルDBに適用する。
 *
 * 通常のINSERTを試み、UNIQUE制約違反（PK重複やユニークカラム重複）が
 * 発生した場合はLWW（Last-Write-Wins）でUPSERTにフォールバックする。
 * ローカル `_tombstone` により、より新しい削除が記録済みのレコードは
 * 再挿入せずスキップする（決定論的LWW）。
 *
 * 別PK・同一ユニークキーの行を畳む際は、敗者行を指している子を勝者行へ付け替えてから
 * 敗者を削除する（先に削除するとカスケードで子が道連れになる）。また、既に畳まれて
 * 消えた行を指す外部キーは、挿入前に吸収先へ向け直す。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - 挿入するリモートレコード
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`inserted` / `upserted` / `skipped`）と競合情報、
 *   および畳んだ記録（{@link RecordFold}）
 * @throws UNIQUE制約以外のSQLiteエラー
 */
export function applyInsert(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt'
): ApplyInsertResult {
  const escapedTable = escapeIdentifier(tableName);
  const escapedColumns = columns.map((c) => escapeIdentifier(c));
  const placeholders = columns.map(() => '?').join(', ');
  const folds: RecordFold[] = [];

  // より新しい削除(tombstone)が記録済みのスロットには再挿入しない（決定論的LWW: 削除が勝つ）
  if (
    isShadowedByTombstone(
      localDb,
      tableName,
      String(remoteRecord[primaryKey]),
      String(remoteRecord[timestampColumn] ?? '')
    )
  ) {
    return { action: 'skipped', folds };
  }

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す
  const record = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord
  );
  const values = columns.map((c) => record[c]);

  try {
    localDb
      .prepare(
        `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`
      )
      .run(...values);
    return { action: 'inserted', folds };
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (
      sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      const escapedPk = escapeIdentifier(primaryKey);
      const pkValue = record[primaryKey];
      const remoteUpdatedAt = String(record[timestampColumn] ?? '');

      // ケース1: 同一PKの行が存在する（PK重複）→ LWWでUPDATE
      const localRecord = localDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(pkValue) as Record<string, unknown> | undefined;

      if (localRecord) {
        const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

        if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
          const updateColumns = columns.filter((c) => c !== primaryKey);
          const setClause = updateColumns
            .map((c) => `${escapeIdentifier(c)} = ?`)
            .join(', ');
          const updateValues = [
            ...updateColumns.map((c) => record[c]),
            pkValue,
          ];

          localDb
            .prepare(
              `UPDATE ${escapedTable} SET ${setClause} WHERE ${escapedPk} = ?`
            )
            .run(...updateValues);

          return {
            action: 'upserted',
            conflict: {
              table: tableName,
              recordId: String(pkValue),
              localUpdatedAt,
              remoteUpdatedAt,
              resolution: 'remote_wins',
            },
            folds,
          };
        }

        return {
          action: 'upserted',
          conflict: {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'local_wins',
          },
          folds,
        };
      }

      // ケース2: 別PK・同一ユニークキーの行が存在する（セカンダリUNIQUE違反）。
      // 各クライアントが独立に同じ論理エンティティの行を作成した場合に発生する。
      // ローカルの競合行を**索引から先に全部**引き、全員ぶんの勝敗を決めてから畳む。
      const rivalRows = findUniqueRivals(
        localDb,
        tableName,
        primaryKey,
        record,
        pkValue,
        readSecondaryUniqueKeys(localDb, tableName)
      );

      if (rivalRows.length === 0) {
        // 競合行を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
        throw err;
      }

      const survivingRival = selectSurvivingRival(
        localDb,
        rivalRows,
        timestampColumn,
        primaryKey
      );
      const localUpdatedAt = String(survivingRival[timestampColumn] ?? '');

      // 同時刻は主キーの辞書順で決める（{@link isPreferredOverRival}）。ここを
      // 「同点ならローカルが勝つ」にすると、相手側の {@link applyUpdate} が同じ2行を
      // 逆向きに畳み、生き残るidが毎周入れ替わって永久に収束しない。
      if (
        outranksAllRivals(
          localDb,
          record,
          rivalRows,
          timestampColumn,
          primaryKey
        )
      ) {
        // リモートが新しい → ローカルの競合行を全て勝者（リモート行）へ畳んで置き換える。
        // 敗者を指している子は勝者へ付け替えてから削除する。
        // DELETEトリガーが発火するため、敗者行の削除はchangelog/tombstone経由で
        // 他クライアントにも伝播し、全体が勝者行に収束する。
        foldAndReplace(
          localDb,
          tableName,
          primaryKey,
          rivalRows,
          record,
          columns,
          timestampColumn,
          folds
        );

        return {
          action: 'upserted',
          conflict: {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'remote_wins',
          },
          folds,
        };
      }

      // ローカルが新しい → リモート行は採用しない。
      // ただし「リモートの敗者idはローカルのこの行に畳まれた」ことを記録し、
      // 他クライアントへも伝わるようにする（この側では敗者行のDELETEが起きないため、
      // tombstone と changelog を手で書く）。記録しないと、あとから届くリモート側の子が
      // 存在しない親を指したままになり、外部キー違反でその相手ぶんの取り込みが
      // 丸ごと巻き戻る（同期が止まる）。
      recordMergeWithoutLocalRow(
        localDb,
        tableName,
        String(pkValue),
        String(survivingRival[primaryKey]),
        localUpdatedAt
      );

      // 敗者行はそもそもローカルに無いので、行は消えていない（数には出さない）。
      // それでも「2つが1つになった」ことは利用者へ伝える。
      recordFold(
        folds,
        tableName,
        String(pkValue),
        String(survivingRival[primaryKey]),
        false,
        // 敗者行をローカルに持っていないので、付け替える子も失う子も居ない
        0,
        0
      );

      return {
        action: 'upserted',
        conflict: {
          table: tableName,
          recordId: String(survivingRival[primaryKey]),
          localUpdatedAt,
          remoteUpdatedAt,
          resolution: 'local_wins',
        },
        folds,
      };
    }

    throw err;
  }
}

/**
 * {@link applyUpdate} の返り値。
 * @internal
 */
interface ApplyUpdateResult {
  action: 'updated' | 'skipped' | 'inserted';
  conflict?: ConflictInfo;
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[];
}

/**
 * リモートのUPDATE操作をローカルDBに適用する。
 *
 * LWW（Last-Write-Wins）方式で `updatedAt` を比較し、
 * リモートの方が新しい場合のみローカルを更新する。
 * ローカルにレコードが存在しない場合はINSERTする。
 *
 * 書き込みがローカルの**別の行**のセカンダリUNIQUEに当たった場合は、
 * {@link applyInsert} と同じ畳み（LWWで1行へ統合する）で解決する。作成の衝突と違い
 * **更新対象の行はローカルに既に在る**ため、どちらが負けても実際に行が1つ消える:
 *
 * - 届いた更新が勝つ → 邪魔なローカル行を畳んでから書き込む
 * - ローカル行が勝つ → 更新対象の行の方を勝者へ畳む。届いた更新を黙って捨てると、
 *   相手は送り続けこちらは断り続けて**分岐したまま収束しない**。畳み先は
 *   `_tombstone.mergedInto` に載って相手にも届き、相手が同じ畳みを行う
 *
 * どちらの向きでも、消える行の子は先に生き残る行へ付け替えられる。
 *
 * ユニークが2本以上ある表では、1回の書き込みが索引ごとに別々の相手へぶつかる。
 * 相手は {@link readSecondaryUniqueKeys} で**索引から先に全部引ける**ので、
 * 1つも畳む前に全員ぶんの勝敗を決める。1人でも勝てない相手が居れば何も畳まずに拒む
 * （「先に見えた相手を畳んでから次の相手に負け、更新は拒まれたのに畳んだ行だけが
 * 消えたまま」という穴が、そもそも開かない形にしてある）。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - リモート側のレコードデータ
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`updated` / `skipped` / `inserted`）と競合情報、
 *   および畳んだ記録（{@link RecordFold}）
 */
export function applyUpdate(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt'
): ApplyUpdateResult {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す
  const record = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord
  );
  const pkValue = record[primaryKey];

  const localRecord = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(pkValue) as Record<string, unknown> | undefined;

  if (!localRecord) {
    // ローカルに存在しない → INSERT（リモートでINSERT後UPDATEされた場合など）。
    // セカンダリUNIQUE違反（別PK・同一ユニークキー）の可能性があるため、
    // 競合解決込みのapplyInsertを経由する。
    const insertResult = applyInsert(
      localDb,
      tableName,
      primaryKey,
      record,
      columns,
      timestampColumn
    );
    if (insertResult.action === 'inserted') {
      return { action: 'inserted', folds: insertResult.folds };
    }
    return {
      action:
        insertResult.conflict?.resolution === 'remote_wins'
          ? 'updated'
          : 'skipped',
      conflict: insertResult.conflict,
      folds: insertResult.folds,
    };
  }

  // LWW比較
  const remoteUpdatedAt = String(record[timestampColumn] ?? '');
  const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

  if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
    const updateColumns = columns.filter((c) => c !== primaryKey);
    const setClause = updateColumns
      .map((c) => `${escapeIdentifier(c)} = ?`)
      .join(', ');
    const values = [...updateColumns.map((c) => record[c]), pkValue];
    const updateStatement = localDb.prepare(
      `UPDATE ${escapedTable} SET ${setClause} WHERE ${escapedPk} = ?`
    );

    const remoteWins = (folds: RecordFold[]): ApplyUpdateResult => ({
      action: 'updated',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: 'remote_wins',
      },
      folds,
    });

    const localWins = (folds: RecordFold[]): ApplyUpdateResult => ({
      action: 'skipped',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: 'local_wins',
      },
      folds,
    });

    let rivalRows: Record<string, unknown>[];
    try {
      updateStatement.run(...values);
      return remoteWins([]);
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string };
      if (sqliteErr.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;

      // 書き込みがローカルの**別の行**のセカンダリUNIQUEに当たった
      // （利用者が編集できる名前の列で、両端末が独立に同じ名前へ辿り着いた場合）。
      // 相手は索引から先に全部引ける。1本ずつ畳んで確かめる必要はもう無い。
      rivalRows = findUniqueRivals(
        localDb,
        tableName,
        primaryKey,
        record,
        pkValue,
        readSecondaryUniqueKeys(localDb, tableName)
      );

      // 衝突相手を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
      // （部分索引・式索引で張られたユニークなど、列の値から相手を引けない形）。
      if (rivalRows.length === 0) throw err;
    }

    if (
      outranksAllRivals(localDb, record, rivalRows, timestampColumn, primaryKey)
    ) {
      // 届いた更新が全員に勝つ → 邪魔なローカル行を全て、更新される行へ畳んでから書き直す。
      // 敗者の子は先に勝者へ付け替わるので、カスケードで道連れにならない。
      // 畳みと書き直しは1つの区切りで行う（片方だけ残さない）。
      const folds: RecordFold[] = [];
      runInSavepoint(localDb, () => {
        const folded = new Set<string>();
        for (const rivalRow of rivalRows) {
          foldRowInto(
            localDb,
            tableName,
            primaryKey,
            rivalRow,
            record,
            timestampColumn,
            folded,
            folds
          );
        }
        updateStatement.run(...values);
      });
      return remoteWins(folds);
    }

    // ローカル行が勝った → 届いた更新は採用しない。ただし**黙って捨てない**。
    // 捨てるだけでは、相手はこの行を送り続け、こちらは断り続けて分岐したまま
    // 収束しない。ユニークキーが同じ以上この2行は同じものなので、更新対象の行の方を
    // 勝者へ畳み、その事実（`_tombstone.mergedInto`）を相手にも伝える。
    // 相手はそれを受けて同じ畳みを行い、両者が1行へ揃う。
    //
    // 畳むのは**更新対象の行だけ**にする。勝てなかった相手が複数居ても、それらは
    // 「採用しないと決めた版」を通してしか結び付いていないので、まとめて畳まない。
    const folds: RecordFold[] = [];
    runDeferringForeignKeys(localDb, () => {
      foldRowInto(
        localDb,
        tableName,
        primaryKey,
        localRecord,
        selectSurvivingRival(localDb, rivalRows, timestampColumn, primaryKey),
        timestampColumn,
        new Set(),
        folds
      );
    });
    return localWins(folds);
  }

  return {
    action: 'skipped',
    conflict:
      remoteUpdatedAt !== localUpdatedAt
        ? {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'local_wins',
          }
        : undefined,
    folds: [],
  };
}

/**
 * リモートのDELETE操作をローカルDBに適用する。
 *
 * 指定された主キーのレコードをローカルDBから削除する。
 * レコードが存在しない場合はスキップする。
 *
 * **畳まれて消えた行のidは読み替えない。** 敗者行の削除が勝者行の削除に化けてしまう。
 * 敗者idの削除はローカルでは対象が無く、そのままスキップされるのが正しい。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param recordId - 削除対象レコードの主キー値
 * @returns 実行されたアクション（`deleted` or `skipped`）
 */
export function applyDelete(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  recordId: string
): { action: 'deleted' | 'skipped' } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  const result = localDb
    .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .run(recordId);

  return { action: result.changes > 0 ? 'deleted' : 'skipped' };
}
