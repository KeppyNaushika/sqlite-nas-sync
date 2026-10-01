/**
 * 案A の表を作る（設計書 `docs/rows-table-design.md` §3.1・§3.2・§3.5）。
 *
 * ここは表を作るだけである。
 * 中身を書くトリガーは `src/rows/triggers.ts` にある。
 *
 * | 表 | 何 |
 * | --- | --- |
 * | `_sns_rows_<表>` | 生きている id の最強の行の版。**UNIQUE も外部キーも CHECK も付けない** |
 * | `_sns_clock` | lamport・`instanceId`・`importTick`。1行しか無い |
 * | `_sns_tick` | 表ごとの書き込み回数（作り直しの token） |
 * | `_sns_dirty` | 作り直しの対象の表 |
 * | `_sns_shown` | 1:1 の表の「真の id ↔ 表示している id」 |
 * | `_sns_hidden` | 隠れた行と、その勝者 |
 * | `_sns_unplaceable` | 置かない行と、親が削除されているときの原因（前回との差で警告と報告を出すため） |
 * | `_sns_rebuilding` | 作り直しの最中である旗 |
 * | `_tombstone` | 削除の版（表ごとでない） |
 * | `_changelog` | 変更の記録（表ごとでない） |
 *
 * **`_sns_rows_<表>` に制約を写さない理由**: ここは「受け取った事実」の置き場で、
 * 置けるかどうかを決める場所ではない。制約を写すと、他端末から届いた版が
 * 手元の UNIQUE に当たって**保存できずに消える**。かぶりの判定は作り直しのときに
 * 一時 DB へ入れて SQLite に決めさせる（設計書 §1.5）。
 *
 * @module rows/schema
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, isSameIdentifier, NOW_SQL } from '../setup/sql'
import { DEFAULTS } from '../types'

/** 同期する表1つ分の指定。 */
export interface RowsTableSpec {
  name: string
  /**
   * 順序に使う時刻列。その表に無ければ、順序用の時刻の第1項は NULL になる
   * （lamport と `instanceId` だけで順序が付く）
   * @defaultValue `'updatedAt'`
   */
  timestampColumn?: string
}

/** 時刻列の既定。 */
export const DEFAULT_TIMESTAMP_COLUMN = DEFAULTS.timestampColumn

/** ライブラリが `_sns_rows_<表>` と `_tombstone` に足す列。 */
export const VERSION_COLUMNS = {
  /** 順序用の時刻（設計書 §1.2.1）。**型名を書かない列**である */
  ts: '_sns_ts',
  /** その端末での書き込み順（設計書 §1.2 の `L`） */
  lamport: '_sns_lamport',
  /** 書いた端末（設計書 §3.2 の `iid`） */
  instance: '_sns_instance',
} as const

/** ライブラリが使う接頭辞。アプリの列がこれで始まっていたら断る。 */
const RESERVED_PREFIX = '_sns_'

/** `PRAGMA table_xinfo` が返す1列。 */
export interface RowsColumn {
  cid: number
  name: string
  /** 宣言された型名（無ければ空文字列） */
  type: string
  notnull: number
  dflt_value: unknown
  /** 主キーなら 1、複合主キーなら 1,2,… */
  pk: number
  /** 0 = 普通の列、1 = 仮想表の隠れ列、2 = VIRTUAL 生成列、3 = STORED 生成列 */
  hidden: number
}

/** `_sns_rows_<表>` の接頭辞。 */
const ROWS_TABLE_PREFIX = '_sns_rows_'

/** `_sns_rows_<表>` の名前。 */
export function rowsTableName(table: string): string {
  return `${ROWS_TABLE_PREFIX}${table}`
}

/** `_sns_rows_<表>` の名前から、元の表の名前を取り出す。そうでない名前なら `null`。 */
export function tableOfRowsTable(name: string): string | null {
  return name.startsWith(ROWS_TABLE_PREFIX)
    ? name.slice(ROWS_TABLE_PREFIX.length)
    : null
}

/** 他の端末が NAS の写しから読む、`_sns_rows_<表>` 以外の表（設計書 §3.1）。 */
const PUBLISHED_LEDGERS: readonly string[] = [
  '_tombstone',
  '_changelog',
  '_changelog_prune',
  '_sync_meta',
]

/**
 * NAS の写しに載せる表か（設計書 §3.1 の「他端末が読む」表）。
 *
 * 写しにはこれだけを載せる。アプリの表・トリガー・他の端末が読まない帳簿は載せない。
 * `_changelog` の `AUTOINCREMENT` の値は、別に `sqlite_sequence` から写す。
 */
export function isPublishedTable(name: string): boolean {
  return PUBLISHED_LEDGERS.includes(name) || tableOfRowsTable(name) !== null
}

