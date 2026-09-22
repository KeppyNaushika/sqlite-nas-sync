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
 * （設計書 §3.4.1 の軽微17）。
 *
 * ここで守っている決まりごと:
 *
 * 1. **番人**（`GUARD`）。4本すべての `WHEN` に
 *    `NOT EXISTS (SELECT 1 FROM _sns_rebuilding)` を AND で足す。これが無いと
 *    **作り直しの適用そのものが削除の版を作り、他端末のデータを消す**
 * 2. **書き込みはすべて `ON CONFLICT` の形**（設計書 §3.4.0 の必須1）。
 *    `INSERT OR IGNORE` / `INSERT OR REPLACE` / 競合解決を書かない `INSERT` は
 *    **外側の文の競合解決に置き換えられる**ので使わない。これを守らないと、
 *    `ON DELETE SET NULL` の子を持つ親を消したときに**アプリの DELETE ごと失敗する**
 * 3. **3項の最大**は `ORDER BY … LIMIT 1` で書く（設計書 §3.3 の `NEWTS`）。
 *    `CASE WHEN TSGT …` の入れ子にすると1つで5万文字になる
 * 4. **`_tombstone.recordId` との比較は必ず正規形**（`CAST(… AS TEXT)`。§1.11 の必須7）
 * 5. **書かなかった列は3分岐**（§3.4.3 の必須2）。`_sns_rows_<表>` に行が無い窓が
 *    あるので、`(SELECT …)` だけにすると NOT NULL の列が NULL になって行が消える
 *
 * **段階2 ではまだ `setupSync` から呼ばれない**（切り替えるのは段階5）。
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
import { ISO_SHAPE_GLOBS } from './versions'

/* ------------------------------------------------------------------ *
 * §3.3 生成に使う式
 * ------------------------------------------------------------------ */

/**
 * 値の種類の群（設計書 §1.2.3）。0 ＜ 1 ＜ 2 ＜ 3 ＜ 4。
 *
 * `src/rows/versions.ts` の {@link ValueOrdering.timeGroup} と**同じ規則**で、
 * 字形の一覧（{@link ISO_SHAPE_GLOBS}）はそちらから借りている。片方だけ直すと、
 * トリガーが書いた順序と作り直しが読む順序が食い違う。
 */
function timeGroupSql(value: string): string {
  const shape = ISO_SHAPE_GLOBS.map((glob) => `${value} GLOB '${glob}'`).join(
    ' OR '
  )
  return `(CASE typeof(${value})
      WHEN 'null' THEN 0
      WHEN 'integer' THEN 1
      WHEN 'real' THEN 1
      WHEN 'blob' THEN 4
      ELSE (CASE WHEN julianday(${value}) IS NOT NULL AND (${shape}) THEN 3 ELSE 2 END)
    END)`
}

/**
 * `TSGT(a, b)` —— 順序用の時刻として `a` が `b` より強いか（設計書 §3.3）。
 *
 * 群が違えば群の順。同じ群なら、群0 は同着、群3 は `julianday`、
 * それ以外は素の比較（群1 は数値、群2・群4 は `COLLATE BINARY`）。
 *
 * **`COLLATE BINARY` を明示する。** 時刻列が `COLLATE NOCASE` で宣言されていると、
 * 素の比較では `'ABC'` と `'abc'` が同着になり、値が違うのに前後が付かない。
 */
function tsGreaterSql(a: string, b: string): string {
  const groupA = timeGroupSql(a)
  const groupB = timeGroupSql(b)
  return `(${groupA} > ${groupB} OR (${groupA} = ${groupB} AND (CASE
      WHEN ${groupA} = 0 THEN 0
      WHEN ${groupA} = 3 THEN julianday(${a}) > julianday(${b})
      ELSE ${a} > ${b} COLLATE BINARY
    END)))`
}

/** `a` と `b` が順序用の時刻として同着か（設計書 §1.2.3）。 */
function tsEqualSql(a: string, b: string): string {
  const groupA = timeGroupSql(a)
  const groupB = timeGroupSql(b)
  return `(${groupA} = ${groupB} AND (CASE
      WHEN ${groupA} = 0 THEN 1
      WHEN ${groupA} = 3 THEN julianday(${a}) = julianday(${b})
      ELSE ${a} = ${b} COLLATE BINARY
    END))`
}

/** 版の3つ組（順序用の時刻・lamport・端末）。 */
interface VersionRefs {
  ts: string
  lamport: string
  instance: string
}

/**
 * `STRONGER(a, b)` —— 版 `a` が版 `b` より強いか（設計書 §3.3）。
 *
 * `( _sns_ts, L, iid )` の辞書順。`iid` の比較は `COLLATE BINARY`。
 */
export function strongerSql(a: VersionRefs, b: VersionRefs): string {
  return `(${tsGreaterSql(a.ts, b.ts)} OR (${tsEqualSql(a.ts, b.ts)} AND (
      ${a.lamport} > ${b.lamport}
      OR (${a.lamport} = ${b.lamport} AND ${a.instance} > ${b.instance} COLLATE BINARY)
    )))`
}

