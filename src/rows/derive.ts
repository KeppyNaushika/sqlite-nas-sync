/**
 * 版の集合とスキーマから、アプリの表の見え方を計算する（設計書
 * `docs/rows-table-design.md` §1.3〜§1.7）。
 *
 * 入力は**版の集合とスキーマだけ**で、DB の状態も時刻も乱数も読まない。同じ入力なら
 * どの端末でも同じ答えになる（設計書 §6.1 の補題1・補題2）。手順は設計書の順番そのまま:
 *
 * 1. `Max`（§1.2.5）—— キーごとに最強の版
 * 2. 候補（§1.3）—— `Max` が行の版の id
 * 3. 表示値（§1.4）—— 外部キーの読み替え、置かない行、1:1 の表示上の主キー
 * 4. 強い順に一時 `:memory:` DB へ INSERT（§1.6）—— 入れば**置く行**、
 *    UNIQUE か PRIMARYKEY で落ちれば**隠れた行**、白紙のリストの制約で落ちれば
 *    **置かない行**、それ以外のエラーなら**中止して例外**
 * 5. 勝者（§1.5）と `Res`（§1.6）
 *
 * **判定は SQLite にさせる。** 照合順序・CHECK・部分索引・式索引・生成列・値の種類を
 * JS で真似ると必ずずれる。かぶりは「一時 DB へ入れてみて、どのエラーで落ちたか」で
 * 決め、勝者は「索引の項の値でその一時 DB を引く」ことで決める（設計書 §1.5）。
 *
 * @module rows/derive
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier } from '../setup/sql'
import {
  UniqueIndexDefinition,
  primaryKeyColumns,
  readUniqueIndexes,
} from './index-parse'
import { missingParentAction } from './on-delete'
import { RowVersion, SqlValue, ValueOrdering } from './versions'

/** 同期する表1つ分のスキーマ。 */
interface RowsTable {
  name: string
  /** `CREATE TABLE` 文。そのまま一時 DB へ流す */
  ddl: string
  /** `CREATE [UNIQUE] INDEX` 文（部分索引・式索引を含んでよい） */
  indexes?: string[]
}

/** 同期する表の一覧。**外部キーの依存の順に並んでいなくてよい**（中で並べ替える）。 */
export interface RowsSchema {
  tables: RowsTable[]
}

/**
 * 候補（＝ `Max` が行の版だった id）の行き先。設計書 §1.4〜§1.6。
 *
 * `parentDeleted` は置かない行のうち、親行が削除されているもの（原則4・付則3）。
 * どの行き先でも版は `_sns_rows_<表>` に残る。行き先は版の集合だけで決まるので、
 * 親行が書き直されて削除の版に勝てば、同じ版がそのまま置く行に戻る。
 */
type Placement = 'placed' | 'hidden' | 'unplaceable' | 'parentDeleted'

/** 1つの候補について分かったこと。 */
export interface CandidateResult {
  table: string
  /** 真の id の正規形（設計書 §1.11） */
  key: string
  placement: Placement
  /** 表示値（設計書 §1.4）。置かない行では、決まるところまで入れた値 */
  display: Record<string, SqlValue>
  /** 隠れた行のときの勝者の真の id の正規形（設計書 §1.5） */
  winner?: string
  /** 隠れた行・置かない行になった理由（SQLite が返したメッセージなど） */
  reason?: string
  /**
   * 原因の親（原則4）。`placement` が `parentDeleted` のときだけ入る。
   * 連鎖（孫）では大元の削除を指す
   */
  cause?: { table: string; key: string }
}

/** {@link derive} の結果。 */
interface DerivedRows {
  /** 表 → 真の id の正規形 → 候補の結果 */
  candidates: Map<string, Map<string, CandidateResult>>
  /** 表 → 置く行（`SELECT *` と同じ列の並びの、アプリの表の行） */
  rows: Map<string, Record<string, SqlValue>[]>
  /** 死んでいる id（`Max` が削除の版）の正規形 */
  dead: Map<string, Set<string>>
}

/** {@link derive} の差し込み口（設計書 §8.2 の「内部の差し込み口」）。公開 API ではない。 */
interface DeriveOptions {
  /**
   * 判定用の一時 DB を開いた直後に呼ばれる。
   *
   * 検査が「資源の不足」を人工的に起こすためにある（`PRAGMA max_page_count = 1` で
   * `SQLITE_FULL` を作るなど）。設計書 §1.4 のとおり、白紙のリストに無いエラーで
   * 置かない行にしてはいけないことを、本物のエラーで確かめられるようにする。
   */
  prepareJudgeDatabase?: (db: Database.Database) => void
}

