/**
 * 案A のトリガー（設計書 `docs/rows-table-design.md` §3.3・§3.4）。
 *
 * 同期する表ごとに**4本**作る。
 *
 * | トリガー | いつ | 何をするか |
 * | --- | --- | --- |
 * | `_sns_after_insert_<表>` | AFTER INSERT | 行の版を1つ作る |
 * | `_sns_after_update_same_<表>` | AFTER UPDATE、主キーが同じ | 行の版を1つ作る（書かなかった列は引き継ぐ） |
 * | `_sns_after_update_move_<表>` | AFTER UPDATE、主キーが違う | 古い真の id の削除の版と、新しい真の id の行の版 |
 * | `_sns_before_delete_<表>` | BEFORE DELETE | 削除の版を1つ作る |
 *
 * UPDATE を2本に分けるのは、SQLite のトリガー本体に**条件分岐が無い**からである
 * （設計書 §3.4）。
 *
 * ここで守っている決まりごと:
 *
 * 1. **番人**（`GUARD`）。4本すべての `WHEN` に
 *    `NOT EXISTS (SELECT 1 FROM _sns_rebuilding)` を AND で足す。これが無いと
 *    **作り直しの適用そのものが削除の版を作り、他端末のデータを消す**
 * 2. **書き込みはすべて `ON CONFLICT` の形**（設計書 §3.4）。
 *    `INSERT OR IGNORE` / `INSERT OR REPLACE` / 競合解決を書かない `INSERT` は
 *    **外側の文の競合解決に置き換えられる**ので使わない。これを守らないと、
 *    `ON DELETE SET NULL` の子を持つ親を消したときに**アプリの DELETE ごと失敗する**
 * 3. **3項の最大**は `ORDER BY … LIMIT 1` で書く（設計書 §3.3 の `NEWTS`）。
 *    `CASE WHEN` の入れ子にすると1つで5万文字になる。値の種類の群の式は長いので、
 *    `NEWTS` と `STRONGER` の中では1つの値について1回だけ計算する
 * 4. **`_tombstone.recordId` との比較は必ず正規形**（`CAST(… AS TEXT)`。設計書 §1.9〜1.11）
 * 5. **書かなかった列は3分岐**（設計書 §3.4）。`_sns_rows_<表>` に行が無い窓が
 *    あるので、`(SELECT …)` だけにすると NOT NULL の列が NULL になって行が消える
 * 6. **時刻列は ISO 8601 の文字列だけ**（前提 P15。原則2 のため）。INSERT と UPDATE の
 *    3本は、本体の先頭で `NEW.<時刻列>` を確かめ、違えば `RAISE(ABORT)` で
 *    アプリの書き込みを失敗させる
 *
 * @module rows/triggers
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, isSameIdentifier, NOW_SQL } from '../setup/sql'
import {
  DEFAULT_TIMESTAMP_COLUMN,
  RowsColumn,
  RowsTableSpec,
  VERSION_COLUMNS,
  primaryKeyColumn,
  quoteLiteral,
  rowsTableName,
  syncedColumns,
} from './schema'
import { TIME_GROUP, timeGroupSql } from './versions'

/* ------------------------------------------------------------------ *
 * §3.3 生成に使う式
 * ------------------------------------------------------------------ */

/**
 * 値が ISO 8601 の文字列（群3）かどうかを答える SQL の式。真なら 1、偽なら 0 で、
 * NULL にはならない。
 *
 * 同期する表の時刻列に許すのはこの値だけである（前提 P15。原則2 のため）。導入時の確かめ
 * （`src/setup/rows-preflight.ts`）とトリガーの両方がこの式を使う。判定を別に
 * 書き写すと、片方だけ直したときに「導入時には通るのに書き込みで落ちる」値が生まれる。
 * @internal
 */
export function isIsoTimeSql(value: string): string {
  return `(${timeGroupSql(value)} = ${TIME_GROUP.isoText})`
}

/** 版の3つ組（順序用の時刻・lamport・端末）。 */
interface VersionRefs {
  ts: string
  lamport: string
  instance: string
}

/**
 * 版の順序の鍵（設計書 §1.2.3〜1.2.5）。`(群, 群の中の値, L, iid)` の4列を1行で返すスカラー副問い合わせである。
 *
 * 群の中の値は、群0 では 0、群3 では `julianday`、それ以外では値そのもの（群1 は数値、群2・群4 は `COLLATE BINARY`）。
 * 群の式は長いので、副問い合わせの中で1回だけ計算する。比べる式の中で何度も書き写すと、トリガーの SQL が大きくなる。
 *
 * **`COLLATE BINARY` を明示する。** 時刻列が `COLLATE NOCASE` で宣言されていると、
 * 素の比較では `'ABC'` と `'abc'` が同着になり、値が違うのに前後が付かない。
 */
