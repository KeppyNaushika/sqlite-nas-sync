/**
 * 行の版の順序（設計書 `docs/rows-table-design.md` §1.2）。
 *
 * 案A の中心にある物差しを、ここ1か所に置く。
 *
 * | 何 | どこ |
 * | --- | --- |
 * | 時刻の値の種類による順序（NULL ＜ 数値 ＜ ISO でない文字列 ＜ ISO の文字列 ＜ BLOB） | {@link ValueOrdering.compareTs} |
 * | 版の順序 `≺`（`(_sns_ts, L, iid)` の辞書順） | {@link ValueOrdering.compareVersions} |
 * | 順序用の時刻の引き上げ（§1.2.1 の `NEWTS`） | {@link ValueOrdering.raiseTs} |
 * | 真の id の正規形（§1.11） | {@link ValueOrdering.idKey} |
 *
 * **判定は SQLite にさせる。** 値の種類（`typeof`）・`julianday`・`CAST(… AS TEXT)` を
 * JS で真似ると必ずずれるので、内部に `:memory:` の DB を1つ持って尋ねる。
 * 群2・群4 の比較を `COLLATE BINARY` 相当（UTF-8 のバイト列）で行うのも同じ理由で、
 * 素の比較に任せると **`COLLATE NOCASE` で宣言された時刻列**では `'ABC'` と `'abc'` が
 * 同着になり、値が違うのに順序が付かない（設計書 §1.2.3 の穴4）。
 *
 * @module rows/versions
 * @internal
 */
import Database from 'better-sqlite3'

/** SQLite が持てる値。 */
export type SqlValue = null | number | bigint | string | Buffer

/**
 * 時刻の値の種類の群（設計書 §1.2.3）。群は 0 ＜ 1 ＜ 2 ＜ 3 ＜ 4 の順に強い。
 *
 * | 群 | 条件 | 群の中の比べ方 |
 * | --- | --- | --- |
 * | 0 | `typeof(x) = 'null'` | 同着 |
 * | 1 | `integer` / `real` | 数値としてそのまま比べる（`CAST` は挟まない） |
 * | 2 | `text` で ISO 8601 の字形でない | `COLLATE BINARY`（UTF-8 のバイト列） |
 * | 3 | `text` で ISO 8601 の字形 | `julianday(x)` の値 |
 * | 4 | `blob` | `COLLATE BINARY` |
 */
export const TIME_GROUP = {
  /** NULL */
  null: 0,
  /** 整数・実数 */
  number: 1,
  /** ISO 8601 の字形でない文字列 */
  text: 2,
  /** ISO 8601 の字形の文字列 */
  isoText: 3,
  /** BLOB */
  blob: 4,
} as const

/** 版（設計書 §1.2 の `W` / `D`）。 */
export interface RowVersion {
  /** 表の名前 */
  table: string
  /** 真の id（主キーが1列である前提。設計書 §1.2 の `k`） */
  id: SqlValue
  /** 行の版か削除の版か */
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

/**
 * ISO 8601 の字形かどうかを見る `GLOB`（設計書 §1.2.3 の軽微15）。
 *
 * **`julianday` が値を返すかどうかでは決めない。** `julianday` は `'now'`・`'12:00'`・
 * `'123'`・`'2460676.5'` も受け取るので、返るかどうかだけで群3 に入れると、
 * **評価するたびに変わる値**や時刻でない値が「ISO の文字列」として最強の群に入ってしまう。
 * 字形を満たし、なおかつ `julianday` が値を返すものだけを群3 にする。
 *
 * 通る/通らないの境目のうち、意外なもの:
 *
 * - `'2026-02-30'`・`'2026-04-31'` は**群3 に入る**（`julianday` が翌月として読む）。
 *   利用者の期待とは違いうるが、**決定的**なので順序としては差し支えない
 * - `'2026-01-01T24:00:00'` も群3（翌日として読まれる）
 * - `'2026-01-01 '`（末尾に空白）は字形に合わないので群2
 * - `'2026-13-01'` は字形に合うが `julianday` が NULL なので群2
 */
export const ISO_SHAPE_GLOBS = [
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9].*',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]*Z',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]*[+-][0-9][0-9]:[0-9][0-9]',
]