/**
 * **置かない行にしてよいエラー**（設計書 §1.4 の白紙のリスト）。
 *
 * ここに無いエラー（`SQLITE_NOMEM`・`SQLITE_FULL`・`SQLITE_INTERRUPT`・`SQLITE_ERROR` など）で
 * 落ちたら、その行を置かない行にせず**作り直しを中止して例外にする**。資源の不足を
 * 「その行は置けない」と読み替えると、表が丸ごと空になる。
 */
const UNPLACEABLE_CODES = new Set([
  'SQLITE_CONSTRAINT_NOTNULL',
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_TRIGGER',
  'SQLITE_CONSTRAINT_DATATYPE',
  'SQLITE_MISMATCH',
])

/**
 * かぶりを表すエラー（設計書 §1.5 の穴3。**主キーの衝突も拾う**）。
 *
 * `SQLITE_CONSTRAINT_ROWID` も要る —— 明示した rowid の重複はこのコードになる。
 * 【確認】この経路は自分では踏まない（`PRAGMA table_xinfo` に出る列だけを書くので、
 * 暗黙の rowid を書くことがない。`rowid` という名の**宣言された列**は、
 * ただの列であって一意にはならない）。それでも拾うのは、拾い落とすと
 * 「かぶり」が「置かない行」に化け、行が黙って消えるからである。
 */
const COLLISION_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_ROWID',
])

/** 外部キー1本。 */
interface ForeignKey {
  /** 子側の列 */
  columns: string[]
  /** 親の表。参照する列は親の主キーである（付則4） */
  parentTable: string
  onDelete: string
}

/** 同期する表1つ分の、`PRAGMA` から読んだ姿。 */
interface TableMeta {
  name: string
  /** `SELECT *` に現れる列（生成列を含む） */
  selectColumns: string[]
  /** 版の中身が持つ列（生成列を除く） */
  storedColumns: string[]
  primaryKey: string[]
  notNull: Set<string>
  /** 列 → 既定値の SQL の字面（`PRAGMA table_xinfo` の `dflt_value`） */
  defaults: Map<string, string | null>
  foreignKeys: ForeignKey[]
  /** 一意にしている索引（主キーを含む。設計書 §1.5） */
  uniqueIndexes: UniqueIndexDefinition[]
  /** 置いた行を指し直すための列（主キー。無い表では全列） */
  identityColumns: string[]
}

/** 判定用の一時 DB に置いた行1つ（勝者を引くときの行き先）。 */
interface PlacedRow {
  /** 真の id の正規形 */
  key: string
  /** 強い順に置いた順番（小さいほど強い。設計書 §1.6） */
  order: number
}

/**
 * 版の集合から、設計書 §1 の定義どおりに「アプリの表の見え方」を計算する。
 *
 * @param versions 版の集合（同じキーの版が何度出てきてもよい。最強のものだけが残る）
 * @param schema 同期する表の `CREATE TABLE` と索引
 * @param options 検査のための差し込み口（公開 API ではない）
 */
export function derive(
  versions: RowVersion[],
  schema: RowsSchema,
  options: DeriveOptions = {}
): DerivedRows {
  const values = new ValueOrdering()
  const model = new SchemaModel(schema, options)
  try {
    return deriveWith(values, model, versions)
  } finally {
    model.close()
    values.close()
  }
}

