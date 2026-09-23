/**
 * 参照実装 `rows-d1` —— 設計書 docs/rows-table-design.md §1（意味の定義）と §2（削除）を、
 * そのまま素直に写した「アプリの表の見え方」の計算。
 *
 * ## 何のためにあるか
 *
 * 網羅検査器の判定4（設計書 §8.1）は「本物の実装が作り直したあとのアプリの表」を、
 * **この参照実装が計算した見え方**と突き合わせる。したがってここは
 *
 * - **`src/` を一切呼ばない。** 呼ぶと `src/` の不具合をそのまま写して、判定が素通りする
 * - **速度より読みやすさを優先する。** 設計書の語（Max・候補・表示値・かぶり・勝者・
 *   隠れた行・置かない行・置く行）を関数名にそのまま使い、1つの定義を1か所で計算する
 * - **SQLite に判定させるべきものは SQLite に判定させる。** 照合順序・CHECK・部分索引・
 *   式索引・生成列・値の種類は、JS で真似ると必ずずれる（設計書 §1.4 の穴B、§1.5 の穴3、
 *   §1.2.3 の穴9）。一時の `:memory:` DB へ**強い順に INSERT** して、SQLite が返した
 *   エラーの種類で「置かない行」「隠れた行」を分ける
 *
 * ## 入力
 *
 * - **版の集合**（{@link Version}）: アプリの書き込みで作られた版。表・真の id・種類
 *   （行 / 削除）・`_sns_ts`・`L`（lamport）・`iid`（instanceId）・中身
 * - **スキーマ**（{@link OracleSchema}）: 同期する表の `CREATE TABLE` 文と索引の文。
 *   主キー・列・外部キー・NOT NULL・既定値は、この文から作った一時 DB の
 *   `PRAGMA` で読み取る（別に宣言させると、宣言と DDL がずれたときに黙って違う表を調べる）
 *
 * ## 出力
 *
 * {@link derive} が「置く行・隠れた行・置かない行・**捨てる行**（原則4）・死んだ id・
 * `Res`」を返し、
 * {@link viewJson} がアプリの表の見え方を、検査器の {@link module:tools/explore/history} の
 * `viewOf` と同じ形の JSON にする。
 *
 * ## 写していない部分（限界。報告に書くこと）
 *
 * - 主キー以外の UNIQUE 列を指す外部キーで、**隠れた行**の中から値の組を探すときだけは、
 *   照合順序を当てずに JS で比べる（置く行は一時 DB へ問い合わせるので照合順序が効く）。
 *   範囲の表にその形の外部キーは無い
 * - `ON UPDATE`（設計書 §1.4 の穴16）はアプリの接続で起きた結果が事実になるので、
 *   ここでは何もしない
 *
 * @module tools/explore/oracles/rows-d1
 */
import Database from 'better-sqlite3'

/** SQLite が持てる値。 */
export type SqlValue = null | number | bigint | string | Buffer

/** 版（設計書 §1.2 の `W` / `D`）。 */
export type Version = {
  table: string
  /** 真の id（主キーが1列である前提。設計書の範囲の表はすべて1列） */
  id: SqlValue
  kind: 'row' | 'delete'
  /** 順序用の時刻 `_sns_ts`（設計書 §1.2.1） */
  ts: SqlValue
  /** その端末での書き込み順（設計書 §1.2 の `L`） */
  lamport: number
  /** `instanceId`（設計書 §3.2 の `iid`） */
  instance: string
  /** 行の版のときの、全列の真の値（生成列を除く） */
  content?: Record<string, SqlValue>
}

/** 同期する表1つ分のスキーマ。 */
export type OracleTable = {
  name: string
  /** `CREATE TABLE` 文。そのまま一時 DB へ流す */
  ddl: string
  /** `CREATE [UNIQUE] INDEX` 文（部分索引・式索引を含んでよい） */
  indexes?: string[]
  /** 見え方の JSON で julianday へ直す時刻列（既定 `updatedAt`） */
  timeColumn?: string
}

/** 同期する表の一覧。**外部キーの依存の順に並んでいなくてよい**（中で並べ替える）。 */
export type OracleSchema = { tables: OracleTable[] }

/**
 * 候補（＝ `Max` が行の版だった id）の行き先。設計書 §1.4〜§1.6、原則4。
 *
 * `discarded` だけ質が違う —— **版そのものを捨てる**（原則4）。残りの3つは
 * アプリの表での置き場所の話で、版は `_sns_rows_<表>` に残る。
 */
export type Placement = 'placed' | 'hidden' | 'unplaceable' | 'discarded'

