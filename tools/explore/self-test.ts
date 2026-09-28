/**
 * 削減手の前提を、**本物を動かして**確かめる（`--self-test N`）。
 *
 * 順序の畳み込みは、`src/` の振る舞いについての主張（「別々の端末への操作は可換」）の上に
 * 立っている。主張の根拠はコードを読んだ結果（tools/explore/reduction.ts）なので、
 * **`src/` が変われば崩れうる**（例: 操作が相手の DB を読む箇所が増える、トリガーが
 * 新しい場所へ壁時計を刻む）。崩れたまま畳むと、検査器は黙って反例を見逃す。
 * そこで検査の前に、範囲の中の列を N 本選んで主張どおりになっているかを実際に確かめる。
 *
 * 確かめること:
 *
 * 1. **再生の揺れ** —— 同じ列を2回再生して違う状態になった本数を数える（報告だけ。
 *    同期の中の2つの刻みが同じミリ秒に収まるかの揺れはライブラリそのものの性質で、
 *    削減手の前提の崩れではない）
 * 2. **可換性** —— 状態 s で、端末の違う2つの操作 x, y を x→y と y→x の順に当てると、
 *    同じ状態になる
 *
 * 端末の入れ替え（対称性）は確かめない。案A では健全でないので、畳み込みに使っていない
 * （tools/explore/reduction.ts の「畳まないもの」）。
 *
 * 列の選び方には擬似乱数を使うが、**種は固定**（毎回同じ列を調べる）。これは範囲を
 * 網羅する検査ではなく、削減手の前提が崩れていないかの抜き取り検査である。
 *
 * @module tools/explore/self-test
 */
import * as fs from 'fs'
import * as path from 'path'
import { ExploreConfig } from './config'
import { Transition, describeTransition, enumerateTransitions } from './ops'
import { failureWarning } from './probe'
import {
  TimeLabeler,
  collectTimes,
  hashString,
  normalizeOptionsFrom,
  readWorld,
  serializeState,
} from './state'
import {
  Library,
  applyTransition,
  buildTemplate,
  closeWorld,
  createWorld,
  loadLibrary,
} from './world'

/** 種を固定した擬似乱数（xorshift32）。 */
function makeRandom(seed: number): (limit: number) => number {
  let state = seed >>> 0 || 1
  return (limit: number): number => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state % limit
  }
}

export async function runSelfTest(
  config: ExploreConfig,
  samples: number,
  workDir: string,
  log: (line: string) => void
): Promise<boolean> {
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(workDir, 'tmp'), { recursive: true })
  // 取り込みの一時コピーをこの検査専用の場所へ（tools/explore-worker.ts の冒頭と同じ理由）
  process.env.TMPDIR = path.join(workDir, 'tmp')

  const lib: Library = loadLibrary(config.libDir)
  const labeler = new TimeLabeler(config)
  const template = path.join(workDir, 'template')
  const work = path.join(workDir, 'work')
  buildTemplate(lib, template, config)
  const transitions = enumerateTransitions(config)
  const ops = transitions
    .map((transition, index) => ({ transition, index }))
    .filter((entry) => entry.transition.kind === 'op')
  const others = transitions.filter((transition) => transition.kind !== 'op')
  const random = makeRandom(20260914)
  const failures: string[] = []

  const describe = (path_: Transition[]): string =>
    path_
      .map((t, i) => `    ${String(i + 1)}. ${describeTransition(t)}`)
      .join('\n')

  /**
   * 列を再生し、正規化して直列化した状態と、警告のうち判定に効くもの
   * （失敗の有無）をまとめた署名を返す。
   */
  const observe = async (path_: Transition[]): Promise<string> => {
    const world = createWorld(template, work, config)
    const warnings: string[][] = []
    try {
      for (const transition of path_) {
        warnings.push((await applyTransition(lib, world, transition)).warnings)
      }
      const raw = readWorld(world, config)
      const text = serializeState(
        raw,
        labeler.labels(collectTimes(raw)),
        normalizeOptionsFrom(config)
      )
      const warningSignature = warnings.map(
        (list) => failureWarning(list) !== null
      )
      return hashString(`${text}\n${JSON.stringify(warningSignature)}`)
    } finally {
      closeWorld(world)
    }
  }

  /**
   * 2つの列が「同じ結果になりうる」か。
   *
   * **1回ずつ比べて違ったら、そこで崩れと決めない。** 同期の中の2つの刻みが同じミリ秒に
   * 収まるかは実行ごとに揺れる（docs の「保証しないこと」）ので、揺れに当たっただけで
   * 「可換でない」と止めると、正しい削減手を誤って止める。違ったら再生し直し、
   * 両方の列で見えた結果に共通のものが1つでもあれば「同じ結果になりうる」とする。
   * 前提が本当に崩れている形（例: 時刻を壁時計のまま刻む）は、何度再生しても
   * 共通の結果が出ないので、ここで見逃すことはない（実測で確かめてある）。
   */
  const RETRIES = 4
  const canAgree = async (
    a: Transition[],
    b: Transition[]
  ): Promise<boolean> => {
    const seenA = new Set<string>()
    const seenB = new Set<string>()
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      seenA.add(await observe(a))
      seenB.add(await observe(b))
      if ([...seenA].some((signature) => seenB.has(signature))) return true
    }
    return false
  }

  let commuted = 0
  let jitters = 0
  for (let sample = 0; sample < samples; sample += 1) {
    // 遷移を一様に引くと、ほとんどが操作になって同期を含む列を引かない（同期は端末数ぶん
    // しか無い）。前提が崩れるのはたいてい同期の中なので、3回に1回は同期か tick を引く。
    // 長さも深さに縛らない（前提は深さによらない主張なので、長い列で調べてよい）
    const length = random(Math.max(4, config.depth)) + 1
    const prefix: Transition[] = Array.from({ length }, () =>
      random(3) === 0
        ? others[random(others.length)]
        : ops[random(ops.length)].transition
    )

    // 1. 再生の決定性。揺れは崩れではない（同期の中の刻み）ので数えて報告だけする
    const first = await observe(prefix)
    const second = await observe(prefix)
    if (first !== second) jitters += 1

    // 2. 可換性（端末の違う2つの操作）
    const x = ops[random(ops.length)].transition
    const candidates = ops.filter(
      (entry) =>
        entry.transition.kind === 'op' &&
        x.kind === 'op' &&
        entry.transition.client !== x.client
    )
    if (candidates.length > 0) {
      const y = candidates[random(candidates.length)].transition
      commuted += 1
      if (!(await canAgree([...prefix, x, y], [...prefix, y, x]))) {
        failures.push(
          `別々の端末への操作が可換でなかった（順序の畳み込みの前提が崩れている）:\n` +
            `${describe(prefix)}\n  のあとに\n    x. ${describeTransition(x)}\n    y. ${describeTransition(y)}`
        )
      }
    }
  }

  fs.rmSync(workDir, { recursive: true, force: true })
  log(
    `自己検査: 列 ${String(samples)} 本（可換性 ${String(commuted)}。` +
      `同じ列を2回再生して揺れた列 ${String(jitters)} 本 —— 同期の中の刻みの揺れで、崩れではない）`
  )
  if (failures.length === 0) {
    log('  削減手の前提は、調べた列ではすべて成り立った')
    return true
  }
  for (const failure of failures.slice(0, 5)) log(`  ✗ ${failure}`)
  log(`  前提が崩れた列: ${String(failures.length)} 本`)
  return false
}
