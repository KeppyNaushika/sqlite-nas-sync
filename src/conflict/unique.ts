/**
 * ユニークキー（主キー／セカンダリUNIQUE）の読み取りと、衝突相手の特定。
 *
 * @module conflict/unique
 * @internal
 */
import Database from 'better-sqlite3';
import {
  cachedBySchema,
  escapeIdentifier,
  foldIdentifier,
  readColumn,
} from './schema';
import { isPreferredOverRival } from './timestamp';

/** @internal SQLiteの `PRAGMA index_list` が返す行 */
export interface IndexListRow {
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
export interface IndexXInfoRow {
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
export interface UniqueKey {
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
export function readSecondaryUniqueKeys(
  db: Database.Database,
  tableName: string
): UniqueKey[] {
  return cachedBySchema(db, `uniq:${foldIdentifier(tableName)}`, () => {
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
export function primaryKeyAsUniqueKey(primaryKey: string): UniqueKey {
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
export function findUniqueRivals(
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
      rivalsById.set(String(readColumn(row, primaryKey)), row);
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
export function selectSurvivingRival(
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
export function outranksAllRivals(
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