/** 1つの候補について分かったこと。 */
export type CandidateResult = {
  table: string
  /** 真の id の正規形（設計書 §1.11） */
  key: string
  placement: Placement
  /** 表示値（設計書 §1.4）。置かない行では、決まるところまで入れた値 */
  display: Record<string, SqlValue>
  /** 隠れた行のときの勝者の真の id の正規形（設計書 §1.5） */
  winner?: string
  /** 置かない行になった理由（SQLite が返したメッセージ） */
  reason?: string
  /**
   * 置かない行になった筋。`parent` は §1.4 の「親が置かれていない」、
   * `constraint` は行に閉じた制約（NOT NULL / CHECK / 型 / 生成列）で SQLite が拒んだもの。
   * 判定13（置かない行の逆向きの検査）は `constraint` だけを見る
   */
  reasonKind?: 'parent' | 'constraint'
  /** 捨てる原因になった親（原則4）。`placement` が `discarded` のときだけ入る */
  cause?: GoneCause
}

/**
 * 「消えている」ことの原因（原則4）。連鎖で捨てられた行では、**大元の削除**を指す
 * （利用者が「どの削除でこの行が消えたか」を1つ知れれば足りる）。
 */
export type GoneCause = { table: string; key: string }

/** {@link derive} の結果。 */
export type Derived = {
  /** 表 → 真の id の正規形 → 候補の結果 */
  candidates: Map<string, Map<string, CandidateResult>>
  /** 表 → 真の id の正規形 → `Res`（表示上の主キー。`⊥` は null。設計書 §1.6） */
  res: Map<string, Map<string, SqlValue | null>>
  /** 表 → 置く行（`SELECT *` と同じ列の並びの、アプリの表の行） */
  rows: Map<string, Record<string, SqlValue>[]>
  /** 死んでいる id（`Max` が削除の版）の正規形 */
  dead: Map<string, Set<string>>
  /** 版ごと捨てる id（原則4）の正規形。表 → 正規形の集合 */
  discarded: Map<string, Set<string>>
}

/* ------------------------------------------------------------------ *
 * 値の比較（設計書 §1.2.3・§1.11）—— SQLite に判定させる
 * ------------------------------------------------------------------ */

/** 値の種類の群と `julianday`（設計書 §1.2.3 の段1・段2）を SQLite に尋ねる道具。 */
export class ValueOracle {
  private readonly db = new Database(':memory:')
  /**
   * 値を1回だけ束縛して、群・`julianday`・`CAST(… AS TEXT)` をまとめて尋ねる
   * （`?1` の形は better-sqlite3 が受け取らないので、CTE で1回だけ渡す）。
   *
   * 群3（`julianday` で比べる）に入れるのは、**`julianday` が値を返し、かつ ISO 8601 の
   * 字形**のものだけ（設計書 §1.2.3）。`julianday` は `'now'`・`'12:00'`・`'123'` も
   * 受け取るので、返るかどうかだけで決めると、評価のたびに変わる値が群3 に入る。
   */
  private readonly groupOf = this.db.prepare(
    `WITH v(x) AS (VALUES (?))
     SELECT CASE typeof(x)
              WHEN 'null'    THEN 0
              WHEN 'integer' THEN 1
              WHEN 'real'    THEN 1
              WHEN 'blob'    THEN 4
              ELSE CASE
                WHEN julianday(x) IS NOT NULL AND (
                     x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                  OR x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]'
                  OR x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
                  OR x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9].*'
                  OR x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]*Z'
                  OR x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]*[+-][0-9][0-9]:[0-9][0-9]'
                ) THEN 3
                ELSE 2
              END
            END AS grp,
            julianday(x) AS j,
            CAST(x AS TEXT) AS text
     FROM v`
  )

  /** 設計書 §1.2.3 の順序。負なら `a` が弱い。 */
  compareTs(a: SqlValue, b: SqlValue): number {
    const x = this.describe(a)
    const y = this.describe(b)
    if (x.grp !== y.grp) return x.grp < y.grp ? -1 : 1
    switch (x.grp) {
      case 0:
        return 0 // NULL どうしは同着
      case 1:
        // 数値としてそのまま比べる（`CAST` は挟まない。設計書 §1.2.3 の軽微19）
        if (typeof a === 'bigint' && typeof b === 'bigint') {
          return a < b ? -1 : a > b ? 1 : 0
        }
        return compareNumbers(Number(a), Number(b))
      case 3:
        return compareNumbers(x.j as number, y.j as number)
      default:
        // 読めない TEXT と BLOB はバイト列（BINARY）で比べる
        return Buffer.compare(toBytes(a), toBytes(b))
    }
  }

