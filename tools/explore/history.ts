/**
 * 「発行した操作の履歴」と「見え方」—— 同期の挟み方によらず結果が1つに決まるかを見る道具。
 *
 * ## なぜ要るか
 *
 * 「1回の実行の中で全端末が同じ状態に落ち着くか」だけを見ても、**実行をまたいだ食い違い**は
 * 原理的に見えない。実証（本物のコード。書き込みは両方とも同じ3つ）:
 *
 * ```
 * ① 端末a: tags g1 を name='t1' で作る   (00:01)
 * ② 端末b: tags g2 を name='t1' で作る   (00:02)
 * ③ 端末b: g2 の name を 't2' に変える  (00:03)
 *
 * 実験1: ①② → 同期 → ③ → 同期   最終: 両端末とも g2=t2 だけ（g1 は消えた）
 * 実験2: ①②③ → 同期               最終: 両端末とも g1=t1, g2=t2
 * ```
 *
 * どちらの実験でも全端末は一致しているので、一致の検査では反例にならない。壊れているのは
 * 「**アプリの操作が同じなら、同期のタイミングが違っても結果が同じか**」である。
 *
 * ## 何を「同じ操作」とみなすか —— 検査器が発行した操作の列
 *
 * **端末ごとの、検査器が発行したアプリ操作の列**（同期・時計・`pruneChangelog` は含めない）が
 * 同じ実行どうしを比べる。**実装から読み取ったもの（`_changelog` や `_tombstone`）では比べない。**
 * 実装の判断（何を事実とみなすか）を比べる単位に借りると、実装の誤りが判定に流れ込み、
 * 誤った実装どうしが「同じ」と見なされて食い違いが隠れる。
 *
 * 端末ごとの列にするのは、別々の端末への操作の前後を入れ替えても列が変わらないようにするため。
 * 順序の畳み込み（tools/explore/reduction.ts）はその入れ替えで状態を畳むので、全体の並びで
 * 比べると、畳まれた側の並びの比較を落とす。
 *
 * `pruneChangelog` を含めないのは、それがアプリの書き込みではなく記録の掃除だからで、
 * 掃除の有無で見え方が変わるなら、それも「タイミングで結果が変わる」反例である。
 *
 * ### `--schedule-key ops+status`（アプリが受け取った結果も含める）
 *
 * 操作の列だけで比べると、**設計どおりでも結果が変わってよい組**が混ざる:
 *
 * - まだ届いていない行を消す操作は、何も消さない（アプリには「0行」と返る）
 * - 届いた行と UNIQUE がぶつかる挿入は失敗する（アプリには制約違反が返る）
 *
 * `ops+status` では、各操作の文が SQLite からアプリへ返した結果（変えた行数が0か、制約違反か）を
 * 列に含め、結果の違う実行どうしは比べない。これは**アプリ自身が受け取る結果**で、ライブラリの
 * 内部の表は読まない。ただし結果そのものはライブラリが残した行に左右されるので、ライブラリが
 * 誤って行を残して挿入を失敗させた形は比べ落とす。既定は `ops`（誤検出の可能性を受け入れて、
 * 実装の判断を一切借りない）。
 *
 * ## 比べない履歴（どちらも発行した操作だけから決める）
 *
 * - **同時刻で中身の違う upsert を含む**（設計書の前提 P1「同じ (表, id) に、同時刻で中身の違う
 *   行の版は無い」の破れ。順序を定めないので、どちらが残るかは書いた順・届いた順で変わってよい。
 *   実測: 同じ端末が g2 を同じ時刻で t1 → t2 と書き直すと、書いた順で残る方が変わる）。
 *   時刻は `julianday` で比べ、書式違いの同じ瞬間も同時刻に数える（比べない側へ倒す）
 * - **同じ端末が、同じ (表, id) へ、自分が前に発行した書き込みより古い時刻で書く**（設計書の
 *   不変条件 I5「アプリの書き込みは、同じキーの手元の `Max` より弱い版で上書きしない」はアプリ側への
 *   前提。実測: a が g1 を T1 で書いたあと T0 で書き直すと、a だけが書いた実行では T0 が残る）。
 *   他端末から届いた版より古い時刻で書く形は、発行した操作だけからは判定できないので除けない
 *
 * 子の表の操作が親を用意する `INSERT … ON CONFLICT(id) DO NOTHING` は、既に在れば何も書かない
 * 条件つきの書き込みなので、**アプリに「1行挿入した」と返ったときだけ**書き込みとして数える
 * （実測: b が `tag_profiles` の g2 を書いて親 `tags` の g2 を t2(T1) で作り、そのあと g2 を T0 で
 * 書き直すと I5 の破れになる。数えないと、この列を比べて誤検出した）。挿入したかどうかは
 * アプリ自身が受け取る結果で、ライブラリの内部の表は読まない。
 *
 * ## 見え方（最終状態）
 *
 * 全端末を不動点まで同期したときの、同期対象の表の中身（`updatedAt` は julianday）。
 * 全端末が一致していればそれ1つ。**膠着で端末ごとに違う場合は比べない**（その形は「全端末の
 * 一致」の検査が膠着の報告の有無で見る）。
 *
 * ## 参照実装との突き合わせ（拡張の口）
 *
 * 「操作の履歴 → 見え方」を素直に計算する参照実装と、本物の結果を突き合わせる。
 * {@link Oracle} を {@link ORACLES} に登録し、`--oracle 名前` で選べば、ワーカーが各状態で
 * 本物の見え方と比べる。いまは `rows-d1`（案A の意味の定義。
 * tools/explore/oracles/rows-d1.ts）が登録してある。
 *
 * @module tools/explore/history
 */