function deriveWith(
  values: ValueOrdering,
  model: SchemaModel,
  versions: RowVersion[]
): DerivedRows {
  // 1. Max（設計書 §1.2.5）。`≺` は版の中身だけで決まる全順序なので、
  //    受け取る順によらずキーごとに最強の版だけを残してよい（補題C）
  const max = new Map<string, Map<string, RowVersion>>()
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
    if (values.compareVersions(current, version) < 0) {
      perTable.set(key, version)
    }
  }

  const candidates = new Map<string, Map<string, CandidateResult>>()
  /**
   * 表 → 真の id の正規形 → `Res`（表示上の主キーの値の組。`⊥` は null。設計書 §1.6）。
   * 子の外部キーを読み替えるのに使う。
   * 死んでいる id は載らない（載っていないのは `⊥` と同じに扱う）
   */
  const res = new Map<string, Map<string, SqlValue[] | null>>()
  const rows = new Map<string, Record<string, SqlValue>[]>()
  const dead = new Map<string, Set<string>>()
  /**
   * 削除されている id と、親が削除されているので置かない id（原則4・付則3）。
   * 表 → 真の id の正規形 → 大元の削除（`<表>:<id>`）。
   * 親が先に並んでいるので（`model.order`）、子を見るときには親のぶんが揃っている。
   */
  const gone = new Map<string, Map<string, string>>()

  for (const name of model.order) {
    const table = model.tables.get(name) as TableMeta
    const perTable = max.get(name) as Map<string, RowVersion>
    const tableCandidates = new Map<string, CandidateResult>()
    const tableRes = new Map<string, SqlValue[] | null>()
    const tableRows: Record<string, SqlValue>[] = []
    const tableDead = new Set<string>()
    const tableGone = new Map<string, string>()
    /** 判定用の DB に置いた行の「同一性の列の値」→ どの候補か */
    const placedByIdentity = new Map<string, PlacedRow>()

    // 2. 候補（設計書 §1.3）。死んだ id は `dead` として返す
    const living: RowVersion[] = []
    for (const [key, version] of perTable) {
      if (version.kind === 'row') living.push(version)
      else {
        tableDead.add(key)
        // 削除そのものが大元。子から見た原因はこの id になる
        tableGone.set(key, `${name}:${key}`)
      }
    }

    // 3〜4. 版の順序の強い順。すべて等しければ真の id の正規形の小さい順（設計書 §1.6）
    living.sort((a, b) => {
      const byVersion = values.compareVersions(b, a)
      if (byVersion !== 0) return byVersion
      return values.compareIdKeys(values.idKey(a.id), values.idKey(b.id))
    })

    const hidden: { key: string; display: Record<string, SqlValue> }[] = []

    for (const version of living) {
      const key = values.idKey(version.id)
      const shown = displayValues(values, model, table, version, res, gone)
      if (shown.kind === 'parentDeleted') {
        // 親が削除されている間は置かない（原則4・付則3）。版は残す
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'parentDeleted',
          display: { ...(version.content ?? {}) },
          reason: `親が削除されている（${shown.cause.table}:${shown.cause.key}）`,
          cause: shown.cause,
        })
        tableRes.set(key, null)
        // この行を親とする孫も、同じ大元の削除で置かない（連鎖）
        tableGone.set(key, `${shown.cause.table}:${shown.cause.key}`)
        continue
      }
      if (shown.kind === 'unplaceable') {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'unplaceable',
          display: { ...(version.content ?? {}) },
          reason:
            '外部キーが指す親の行がユーザーテーブルに入っていない（親の行がまだ届いていないか、親の行自体が制約で入らない）',
        })
        tableRes.set(key, null)
        continue
      }
      const display = shown.display
      // 主キーが NULL の候補は置かない行にする。`INTEGER PRIMARY KEY` に NULL を
      // 入れると SQLite が rowid を割り当ててしまい、**ライブラリが id を捏造する**
      // ことになる（目標 (c) に反する）
      if (
        table.primaryKey.some((column) => (display[column] ?? null) === null)
      ) {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'unplaceable',
          display,
          reason: '主キーが NULL',
        })
        tableRes.set(key, null)
        continue
      }
      const outcome = model.insertIntoJudge(table, display)
      if (outcome.outcome === 'unplaceable') {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'unplaceable',
          display,
          reason: outcome.reason,
        })
        tableRes.set(key, null)
        continue
      }
      // ここから先は、行に閉じた制約は通っている。使い捨ての DB へ1行だけ置いて、
      // 生成列の値・宣言された型への寄せ・索引の項を SQLite に計算させる
      model.placeOnProbe(table, display)
      if (outcome.outcome === 'placed') {
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'placed',
          display,
        })
        tableRows.push(model.probeRow(table))
        tableRes.set(
          key,
          table.primaryKey.map((column) => display[column] ?? null)
        )
        placedByIdentity.set(model.probeIdentity(table), {
          key,
          order: placedByIdentity.size,
        })
      } else {
        hidden.push({ key, display })
        tableCandidates.set(key, {
          table: name,
          key,
          placement: 'hidden',
          display,
          reason: outcome.reason,
        })
      }
    }

    // 5. 勝者（設計書 §1.5）—— 索引ごとに「その候補の表示値の組」で判定用の DB を引き、
    //    引けた置く行のうち §1.6 の順で最も強いもの
    for (const row of hidden) {
      const winner = findWinner(model, table, row.display, placedByIdentity)
      const entry = tableCandidates.get(row.key) as CandidateResult
      if (winner === null) {
        // かぶる相手が見つからない。設計書 §1.6 の表の「それ以外」に落とし、`Res` は ⊥
        tableRes.set(row.key, null)
        continue
      }
      entry.winner = winner
      tableRes.set(row.key, tableRes.get(winner) ?? null)
    }

    candidates.set(name, tableCandidates)
    res.set(name, tableRes)
    rows.set(name, tableRows)
    dead.set(name, tableDead)
    gone.set(name, tableGone)
  }

  return { candidates, rows, dead }
}