  /**
   * 真の id の正規形（設計書 §1.11）。`CAST(x AS TEXT)` と同じ形にしてから
   * UTF-8 のバイト列で比べられるよう、文字列にして返す。
   */
  idKey(value: SqlValue): string {
    if (Buffer.isBuffer(value)) return value.toString('utf8')
    return String(this.describe(value).text)
  }

  /** `julianday`（見え方の JSON で時刻列に当てる。読めなければ null）。 */
  julian(value: SqlValue): number | null {
    return this.describe(value).j
  }

  private describe(value: SqlValue): {
    grp: number
    j: number | null
    text: string | null
  } {
    return this.groupOf.get(value as never) as {
      grp: number
      j: number | null
      text: string | null
    }
  }
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function toBytes(value: SqlValue): Buffer {
  if (Buffer.isBuffer(value)) return value
  return Buffer.from(String(value), 'utf8')
}

/**
 * 版の順序 `≺`（設計書 §1.2.5）。`( _sns_ts, L, iid )` の辞書順、すべて等しければ
 * 種類（行の版 ＜ 削除の版）。負なら `a` が弱い。
 */
export function compareVersions(
  values: ValueOracle,
  a: Version,
  b: Version
): number {
  const byTs = values.compareTs(a.ts, b.ts)
  if (byTs !== 0) return byTs
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1
  // `iid` は `COLLATE BINARY`（UTF-8 のバイト列）で比べる。JS の `<` は UTF-16 の
  // 符号単位の順で、SQLite の既定の照合順序とは並びが違う
  const byInstance = Buffer.compare(
    Buffer.from(a.instance, 'utf8'),
    Buffer.from(b.instance, 'utf8')
  )
  if (byInstance !== 0) return byInstance
  const rank = (version: Version): number => (version.kind === 'row' ? 0 : 1)
  return compareNumbers(rank(a), rank(b))
}

/* ------------------------------------------------------------------ *
 * スキーマ（一時 DB の PRAGMA から読む）
 * ------------------------------------------------------------------ */

type ForeignKey = {
  /** 子側の列 */
  columns: string[]
  parentTable: string
  /** 親側の列（`REFERENCES t(id)` の `id`。省略されていれば親の主キー） */
  parentColumns: string[]
  onDelete: string
}

type TableMeta = {
  name: string
  /** `SELECT *` に現れる列（生成列を含む） */
  selectColumns: string[]
  /** 版の中身が持つ列（生成列を除く） */
  storedColumns: string[]
  primaryKey: string[]
  notNull: Set<string>
  /** 列 → 既定値の SQL の字面（`PRAGMA table_info` の `dflt_value`） */
  defaults: Map<string, string | null>
  foreignKeys: ForeignKey[]
  timeColumn: string
}

/**
 * **置かない行にしてよいエラー**（設計書 §1.4 の白紙のリスト）。
 * ここに無いエラーで失敗したら、その行を置かない行にせず作り直しを中止する。
 */
const UNPLACEABLE_CODES = new Set([
  'SQLITE_CONSTRAINT_NOTNULL',
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_TRIGGER',
  'SQLITE_CONSTRAINT_DATATYPE',
  'SQLITE_MISMATCH',
])

/**
 * **かぶりを表すエラー**（設計書 §1.5）。`rowid` という名の列は宣言でき、
 * 明示した rowid の重複は `SQLITE_CONSTRAINT_ROWID` になる。
 */
const COLLISION_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_ROWID',
])

/** 主キーの席の取り合いを表すエラー（勝者を選ぶとき、こちらを優先する）。 */
const PRIMARY_KEY_CODES = new Set([
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_ROWID',
])

/** 一時 DB（判定用と、かぶりの当たりを見る使い捨て用）とスキーマの読み取り。 */
class SchemaModel {
  /** 強い順に候補を入れていく判定用の DB（設計書 §3.7.1） */
  readonly judge: Database.Database
  /** 候補2つの「かぶり」を見るための、毎回空にする DB */
  private readonly probe: Database.Database
  readonly tables: Map<string, TableMeta> = new Map()
  /** 外部キーの依存の順（親が先。設計書の前提 P2 より循環しない） */
  readonly order: string[]

  constructor(schema: OracleSchema) {
    this.judge = SchemaModel.open(schema)
    this.probe = SchemaModel.open(schema)
    for (const table of schema.tables) {
      this.tables.set(table.name, this.readMeta(table))
    }
    this.order = topologicalOrder(this.tables)
  }