/** 1つの値について SQLite に尋ねた結果。 */
interface ValueFacts {
  /** {@link TIME_GROUP} の値 */
  group: number
  /** `julianday(x)`（読めなければ null） */
  julian: number | null
  /** `CAST(x AS TEXT)`（設計書 §1.11 の正規形） */
  text: string | null
}

/**
 * 版の順序を答える道具。
 *
 * 内部に `:memory:` の DB を1つ持つ。作った側が {@link close} を呼ぶこと
 * （呼び忘れても GC で閉じるが、数が増えると開いたままの DB が溜まる）。
 * @internal
 */
export class ValueOrdering {
  private readonly db = new Database(':memory:')

  /**
   * 値を1回だけ束縛して、群・`julianday`・`CAST(… AS TEXT)` をまとめて尋ねる。
   *
   * `?1` の形は better-sqlite3 が受け取らないので、CTE で1回だけ渡している。
   *
   * この文は `defaultSafeIntegers(true)` を立てる**前**に用意する。あとで立てても
   * 用意済みの文の設定は変わらないので、`group` は素の数値のまま返る（それでも
   * 取り違えないよう、読むときに `Number` を通してある）。
   */
  private readonly facts = this.db.prepare(
    `WITH v(x) AS (VALUES (?))
     SELECT CASE typeof(x)
              WHEN 'null'    THEN ${TIME_GROUP.null}
              WHEN 'integer' THEN ${TIME_GROUP.number}
              WHEN 'real'    THEN ${TIME_GROUP.number}
              WHEN 'blob'    THEN ${TIME_GROUP.blob}
              ELSE CASE
                WHEN julianday(x) IS NOT NULL AND (
                  ${ISO_SHAPE_GLOBS.map((glob) => `x GLOB '${glob}'`).join(
                    '\n                  OR '
                  )}
                ) THEN ${TIME_GROUP.isoText}
                ELSE ${TIME_GROUP.text}
              END
            END AS "group",
            julianday(x) AS julian,
            CAST(x AS TEXT) AS text
     FROM v`
  )

  constructor() {
    // 作り直しで開く接続はすべて安全な整数で読む。既定では 2^53 を超える整数が
    // 潰れ、別の id や別の時刻が JS 上で同着になり、書き戻すと値が変わる
    this.db.defaultSafeIntegers(true)
  }

  /** 値の種類の群（{@link TIME_GROUP}）。設計書 §1.2.3。 */
  timeGroup(value: SqlValue): number {
    return this.describe(value).group
  }

  /** `julianday(x)`。読めなければ null（見え方の JSON で時刻列に当てる）。 */
  julian(value: SqlValue): number | null {
    return this.describe(value).julian
  }

  /**
   * 順序用の時刻の比較（設計書 §1.2.3）。
   *
   * 負なら `a` が弱い。群が違えば群の順、同じ群なら群ごとの比べ方による。
   */
  compareTs(a: SqlValue, b: SqlValue): number {
    const left = this.describe(a)
    const right = this.describe(b)
    if (left.group !== right.group) return left.group < right.group ? -1 : 1
    switch (left.group) {
      case TIME_GROUP.null:
        // NULL どうしは同着（SQLite の NULL と違い、順序の上では区別しない）
        return 0
      case TIME_GROUP.number:
        // 数値としてそのまま比べる。`CAST` を挟むと、整数と実数のあいだで
        // 桁が落ちたり字面へ化けたりする（設計書 §1.2.3 の軽微19）
        return compareNumeric(a, b)
      case TIME_GROUP.isoText:
        return compareNumbers(left.julian as number, right.julian as number)
      default:
        // 群2（読めない文字列）と群4（BLOB）は `COLLATE BINARY` 相当のバイト比較。
        // ここを素の比較に任せると、`COLLATE NOCASE` の列では 'ABC' と 'abc' が
        // 同着になり、値が違うのに前後が付かない（設計書 §1.2.3 の穴4）
        return Buffer.compare(toBytes(a), toBytes(b))
    }
  }