/**
 * かぶった候補の勝者（設計書 §1.5）。
 *
 * **エラーの種別では分岐しない。** 主キーと UNIQUE の両方に当たる候補では、SQLite は
 * `SQLITE_CONSTRAINT_UNIQUE` しか返さないので、種別で分岐すると主キーを占めている
 * 行とは別の行を勝者にしてしまう。当たりうる索引と主キーで**全部引き直し**、
 * 引けた置く行のうち §1.6 の順で最も強いものを勝者にする。
 * ただし**主キーで引けた行があればそちらを優先する** —— 1:1 の表では、
 * 表示上の主キーを占めている行こそが「その席に居る行」だからである。
 *
 * **部分索引では、索引の `WHERE` の述語も引く条件に加える**（穴9）——
 * 加えないと、その索引の対象ですらない行を勝者に選ぶ。
 *
 * @returns 勝者の真の id の正規形。引けなければ null
 */
function findWinner(
  model: SchemaModel,
  table: TableMeta,
  display: Record<string, SqlValue>,
  placedByIdentity: Map<string, PlacedRow>
): string | null {
  // 隠れた行を使い捨ての DB へ置き直す（索引の項と述語を SQLite に評価させる足場）
  model.placeOnProbe(table, display)
  let byPrimaryKey: PlacedRow | null = null
  let byAny: PlacedRow | null = null
  for (const index of table.uniqueIndexes) {
    const probed = model.probeIndexTerms(table, index)
    // 索引の項に NULL があると SQLite は一意を強制しない（NULL どうしは別物）。
    // 部分索引の述語を満たさない候補は、そもそもその索引に載らない
    if (probed === null) continue
    for (const identity of model.findByIndex(table, index, probed.terms)) {
      const placed = placedByIdentity.get(identity)
      if (placed === undefined) continue
      if (byAny === null || placed.order < byAny.order) byAny = placed
      if (
        index.origin === 'pk' &&
        (byPrimaryKey === null || placed.order < byPrimaryKey.order)
      ) {
        byPrimaryKey = placed
      }
    }
  }
  const best = byPrimaryKey ?? byAny
  return best === null ? null : best.key
}

/** {@link displayValues} の答え。 */
type DisplayOutcome =
  /** 置ける（表示値が決まった） */
  | { kind: 'values'; display: Record<string, SqlValue> }
  /** 置かない行 */
  | { kind: 'unplaceable' }
  /** 親が削除されているので置かない行（原則4）。`cause` は大元の削除 */
  | { kind: 'parentDeleted'; cause: { table: string; key: string } }

/**
 * 表示値（設計書 §1.4、原則4）。
 *
 * 外部キーの列は、同期する親を指していれば `Res_p` で読み替える。親が置かれていなければ
 * 宣言された `ON DELETE` に従う。主キーが親を指している（1:1 の）表では、主キーも
 * 読み替える —— `Res_p = ⊥` ならその行は置かない行になる。
 *
 * 置かない行のうち、**親が削除されているもの**を `parentDeleted` として分ける（付則3）。
 * 版は捨てない。親行が書き直されて削除の版に勝てば、次の作り直しで同じ版が置く行に戻る。
 * 分けるのは利用者へ知らせるためで、アプリの表の中身はどちらでも同じである。
 *
 * 外部キーは親の主キーを参照している（付則4。`setupSync` の前提 P14 が確かめる）。
 */