  private static open(schema: OracleSchema): Database.Database {
    const db = new Database(':memory:')
    // 外部キーは §1.4 の表示値の規則でこちらが決める（SQLite には検査させない）
    db.pragma('foreign_keys = OFF')
    for (const table of schema.tables) {
      db.exec(table.ddl)
      for (const index of table.indexes ?? []) db.exec(index)
    }
    return db
  }

  private readMeta(table: OracleTable): TableMeta {
    const info = this.judge.pragma(`table_xinfo("${table.name}")`) as {
      name: string
      notnull: number
      dflt_value: string | null
      pk: number
      hidden: number
    }[]
    const selectColumns = info
      .filter((column) => column.hidden !== 1) // 1 は WITHOUT ROWID の隠し列
      .map((column) => column.name)
    const storedColumns = info
      .filter((column) => column.hidden === 0)
      .map((column) => column.name)
    const primaryKey = info
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name)
    const keys = this.judge.pragma(`foreign_key_list("${table.name}")`) as {
      id: number
      seq: number
      table: string
      from: string
      to: string | null
      on_delete: string
    }[]
    const grouped = new Map<number, typeof keys>()
    for (const row of keys) {
      const list = grouped.get(row.id) ?? []
      list.push(row)
      grouped.set(row.id, list)
    }
    const foreignKeys = [...grouped.values()].map((rows) => {
      const sorted = [...rows].sort((a, b) => a.seq - b.seq)
      return {
        columns: sorted.map((row) => row.from),
        parentTable: sorted[0].table,
        // `to` が NULL なら親の主キーを指している
        parentColumns: sorted.map((row) => row.to).every((to) => to === null)
          ? []
          : sorted.map((row) => row.to as string),
        onDelete: sorted[0].on_delete.toUpperCase(),
      }
    })
    return {
      name: table.name,
      selectColumns,
      storedColumns,
      primaryKey,
      notNull: new Set(info.filter((c) => c.notnull === 1).map((c) => c.name)),
      defaults: new Map(info.map((c) => [c.name, c.dflt_value])),
      foreignKeys,
      timeColumn: table.timeColumn ?? 'updatedAt',
    }
  }

  /** 親側の列（省略されていれば親の主キー）。 */
  parentColumnsOf(key: ForeignKey): string[] {
    if (key.parentColumns.length > 0) return key.parentColumns
    const parent = this.tables.get(key.parentTable)
    return parent === undefined ? [] : parent.primaryKey
  }

  /**
   * 候補 `row` を判定用の DB へ入れてみる（設計書 §1.4 の「強い順に INSERT する」）。
   *
   * @returns 入ったら `placed`、UNIQUE で落ちたら `unique`、それ以外の制約で落ちたら
   *   `unplaceable`（置かない行）
   */
  insertIntoJudge(
    table: TableMeta,
    display: Record<string, SqlValue>
  ):
    | { outcome: 'placed'; rowid: number }
    | { outcome: 'unique' | 'unplaceable'; reason: string } {
    try {
      const info = statementFor(this.judge, table).run(
        ...table.storedColumns.map((column) => display[column] ?? null)
      )
      return { outcome: 'placed', rowid: Number(info.lastInsertRowid) }
    } catch (error) {
      const code = (error as { code?: string }).code ?? ''
      const reason = String((error as Error).message)
      if (COLLISION_CODES.has(code)) {
        return { outcome: 'unique', reason }
      }
      if (!UNPLACEABLE_CODES.has(code)) {
        // 資源の不足（SQLITE_NOMEM / SQLITE_FULL など）を「その行は置けない」と読み替えると、
        // 表が丸ごと空になる。設計書 §1.4 のとおり、白紙のリストに無いエラーは中止する
        throw error
      }
      return { outcome: 'unplaceable', reason }
    }
  }

  /**
   * 候補2つが**かぶる**か（設計書 §1.5）。空の DB へ片方を入れ、もう片方を入れて
   * かぶりのエラーになるかどうかで決める。**どのエラーになったか**も返す
   * （主キーの衝突は `SQLITE_CONSTRAINT_PRIMARYKEY` / `SQLITE_CONSTRAINT_ROWID`）。
   *
   * 索引の文を字句解析せずに済むので、部分索引・式索引・生成列を含む索引・
   * 索引ごとの照合順序が、宣言どおりそのまま効く。
   */
  collides(
    table: TableMeta,
    left: Record<string, SqlValue>,
    right: Record<string, SqlValue>
  ): string | null {
    this.probe.exec(`DELETE FROM "${table.name}"`)
    const insert = (values: Record<string, SqlValue>): string | null => {
      try {
        statementFor(this.probe, table).run(
          ...table.storedColumns.map((column) => values[column] ?? null)
        )
        return null
      } catch (error) {
        return (error as { code?: string }).code ?? 'SQLITE_ERROR'
      }
    }
    if (insert(left) !== null) return null
    return insert(right)
  }

  /** 判定用の DB から、置く行を `SELECT *` の形で読み出す。 */
  readRow(table: TableMeta, rowid: number): Record<string, SqlValue> {
    return this.judge
      .prepare(`SELECT * FROM "${table.name}" WHERE rowid = ?`)
      .get(rowid) as Record<string, SqlValue>
  }

  /** 判定用の DB を引いて、値の組を持つ置く行を探す（照合順序が効く）。 */
  findPlaced(
    table: TableMeta,
    columns: string[],
    values: SqlValue[]
  ): Record<string, SqlValue> | null {
    const where = columns.map((column) => `"${column}" IS ?`).join(' AND ')
    const row = this.judge
      .prepare(`SELECT * FROM "${table.name}" WHERE ${where}`)
      .get(...(values as never[]))
    return (row as Record<string, SqlValue> | undefined) ?? null
  }

  close(): void {
    this.judge.close()
    this.probe.close()
  }
}