function versionKeySql(version: VersionRefs): string {
  return `(SELECT "g", (CASE "g" WHEN ${TIME_GROUP.null} THEN 0 WHEN ${TIME_GROUP.isoText} THEN julianday("v") ELSE "v" END) COLLATE BINARY,
         ${version.lamport}, ${version.instance} COLLATE BINARY
       FROM (SELECT "v", ${timeGroupSql('"v"')} AS "g" FROM (SELECT ${version.ts} AS "v")))`
}

/**
 * `STRONGER(a, b)` —— 版 `a` が版 `b` より強いか（設計書 §3.3）。
 *
 * `( _sns_ts, L, iid )` の辞書順を、{@link versionKeySql} の行値どうしの `>` で比べる。
 * 行値の比較は左の列から順に比べ、最初に等しくない列で決まる。
 * そこまでに NULL との比較があれば NULL になるので、L や iid が NULL のときの答えは、列ごとに `>` と `=` を組み合わせた式と同じである。
 */
export function strongerSql(a: VersionRefs, b: VersionRefs): string {
  return `(${versionKeySql(a)} > ${versionKeySql(b)})`
}

/**
 * 順序用の時刻の引き上げ（設計書 §1.2.1）。**3項の最大**。
 *
 * `CASE WHEN` で2項ずつ比べて入れ子にすると、項が増えるたびに式が二乗で膨らみ、
 * 3項で5万文字を超える。**並べ替えて1行取る**形にすれば、項の数だけ線形に伸びる。
 *
 * 並べ替えの鍵は §1.2.3 の順序そのもの: 群 → 群3 なら `julianday` →
 * 同じ群の中の `COLLATE BINARY`。群1（数値）では照合順序は無視され、
 * SQLite が数値として比べる。群は副問い合わせの中で1回だけ計算する。
 */
export function maxTsSql(terms: string[]): string {
  const branches = terms
    .map((term, at) => (at === 0 ? `SELECT ${term} AS "v"` : `SELECT ${term}`))
    .join(' UNION ALL ')
  return `(SELECT "v" FROM (SELECT "v", ${timeGroupSql('"v"')} AS "g" FROM (${branches}))
     ORDER BY "g" DESC,
              (CASE WHEN "g" = ${TIME_GROUP.isoText} THEN julianday("v") END) DESC,
              "v" COLLATE BINARY DESC
     LIMIT 1)`
}

/* ------------------------------------------------------------------ *
 * 表ごとの部品
 * ------------------------------------------------------------------ */

/** 1つの表について、トリガーを組み立てるのに要る材料。 */
interface TableParts {
  name: string
  literal: string
  quoted: string
  rows: string
  columns: RowsColumn[]
  primaryKey: RowsColumn
  /** 時刻列。その表に無ければ null */
  timestampColumn: string | null
}

function readParts(db: Database.Database, table: RowsTableSpec): TableParts {
  const columns = syncedColumns(db, table.name)
  const wanted = table.timestampColumn ?? DEFAULT_TIMESTAMP_COLUMN
  // 生成列でも時刻列としては読める（`NEW."x"` は見える）ので、
  // `_sns_rows_<表>` へ写す列ではなく、表の全列から探す
  const all = db.pragma(
    `table_xinfo(${escapeIdentifier(table.name)})`
  ) as RowsColumn[]
  // 名前は宣言どおりの綴りで持つ（SQL ではどちらの綴りでも同じ列だが、
  // トリガーの失敗の文面に出るので、利用者が表に書いた綴りに揃える）
  const timestamp = all.find((column) => isSameIdentifier(column.name, wanted))
  return {
    name: table.name,
    literal: quoteLiteral(table.name),
    quoted: escapeIdentifier(table.name),
    rows: escapeIdentifier(rowsTableName(table.name)),
    columns,
    primaryKey: primaryKeyColumn(db, table.name),
    timestampColumn: timestamp === undefined ? null : timestamp.name,
  }
}

/**
 * **番人**（設計書 §3.3・§3.7.2）。
 *
 * 作り直しの適用は、アプリの表から行を消し、行を入れ直す。その書き込みが
 * トリガーを通って事実になると、**適用そのものが削除の版を作り、
 * 他端末のデータを消す**。旗が立っているあいだは、4本とも何もしない。
 */
const GUARD = `NOT EXISTS (SELECT 1 FROM "_sns_rebuilding")`

/** `_sns_clock` から読む lamport。行が無ければ NULL になり、NOT NULL で落ちる。 */
const CLOCK_LAMPORT = `(SELECT "lamport" FROM "_sns_clock")`

/** `_sns_clock` から読む `instanceId`。 */
const CLOCK_INSTANCE = `(SELECT "instanceId" FROM "_sns_clock")`

/**
 * `TICK(t)`（設計書 §3.3）。**本体の先頭**（時刻列の確かめの直後）に置く。
 *
 * `_sns_clock` の `instanceId` を `(SELECT instanceId FROM _sns_clock)` から
 * 取っているのは、**行が無いときに行を作らせないため**である。作ってしまうと
 * lamport が 0 から数え直され、不変条件 C（lamport は手元のすべての版の L 以上）が
 * 黙って破れる。行が無ければ NOT NULL でアプリの書き込みごと落ちるので、
 * 利用者は `setupSync` をやり直すことになる（設計書 §3.10 の「仕掛けの欠け」）。
 * `_sns_tick` の側は、行が無ければ作ってよい（tick は単調に増えれば足りる）。
 */