/** SQL の文字列リテラル（表の名前を SQL に埋めるときに通す）。 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * `_sns_rows_<表>` に写す列（設計書 §3.1）。
 *
 * **生成列は写さない。** `PRAGMA table_xinfo` の `hidden` が 2（VIRTUAL）か
 * 3（STORED）の列は書き込めないので、写すと適用の INSERT がそこで落ちる。
 * `hidden = 1`（仮想表の隠れ列）も同じ理由で外す。
 */
export function syncedColumns(
  db: Database.Database,
  table: string
): RowsColumn[] {
  const info = db.pragma(
    `table_xinfo(${escapeIdentifier(table)})`
  ) as RowsColumn[]
  if (info.length === 0) {
    throw new Error(`同期する表 ${table} が無い`)
  }
  return info.filter((column) => column.hidden === 0)
}

/**
 * 主キーの列（設計書 §1.8 の P11。1列であること）。
 *
 * 複合主キーを断るのは、真の id・`_tombstone.recordId`・`_sns_shown` の
 * すべてが「1つの値」を前提にしているからである。
 */
export function primaryKeyColumn(
  db: Database.Database,
  table: string
): RowsColumn {
  const keys = syncedColumns(db, table)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
  if (keys.length === 0) {
    throw new Error(
      `同期する表 ${table} に主キーが無い。同期する表には1列の主キーが要る`
    )
  }
  if (keys.length > 1) {
    throw new Error(
      `同期する表 ${table} の主キーが複合（${keys
        .map((column) => column.name)
        .join(', ')}）である。同期する表の主キーは1列でなければならない`
    )
  }
  return keys[0]
}

/**
 * 案A の表をぜんぶ作る（冪等）。`_sns_clock` の行も**必ず**作る。
 *
 * 行を必ず作るのは、無いとアプリの書き込みが（トリガーの中の NOT NULL で）
 * 失敗するからである。これは設計どおりの振る舞いで、**黙って lamport が
 * 0 から数え直されるより安全**だが、作れるところでは作っておく。
 *
 * @param db 同期するローカル DB
 * @param tables 同期する表
 * @param instanceId この `setupSync` の端末の id（`_sns_clock.instanceId` を毎回これで上書きする。§3.2）
 */
export function createRowsTables(
  db: Database.Database,
  tables: RowsTableSpec[],
  instanceId: string
): void {
  createSharedTables(db)
  ensureUnplaceableCauseColumns(db)
  ensureClockRow(db, instanceId)
  ensureTombstoneVersionColumns(db)
  for (const table of tables) {
    createRowsTable(db, table.name)
    ensureTickRow(db, table.name)
  }
}