const statementCache = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>()

function statementFor(
  db: Database.Database,
  table: TableMeta
): Database.Statement {
  let perDb = statementCache.get(db)
  if (perDb === undefined) {
    perDb = new Map()
    statementCache.set(db, perDb)
  }
  const cached = perDb.get(table.name)
  if (cached !== undefined) return cached
  const columns = table.storedColumns.map((column) => `"${column}"`).join(', ')
  const holes = table.storedColumns.map(() => '?').join(', ')
  const statement = db.prepare(
    `INSERT INTO "${table.name}" (${columns}) VALUES (${holes})`
  )
  perDb.set(table.name, statement)
  return statement
}

/** 外部キーの依存の順（親が先）。循環していれば例外（設計書の前提 P2）。 */
function topologicalOrder(tables: Map<string, TableMeta>): string[] {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string): void => {
    const mark = state.get(name)
    if (mark === 'done') return
    if (mark === 'visiting') {
      throw new Error(`同期する表の外部キーが循環している（前提 P2）: ${name}`)
    }
    state.set(name, 'visiting')
    for (const key of tables.get(name)?.foreignKeys ?? []) {
      if (tables.has(key.parentTable) && key.parentTable !== name) {
        visit(key.parentTable)
      }
    }
    state.set(name, 'done')
    order.push(name)
  }
  for (const name of tables.keys()) visit(name)
  return order
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

/**
 * 版の集合から、設計書 §1 の定義どおりに「アプリの表の見え方」を計算する。
 *
 * 手順は設計書の順番そのまま:
 *
 * 1. `Max`（§1.2.5）—— キーごとに最強の版
 * 2. 候補（§1.3）—— `Max` が行の版の id
 * 3. 表示値（§1.4）—— 外部キーの読み替え、置かない行、1:1 の主キー
 * 4. 強い順に一時 DB へ入れる（§1.6）—— 入れば置く行、UNIQUE で落ちれば隠れた行、
 *    ほかの制約で落ちれば置かない行
 * 5. 勝者（§1.5）と `Res`（§1.6）
 */
export function derive(versions: Version[], schema: OracleSchema): Derived {
  const values = new ValueOracle()
  const model = new SchemaModel(schema)
  try {
    return deriveWith(values, model, versions)
  } finally {
    model.close()
  }
}