function tickSql(parts: TableParts): string {
  return [
    `INSERT INTO "_sns_clock" ("onlyRow", "lamport", "instanceId", "importTick")
       VALUES (0, 1, (SELECT "instanceId" FROM "_sns_clock"), 0)
       ON CONFLICT ("onlyRow") DO UPDATE SET "lamport" = "lamport" + 1;`,
    `INSERT INTO "_sns_tick" ("tableName", "tick") VALUES (${parts.literal}, 1)
       ON CONFLICT ("tableName") DO UPDATE SET "tick" = "tick" + 1;`,
  ].join('\n      ')
}

/**
 * 時刻列に ISO 8601 の文字列以外を書かせない（前提 P15。原則2 のため）。**本体の先頭に置く。**
 *
 * 削除の版は削除を実行した時刻（ISO 8601 の文字列）で比べる。時刻列に数値や
 * ISO でない文字列が入ると、その行の版と削除の版が同じ物差しで比べられなくなる。
 * AFTER トリガーの `RAISE(ABORT)` は、その文が行った変更（アプリの表への書き込みを
 * 含む）を取り消して文を失敗させる。同じトランザクションのそれ以前の文は残る。
 *
 * 時刻列が無い表では何もしない。番人（`GUARD`）はトリガーの `WHEN` にあるので、
 * 作り直しの適用中はこの確かめも動かない。
 */
function timestampCheckSql(parts: TableParts): string {
  if (parts.timestampColumn === null) return ''
  const value = `NEW.${escapeIdentifier(parts.timestampColumn)}`
  const message =
    `同期する表 ${parts.name} の時刻列 ${parts.timestampColumn} に` +
    ` ISO-8601 の文字列でない値は書けない。` +
    `ISO-8601 の文字列（例: 2026-01-01T00:00:00.000Z）で書くこと`
  return `SELECT RAISE(ABORT, ${quoteLiteral(message)}) WHERE NOT ${isIsoTimeSql(value)};`
}

/**
 * `TRUE_ID`（設計書 §3.3）。**`_sns_shown` を shownId 側から引く。**
 *
 * 引けなければ主キーそのもの。1:1 の表では、表示している id とは別に
 * 「真の id」があり、削除の版も行の版も真の id で記録しなければならない
 * （表示している id で記録すると、他端末では別の行を指す）。
 *
 * `COALESCE` を使ってよいのはここだけである —— `_sns_shown.trueId` は NOT NULL
 * なので、「行が無い」と「値が NULL」が食い違わない。
 */
function trueIdSql(parts: TableParts, side: 'NEW' | 'OLD'): string {
  const key = `${side}.${escapeIdentifier(parts.primaryKey.name)}`
  return `COALESCE((SELECT "trueId" FROM "_sns_shown"
       WHERE "tableName" = ${parts.literal} AND "shownId" = CAST(${key} AS TEXT)), ${key})`
}

/** `KEY_TEXT`（設計書 §1.9〜1.11）。`_tombstone.recordId` と突き合わせる形。 */
function keyTextSql(parts: TableParts, side: 'NEW' | 'OLD'): string {
  return `CAST(${trueIdSql(parts, side)} AS TEXT)`
}

/** `_sns_rows_<表>` のその真の id の列を読む式（行が無ければ NULL）。 */
function rowsValueSql(
  parts: TableParts,
  column: string,
  trueId: string
): string {
  return `(SELECT ${escapeIdentifier(column)} FROM ${parts.rows}
       WHERE ${escapeIdentifier(parts.primaryKey.name)} = ${trueId})`
}

/** `_tombstone` のその真の id の列を読む式（行が無ければ NULL）。 */
function tombstoneValueSql(
  parts: TableParts,
  column: string,
  keyText: string
): string {
  return `(SELECT ${escapeIdentifier(column)} FROM "_tombstone"
       WHERE "tableName" = ${parts.literal} AND "recordId" = ${keyText})`
}

/** `_sns_rows_<表>` にその真の id の行があるか。 */
function rowsExistsSql(parts: TableParts, trueId: string): string {
  return `EXISTS (SELECT 1 FROM ${parts.rows}
       WHERE ${escapeIdentifier(parts.primaryKey.name)} = ${trueId})`
}

/** `_tombstone` にその真の id の行があるか。 */
function tombstoneExistsSql(parts: TableParts, keyText: string): string {
  return `EXISTS (SELECT 1 FROM "_tombstone"
       WHERE "tableName" = ${parts.literal} AND "recordId" = ${keyText})`
}