function displayValues(
  values: ValueOrdering,
  model: SchemaModel,
  table: TableMeta,
  version: RowVersion,
  res: Map<string, Map<string, SqlValue[] | null>>,
  gone: Map<string, Map<string, string>>
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
    const resolved = resolveParent(values, key, trueValues, res)
    if (resolved !== null) {
      key.columns.forEach((column, index) => {
        display[column] = resolved[index]
      })
      continue
    }
    // 親が置かれていないとき（設計書 §1.4 の下の表）
    const isPrimary =
      key.columns.length === table.primaryKey.length &&
      key.columns.every((column) => table.primaryKey.includes(column))
    // 親が削除されているなら、置かない行のうち `parentDeleted`（原則4）
    const cause = goneParent(values, key, trueValues, gone)
    const out = (): DisplayOutcome =>
      cause === null
        ? { kind: 'unplaceable' }
        : { kind: 'parentDeleted', cause }
    // `ON DELETE` の綴りを読むのは `rows/on-delete.ts` の1か所だけ（写しを増やさない）
    switch (missingParentAction(key.onDelete)) {
      case 'setNull': {
        if (isPrimary) return out() // 1:1 の主キーは NULL にできない
        if (key.columns.some((column) => table.notNull.has(column)))
          return out()
        for (const column of key.columns) display[column] = null
        break
      }
      case 'setDefault': {
        if (isPrimary) return out()
        const defaults = key.columns.map((column) =>
          literalDefault(model, table, column)
        )
        if (defaults.some((value) => value === undefined)) return out()
        const asValues = defaults as SqlValue[]
        // 既定値の指す親が置かれていなければ、置かない行
        if (resolveParent(values, key, asValues, res) === null) {
          return out()
        }
        key.columns.forEach((column, index) => {
          display[column] = asValues[index]
        })
        break
      }
      default:
        // 'drop'（CASCADE / RESTRICT / NO ACTION）
        return out()
    }
  }
  return { kind: 'values', display }
}

/**
 * 削除されている親（原則4・付則3）。親の `Max` が削除の版か、親自身が
 * 同じ理由で置かれていないか。どちらでもなければ `null`。
 *
 * `gone` は表 → 真の id の正規形 → **原因の表示**（`<表>:<id>` の形）で、
 * 親自身が親の削除で置かれていないときは、その大元の削除を指す。
 * 連鎖の根を答えるのは、利用者が「どの削除でこの行が入らないか」を1つ知れば
 * 足りるからである。
 */
function goneParent(
  values: ValueOrdering,
  key: ForeignKey,
  trueValues: SqlValue[],
  gone: Map<string, Map<string, string>>
): { table: string; key: string } | null {
  const parentKey = values.idKey(trueValues[0])
  const root = gone.get(key.parentTable)?.get(parentKey)
  if (root === undefined) return null
  const at = root.indexOf(':')
  return { table: root.slice(0, at), key: root.slice(at + 1) }
}

/**
 * 既定値が**定数の字面**なら、その値（設計書 §1.4 の `SET DEFAULT`）。
 *
 * 字面でなければ `undefined`（＝置かない行）。字面かどうかは自前で解釈せず、
 * 形を見てから一時 DB に評価させる。
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
 * 親の行の表示上の主キー（設計書 §1.4）。親が置かれていなければ `null`。
 *
 * 外部キーは親の主キーを参照している（付則4）ので、親の `Res_p` を引けば足りる。
 * 主キーは1列（前提 P11）なので、外部キーの列も1つである。
 */
function resolveParent(
  values: ValueOrdering,
  key: ForeignKey,
  trueValues: SqlValue[],
  res: Map<string, Map<string, SqlValue[] | null>>
): SqlValue[] | null {
  const resolved = res.get(key.parentTable)?.get(values.idKey(trueValues[0]))
  return resolved === undefined || resolved === null ? null : resolved
}

/* ------------------------------------------------------------------ *
 * 一時 DB とスキーマの読み取り
 * ------------------------------------------------------------------ */

/** 判定用の一時 DB（強い順に入れていく）と、候補1つを測る使い捨ての DB。 */
class SchemaModel {
  /** 強い順に候補を入れていく判定用の DB（設計書 §3.7.1） */
  readonly judge: Database.Database
  /** 候補1つを置いて、生成列・索引の項・部分索引の述語を評価する、毎回空にする DB */
  private readonly probe: Database.Database
  readonly tables: Map<string, TableMeta> = new Map()
  /** 外部キーの依存の順（親が先。設計書の前提 P2 より循環しない） */
  readonly order: string[]