function deriveWith(
  values: ValueOracle,
  model: SchemaModel,
  versions: Version[]
): Derived {
  // 1. Max（§1.2.5）
  const max = new Map<string, Map<string, Version>>()
  for (const name of model.tables.keys()) max.set(name, new Map())
  for (const version of versions) {
    const perTable = max.get(version.table)
    if (perTable === undefined) continue // 同期しない表の版は見え方に効かない
    const key = values.idKey(version.id)
    const current = perTable.get(key)
    if (current === undefined) {
      perTable.set(key, version)
      continue
    }
    if (compareVersions(values, current, version) < 0) {
      perTable.set(key, version)
    }
  }

  const candidates = new Map<string, Map<string, CandidateResult>>()
  const res = new Map<string, Map<string, SqlValue | null>>()
  const rows = new Map<string, Record<string, SqlValue>[]>()
  const dead = new Map<string, Set<string>>()
  const discarded = new Map<string, Set<string>>()
  /**
   * 消えている id（原則4）。表 → 真の id の正規形 → 大元の削除。
   * 表は親が先の順（`model.order`）に回るので、子を見るときには親のぶんが揃っている。
   */
  const gone = new Map<string, Map<string, GoneCause>>()

  for (const name of model.order) {
    const table = model.tables.get(name) as TableMeta
    const perTable = max.get(name) as Map<string, Version>
    const tableCandidates = new Map<string, CandidateResult>()
    const tableRes = new Map<string, SqlValue | null>()
    const tableRows: Record<string, SqlValue>[] = []
    const tableDead = new Set<string>()
    const tableDiscarded = new Set<string>()
    const tableGone = new Map<string, GoneCause>()

    // 2. 候補（§1.3）。死んでいる id は `dead` として返す
    const living: Version[] = []
    for (const [key, version] of perTable) {
      if (version.kind === 'row') living.push(version)
      else {
        tableDead.add(key)
        // 削除そのものが大元。子から見た原因はこの id（原則4）
        tableGone.set(key, { table: name, key })
      }
    }

    // 3〜4. 版の順序の強い順、同着は真の id の正規形の小さい順（§1.6）
    living.sort((a, b) => {
      const byVersion = compareVersions(values, b, a)
      if (byVersion !== 0) return byVersion
      return Buffer.compare(
        Buffer.from(values.idKey(a.id), 'utf8'),
        Buffer.from(values.idKey(b.id), 'utf8')
      )
    })

    const placedRows: { key: string; display: Record<string, SqlValue> }[] = []
    const hidden: { key: string; display: Record<string, SqlValue> }[] = []

    for (const version of living) {
      const key = values.idKey(version.id)
      const shown = displayValues(
        values,
        model,
        table,
        version,
        res,
        candidates,
        gone
      )
      if (shown.kind === 'discard') {
        // 親が削除されている。版ごと捨てる（原則4）
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'discarded',
          display: { ...(version.content ?? {}) },
          reason: `親が削除されている（${shown.cause.table}:${shown.cause.key}）`,
          reasonKind: 'parent',
          cause: shown.cause,
        })
        tableRes.set(key, null)
        tableDiscarded.add(key)
        // 捨てられた行を親とする孫も捨てる（連鎖。大元の削除をそのまま伝える）
        tableGone.set(key, shown.cause)
        continue
      }
      if (shown.kind === 'unplaceable') {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'unplaceable',
          display: { ...(version.content ?? {}) },
          reason: '親が置かれていない（設計書 §1.4）',
          reasonKind: 'parent',
        })
        tableRes.set(key, null)
        continue
      }
      const display = shown.display
      // 主キーが NULL の候補は置かない行にする。`INTEGER PRIMARY KEY` に NULL を
      // 入れると SQLite が rowid を割り当ててしまい、ライブラリが id を捏造する
      if (
        table.primaryKey.some((column) => (display[column] ?? null) === null)
      ) {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'unplaceable',
          display,
          reason: '主キーが NULL',
          reasonKind: 'constraint',
        })
        tableRes.set(key, null)
        continue
      }
      const outcome = model.insertIntoJudge(table, display)
      if (outcome.outcome === 'placed') {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'placed',
          display,
        })
        placedRows.push({ key, display })
        tableRows.push(model.readRow(table, outcome.rowid))
        tableRes.set(key, displayPrimaryKey(table, display))
      } else if (outcome.outcome === 'unique') {
        hidden.push({ key, display })
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'hidden',
          display,
        })
      } else {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'unplaceable',
          display,
          reason: outcome.reason,
          reasonKind: 'constraint',
        })
        tableRes.set(key, null)
      }
    }

    // 5. 勝者（§1.5）—— かぶった置く行のうち、いちばん強いもの。置く行は強い順に
    //    並んでいるので、先に当たったものが勝者
    for (const row of hidden) {
      // **エラーの種別で分岐しない。** 主キーと UNIQUE の両方に当たる候補では
      // SQLite は `SQLITE_CONSTRAINT_UNIQUE` しか返さないので、種別で分岐すると
      // 主キーを占めている行とは別の行を勝者にしてしまう。置く行を強い順に
      // 全部当ててみて、主キーで当たった行があればそちらを優先する
      const codes = placedRows.map((placed) => ({
        placed,
        code: model.collides(table, placed.display, row.display),
      }))
      const winner = (
        codes.find(
          (entry) => entry.code !== null && PRIMARY_KEY_CODES.has(entry.code)
        ) ??
        codes.find(
          (entry) => entry.code !== null && COLLISION_CODES.has(entry.code)
        )
      )?.placed
      const entry = tableCandidates.get(row.key) as CandidateResult
      if (winner === undefined) {
        // かぶる相手が見つからない（部分索引の当たり方などで起こりうる）。
        // 設計書 §1.6 の表の「それ以外」に落とし、Res は ⊥
        tableRes.set(row.key, null)
        continue
      }
      entry.winner = winner.key
      tableRes.set(row.key, tableRes.get(winner.key) ?? null)
    }

    candidates.set(name, tableCandidates)
    res.set(name, tableRes)
    rows.set(name, tableRows)
    dead.set(name, tableDead)
    discarded.set(name, tableDiscarded)
    gone.set(name, tableGone)
  }

  return { candidates, res, rows, dead, discarded }
}