import Database from 'better-sqlite3'
import { Op, describeOpForHistory } from './ops'
import { rowsD1Oracle } from './oracles/from-history'
import { hashString } from './state'

/** 発行した操作1つと、アプリがそれを当てたときに SQLite から受け取った結果。 */
export type IssuedOp = { op: Op; status: string }

/** 端末ごとの、発行した操作の列（添字は端末の番号）。 */
export type History = IssuedOp[][]

export type ScheduleKeyMode = 'ops' | 'ops+status'

/** アプリの書き込みか（`pruneChangelog` は記録の掃除なので履歴に含めない）。 */
export function isAppWrite(op: Op): boolean {
  return op.kind !== 'pruneChangelog'
}

/** 履歴の鍵。端末の番号の順に直列化してハッシュにする。 */
export function historyKey(history: History, mode: ScheduleKeyMode): string {
  const arranged = history.map((issued) =>
    issued.map((entry) =>
      mode === 'ops'
        ? describeOpForHistory(entry.op)
        : [describeOpForHistory(entry.op), entry.status]
    )
  )
  return hashString(JSON.stringify(arranged))
}

let julianStatement: Database.Statement | null = null

/** SQLite の `julianday`（ライブラリが時刻を比べるのと同じ解釈）。読めなければ null。 */
function julianOf(value: string): number | null {
  julianStatement ??= new Database(':memory:').prepare(
    `SELECT julianday(?) AS j`
  )
  return (julianStatement.get(value) as { j: number | null }).j
}

/**
 * 操作が書いた行の版（表, id, 時刻, 中身）。親を用意する条件つきの書き込みは、アプリに
 * 「挿入した」と返ったとき（結果に `parent:ok`）だけ含める。
 */
function versionsWritten({
  op,
  status,
}: IssuedOp): { table: string; id: string; at: string; content: string }[] {
  const parent =
    (op.kind === 'upsertTagProfile' || op.kind === 'upsertTagNote') &&
    status.split(',').includes('parent:ok')
      ? [{ table: 'tags', id: op.tagId, at: op.at, content: op.tagName }]
      : []
  return [...parent, ...ownVersions(op)]
}

function ownVersions(
  op: Op
): { table: string; id: string; at: string; content: string }[] {
  switch (op.kind) {
    case 'upsertTag':
      return [{ table: 'tags', id: op.id, at: op.at, content: op.name }]
    case 'upsertTagProfile':
      return [
        { table: 'tag_profiles', id: op.tagId, at: op.at, content: op.memo },
      ]
    case 'upsertTagNote':
      return [
        {
          table: 'tag_notes',
          id: op.id,
          at: op.at,
          content: JSON.stringify([op.tagId, op.body]),
        },
      ]
    case 'upsertUser':
      return [{ table: 'users', id: op.id, at: op.at, content: op.name }]
    case 'upsertDecision':
      return [
        {
          table: 'decisions',
          id: op.id,
          at: op.at,
          content: JSON.stringify([op.cellKey, op.value]),
        },
      ]
    case 'deleteRecreate':
      // 作り直した版は、書いた時刻をそのまま名乗る（削除の版の時刻は実行した時刻と手元の Max の
      // 大きい方なので、発行した操作だけからは決められない。参照実装の側で候補を全部試す）
      return [
        {
          table: op.table,
          id: op.id,
          at: op.at,
          content: op.value,
        },
      ]
    case 'upsertAccount':
      return [
        {
          table: 'accounts',
          id: op.id,
          at: op.at,
          content: JSON.stringify([op.username, op.email]),
        },
      ]
    default:
      return []
  }
}