  /**
   * 順序用の時刻の引き上げ（設計書 §1.2.1・§3.3 の `NEWTS`）。
   *
   * ```
   * _sns_ts := 大きい方( アプリが書いた新しい値 , 手元の _sns_rows_* の _sns_ts , 手元の _tombstone の _sns_ts )
   * ```
   *
   * 手元に無いものは NULL（群0 なので最小）を渡す。3つの素直な最大であって、
   * `MAX()` ではない —— SQLite の `MAX()` は値の種類の順序を §1.2.3 のとおりには扱わない。
   */
  raiseTs(
    newTs: SqlValue,
    rowsTs: SqlValue = null,
    tombstoneTs: SqlValue = null
  ): SqlValue {
    const strongest = this.compareTs(rowsTs, newTs) > 0 ? rowsTs : newTs
    return this.compareTs(tombstoneTs, strongest) > 0 ? tombstoneTs : strongest
  }

  /**
   * 版の順序 `≺`（設計書 §1.2.5）。
   *
   * `( _sns_ts, L, iid )` の辞書順。すべて等しければ 種類（行の版 ＜ 削除の版）。
   * 負なら `a` が弱い。
   *
   * `iid` の比較は `COLLATE BINARY`（UTF-8 のバイト列）で行う。JS の `<` は
   * UTF-16 の符号単位の順で、SQLite の既定の照合順序とは並びが違う。
   */
  compareVersions(a: RowVersion, b: RowVersion): number {
    const byTs = this.compareTs(a.ts, b.ts)
    if (byTs !== 0) return byTs
    if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1
    const byInstance = Buffer.compare(
      Buffer.from(a.instance, 'utf8'),
      Buffer.from(b.instance, 'utf8')
    )
    if (byInstance !== 0) return byInstance
    const rank = (version: RowVersion): number =>
      version.kind === 'row' ? 0 : 1
    return compareNumbers(rank(a), rank(b))
  }

  /**
   * 真の id の正規形（設計書 §1.11）。
   *
   * `CAST(x AS TEXT)` と同じ形にしてから UTF-8 のバイト列で比べられるよう、
   * 文字列にして返す。BLOB は SQLite の `CAST` と同じく中身をそのまま文字として読む。
   *
   * **JS の `number` は、整数でも SQLite には REAL として渡る**（better-sqlite3 の
   * 束縛の決まり）。したがって `idKey(5)` は `'5.0'`、`idKey(5n)` は `'5'` になる。
   * 整数の id を扱うときは、`defaultSafeIntegers(true)` の接続から読んだ `bigint` を
   * そのまま渡すこと —— JS の数へ落としてから渡すと、`_tombstone.recordId`（TEXT の
   * `'5'`）と突き合わないまま「別の id」として通る。
   */
  idKey(value: SqlValue): string {
    if (Buffer.isBuffer(value)) return value.toString('utf8')
    return String(this.describe(value).text)
  }

  /** 真の id の正規形どうしの比較（UTF-8 のバイト列。設計書 §1.11）。 */
  compareIdKeys(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  }

  close(): void {
    this.db.close()
  }

  private describe(value: SqlValue): ValueFacts {
    const row = this.facts.get(value as never) as ValueFacts
    return { ...row, group: Number(row.group) }
  }
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 群1（整数・実数）の比較。
 *
 * `defaultSafeIntegers(true)` の接続から読んだ整数は `bigint`、アプリが JS で
 * 書いた整数は `number` になるので、**同じ値が2つの型で現れる**。どちらも整数の
 * ときは `bigint` へ寄せて比べる（`Number` へ寄せると 2^53 を超えたところで
 * 別々の時刻が同着になる）。実数が混ざるときだけ `number` で比べる。
 */
function compareNumeric(a: SqlValue, b: SqlValue): number {
  const asBigInt = (value: SqlValue): bigint | null => {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isInteger(value)) {
      return BigInt(value)
    }
    return null
  }
  const left = asBigInt(a)
  const right = asBigInt(b)
  if (left !== null && right !== null) {
    return left < right ? -1 : left > right ? 1 : 0
  }
  return compareNumbers(Number(a), Number(b))
}

function toBytes(value: SqlValue): Buffer {
  if (Buffer.isBuffer(value)) return value
  return Buffer.from(String(value), 'utf8')
}