/** 表示上の主キー（主キーが1列である前提）。 */
function displayPrimaryKey(
  table: TableMeta,
  display: Record<string, SqlValue>
): SqlValue {
  return display[table.primaryKey[0]] ?? null
}

/** {@link displayValues} の答え。 */
type DisplayOutcome =
  /** 置ける（表示値が決まった） */
  | { kind: 'values'; display: Record<string, SqlValue> }
  /** 置かない行。版は残る */
  | { kind: 'unplaceable' }
  /** 版ごと捨てる（原則4）。`cause` は削除されている親 */
  | { kind: 'discard'; cause: GoneCause }

/**
 * 表示値（設計書 §1.4、原則4）。
 *
 * 外部キーの列は、同期する親を指していれば `Res_p` で読み替える。親が置かれていなければ
 * 宣言された `ON DELETE` に従う。主キーが親を指している（1:1）表では、主キーも読み替える。
 *
 * 親が置かれていないまま落ちるとき、その親が**削除されている**（または同じ規則で
 * 捨てられた）なら、置かない行ではなく **`discard`**（原則4）。単に届いていない・
 * 制約で置けない・隠れているだけなら、従来どおり置かない行のまま。
 */
function displayValues(
  values: ValueOracle,
  model: SchemaModel,
  table: TableMeta,
  version: Version,
  res: Map<string, Map<string, SqlValue | null>>,
  candidates: Map<string, Map<string, CandidateResult>>,
  gone: Map<string, Map<string, GoneCause>>
): DisplayOutcome {
  const display: Record<string, SqlValue> = {}
  for (const column of table.storedColumns) {
    display[column] = version.content?.[column] ?? null
  }
  for (const key of table.foreignKeys) {
    if (!model.tables.has(key.parentTable)) continue // 同期しない表は真の値のまま（§1.4）
    const trueValues = key.columns.map((column) => display[column] ?? null)
    // 複合外部キーで1列でも NULL なら、SQLite は検査しない（そのまま置く）
    if (trueValues.some((value) => value === null)) continue
    const resolved = resolveParent(
      values,
      model,
      key,
      trueValues,
      res,
      candidates
    )
    if (resolved !== null) {
      key.columns.forEach((column, index) => {
        display[column] = resolved[index]
      })
      continue
    }
    // 親が置かれていないとき（§1.4 の下の表）
    const isPrimary =
      key.columns.length === table.primaryKey.length &&
      key.columns.every((column) => table.primaryKey.includes(column))
    // 落ちるときの行き先。原因が「削除されている親」なら捨てる、でなければ置かない行
    const cause = goneParent(values, model, key, trueValues, gone)
    const out = (): DisplayOutcome =>
      cause === null ? { kind: 'unplaceable' } : { kind: 'discard', cause }
    switch (key.onDelete) {
      case 'SET NULL': {
        if (isPrimary) return out() // 1:1 の主キーは NULL にできない
        if (key.columns.some((column) => table.notNull.has(column)))
          return out()
        for (const column of key.columns) display[column] = null
        break
      }
      case 'SET DEFAULT': {
        if (isPrimary) return out()
        const defaults = key.columns.map((column) =>
          literalDefault(model, table, column)
        )
        if (defaults.some((value) => value === undefined)) return out()
        const asValues = defaults as SqlValue[]
        // 既定値の親が置かれていなければ、子は生き残れない
        if (
          resolveParent(values, model, key, asValues, res, candidates) === null
        ) {
          return out()
        }
        key.columns.forEach((column, index) => {
          display[column] = asValues[index]
        })
        break
      }
      default:
        // CASCADE / RESTRICT / NO ACTION
        return out()
    }
  }
  return { kind: 'values', display }
}

/**
 * 消えている親（原則4）。削除の版が `Max` か、親自身が同じ規則で捨てられたか。
 *
 * 分けられるのは**親の主キーを指している外部キーだけ**。主キー以外の `UNIQUE` 列を
 * 指しているときは、その値を持っていた親がどれだったかが決まらず、「どの削除が原因か」
 * を答えられないので `null`（＝従来どおり置かない行）。
 */