/**
 * 行の版の `_sns_ts`（設計書 §1.2.1 の3項の最大）。
 *
 * (1) アプリの表の時刻列の新しい値、(2) `_sns_rows_<表>` の `_sns_ts`、
 * (3) `_tombstone` の `_sns_ts`。**(3) を落とすと、消してから作り直した行が
 * 作り直せない**（設計書 §5）。
 *
 * `heldTs` は (2) を読む式で、呼び出し側が決める。
 */
function rowTsSql(
  parts: TableParts,
  side: 'NEW' | 'OLD',
  heldTs: string,
  keyText: string
): string {
  const written =
    parts.timestampColumn === null
      ? 'NULL'
      : `${side}.${escapeIdentifier(parts.timestampColumn)}`
  return maxTsSql([
    written,
    heldTs,
    tombstoneValueSql(parts, VERSION_COLUMNS.ts, keyText),
  ])
}

/**
 * 削除を実行した時刻（原則2）。
 *
 * `DELETE` も1つの変更なので、行の版が `NEW.<時刻列>` を使うのと同じように、
 * 削除の版は**削除を実行した時刻**（`_tombstone.deletedAt` と同じ {@link NOW_SQL}）を
 * 使う。これを使わないと、消した行の `updatedAt` が相手の編集より古いというだけで
 * 削除が負け、消したはずの行が戻る。
 *
 * 時刻列には ISO 8601 の文字列しか入らない（{@link timestampCheckSql} と導入時の
 * 確かめで止める）ので、`NOW_SQL` はアプリが書く時刻とそのまま比べられる。
 *
 * 時刻列が無い表では NULL にする。その表の行の版の時刻はいつも NULL で、
 * 編集どうしは書き込み順（lamport）だけで比べている。削除にだけ時刻を与えると、
 * 削除が群の差だけで必ず勝ち、同じ規則で比べたことにならない。
 */
function deletedAtSql(parts: TableParts): string {
  return parts.timestampColumn === null ? 'NULL' : NOW_SQL
}

/**
 * 削除の版の `_sns_ts`（設計書 §3.4、原則2）。
 *
 * 削除を実行した時刻（{@link deletedAtSql}）を、手元の版の時刻まで引き上げた値にする（単調化）。
 * `_sns_rows_<表>` か `_tombstone` にその id の版があれば、実行した時刻とその版の `_sns_ts` の最大を取る。
 * どちらにも版が無いとき（取り込みの COMMIT から作り直しの適用までの窓）は、消す行の `OLD.<時刻列>` をその行の版の時刻とみなし、実行した時刻との最大を取る。
 * 時刻列が無い表では、どの項も NULL なので NULL になる。
 *
 * **版の有無を `EXISTS` で分ける。**
 * `COALESCE` は「値が NULL」と「行が無い」を区別しないので、`_sns_ts` が NULL（群0）の版が手元にあるときにも `OLD.<時刻列>` を見てしまう。
 * 版があるのにアプリの表の値で引き上げるのは単調化の規則から外れるので、版があるときは版の時刻だけを使う。
 */
function deleteTsSql(
  parts: TableParts,
  trueId: string,
  keyText: string
): string {
  const fallback =
    parts.timestampColumn === null
      ? 'NULL'
      : `OLD.${escapeIdentifier(parts.timestampColumn)}`
  const deletedAt = deletedAtSql(parts)
  return `(CASE
      WHEN NOT ${rowsExistsSql(parts, trueId)}
       AND NOT ${tombstoneExistsSql(parts, keyText)}
      THEN ${maxTsSql([deletedAt, fallback])}
      ELSE ${maxTsSql([
        deletedAt,
        rowsValueSql(parts, VERSION_COLUMNS.ts, trueId),
        tombstoneValueSql(parts, VERSION_COLUMNS.ts, keyText),
      ])}
    END)`
}

/**
 * `_sns_rows_<表>` へ行の版を書く upsert（値の式は呼び出し側が決める）。
 *
 * `from` を渡したときは、値の式をその `FROM` 句から1行選ぶ `INSERT … SELECT` の形にする。
 * `ON CONFLICT` の前に `WHERE` が無いと、結合の `ON` と取り違えて構文の誤りになるので、`WHERE true` を足す。
 */