/**
 * 見え方を突き合わせてよい履歴か（モジュール冒頭の「比べない履歴」）。
 * 発行した操作だけから決め、実装の状態は読まない。
 */
export function isComparableHistory(history: History): boolean {
  // 時刻列を変えない UPDATE（設計書 §8.2 の新しい操作）は、版に載る時刻が「そのとき行に
  // 入っていた値」なので、同期がどこで挟まったかで変わる。発行した操作だけからは決められない
  for (const issued of history) {
    for (const entry of issued) {
      if (entry.op.kind === 'updateKeepTime') return false
    }
  }
  // P1: 同じ (表, id, 瞬間) に中身の違う版
  const byMoment = new Map<string, string>()
  for (const issued of history) {
    for (const entry of issued) {
      for (const version of versionsWritten(entry)) {
        const j = julianOf(version.at)
        const moment = `${version.table} ${version.id} ${j === null ? `raw:${version.at}` : String(j)}`
        // 中身には時刻の字面も含める（同じ瞬間の書式違いは、同じ版とは言えない）
        const content = `${version.content} ${version.at}`
        const seen = byMoment.get(moment)
        if (seen !== undefined && seen !== content) return false
        byMoment.set(moment, content)
      }
    }
  }
  // I5（自分の書き込みの範囲）: 同じ端末が同じ (表, id) へ、前に発行した版より古い時刻で書く
  for (const issued of history) {
    const newest = new Map<string, number>()
    for (const entry of issued) {
      for (const version of versionsWritten(entry)) {
        const key = `${version.table} ${version.id}`
        const j = julianOf(version.at)
        if (j === null) continue
        const previous = newest.get(key)
        if (previous !== undefined && j < previous) return false
        newest.set(key, Math.max(previous ?? j, j))
      }
    }
  }
  return true
}

/**
 * 見え方の表現。全端末が一致していれば、その中身を行のキー順に並べた JSON。
 * 一致していなければ null（比べない）。
 */
export function viewOf(
  snapshots: Map<string, Record<string, unknown>>[]
): string | null {
  const texts = snapshots.map((snapshot) =>
    JSON.stringify(
      [...snapshot.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  )
  return texts.every((text) => text === texts[0]) ? texts[0] : null
}

/**
 * 状態ごとの、不動点での見え方の記録。
 *
 * - `view`: どの開始端末から回しても同じ見え方（膠着で端末ごとに違えば null）
 * - `rotation`: 開始端末によって見え方が違った。**状態の性質として記録するだけで、ここでは反例に
 *   しない。** 状態の検査は、違う操作の列から同じ状態へ来た節で使い回されるので、比べてよい履歴の
 *   節がその状態に来たときにだけ、親が反例にする（比べない履歴の節が先に来ても見落とさない）
 */
export type ViewInfo =
  | { kind: 'view'; view: string | null }
  | { kind: 'rotation'; starts: [number, number]; views: [string, string] }

/**
 * 参照実装: 発行した操作の履歴から、期待する見え方（{@link viewOf} と同じ形の JSON）を計算する。
 * 決められない（範囲外の形など）ときは null を返せば、その状態では比べない。
 */
export type Oracle = {
  name: string
  description: string
  expectedView: (history: History) => string | null
}

/**
 * 登録済みの参照実装。
 *
 * - `rows-d1`: 案A（docs/rows-table-design.md §1・§2）の意味の定義どおりに計算した見え方
 *   （tools/explore/oracles/rows-d1.ts）。組み立ての限界は
 *   tools/explore/oracles/from-history.ts の冒頭にある
 */
export const ORACLES: Record<string, Oracle> = { 'rows-d1': rowsD1Oracle }