function goneParent(
  values: ValueOracle,
  model: SchemaModel,
  key: ForeignKey,
  trueValues: SqlValue[],
  gone: Map<string, Map<string, GoneCause>>
): GoneCause | null {
  const parent = model.tables.get(key.parentTable) as TableMeta
  const parentColumns = model.parentColumnsOf(key)
  const isParentPrimaryKey =
    parentColumns.length === parent.primaryKey.length &&
    parentColumns.every((column) => parent.primaryKey.includes(column))
  if (!isParentPrimaryKey || parentColumns.length !== 1) return null
  return gone.get(key.parentTable)?.get(values.idKey(trueValues[0])) ?? null
}

/**
 * 既定値が**定数の字面**なら、その値（設計書 §1.4）。字面でなければ `undefined`。
 * 字面かどうかは一時 DB に評価させる（`SELECT <既定値>`）。
 */
function literalDefault(
  model: SchemaModel,
  table: TableMeta,
  column: string
): SqlValue | undefined {
  const text = table.defaults.get(column)
  if (text === null || text === undefined) return undefined
  if (
    !/^(-?\d+(\.\d+)?|'([^']|'')*'|NULL|X'[0-9a-fA-F]*')$/i.test(text.trim())
  ) {
    return undefined
  }
  const row = model.judge.prepare(`SELECT ${text} AS v`).get() as {
    v: SqlValue
  }
  return row.v
}

/**
 * 親の行を探す（設計書 §1.4 の表の1〜4行目）。見つからなければ `null`。
 *
 * - 親の主キーを指しているなら `Res_p`
 * - 主キー以外の UNIQUE 列を指しているなら、その値の組を持つ**置く行**、無ければ
 *   **隠れた行**の勝者
 */
function resolveParent(
  values: ValueOracle,
  model: SchemaModel,
  key: ForeignKey,
  trueValues: SqlValue[],
  res: Map<string, Map<string, SqlValue | null>>,
  candidates: Map<string, Map<string, CandidateResult>>
): SqlValue[] | null {
  const parent = model.tables.get(key.parentTable) as TableMeta
  const parentColumns = model.parentColumnsOf(key)
  const isParentPrimaryKey =
    parentColumns.length === parent.primaryKey.length &&
    parentColumns.every((column) => parent.primaryKey.includes(column))

  if (isParentPrimaryKey && parentColumns.length === 1) {
    const resolved = res.get(key.parentTable)?.get(values.idKey(trueValues[0]))
    return resolved === undefined || resolved === null ? null : [resolved]
  }

  const placed = model.findPlaced(parent, parentColumns, trueValues)
  if (placed !== null) {
    return parentColumns.map((column) => placed[column] ?? null)
  }
  // 置く行が無ければ隠れた行の勝者（照合順序を当てずに比べる。模組冒頭の「限界」）
  for (const entry of candidates.get(key.parentTable)?.values() ?? []) {
    if (entry.placement !== 'hidden' || entry.winner === undefined) continue
    const same = parentColumns.every(
      (column, index) =>
        values.idKey(entry.display[column] ?? null) ===
        values.idKey(trueValues[index])
    )
    if (!same) continue
    const winner = candidates.get(key.parentTable)?.get(entry.winner)
    if (winner === undefined) continue
    return parentColumns.map((column) => winner.display[column] ?? null)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 見え方の JSON（検査器の viewOf と同じ形）
 * ------------------------------------------------------------------ */

/**
 * 見え方 `Φ(F)`（設計書 §1.7）を、`tools/explore/state.ts` の `snapshotData` ＋
 * `tools/explore/history.ts` の `viewOf` と**同じ形**の JSON にする。
 *
 * すなわち `[[ "表:id", { …列…, 時刻列は julianday } ], …]` を鍵の昇順に並べたもの。
 */
export function viewJson(derived: Derived, schema: OracleSchema): string {
  const values = new ValueOracle()
  const entries: [string, Record<string, SqlValue | number | null>][] = []
  for (const table of schema.tables) {
    const meta = table.timeColumn ?? 'updatedAt'
    for (const row of derived.rows.get(table.name) ?? []) {
      const normalized: Record<string, SqlValue | number | null> = { ...row }
      if (meta in normalized) {
        normalized[meta] =
          values.julian(row[meta] ?? null) ?? String(row[meta] ?? null)
      }
      entries.push([`${table.name}:${String(row.id)}`, normalized])
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries)
}

/** 版の集合とスキーマから、見え方の JSON をひと息で作る。 */
export function expectedView(
  versions: Version[],
  schema: OracleSchema
): string {
  return viewJson(derive(versions, schema), schema)
}