  constructor(schema: RowsSchema, options: DeriveOptions) {
    this.judge = SchemaModel.open(schema)
    this.probe = SchemaModel.open(schema)
    for (const table of schema.tables) {
      this.tables.set(table.name, this.readMeta(table))
    }
    this.order = topologicalOrder(this.tables)
    // 作り直しで開く接続はすべて安全な整数で読む。既定では 2^53 を超える整数が
    // 潰れ、別の id や別の時刻が JS 上で同着になり、書き戻すと値が変わる。
    // **スキーマを読み終えてから**立てるのは、`PRAGMA` の戻り値（`pk`・`hidden`・
    // `key` など）まで `bigint` になると `=== 1` の判定が黙って外れるからである
    this.judge.defaultSafeIntegers(true)
    this.probe.defaultSafeIntegers(true)
    // 差し込みも最後（`PRAGMA max_page_count = 1` を先に当てると、スキーマの
    // 読み取りそのものが落ちて、検査したい場面に届かない）
    options.prepareJudgeDatabase?.(this.judge)
  }

  private static open(schema: RowsSchema): Database.Database {
    const db = new Database(':memory:')
    // 外部キーは §1.4 の表示値の規則でこちらが決める（SQLite には検査させない）
    db.pragma('foreign_keys = OFF')
    for (const table of schema.tables) {
      db.exec(table.ddl)
      for (const index of table.indexes ?? []) db.exec(index)
    }
    return db
  }

  private readMeta(table: RowsTable): TableMeta {
    const info = this.judge.pragma(
      `table_xinfo(${escapeIdentifier(table.name)})`
    ) as {
      name: string
      notnull: number
      dflt_value: string | null
      pk: number
      hidden: number
    }[]
    const primaryKey = primaryKeyColumns(this.judge, table.name).map(
      (column) => column.name
    )
    // hidden が 1 の列は `WITHOUT ROWID` の隠し列で `SELECT *` に出ない。
    // hidden が 2・3 は生成列で、版には載らない（設計書 §3.2）
    const selectColumns = info
      .filter((column) => column.hidden !== 1)
      .map((column) => column.name)
    return {
      name: table.name,
      selectColumns,
      storedColumns: info
        .filter((column) => column.hidden === 0)
        .map((column) => column.name),
      primaryKey,
      notNull: new Set(
        info.filter((column) => column.notnull === 1).map((c) => c.name)
      ),
      defaults: new Map(info.map((c) => [c.name, c.dflt_value])),
      foreignKeys: this.readForeignKeys(table.name),
      uniqueIndexes: readUniqueIndexes(this.judge, table.name),
      identityColumns: primaryKey.length > 0 ? primaryKey : selectColumns,
    }
  }

  private readForeignKeys(table: string): ForeignKey[] {
    const rows = this.judge.pragma(
      `foreign_key_list(${escapeIdentifier(table)})`
    ) as {
      id: number
      seq: number
      table: string
      from: string
      to: string | null
      on_delete: string
    }[]
    const grouped = new Map<number, typeof rows>()
    for (const row of rows) {
      const list = grouped.get(row.id) ?? []
      list.push(row)
      grouped.set(row.id, list)
    }
    return [...grouped.values()].map((entries) => {
      const sorted = [...entries].sort((a, b) => a.seq - b.seq)
      return {
        columns: sorted.map((row) => row.from),
        parentTable: sorted[0].table,
        onDelete: sorted[0].on_delete.toUpperCase(),
      }
    })
  }

  /**
   * 候補を判定用の DB へ入れてみる（設計書 §1.6 の「強い順に INSERT する」）。
   *
   * @returns 入ったら `placed`、かぶりで落ちたら `collision`、
   *   白紙のリストの制約で落ちたら `unplaceable`。それ以外のエラーは**投げ直す**
   */
  insertIntoJudge(
    table: TableMeta,
    display: Record<string, SqlValue>
  ):
    | { outcome: 'placed' }
    | { outcome: 'collision' | 'unplaceable'; reason: string } {
    try {
      insertStatement(this.judge, table).run(
        ...table.storedColumns.map((column) => display[column] ?? null)
      )
      return { outcome: 'placed' }
    } catch (error) {
      const code = (error as { code?: string }).code ?? ''
      const reason = String((error as Error).message)
      if (COLLISION_CODES.has(code)) return { outcome: 'collision', reason }
      if (!UNPLACEABLE_CODES.has(code)) {
        // 資源の不足（SQLITE_NOMEM / SQLITE_FULL など）を「その行は置けない」と
        // 読み替えると、表が丸ごと空になる。設計書 §1.4 のとおり中止する
        throw error
      }
      return { outcome: 'unplaceable', reason }
    }
  }