function upsertRowSql(
  parts: TableParts,
  values: Map<string, string>,
  ts: string,
  from: string | null = null
): string {
  const names = [
    ...parts.columns.map((column) => escapeIdentifier(column.name)),
    escapeIdentifier(VERSION_COLUMNS.ts),
    escapeIdentifier(VERSION_COLUMNS.lamport),
    escapeIdentifier(VERSION_COLUMNS.instance),
  ]
  const expressions = [
    ...parts.columns.map((column) => values.get(column.name) as string),
    ts,
    CLOCK_LAMPORT,
    CLOCK_INSTANCE,
  ]
  const assignments = [
    ...parts.columns
      .filter((column) => !isSameIdentifier(column.name, parts.primaryKey.name))
      .map(
        (column) =>
          `${escapeIdentifier(column.name)} = "excluded".${escapeIdentifier(column.name)}`
      ),
    `${escapeIdentifier(VERSION_COLUMNS.ts)} = "excluded".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    `${escapeIdentifier(VERSION_COLUMNS.lamport)} = "excluded".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    `${escapeIdentifier(VERSION_COLUMNS.instance)} = "excluded".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  ]
  const excluded: VersionRefs = {
    ts: `"excluded".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"excluded".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"excluded".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const held: VersionRefs = {
    ts: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const source =
    from === null
      ? `VALUES (${expressions.join(', ')})`
      : `SELECT ${expressions.join(', ')} ${from} WHERE true`
  return `INSERT INTO ${parts.rows} (${names.join(', ')})
       ${source}
       ON CONFLICT (${escapeIdentifier(parts.primaryKey.name)}) DO UPDATE SET
         ${assignments.join(',\n         ')}
       WHERE ${strongerSql(excluded, held)};`
}

/**
 * `_tombstone` へ削除の版を書く upsert（設計書 §3.4）。
 *
 * `guard` が渡されたときは `INSERT … SELECT … WHERE` の形にする
 * （トリガー本体には条件分岐が無いので、文ごと条件で消すしかない）。
 */
function upsertTombstoneSql(
  parts: TableParts,
  keyText: string,
  ts: string,
  guard: string | null
): string {
  const excluded: VersionRefs = {
    ts: `"excluded".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"excluded".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"excluded".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const held: VersionRefs = {
    ts: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const columns = `("tableName", "recordId", "deletedAt", ${escapeIdentifier(
    VERSION_COLUMNS.ts
  )}, ${escapeIdentifier(VERSION_COLUMNS.lamport)}, ${escapeIdentifier(
    VERSION_COLUMNS.instance
  )})`
  const values = `${parts.literal}, ${keyText}, ${NOW_SQL}, ${ts}, ${CLOCK_LAMPORT}, ${CLOCK_INSTANCE}`
  const source =
    guard === null ? `VALUES (${values})` : `SELECT ${values} WHERE ${guard}`
  return `INSERT INTO "_tombstone" ${columns}
       ${source}
       ON CONFLICT ("tableName", "recordId") DO UPDATE SET
         "deletedAt" = "excluded"."deletedAt",
         ${escapeIdentifier(VERSION_COLUMNS.ts)} = ${excluded.ts},
         ${escapeIdentifier(VERSION_COLUMNS.lamport)} = ${excluded.lamport},
         ${escapeIdentifier(VERSION_COLUMNS.instance)} = ${excluded.instance}
       WHERE ${strongerSql(excluded, held)};`
}

/**
 * 統合で隠れている主キーの集合（原則3）。
 *
 * `_sns_hidden.winnerId` には**真の id の正規形**が入る（`src/rows/derive.ts` の
 * `findWinner`）。`keyText` も同じ正規形なので、そのまま突き合わせてよい。
 * かぶる相手が見つからずに隠れた行（`winnerId` が NULL）は統合ではないので、
 * この条件では拾われない。
 */
function hiddenBehindSql(parts: TableParts, keyText: string): string {
  return `FROM "_sns_hidden" AS "h"
       WHERE "h"."tableName" = ${parts.literal}
         AND "h"."winnerId" = ${keyText}`
}

/**
 * 統合されていた側の主キーにも削除の版を書く（原則3）。
 *
 * `UNIQUE` が衝突して統合された2行は、アプリケーションから見れば1行である。
 * その1行を `DELETE` したのに片方の主キーにしか削除の版を書かないと、
 * 統合が崩れ、隠れていた側が次の作り直しで**中身の違う行として現れる**。
 *
 * 順序用の時刻は、**隠れている側が持っている版の時刻**と、削除を実行した時刻の
 * 最大にする。隠れている側の行の版より弱いと、消したはずの行がその版に負けて
 * 戻ってくる。`_sns_lamport` は手元の時計なので、取り込んだどの値より
 * 進んでいる（単調化）。
 *
 * 削除を実行した時刻は {@link deletedAtSql} と同じものを使う。
 *
 * 隠れている行はアプリの表に無く、その `DELETE` トリガーは発火しない。
 * だからここで**まとめて**書くしかない。
 */
function mergedTombstoneSql(parts: TableParts, keyText: string): string {
  const pk = escapeIdentifier(parts.primaryKey.name)
  const heldTs = `(SELECT ${escapeIdentifier(VERSION_COLUMNS.ts)} FROM ${parts.rows}
         WHERE CAST(${pk} AS TEXT) = "h"."trueId")`
  const hiddenTs = maxTsSql([
    deletedAtSql(parts),
    heldTs,
    `(SELECT ${escapeIdentifier(VERSION_COLUMNS.ts)} FROM "_tombstone"
         WHERE "tableName" = ${parts.literal} AND "recordId" = "h"."trueId")`,
  ])
  const excluded: VersionRefs = {
    ts: `"excluded".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"excluded".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"excluded".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const held: VersionRefs = {
    ts: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"_tombstone".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  return `INSERT INTO "_tombstone" ("tableName", "recordId", "deletedAt", ${escapeIdentifier(
    VERSION_COLUMNS.ts
  )}, ${escapeIdentifier(VERSION_COLUMNS.lamport)}, ${escapeIdentifier(
    VERSION_COLUMNS.instance
  )})
       SELECT ${parts.literal}, "h"."trueId", ${NOW_SQL}, ${hiddenTs}, ${CLOCK_LAMPORT}, ${CLOCK_INSTANCE}
       ${hiddenBehindSql(parts, keyText)}
       ON CONFLICT ("tableName", "recordId") DO UPDATE SET
         "deletedAt" = "excluded"."deletedAt",
         ${escapeIdentifier(VERSION_COLUMNS.ts)} = ${excluded.ts},
         ${escapeIdentifier(VERSION_COLUMNS.lamport)} = ${excluded.lamport},
         ${escapeIdentifier(VERSION_COLUMNS.instance)} = ${excluded.instance}
       WHERE ${strongerSql(excluded, held)};`
}

/** 統合されていた側の、負けた行の版を落とす（原則3）。 */
function mergedRowsCleanupSql(parts: TableParts, keyText: string): string {
  const pk = escapeIdentifier(parts.primaryKey.name)
  const tombstone: VersionRefs = {
    ts: `"tb".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"tb".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"tb".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const held: VersionRefs = {
    ts: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  return `DELETE FROM ${parts.rows}
       WHERE CAST(${pk} AS TEXT) IN (SELECT "h"."trueId" ${hiddenBehindSql(parts, keyText)})
         AND EXISTS (SELECT 1 FROM "_tombstone" AS "tb"
               WHERE "tb"."tableName" = ${parts.literal}
                 AND "tb"."recordId" = CAST(${parts.rows}.${pk} AS TEXT)
                 AND ${strongerSql(tombstone, held)});`
}

/** 統合されていた側の主キーも `_changelog` で告げる（原則3）。 */
function mergedChangelogSql(parts: TableParts, keyText: string): string {
  return `INSERT INTO "_changelog" ("tableName", "recordId", "operation", "changedAt")
       SELECT ${parts.literal}, "h"."trueId", 'DELETE', ${NOW_SQL}
       ${hiddenBehindSql(parts, keyText)}
       ON CONFLICT DO NOTHING;`
}

/** `_changelog` への通知（対象の無い `ON CONFLICT DO NOTHING`）。 */
function changelogSql(
  parts: TableParts,
  keyText: string,
  operation: string,
  guard: string | null
): string {
  const values = `${parts.literal}, ${keyText}, '${operation}', ${NOW_SQL}`
  const source =
    guard === null ? `VALUES (${values})` : `SELECT ${values} WHERE ${guard}`
  return `INSERT INTO "_changelog" ("tableName", "recordId", "operation", "changedAt")
       ${source}
       ON CONFLICT DO NOTHING;`
}

/** `_sns_dirty` への登録。**`OR IGNORE` では書かない**（冒頭の決まりごとの2）。 */
function dirtySql(parts: TableParts): string {
  return `INSERT INTO "_sns_dirty" ("tableName") VALUES (${parts.literal})
       ON CONFLICT ("tableName") DO NOTHING;`
}

/* ------------------------------------------------------------------ *
 * 4本のトリガー
 * ------------------------------------------------------------------ */

/** AFTER INSERT（設計書 §3.4）。 */
function insertTrigger(parts: TableParts): string {
  const trueId = trueIdSql(parts, 'NEW')
  const keyText = keyTextSql(parts, 'NEW')
  const values = new Map<string, string>()
  for (const column of parts.columns) {
    values.set(
      column.name,
      // 主キーの列に入れるのは**真の id**
      isSameIdentifier(column.name, parts.primaryKey.name)
        ? trueId
        : `NEW.${escapeIdentifier(column.name)}`
    )
  }
  return `CREATE TRIGGER ${escapeIdentifier(`_sns_after_insert_${parts.name}`)}
    AFTER INSERT ON ${parts.quoted} FOR EACH ROW
    WHEN ${GUARD}
    BEGIN
      ${timestampCheckSql(parts)}
      ${tickSql(parts)}
      ${upsertRowSql(parts, values, rowTsSql(parts, 'NEW', rowsValueSql(parts, VERSION_COLUMNS.ts, trueId), keyText))}
      ${changelogSql(parts, keyText, 'INSERT', null)}
      ${dirtySql(parts)}
    END`
}

/**
 * AFTER UPDATE、主キーが同じ側（設計書 §3.4）。
 *
 * 書かなかった列を**3分岐**で決めるのがここの肝である。
 * `_sns_rows_<表>` にその行が無い窓（取り込みの COMMIT 〜 作り直しの適用）で
 * `(SELECT …)` だけを使うと、その UPDATE で全列が NULL になり、
 * NOT NULL の列がある表はその行が**全端末の画面から決定的に消える**。
 */
function updateSameTrigger(parts: TableParts): string {
  const pk = escapeIdentifier(parts.primaryKey.name)
  // 真の id と `_sns_rows_<表>` の行は、upsert の `FROM` 句で1回だけ引く。
  // 主キーは一意なので、結合の結果はいつも1行である。`"r".<主キー>` は、
  // 結合の条件の `=` を満たす行があるときだけ NULL でないので、行があるかどうかを表す
  const trueId = `"x"."k"`
  const keyText = `CAST(${trueId} AS TEXT)`
  const from = `FROM (SELECT ${trueIdSql(parts, 'NEW')} AS "k") AS "x"
       LEFT JOIN ${parts.rows} AS "r" ON "r".${pk} = ${trueId}`
  const values = new Map<string, string>()
  for (const column of parts.columns) {
    if (isSameIdentifier(column.name, parts.primaryKey.name)) {
      values.set(column.name, trueId)
      continue
    }
    const quoted = escapeIdentifier(column.name)
    values.set(
      column.name,
      `(CASE WHEN NEW.${quoted} IS NOT OLD.${quoted} COLLATE BINARY THEN NEW.${quoted}
         WHEN "r".${pk} IS NOT NULL THEN "r".${quoted} ELSE OLD.${quoted} END)`
    )
  }
  const ts = rowTsSql(
    parts,
    'NEW',
    `"r".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    keyText
  )
  return `CREATE TRIGGER ${escapeIdentifier(`_sns_after_update_same_${parts.name}`)}
    AFTER UPDATE ON ${parts.quoted} FOR EACH ROW
    WHEN NEW.${pk} IS OLD.${pk} AND ${GUARD}
    BEGIN
      ${timestampCheckSql(parts)}
      ${tickSql(parts)}
      ${upsertRowSql(parts, values, ts, from)}
      ${changelogSql(parts, keyTextSql(parts, 'NEW'), 'UPDATE', null)}
      ${dirtySql(parts)}
    END`
}

/**
 * AFTER UPDATE、主キーが違う側（設計書 §3.4）。
 *
 * 1回の書き込みで **2つの版**を作る —— 古い真の id の削除の版と、
 * 新しい真の id の行の版（全列に `NEW` を使う）。
 *
 * ただし1:1 の表で、`TRUE_ID(OLD)` と `TRUE_ID(NEW)` が**同じ**なら、
 * 真の id は動いていない。**削除の版は作らず**、`_sns_shown.shownId` を
 * 書き換えて行の版だけ更新する。作ってしまうと、表示のための付け替えが
 * 他端末ではその行の削除として届く。
 *
 * `_sns_shown` の書き換えを**いちばん最後**に置いてあるのは、先に書き換えると
 * その後の `TRUE_ID(OLD)` が別の答えを返すからである。
 */
function updateMoveTrigger(parts: TableParts): string {
  const oldTrueId = trueIdSql(parts, 'OLD')
  const oldKeyText = keyTextSql(parts, 'OLD')
  const newTrueId = trueIdSql(parts, 'NEW')
  const newKeyText = keyTextSql(parts, 'NEW')
  // 真の id が動いたか。正規形どうしを `IS` で比べる（NULL は前提 P1 で来ない）
  const moved = `${oldKeyText} IS NOT ${newKeyText}`
  const stayed = `${oldKeyText} IS ${newKeyText}`

  const values = new Map<string, string>()
  for (const column of parts.columns) {
    values.set(
      column.name,
      isSameIdentifier(column.name, parts.primaryKey.name)
        ? newTrueId
        : `NEW.${escapeIdentifier(column.name)}`
    )
  }

  const tombstone: VersionRefs = {
    ts: `"tb".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"tb".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"tb".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const held: VersionRefs = {
    ts: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const pk = escapeIdentifier(parts.primaryKey.name)

  return `CREATE TRIGGER ${escapeIdentifier(`_sns_after_update_move_${parts.name}`)}
    AFTER UPDATE ON ${parts.quoted} FOR EACH ROW
    WHEN NEW.${pk} IS NOT OLD.${pk} AND ${GUARD}
    BEGIN
      ${timestampCheckSql(parts)}
      ${tickSql(parts)}
      ${upsertTombstoneSql(parts, oldKeyText, deleteTsSql(parts, oldTrueId, oldKeyText), moved)}
      DELETE FROM ${parts.rows}
       WHERE ${pk} = ${oldTrueId}
         AND ${moved}
         AND EXISTS (SELECT 1 FROM "_tombstone" AS "tb"
               WHERE "tb"."tableName" = ${parts.literal}
                 AND "tb"."recordId" = ${oldKeyText}
                 AND ${strongerSql(tombstone, held)});
      ${upsertRowSql(parts, values, rowTsSql(parts, 'NEW', rowsValueSql(parts, VERSION_COLUMNS.ts, newTrueId), newKeyText))}
      ${changelogSql(parts, oldKeyText, 'DELETE', moved)}
      ${changelogSql(parts, newKeyText, 'UPDATE', null)}
      ${dirtySql(parts)}
      UPDATE "_sns_shown" SET "shownId" = CAST(NEW.${pk} AS TEXT)
       WHERE "tableName" = ${parts.literal}
         AND "shownId" = CAST(OLD.${pk} AS TEXT)
         AND ${stayed};
    END`
}

/**
 * BEFORE DELETE（設計書 §3.4）。
 *
 * `BEFORE` なのは、`_sns_rows_<表>` と `_tombstone` を引くときに
 * アプリの行がまだ在ってほしいからではなく、**`OLD` の値で版を作る**のに
 * 位置を選ばないためである。`AFTER` でも `OLD` は読めるが、
 * `ON DELETE` の連鎖が走る前に自分の版を確定させたい。
 */
function deleteTrigger(parts: TableParts): string {
  const trueId = trueIdSql(parts, 'OLD')
  const keyText = keyTextSql(parts, 'OLD')
  const ts = deleteTsSql(parts, trueId, keyText)
  const tombstone: VersionRefs = {
    ts: `"tb".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `"tb".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `"tb".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  const held: VersionRefs = {
    ts: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.ts)}`,
    lamport: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
    instance: `${parts.rows}.${escapeIdentifier(VERSION_COLUMNS.instance)}`,
  }
  return `CREATE TRIGGER ${escapeIdentifier(`_sns_before_delete_${parts.name}`)}
    BEFORE DELETE ON ${parts.quoted} FOR EACH ROW
    WHEN ${GUARD}
    BEGIN
      ${tickSql(parts)}
      ${upsertTombstoneSql(parts, keyText, ts, null)}
      ${mergedTombstoneSql(parts, keyText)}
      DELETE FROM ${parts.rows}
       WHERE ${escapeIdentifier(parts.primaryKey.name)} = ${trueId}
         AND EXISTS (SELECT 1 FROM "_tombstone" AS "tb"
               WHERE "tb"."tableName" = ${parts.literal}
                 AND "tb"."recordId" = ${keyText}
                 AND ${strongerSql(tombstone, held)});
      ${mergedRowsCleanupSql(parts, keyText)}
      ${changelogSql(parts, keyText, 'DELETE', null)}
      ${mergedChangelogSql(parts, keyText)}
      ${dirtySql(parts)}
    END`
}

/* ------------------------------------------------------------------ *
 * 作る・落とす
 * ------------------------------------------------------------------ */

/** 1つの表に付く4本のトリガーの名前。 */
export function rowsTriggerNames(table: string): string[] {
  return [
    `_sns_after_insert_${table}`,
    `_sns_after_update_same_${table}`,
    `_sns_after_update_move_${table}`,
    `_sns_before_delete_${table}`,
  ]
}

/** 1つの表に付く4本のトリガーの SQL（{@link rowsTriggerNames} と同じ順）。 */
function rowsTriggerSql(db: Database.Database, table: RowsTableSpec): string[] {
  const parts = readParts(db, table)
  return [
    insertTrigger(parts),
    updateSameTrigger(parts),
    updateMoveTrigger(parts),
    deleteTrigger(parts),
  ]
}

/**
 * 同期する表にトリガーを作る（冪等）。
 *
 * **`CREATE TRIGGER IF NOT EXISTS` では足りない。** トリガーの中身は表の列に
 * 依るので、列が増えた DB では古い定義が残ったまま動き続ける。いま在るものと
 * 見比べて、**違うときだけ**落として作り直す（同じなら DB は動かない）。
 *
 * あわせて `PRAGMA recursive_triggers` を立てる。既定では **`INSERT OR REPLACE` が
 * 消した行の DELETE トリガーが発火しない**ので、設計書 §2 の R0
 * （アプリの接続で起きた変化は原因によらずすべて事実になる）が破れる。
 * これは接続ごとの設定なので、アプリが開き直したら立て直す必要がある。
 */
export function createRowsTriggers(
  db: Database.Database,
  tables: RowsTableSpec[]
): void {
  db.pragma('recursive_triggers = ON')
  for (const table of tables) {
    const names = rowsTriggerNames(table.name)
    const statements = rowsTriggerSql(db, table)
    for (let at = 0; at < names.length; at += 1) {
      const current = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`
        )
        .get(names[at]) as { sql: string | null } | undefined
      if (current !== undefined && current.sql === statements[at]) continue
      if (current !== undefined) {
        db.exec(`DROP TRIGGER ${escapeIdentifier(names[at])}`)
      }
      db.exec(statements[at])
    }
  }
}

/**
 * 同期する表からトリガーを落とす。
 *
 * 移行で列の増減があった表のトリガーを、作り直す前に落とすために使う（`src/rows/migrate.ts`）。
 */
export function dropRowsTriggers(
  db: Database.Database,
  tables: RowsTableSpec[]
): void {
  for (const table of tables) {
    for (const name of rowsTriggerNames(table.name)) {
      db.exec(`DROP TRIGGER IF EXISTS ${escapeIdentifier(name)}`)
    }
  }
}