/** 表ごとでない表をまとめて作る。 */
function createSharedTables(db: Database.Database): void {
  // 時計。`onlyRow` で席を固定するのは `_changelog_prune` と同じ理由で、
  // 行が増えると「どれが本当の位置か」が決まらなくなるからである。
  // `instanceId` が NOT NULL なのは要で、行が無いまま書き込まれると
  // トリガーの中の `(SELECT instanceId FROM _sns_clock)` が NULL になり、
  // ここで**アプリの書き込みごと落ちる**（§3.2）。黙って通すと lamport が
  // 0 から数え直され、不変条件 C（lamport は手元のすべての版の L 以上）が破れる。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_clock (
      onlyRow    INTEGER PRIMARY KEY CHECK (onlyRow = 0),
      lamport    INTEGER NOT NULL DEFAULT 0,
      instanceId TEXT    NOT NULL,
      importTick INTEGER NOT NULL DEFAULT 0
    )
  `)

  // 表ごとの書き込み回数。作り直しの計算が読んだ時点を覚えておき、適用の直前に
  // 見比べて「計算のあいだに書き込まれたか」を判断する（設計書 §3.7.2 の token）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_tick (
      tableName TEXT    PRIMARY KEY,
      tick      INTEGER NOT NULL DEFAULT 0
    )
  `)

  // 作り直しの対象。表の単位で持つ（id の単位にすると、外部キーでつながる行を
  // 取りこぼす）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_dirty (
      tableName TEXT PRIMARY KEY
    )
  `)

  // 1:1 の表の「真の id ↔ 表示している id」。**主キーは (tableName, trueId)** で、
  // `(tableName, shownId)` には別に UNIQUE 索引を張る。どちらの向きにも1つしか
  // 無いことを DB に守らせないと、`TRUE_ID` が2つの答えを返しうる。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_shown (
      tableName TEXT NOT NULL,
      trueId    TEXT NOT NULL,
      shownId   TEXT NOT NULL,
      PRIMARY KEY (tableName, trueId)
    )
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sns_shown_shown
      ON _sns_shown (tableName, shownId)
  `)

  // 隠れた行と、その勝者（設計書 §1.6）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_hidden (
      tableName TEXT NOT NULL,
      trueId    TEXT NOT NULL,
      winnerId  TEXT,
      PRIMARY KEY (tableName, trueId)
    )
  `)

  // 置かない行（設計書 §1.4）。同期のたびに前回との差を取り、新しく置かなくなった行を
  // 警告し、親が削除されているので置かない行（原則4）の出入りを報告する。
  // `causeTable` と `causeId` は、親が削除されているときの大元の削除（それ以外は NULL）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_unplaceable (
      tableName  TEXT NOT NULL,
      trueId     TEXT NOT NULL,
      reason     TEXT,
      causeTable TEXT,
      causeId    TEXT,
      PRIMARY KEY (tableName, trueId)
    )
  `)

  // 作り直しの最中である旗。**行があるあいだ、トリガーは何も事実にしない**
  // （設計書 §3.3・§3.7.2）。旗が無いと、作り直しの適用そのものが
  // 削除の版を作り、他端末のデータを消す。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_rebuilding (
      onlyRow   INTEGER PRIMARY KEY CHECK (onlyRow = 0),
      startedAt TEXT NOT NULL DEFAULT (${NOW_SQL})
    )
  `)

  // 削除の版と通知の置き場。
  // 案A の形でない DB（新しい DB を含む）では、移行（`src/rows/migrate.ts`）がこの2つの表を先に作り直しているので、ここでは何も起きない。
  // ここで作るのは、移行を通さずにこの関数を呼んだとき（試験など）と、外で表が消されたときである。
  // `_tombstone` の版の3列は、この後の `ensureTombstoneVersionColumns` が足す。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tombstone (
      tableName  TEXT NOT NULL,
      recordId   TEXT NOT NULL,
      deletedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      PRIMARY KEY (tableName, recordId)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tableName TEXT    NOT NULL,
      recordId  TEXT    NOT NULL,
      operation TEXT    NOT NULL,
      changedAt TEXT    NOT NULL DEFAULT (${NOW_SQL})
    )
  `)
}

/**
 * `_tombstone` に版の3列を足す（冪等）。
 *
 * **`_sns_ts` は型名を書かずに足す。**
 * `TEXT` を付けると TEXT の親和性が付き、入れた数値が文字列へ化ける。
 * 順序用の時刻は「値の種類」で順序が決まるので（設計書 §1.2.3）、群1 の値が群2 に化けると**順序そのものが変わる**。
 */
export function ensureTombstoneVersionColumns(db: Database.Database): void {
  const existing = new Set(
    (db.pragma(`table_info(_tombstone)`) as RowsColumn[]).map(
      (column) => column.name
    )
  )
  // 型名なし。`ADD COLUMN "_sns_ts"` は SQLite が受け取る（親和性 BLOB ＝無し）
  if (!existing.has(VERSION_COLUMNS.ts)) {
    db.exec(
      `ALTER TABLE _tombstone ADD COLUMN ${escapeIdentifier(VERSION_COLUMNS.ts)}`
    )
  }
  if (!existing.has(VERSION_COLUMNS.lamport)) {
    db.exec(
      `ALTER TABLE _tombstone ADD COLUMN ${escapeIdentifier(
        VERSION_COLUMNS.lamport
      )} INTEGER`
    )
  }
  if (!existing.has(VERSION_COLUMNS.instance)) {
    db.exec(
      `ALTER TABLE _tombstone ADD COLUMN ${escapeIdentifier(
        VERSION_COLUMNS.instance
      )} TEXT`
    )
  }
  // 足したばかりの列は NULL である。**版の無い墓標**は比較のたびに
  // 「instanceId が NULL」で同着の決め手を失うので、§3.9 の3項と同じ値で埋める
  // （`_sns_ts` は NULL のまま＝群0＝最小、`_sns_lamport` は 0、
  // `_sns_instance` は自分）。`_sns_clock` の行は `createRowsTables` が先に作る
  db.exec(`
    UPDATE _tombstone
       SET ${escapeIdentifier(VERSION_COLUMNS.lamport)} =
             COALESCE(${escapeIdentifier(VERSION_COLUMNS.lamport)}, 0),
           ${escapeIdentifier(VERSION_COLUMNS.instance)} =
             COALESCE(${escapeIdentifier(VERSION_COLUMNS.instance)},
                      (SELECT instanceId FROM _sns_clock), '')
     WHERE ${escapeIdentifier(VERSION_COLUMNS.lamport)} IS NULL
        OR ${escapeIdentifier(VERSION_COLUMNS.instance)} IS NULL
  `)
}

