/**
 * 案A の表を作る（設計書 `docs/rows-table-design.md` §3.1・§3.2・§3.5）。
 *
 * 段階2 の受け持ちのうち「器」の側である。中身を書くトリガーは
 * `src/rows/triggers.ts` にある。
 *
 * | 表 | 何 |
 * | --- | --- |
 * | `_sns_rows_<表>` | 生きている id の最強の行の版。**UNIQUE も外部キーも CHECK も付けない** |
 * | `_sns_clock` | lamport・`instanceId`・`importTick`。1行しか無い |
 * | `_sns_tick` | 表ごとの書き込み回数（作り直しの token） |
 * | `_sns_dirty` | 作り直しの対象の表 |
 * | `_sns_shown` | 1:1 の表の「真の id ↔ 表示している id」 |
 * | `_sns_hidden` | 隠れた行と、その勝者 |
 * | `_sns_unplaceable` | 置かない行（警告の重複を避けるため） |
 * | `_sns_rebuilding` | 作り直しの最中である旗 |
 *
 * **`_sns_rows_<表>` に制約を写さない理由**: ここは「受け取った事実」の置き場で、
 * 置けるかどうかを決める場所ではない。制約を写すと、他端末から届いた版が
 * 手元の UNIQUE に当たって**保存できずに消える**。かぶりの判定は作り直しのときに
 * 一時 DB へ入れて SQLite に決めさせる（設計書 §1.5）。
 *
 * **段階2 ではまだ `setupSync` から呼ばれない**（切り替えるのは段階5）。
 *
 * @module rows/schema
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, isSameIdentifier, NOW_SQL } from '../setup/sql'

/** 同期する表1つ分の指定。 */
export interface RowsTableSpec {
  name: string
  /**
   * 順序に使う時刻列。その表に無ければ、順序用の時刻の第1項は NULL になる
   * （lamport と `instanceId` だけで順序が付く）
   * @defaultValue `'updatedAt'`
   */
  timestampColumn?: string
  /**
   * 削除の版が**表示の計算で勝たない**表（`TableConfig.deleteProtected`）。
   *
   * 行の版がある限り、その行は置かれる。取り込みは削除の版が勝っても
   * 行の版を消さない（消すと設定を外したときに戻せない）。
   *
   * **全端末で同じ値である前提**（違うと端末ごとに見え方が変わる）。
   * 食い違いは `_sync_meta` の `sns.deleteProtected` で検出して警告する。
   */
  deleteProtected?: boolean
}

/** 時刻列の既定。 */
export const DEFAULT_TIMESTAMP_COLUMN = 'updatedAt'

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

/** `_sns_rows_<表>` の名前。 */
export function rowsTableName(table: string): string {
  return `_sns_rows_${table}`
}

/** SQL の文字列リテラル（表の名前を SQL に埋めるときに通す）。 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * `_sns_rows_<表>` に写す列（設計書 §3.1 の軽微18）。
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
    throw new Error(`同期する表 ${table} に主キーが無い（前提 P1）`)
  }
  if (keys.length > 1) {
    throw new Error(
      `同期する表 ${table} の主キーが複合（${keys
        .map((column) => column.name)
        .join(', ')}）である（前提 P11）`
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
 * @param instanceId この `setupSync` の端末の id（`_sns_clock` に無いときだけ使う）
 */
export function createRowsTables(
  db: Database.Database,
  tables: RowsTableSpec[],
  instanceId: string
): void {
  createSharedTables(db)
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

  // 置かない行（設計書 §1.4）。警告の重複を避けるためだけに持つ。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_unplaceable (
      tableName  TEXT NOT NULL,
      trueId     TEXT NOT NULL,
      reasonKind TEXT,
      reason     TEXT,
      noticedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      PRIMARY KEY (tableName, trueId)
    )
  `)

  // 作り直しの最中である旗。**行があるあいだ、トリガーは何も事実にしない**
  // （設計書 §3.7.2・§3.10 の軽微15）。旗が無いと、作り直しの適用そのものが
  // 削除の版を作り、他端末のデータを消す。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sns_rebuilding (
      onlyRow   INTEGER PRIMARY KEY CHECK (onlyRow = 0),
      startedAt TEXT NOT NULL DEFAULT (${NOW_SQL})
    )
  `)

  // 削除の版と通知の置き場。旧方式の取り付けを通していない DB でも
  // トリガーが書けるよう、同じ形をここでも作る（`IF NOT EXISTS` なので
  // 既存の DB には触らない）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tombstone (
      tableName  TEXT NOT NULL,
      recordId   TEXT NOT NULL,
      deletedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      mergedInto TEXT,
      revokedAt  TEXT,
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
 * **`ensureTombstoneColumn` は使えない。** あれは `ADD COLUMN <name> TEXT` と
 * 決め打ちで、`_sns_ts` に TEXT の親和性が付いてしまう。順序用の時刻は
 * 「値の種類」で順序が決まるので（設計書 §1.2.3）、入れた数値が文字列へ
 * 化けると群1 の値が群2 に化け、**順序そのものが変わる**。型名を書かずに足す。
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
 * `_sns_rows_<表>` を作る（冪等）。
 *
 * アプリの列の**宣言された型名だけ**を写す。NOT NULL も DEFAULT も UNIQUE も
 * 外部キーも CHECK も写さない（§3.1）。型名を写すのは、主キーの突き合わせで
 * 親和性が食い違うと `_sns_shown` から引いた文字列の id が整数の id と
 * 一致しなくなるからである。
 */
export function createRowsTable(db: Database.Database, table: string): void {
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
  const declarations = columns.map((column) => {
    const type = column.type.trim()
    const suffix = isSameIdentifier(column.name, primaryKey.name)
      ? ' PRIMARY KEY'
      : ''
    return `${escapeIdentifier(column.name)}${type === '' ? '' : ` ${type}`}${suffix}`
  })
  // `_sns_ts` は型名を書かない（値の種類をそのまま保つ）。lamport と instance は
  // NOT NULL —— `_sns_clock` の行が無いまま書き込まれたら、ここで落ちてほしい
  declarations.push(escapeIdentifier(VERSION_COLUMNS.ts))
  declarations.push(
    `${escapeIdentifier(VERSION_COLUMNS.lamport)} INTEGER NOT NULL`
  )
  declarations.push(
    `${escapeIdentifier(VERSION_COLUMNS.instance)} TEXT NOT NULL`
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(rowsTableName(table))} (
       ${declarations.join(',\n       ')}
     )`
  )
}

/** `_sns_clock` に行が無ければ作る（冪等）。lamport には触らない。 */
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
export function ensureTickRow(db: Database.Database, table: string): void {
  db.prepare(
    `INSERT INTO _sns_tick (tableName, tick) VALUES (?, 0)
     ON CONFLICT (tableName) DO NOTHING`
  ).run(table)
}