/**
 * 順序用の時刻の引き上げ（設計書 §1.2.1 の必須3）。**3項の最大**。
 *
 * `CASE WHEN TSGT(…)` を入れ子にすると、項が増えるたびに式が二乗で膨らみ、
 * 3項で5万文字を超える。**並べ替えて1行取る**形にすれば、項の数だけ線形に伸びる。
 *
 * 並べ替えの鍵は §1.2.3 の順序そのもの: 群 → 群3 なら `julianday` →
 * 同じ群の中の `COLLATE BINARY`。群1（数値）では照合順序は無視され、
 * SQLite が数値として比べる。
 */
export function maxTsSql(terms: string[]): string {
  const branches = terms
    .map((term, at) => (at === 0 ? `SELECT ${term} AS "v"` : `SELECT ${term}`))
    .join(' UNION ALL ')
  const group = timeGroupSql('"v"')
  return `(SELECT "v" FROM (${branches})
     ORDER BY ${group} DESC,
              (CASE WHEN ${group} = 3 THEN julianday("v") END) DESC,
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
  return {
    name: table.name,
    literal: quoteLiteral(table.name),
    quoted: escapeIdentifier(table.name),
    rows: escapeIdentifier(rowsTableName(table.name)),
    columns,
    primaryKey: primaryKeyColumn(db, table.name),
    timestampColumn: all.some((column) => isSameIdentifier(column.name, wanted))
      ? wanted
      : null,
  }
}

/**
 * **番人**（設計書 §3.7.2・§3.10 の軽微15）。
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
 * `TICK(t)`（設計書 §3.3・訂正6）。**本体の先頭に置く。**
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
 * `TRUE_ID`（設計書 §3.3・訂正2）。**`_sns_shown` を shownId 側から引く。**
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

/** `KEY_TEXT`（設計書 §1.11 の必須7）。`_tombstone.recordId` と突き合わせる形。 */
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
 * 作り直せない**（§2.3 の場面4）。
 */
function rowTsSql(
  parts: TableParts,
  side: 'NEW' | 'OLD',
  trueId: string,
  keyText: string
): string {
  const written =
    parts.timestampColumn === null
      ? 'NULL'
      : `${side}.${escapeIdentifier(parts.timestampColumn)}`
  return maxTsSql([
    written,
    rowsValueSql(parts, VERSION_COLUMNS.ts, trueId),
    tombstoneValueSql(parts, VERSION_COLUMNS.ts, keyText),
  ])
}

/**
 * 削除の版の `_sns_ts`（設計書 §3.4.4 の必須3・訂正3）。
 *
 * 削除には「新しい時刻列の値」が無いので、`_sns_rows_<表>` と `_tombstone` の
 * **強い方**を使い、**どちらにも行が無いときだけ** `OLD.<時刻列>` に落ちる。
 *
 * **`COALESCE` では書けない。** `COALESCE` は「値が NULL」と「行が無い」を
 * 区別しないので、`_sns_ts` が NULL（群0）の行の版が手元にあるとき、
 * `OLD.<時刻列>` に落ちてしまう。それは引き上げの規則に反し、
 * 取り込んだ強い削除の版をあとから弱い版で上書きする経路になる。
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
  return `(CASE
      WHEN NOT ${rowsExistsSql(parts, trueId)}
       AND NOT ${tombstoneExistsSql(parts, keyText)}
      THEN ${fallback}
      ELSE ${maxTsSql([
        rowsValueSql(parts, VERSION_COLUMNS.ts, trueId),
        tombstoneValueSql(parts, VERSION_COLUMNS.ts, keyText),
      ])}
    END)`
}

/** `_sns_rows_<表>` へ行の版を書く upsert（値の式は呼び出し側が決める）。 */
function upsertRowSql(
  parts: TableParts,
  values: Map<string, string>,
  ts: string
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
  return `INSERT INTO ${parts.rows} (${names.join(', ')})
       VALUES (${expressions.join(', ')})
       ON CONFLICT (${escapeIdentifier(parts.primaryKey.name)}) DO UPDATE SET
         ${assignments.join(',\n         ')}
       WHERE ${strongerSql(excluded, held)};`
}

/**
 * `_tombstone` へ削除の版を書く upsert（設計書 §3.4.4）。
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

/** `_sns_dirty` への登録。**`OR IGNORE` では書かない**（必須1）。 */
function dirtySql(parts: TableParts): string {
  return `INSERT INTO "_sns_dirty" ("tableName") VALUES (${parts.literal})
       ON CONFLICT ("tableName") DO NOTHING;`
}

/* ------------------------------------------------------------------ *
 * 4本のトリガー
 * ------------------------------------------------------------------ */

/** AFTER INSERT（設計書 §3.4.2）。 */
function insertTrigger(parts: TableParts): string {
  const trueId = trueIdSql(parts, 'NEW')
  const keyText = keyTextSql(parts, 'NEW')
  const values = new Map<string, string>()
  for (const column of parts.columns) {
    values.set(
      column.name,
      // 主キーの列に入れるのは**真の id**（訂正8）
      isSameIdentifier(column.name, parts.primaryKey.name)
        ? trueId
        : `NEW.${escapeIdentifier(column.name)}`
    )
  }
  return `CREATE TRIGGER ${escapeIdentifier(`_sns_after_insert_${parts.name}`)}
    AFTER INSERT ON ${parts.quoted} FOR EACH ROW
    WHEN ${GUARD}
    BEGIN
      ${tickSql(parts)}
      ${upsertRowSql(parts, values, rowTsSql(parts, 'NEW', trueId, keyText))}
      ${changelogSql(parts, keyText, 'INSERT', null)}
      ${dirtySql(parts)}
    END`
}

/**
 * AFTER UPDATE、主キーが同じ側（設計書 §3.4.3 の必須2）。
 *
 * 書かなかった列を**3分岐**で決めるのがここの肝である。
 * `_sns_rows_<表>` にその行が無い窓（取り込みの COMMIT 〜 作り直しの適用）で
 * `(SELECT …)` だけを使うと、その UPDATE で全列が NULL になり、
 * NOT NULL の列がある表はその行が**全端末の画面から決定的に消える**。
 */
function updateSameTrigger(parts: TableParts): string {
  const trueId = trueIdSql(parts, 'NEW')
  const keyText = keyTextSql(parts, 'NEW')
  const values = new Map<string, string>()
  for (const column of parts.columns) {
    if (isSameIdentifier(column.name, parts.primaryKey.name)) {
      values.set(column.name, trueId)
      continue
    }
    const quoted = escapeIdentifier(column.name)
    values.set(
      column.name,
      `(CASE
         WHEN NEW.${quoted} IS NOT OLD.${quoted} COLLATE BINARY THEN NEW.${quoted}
         WHEN ${rowsExistsSql(parts, trueId)} THEN ${rowsValueSql(parts, column.name, trueId)}
         ELSE OLD.${quoted}
       END)`
    )
  }
  const pk = escapeIdentifier(parts.primaryKey.name)
  return `CREATE TRIGGER ${escapeIdentifier(`_sns_after_update_same_${parts.name}`)}
    AFTER UPDATE ON ${parts.quoted} FOR EACH ROW
    WHEN NEW.${pk} IS OLD.${pk} AND ${GUARD}
    BEGIN
      ${tickSql(parts)}
      ${upsertRowSql(parts, values, rowTsSql(parts, 'NEW', trueId, keyText))}
      ${changelogSql(parts, keyText, 'UPDATE', null)}
      ${dirtySql(parts)}
    END`
}

/**
 * AFTER UPDATE、主キーが違う側（設計書 §3.4.1・訂正2）。
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
      ${tickSql(parts)}
      ${upsertTombstoneSql(parts, oldKeyText, deleteTsSql(parts, oldTrueId, oldKeyText), moved)}
      DELETE FROM ${parts.rows}
       WHERE ${pk} = ${oldTrueId}
         AND ${moved}
         AND EXISTS (SELECT 1 FROM "_tombstone" AS "tb"
               WHERE "tb"."tableName" = ${parts.literal}
                 AND "tb"."recordId" = ${oldKeyText}
                 AND ${strongerSql(tombstone, held)});
      ${upsertRowSql(parts, values, rowTsSql(parts, 'NEW', newTrueId, newKeyText))}
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
 * BEFORE DELETE（設計書 §3.4.4 の必須3・必須7）。
 *
 * `BEFORE` なのは、`_sns_rows_<表>` と `_tombstone` を引くときに
 * アプリの行がまだ在ってほしいからではなく、**`OLD` の値で版を作る**のに
 * 位置を選ばないためである。`AFTER` でも `OLD` は読めるが、
 * `ON DELETE` の連鎖が走る前に自分の版を確定させたい。
 */
function deleteTrigger(parts: TableParts): string {
  const trueId = trueIdSql(parts, 'OLD')
  const keyText = keyTextSql(parts, 'OLD')
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
      ${upsertTombstoneSql(parts, keyText, deleteTsSql(parts, trueId, keyText), null)}
      DELETE FROM ${parts.rows}
       WHERE ${escapeIdentifier(parts.primaryKey.name)} = ${trueId}
         AND EXISTS (SELECT 1 FROM "_tombstone" AS "tb"
               WHERE "tb"."tableName" = ${parts.literal}
                 AND "tb"."recordId" = ${keyText}
                 AND ${strongerSql(tombstone, held)});
      ${changelogSql(parts, keyText, 'DELETE', null)}
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

/** 1つの表に付く4本のトリガーの SQL（検査から中身を見るために公開している）。 */
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
 * 消した行の DELETE トリガーが発火しない**ので、設計書 §2.2 の R0
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

/** 同期する表からトリガーを落とす（移行と、検査の後始末のため）。 */
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