/**
 * `_sns_unplaceable` に `causeTable` と `causeId` を足す（冪等）。
 *
 * 0.20.0 の DB の `_sns_unplaceable` にはこの2列が無い。足したばかりの列は NULL で、
 * 「親が削除されているので置かない行ではない」と読まれる。次の作り直しが書き直すので、
 * その回の同期で親の削除による行が報告に出る。
 */
function ensureUnplaceableCauseColumns(db: Database.Database): void {
  const existing = new Set(
    (db.pragma(`table_info(_sns_unplaceable)`) as RowsColumn[]).map(
      (column) => column.name
    )
  )
  for (const column of ['causeTable', 'causeId']) {
    if (existing.has(column)) continue
    db.exec(
      `ALTER TABLE _sns_unplaceable ADD COLUMN ${escapeIdentifier(column)} TEXT`
    )
  }
}

/**
 * `_sns_rows_<表>` を作る（冪等）。
 *
 * 列の宣言は {@link rowsColumnsSql} が決める。NOT NULL も DEFAULT も UNIQUE も
 * 外部キーも CHECK も写さない（§3.1）。
 */
function createRowsTable(db: Database.Database, table: string): void {
  const columns = syncedColumns(db, table)
  const primaryKey = primaryKeyColumn(db, table)
  for (const column of columns) {
    if (column.name.startsWith(RESERVED_PREFIX)) {
      throw new Error(
        `同期する表 ${table} の列 ${column.name} が ${RESERVED_PREFIX} で始まっている。` +
          ` この接頭辞はライブラリが使う`
      )
    }
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(rowsTableName(table))} (
       ${rowsColumnsSql(
         columns.map((column) => column.name),
         primaryKey
       )}
     )`
  )
}

/**
 * `_sns_rows_<表>` の列の宣言（`CREATE TABLE` の括弧の中）。
 *
 * 主キーの列だけはアプリの列の型名を写す。主キーの突き合わせで親和性が
 * 食い違うと、`_sns_shown` から引いた文字列の id が整数の id と一致しなくなるからである。
 *
 * **主キー以外のアプリの列には型名を書かない。** 型名の無い列は BLOB 親和性で、
 * 入れた値をそのまま持つ。型名を写すと、アプリの表と違う変換が起きうる。
 * STRICT 表の `ANY` 列は値をそのまま持つが、`_sns_rows_<表>` は STRICT でないので、
 * そこに `ANY` と書くと NUMERIC 親和性になり、文字列 `'123'` が整数 `123` に変わる。
 * STRICT でないアプリの表では、`_sns_rows_<表>` に入るのはアプリの表が親和性で
 * 変換したあとの値で、作り直しで同じ親和性をもう一度当てても値は変わらない。
 *
 * @param columns 写すアプリの列の名前（主キーを含む）
 * @param primaryKey アプリの表の主キーの列
 */
export function rowsColumnsSql(
  columns: readonly string[],
  primaryKey: RowsColumn
): string {
  const declarations = columns.map((name) => {
    if (!isSameIdentifier(name, primaryKey.name)) return escapeIdentifier(name)
    const type = primaryKey.type.trim()
    return `${escapeIdentifier(name)}${type === '' ? '' : ` ${type}`} PRIMARY KEY`
  })
  // `_sns_ts` も型名を書かない。lamport と instance は
  // NOT NULL —— `_sns_clock` の行が無いまま書き込まれたら、ここで落ちてほしい
  declarations.push(escapeIdentifier(VERSION_COLUMNS.ts))
  declarations.push(
    `${escapeIdentifier(VERSION_COLUMNS.lamport)} INTEGER NOT NULL`
  )
  declarations.push(
    `${escapeIdentifier(VERSION_COLUMNS.instance)} TEXT NOT NULL`
  )
  return declarations.join(',\n       ')
}

/**
 * `_sns_clock` の行を用意する（冪等）。
 *
 * 行が無ければ作り、あれば `instanceId` だけを渡された値で上書きする（`setupSync` のたびに端末の id を作り直す。§3.2）。
 * lamport と `importTick` には触らない。
 */
export function ensureClockRow(
  db: Database.Database,
  instanceId: string
): void {
  db.prepare(
    `INSERT INTO _sns_clock (onlyRow, lamport, instanceId, importTick)
     VALUES (0, 0, ?, 0)
     ON CONFLICT (onlyRow) DO UPDATE SET instanceId = excluded.instanceId`
  ).run(instanceId)
}

/** `_sns_tick` にその表の行が無ければ作る（冪等）。tick には触らない。 */
function ensureTickRow(db: Database.Database, table: string): void {
  db.prepare(
    `INSERT INTO _sns_tick (tableName, tick) VALUES (?, 0)
     ON CONFLICT (tableName) DO NOTHING`
  ).run(table)
}