  /** 候補を使い捨ての DB へ1行だけ置く（SQLite に評価させるための足場）。 */
  placeOnProbe(table: TableMeta, display: Record<string, SqlValue>): void {
    this.probe.exec(`DELETE FROM ${escapeIdentifier(table.name)}`)
    insertStatement(this.probe, table).run(
      ...table.storedColumns.map((column) => display[column] ?? null)
    )
  }

  /** 使い捨ての DB に置いた候補を `SELECT *` の形で読む（生成列と型への寄せ込み）。 */
  probeRow(table: TableMeta): Record<string, SqlValue> {
    return this.probe
      .prepare(`SELECT * FROM ${escapeIdentifier(table.name)}`)
      .get() as Record<string, SqlValue>
  }

  /** 使い捨ての DB に置いた候補の「同一性の列」の値を、1本の文字列にする。 */
  probeIdentity(table: TableMeta): string {
    return identityOf(table, this.probeRow(table))
  }

  /**
   * 使い捨ての DB に置いた候補について、索引の項と部分索引の述語を評価する。
   *
   * @returns 項の値。項に NULL があるか、部分索引の述語を満たさなければ null
   *   （どちらの場合もその索引は一意を強制しないので、かぶりようがない）
   */
  probeIndexTerms(
    table: TableMeta,
    index: UniqueIndexDefinition
  ): { terms: SqlValue[] } | null {
    const selected = index.terms.map(
      (term, at) => `(${term.expression}) AS ${escapeIdentifier(`t${at}`)}`
    )
    if (index.predicate !== null) {
      selected.push(`(${index.predicate}) AS "p"`)
    }
    const row = this.probe
      .prepare(
        `SELECT ${selected.join(', ')} FROM ${escapeIdentifier(table.name)}`
      )
      .get() as Record<string, SqlValue> | undefined
    if (row === undefined) return null
    if (index.predicate !== null && !row['p']) return null
    const terms = index.terms.map((_, at) => row[`t${at}`] ?? null)
    if (terms.some((value) => value === null)) return null
    return { terms }
  }

  /**
   * 判定用の DB を、索引の項の値で引く（設計書 §1.5 の「勝者の引き方」）。
   *
   * @returns 引けた置く行の「同一性の列」の値
   */
  findByIndex(
    table: TableMeta,
    index: UniqueIndexDefinition,
    terms: SqlValue[]
  ): string[] {
    const conditions = index.terms.map(
      (term) =>
        `((${term.expression}) COLLATE ${escapeIdentifier(term.collation)}) IS ?`
    )
    // 部分索引の述語を条件に加える（設計書 §1.5 の穴9）。加えないと、その索引の
    // 対象ですらない行まで引いてしまい、かぶっていない行が勝者になる
    if (index.predicate !== null) conditions.push(`(${index.predicate})`)
    const rows = this.judge
      .prepare(
        `SELECT * FROM ${escapeIdentifier(table.name)}
         WHERE ${conditions.join(' AND ')}`
      )
      .all(...(terms as never[])) as Record<string, SqlValue>[]
    return rows.map((row) => identityOf(table, row))
  }

  close(): void {
    this.judge.close()
    this.probe.close()
  }
}

/** 行を「同一性の列」の値で表す文字列（判定用の DB の行と候補を突き合わせる鍵）。 */
function identityOf(table: TableMeta, row: Record<string, SqlValue>): string {
  return table.identityColumns
    .map((column) => {
      const value = row[column] ?? null
      const kind = Buffer.isBuffer(value) ? 'b' : typeof value
      const text = Buffer.isBuffer(value)
        ? value.toString('hex')
        : String(value)
      return `${kind}:${text}`
    })
    .join(' ')
}

const statementCache = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>()

function insertStatement(
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
  const columns = table.storedColumns.map(escapeIdentifier).join(', ')
  const holes = table.storedColumns.map(() => '?').join(', ')
  const statement = db.prepare(
    `INSERT INTO ${escapeIdentifier(table.name)} (${columns}) VALUES (${holes})`
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
      throw new Error(
        `同期する表の外部キーが循環している: ${name}。同期する表どうしの外部キーは循環させられない`
      )
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
