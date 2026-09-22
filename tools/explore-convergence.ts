/**
 * 有界網羅検査器（親プロセス）。
 *
 * ## 何のための道具か
 *
 * `__tests__/convergence-properties.test.ts` は**乱数**の操作列で収束を確かめる。
 * 不具合を見つける網としては優秀だが、「直った」の判定には向かない。乱数は「ある」は
 * 示せても「無い」は示せない（失敗率3%の族に「10回連続通過」は偶然で約73%起こり、
 * 実際に誤った「直った」報告が3回続いた）。
 *
 * この道具は、**範囲を有限に区切って、その中を乱数なしで漏れなく試す**。
 * 反例が無ければ、範囲・展開した状態数・遷移数を出して「この範囲には反例が無い」を
 * 確率ではなく事実として言う。範囲の外については何も言わない。
 *
 * 使い方は docs/exhaustive-check.md。
 *
 * ## 並列化と重複排除の置き場所
 *
 * 探索は**層ごとの幅優先**で、深さ d の節を全ワーカーで分けて展開し、深さ d+1 の子を
 * 親が集める。**訪れた状態の集合は親が1つだけ持つ**（正本）。理由:
 *
 * - 状態数が**並列度によらず同じ**になる。ワーカーごとに持つと、違うワーカーへ
 *   割り当てられた同じ状態を二度数え、「並列度を上げたら状態数が増えた」になる
 *   （「この範囲を見た」の根拠として出す数が実行ごとに揺れては困る）
 * - 最初に見つかる反例が**本当に最短**になる（層を跨いで先へ潜るワーカーが居ない）
 *
 * ただし状態1つの検査は同期を何回も回すので、「親に聞いてから検査する」往復を
 * 状態ごとにやると親が詰まる。そこで親は、ワーカーから子が返ってくるたびに
 * **受け入れた状態と、そのワーカーが覚えた検査の結果を、他の全ワーカーへすぐ配る**。
 * ワーカーは手元の写しで先に捨て、覚えた結果で検査を打ち切る。層の終わりまで待って
 * 配る形では、同じ層で同じ状態を何度も検査し、並列度を2にしても検査の同期が1.5倍に
 * 増えて時間がほとんど縮まなかった（実測）。途中で配っても、配られるのは同じ層の子
 * （同じ深さ）なので畳み方は健全。それでも行き違いで二重に検査する分は残るが、
 * 親が畳むので数も答えも変わらない。
 *
 * 節の少ない層（根の層は1節）では、節をまるごと1つのワーカーへ渡すと他が遊ぶので、
 * 1つの節の遷移を範囲に分けて配る。
 *
 * @module tools/explore-convergence
 */
import { ChildProcess, fork } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {
  ExploreConfig,
  describeConfig,
  describeReductions,
  parseArgs,
  usage,
} from './explore/config'
import { MUTANTS, buildMutant, findMutant } from './explore/mutants'
import { runNormalizeUnitTests } from './explore/normalize'
import { runJudgmentUnitTests } from './explore/judgments'
import { runRowsD1Tests } from './explore/oracles/rows-d1-tests'
import { runRebuildScenarios } from './explore/rebuild-scenarios'
import { loadLibrary } from './explore/world'
import {
  clientName,
  describeTransition,
  enumerateTransitions,
} from './explore/ops'
import { ViewInfo, historyKey } from './explore/history'
import { runSelfTest } from './explore/self-test'
import {
  ExpandUnit,
  FrontierNode,
  FromWorker,
  SeenEntry,
  ToWorker,
  Violation,
  WorkerStats,
} from './explore/protocol'
import { dominates } from './explore/reduction'

/** リポジトリの根（コンパイル先は node_modules/.cache/explore/tools/）。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

function out(text: string): void {
  process.stdout.write(text)
}

function freeBytes(dir: string): number {
  const stat = fs.statfsSync(dir)
  return stat.bavail * stat.bsize
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 90) return `${seconds.toFixed(1)}秒`
  return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`
}

type Worker = {
  index: number
  child: ChildProcess
  busy: boolean
  /** いま渡している仕事（展開し終えた節を数えるのに使う） */
  unit: ExpandUnit | null
  stats: WorkerStats
}

type LayerRecord = {
  depth: number
  frontier: number
  /** 実際に展開し終えた節の数（反例で途中で止めた層では frontier より少ない） */
  expanded: number
  newStates: number
  newNodes: number
  seconds: number
}

/**
 * 正規化の関数の単体テスト（tools/explore/normalize.ts）。
 *
 * **探索の前に必ず走らせる。** 正規化が壊れていると、畳みすぎた探索が黙って「反例なし」と
 * 嘘をつく。走らせる費用は1ミリ秒に満たない。
 *
 * @returns 全部通ったか
 */
function checkNormalizeUnits(): boolean {
  const suites: [string, () => string[]][] = [
    ['正規化（tools/explore/normalize.ts）', runNormalizeUnitTests],
    [
      '参照実装 rows-d1（tools/explore/oracles/rows-d1-tests.ts）',
      runRowsD1Tests,
    ],
    ['判定5〜13（tools/explore/judgments.ts）', runJudgmentUnitTests],
  ]
  let ok = true
  for (const [name, run] of suites) {
    const failures = run()
    if (failures.length === 0) continue
    ok = false
    out(
      `${name}の単体テストが通らない:\n${failures
        .map((line) => `  ${line}`)
        .join('\n')}\n`
    )
  }
  return ok
}

/**
 * 判定20・21（tools/explore/rebuild-scenarios.ts）を、**駆動するライブラリ**に当てる。
 *
 * 探索の中では踏めない筋書き（ロックの取り合い・計算と適用のあいだの書き込み）なので、
 * 探索を始める前に1回だけ直に踏む。壊した版を駆動するときは、その版に当てる。
 */
function checkRebuildScenarios(libDir: string): boolean {
  const failures = runRebuildScenarios(loadLibrary(libDir))
  if (failures.length === 0) return true
  out(
    `判定20・21（tools/explore/rebuild-scenarios.ts）が通らない:\n${failures
      .map((line) => `  ${line}`)
      .join('\n')}\n`
  )
  return false
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'unit-tests') {
    if (!checkNormalizeUnits()) return 2
    if (!checkRebuildScenarios(path.resolve(__dirname, '..', 'src'))) return 2
    out(
      '単体テスト（正規化・参照実装 rows-d1・判定5〜13・判定20・21）: 全部通った\n'
    )
    return 0
  }
  if (!checkNormalizeUnits()) return 2
  if (parsed === 'help') {
    out(usage())
    return 0
  }
  if (parsed === 'list-mutants') {
    for (const mutant of MUTANTS) {
      out(
        `${mutant.name}${mutant.pending === undefined ? '' : '（いまは当てられない）'}\n` +
          `  ${mutant.description}\n` +
          (mutant.pending === undefined
            ? `  目安: --mutant ${mutant.name} ${mutant.suggestedArgs}\n\n`
            : `  当てられない理由: ${mutant.pending}\n\n`)
      )
    }
    return 0
  }
  const config: ExploreConfig = parsed

  if (config.mutant !== null) {
    const mutant = findMutant(config.mutant)
    out(
      `既知の不具合を戻した版を作っている: ${mutant.name}\n  ${mutant.description}\n`
    )
    config.libDir = buildMutant(
      mutant,
      REPO_ROOT,
      path.join(REPO_ROOT, 'node_modules', '.cache', 'explore-mutants')
    )
  }

  if (!checkRebuildScenarios(config.libDir)) return 2

  const transitions = enumerateTransitions(config)
  out(
    [
      '有界網羅検査',
      `  範囲: ${describeConfig(config)}`,
      `  削減手: ${describeReductions(config)}`,
      `  遷移の種類: ${String(transitions.length)}（1つの状態から出る辺の数）`,
      `  ワーカー: ${String(config.workers)}（作業ディレクトリ ${config.workRoot}）`,
      `  駆動するライブラリ: ${config.libDir}`,
      '',
    ].join('\n')
  )

  fs.rmSync(config.workRoot, { recursive: true, force: true })
  fs.mkdirSync(config.workRoot, { recursive: true })
  // 空きの下限（探索は大量のDBを作っては捨てる。前に消し損ねで60GB溜まったことがある）
  const minFreeBytes = config.minFreeMb * 1024 ** 2
  if (freeBytes(config.workRoot) < minFreeBytes) {
    throw new Error(
      `作業ディレクトリの場所の空きが ${String(config.minFreeMb)}MB を割っているので始めない`
    )
  }

  if (config.selfTest > 0) {
    // 削減手の前提が崩れていれば、畳んだ探索の「反例なし」は信用できないので探索しない
    const ok = await runSelfTest(
      config,
      config.selfTest,
      path.join(config.workRoot, 'self-test'),
      (line) => out(`${line}\n`)
    )
    if (!ok) {
      out(
        '削減手の前提が崩れているので探索しない（--no-por / --no-symmetry で外せば探索はできる）\n'
      )
      fs.rmSync(config.workRoot, { recursive: true, force: true })
      return 2
    }
    out('\n')
  }

  const startedAt = Date.now()
  const workers: Worker[] = []
  const violations: Violation[] = []
  const errors: string[] = []
  let parentDuplicates = 0
  const mismatchExamples: number[][] = []

  // 重複排除の正本: (正準な状態の鍵 | 事実の集合の鍵) → 訪れた集合（互いに包み合わないものだけ）
  const visited = new Map<string, number[]>()
  /** 調べた（互いに異なる）状態。事実の集合が違っても状態が同じなら1つと数える */
  const stateSet = new Set<string>()
  let nodeCount = 0
  /** 状態の鍵 → 不動点での見え方の記録（history.ts の ViewInfo） */
  const views = new Map<string, ViewInfo>()
  /**
   * 操作の列の鍵 → 最初に見つけた見え方とその列。同じ操作の列で違う見え方が出たら、
   * それが「同期の挟み方で見え方が変わる」反例（tools/explore/history.ts）
   */
  const historyIndex = new Map<string, { view: string; path: number[] }>()
  /**
   * 挟み方の食い違いは2種類に分けて数える。
   *
   * - **強い**: アプリが受け取った結果（変えた行数・制約違反）まで同じ実行どうしで、見え方が違う
   * - **弱い**: 発行した操作の列は同じだが、アプリが受け取った結果が違う（まだ届いていない行の削除が
   *   0行だった、届いた行と UNIQUE がぶつかって挿入が失敗した、など）。設計上も結果が変わってよい形を
   *   含む（history.ts）
   *
   * **どちらも違反にしない**（docs/rows-table-design.md §8.1 第11版）。案A では `_sns_ts` の
   * 引き上げ（§1.2.1）があるので、「同じ操作の集まり ⇒ 同じ見え方」（強）は**成り立たない**:
   * 他端末の版を取り込んだあとに、より古い時刻でその行を書くと、引き上げのぶんだけ強い版になる
   * （取り込んでいなければ弱い版のまま）。したがってこの検査は**件数の記録**として扱い、
   * 代表例を1つだけ「（強）が破れた形の観察」として出す（§6.5-17、§9.25）。探索は止めない。
   */
  let strongConflicts = 0
  let weakConflicts = 0
  /** 結果つきの鍵 → 最初に見つけた見え方とその列 */
  const statusIndex = new Map<string, { view: string; path: number[] }>()
  let weakExample: {
    runs: { path: number[]; start: number }[]
    length: number
    summary: string
  } | null = null as {
    runs: { path: number[]; start: number }[]
    length: number
    summary: string
  } | null
  /** 同時刻で中身の違う版を含むので突き合わせなかった節の数 */
  let skippedIncomparable = 0
  const visit = (entry: SeenEntry): boolean => {
    const masks = visited.get(entry.key)
    if (masks === undefined) {
      visited.set(entry.key, [entry.mask])
      nodeCount += 1
      return true
    }
    if (masks.some((mask) => dominates(mask, entry.mask))) return false
    // 新しい集合に包まれる古い集合は、以後の判定に要らないので落とす
    const kept = masks.filter((mask) => !dominates(entry.mask, mask))
    kept.push(entry.mask)
    visited.set(entry.key, kept)
    nodeCount += 1
    return true
  }

  const onMessage = new Map<number, (message: FromWorker) => void>()
  for (let index = 0; index < config.workers; index += 1) {
    const workDir = path.join(config.workRoot, `w${String(index)}`)
    const tmpDir = path.join(workDir, 'tmp')
    fs.mkdirSync(tmpDir, { recursive: true })
    const child = fork(path.join(__dirname, 'explore-worker.js'), [], {
      // TMPDIR をワーカーごとに分ける（理由は tools/explore-worker.ts の冒頭）
      env: { ...process.env, TMPDIR: tmpDir },
      // ライブラリやワーカーの標準出力は混ざると読めないので捨てる。反例も数もメッセージで受ける
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    const worker: Worker = {
      index,
      child,
      busy: false,
      unit: null,
      stats: {
        transitions: 0,
        porSkipped: 0,
        localDuplicates: 0,
        probes: 0,
        probeSyncs: 0,
        memoHits: 0,
        replayMismatches: 0,
      },
    }
    child.on('message', (message: FromWorker) => {
      if (message.type === 'error') {
        errors.push(`ワーカー ${String(index)}: ${message.message}`)
      }
      onMessage.get(index)?.(message)
    })
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        errors.push(
          `ワーカー ${String(index)} が終了コード ${String(code)} で落ちた`
        )
      }
      onMessage.get(index)?.({ type: 'error', message: 'exited' })
    })
    workers.push(worker)
  }

  const send = (worker: Worker, message: ToWorker): void => {
    // 止めたあとに届いた終了の知らせから送り返さない（閉じた IPC へ送ると親が落ちる）
    if (worker.child.connected) worker.child.send(message)
  }

  // 初期化（雛形の世界を作り、根の状態の鍵を返してもらう）
  const readies = await Promise.all(
    workers.map(
      (worker) =>
        new Promise<FromWorker>((resolve) => {
          onMessage.set(worker.index, resolve)
          send(worker, {
            type: 'init',
            config,
            workDir: path.join(config.workRoot, `w${String(worker.index)}`),
          })
        })
    )
  )
  /**
   * 生き残っているワーカーを落とす。
   *
   * **初期化に失敗したときに要る。** ワーカーを繋いだままにすると、親が例外で
   * 降りようとしても IPC の口が開いているせいで process が終わらず、
   * 何も出力しないまま固まる（実測: 雛形の DB を作れない版を駆動したとき）
   */
  const killWorkers = (): void => {
    for (const worker of workers) worker.child.kill()
  }
  const firstReady = readies[0]
  if (firstReady.type !== 'ready') {
    killWorkers()
    throw new Error(`ワーカーの初期化に失敗した:\n${errors.join('\n')}`)
  }
  for (const ready of readies) {
    if (ready.type !== 'ready' || ready.rootKey !== firstReady.rootKey) {
      killWorkers()
      throw new Error(
        `ワーカーの初期化が揃わない（根の状態の鍵が違う）:\n${errors.join('\n')}`
      )
    }
  }
  // 根は何も書いていない空の世界。操作の列は空、見え方も空。鍵の作り方はワーカーの子と揃える
  // （tools/explore-worker.ts の chooseCanonical。揃えないと、何も書かない列が根と別の節に見える）
  const rootHistoryKey = config.scheduleCheck
    ? historyKey(
        Array.from({ length: config.clients }, () => []),
        Array.from({ length: config.clients }, (_, index) => index),
        config.scheduleKey
      )
    : ''
  const root: FrontierNode = {
    path: [],
    frameKey: firstReady.rootFrameKey,
    history: Array.from({ length: config.clients }, () => []),
    stateKey: firstReady.rootKey,
    mask: (1 << config.clients) - 1,
    key: `${firstReady.rootKey}|${rootHistoryKey}|${config.scheduleCheck ? 'c' : 'x'}`,
  }
  const rootEntry: SeenEntry = {
    key: root.key,
    stateKey: root.stateKey,
    mask: firstReady.rootMask,
  }
  visit(rootEntry)
  stateSet.add(root.stateKey)
  views.set(root.stateKey, { kind: 'view', view: '[]' })
  historyIndex.set(rootHistoryKey, { view: '[]', path: [] })
  if (config.scheduleCheck) {
    statusIndex.set(
      historyKey(
        Array.from({ length: config.clients }, () => []),
        Array.from({ length: config.clients }, (_, index) => index),
        'ops+status'
      ),
      { view: '[]', path: [] }
    )
  }
  for (const worker of workers) {
    send(worker, {
      type: 'share',
      seen: config.dedup ? [rootEntry] : [],
      memo: [],
      views: [[root.stateKey, { kind: 'view', view: '[]' }]],
    })
  }

  let frontier: FrontierNode[] = [root]
  const layers: LayerRecord[] = []
  let lastProgress = Date.now()
  let diskStop = false
  let treeNodes = 1

  const totals = (): WorkerStats => {
    const sum: WorkerStats = {
      transitions: 0,
      porSkipped: 0,
      localDuplicates: 0,
      probes: 0,
      probeSyncs: 0,
      memoHits: 0,
      replayMismatches: 0,
    }
    for (const worker of workers) {
      for (const key of Object.keys(sum) as (keyof WorkerStats)[]) {
        sum[key] += worker.stats[key]
      }
    }
    return sum
  }

  type Conflict = {
    runs: { path: number[]; start: number }[]
    length: number
    summary: string
  }
  type Pair = {
    historyKey: string
    statusKey: string
    stateKey: string
    path: number[]
  }
  /**
   * 走らせた全体でいちばん短い強い食い違い（違反ではなく、出力に残す代表例）。
   * **層ごとに空へ戻さない**（止めずに最後まで数えるので、いちばん短い1つを持ち回る）
   */
  let strongExample: Conflict | null = null

  /**
   * 突き合わせを、見え方が分かっている節から順に片付ける。**子が届くたびに呼ぶ**（挟み方の食い違いは
   * 違反ではないので探索は止めないが、代表例の長さは短いものを優先して持ち替える）。
   *
   * @param final - 層の終わり。見え方がまだ無い節は、違反のあった状態なので捨てる
   */
  const drainPairs = (pending: Pair[], final: boolean): void => {
    const waiting: Pair[] = []
    for (const pair of pending) {
      const info = views.get(pair.stateKey)
      if (info === undefined) {
        if (!final) waiting.push(pair)
        continue
      }
      if (info.kind === 'rotation') {
        // 同じ状態から、開始端末だけを変えた round-robin で見え方が違う（比べてよい履歴の節が
        // この状態に来たので、ここで反例にする。history.ts の ViewInfo）
        strongConflicts += 1
        const candidate: Conflict = {
          runs: [
            { path: pair.path, start: info.starts[0] },
            { path: pair.path, start: info.starts[1] },
          ],
          length: pair.path.length,
          summary:
            `同じ操作の列のあと、${clientName(info.starts[0])} から始める round-robin と ` +
            `${clientName(info.starts[1])} から始める round-robin で、落ち着いた先の見え方が違う`,
        }
        if (strongExample === null || candidate.length < strongExample.length) {
          strongExample = candidate
        }
        continue
      }
      // 膠着（null）は比べない
      if (info.view === null) continue
      const byStatus = statusIndex.get(pair.statusKey)
      const byOps = historyIndex.get(pair.historyKey)
      if (byStatus === undefined) {
        statusIndex.set(pair.statusKey, { view: info.view, path: pair.path })
      }
      if (byOps === undefined) {
        historyIndex.set(pair.historyKey, { view: info.view, path: pair.path })
      }
      if (byStatus !== undefined && byStatus.view !== info.view) {
        strongConflicts += 1
        const candidate: Conflict = {
          runs: [
            { path: byStatus.path, start: 0 },
            { path: pair.path, start: 0 },
          ],
          length: Math.max(byStatus.path.length, pair.path.length),
          summary:
            '端末ごとのアプリ操作の列も、アプリが受け取った結果も同じなのに、同期の挟み方が違う' +
            '2つの実行で、落ち着いた先の見え方が違う（強い食い違い）',
        }
        if (strongExample === null || candidate.length < strongExample.length) {
          strongExample = candidate
        }
      } else if (byOps !== undefined && byOps.view !== info.view) {
        weakConflicts += 1
        const candidate: Conflict = {
          runs: [
            { path: byOps.path, start: 0 },
            { path: pair.path, start: 0 },
          ],
          length: Math.max(byOps.path.length, pair.path.length),
          summary:
            '端末ごとのアプリ操作の列は同じだが、同期の挟み方が違う2つの実行で、落ち着いた先の' +
            '見え方が違う（弱い食い違い: アプリが受け取った結果が実行どうしで違うので、' +
            'まだ届いていない行の削除や UNIQUE 違反のように、設計上も変わってよい形を含む）',
        }
        if (weakExample === null || candidate.length < weakExample.length) {
          weakExample = candidate
        }
      }
    }
    pending.length = 0
    pending.push(...waiting)
  }

  for (let depth = 0; depth < config.depth; depth += 1) {
    if (frontier.length === 0) break
    const layerStart = Date.now()
    const statesBefore = stateSet.size
    /** この層で受け入れた節の (事実の集合, 状態)。層の終わりに見え方を突き合わせる */
    const pairs: Pair[] = []
    let incomparable = 0
    const nodesBefore = nodeCount
    const next: FrontierNode[] = []
    // 仕事の単位。節の少ない層（根の層は1節）で節をまるごと1つのワーカーへ渡すと、
    // 他のワーカーが遊ぶ。そのときは1つの節の遷移を範囲に分けて配る
    //
    // 節は「世界の上で同じ状態」（frameKey）ごとに組にする。組の中の節は操作の列だけが違い、
    // 遷移を1回実行すれば全員の子が作れる（tools/explore-worker.ts の expand）
    const groups = new Map<string, FrontierNode[]>()
    for (const node of frontier) {
      const group = groups.get(node.frameKey)
      if (group === undefined) groups.set(node.frameKey, [node])
      else group.push(node)
    }
    const units: ExpandUnit[] = []
    const split = config.workers > 1 && groups.size < config.workers * 4
    const chunk = split
      ? Math.ceil(transitions.length / config.workers)
      : transitions.length
    for (const nodes of groups.values()) {
      for (let from = 0; from < transitions.length; from += chunk) {
        units.push({
          nodes,
          from,
          to: Math.min(transitions.length, from + chunk),
        })
      }
    }
    let expandedInLayer = 0
    let cursor = 0
    let done = 0
    const stopLayer = (): boolean =>
      diskStop ||
      errors.length > 0 ||
      (config.stopAtFirst && violations.length > 0)

    await new Promise<void>((resolve) => {
      const dispatch = (worker: Worker): void => {
        if (stopLayer() || cursor >= units.length) {
          if (workers.every((candidate) => !candidate.busy)) resolve()
          return
        }
        worker.busy = true
        const unit = units[cursor]
        worker.unit = unit
        cursor += 1
        send(worker, { type: 'expand', work: [unit] })
      }
      for (const worker of workers) {
        onMessage.set(worker.index, (message) => {
          if (message.type === 'expanded') {
            worker.busy = false
            worker.stats = message.stats
            done += 1
            // 組の最後の範囲を終えたら、その組の節を展開し終えたと数える
            if (worker.unit !== null && worker.unit.to === transitions.length) {
              expandedInLayer += worker.unit.nodes.length
            }
            const accepted: SeenEntry[] = []
            const newViews: [string, ViewInfo][] = []
            for (const child of message.children) {
              if (child.view !== undefined && !views.has(child.stateKey)) {
                views.set(child.stateKey, child.view)
                newViews.push([child.stateKey, child.view])
              }
              const entry: SeenEntry = {
                key: child.key,
                stateKey: child.stateKey,
                mask: child.canonicalMask,
              }
              if (config.dedup) {
                if (!visit(entry)) {
                  parentDuplicates += 1
                  continue
                }
                accepted.push(entry)
              } else {
                treeNodes += 1
                if (!visited.has(child.key)) visit(entry)
              }
              stateSet.add(child.stateKey)
              if (child.comparable) {
                pairs.push({
                  historyKey: child.historyKey,
                  statusKey: child.statusKey,
                  stateKey: child.stateKey,
                  path: child.path,
                })
              } else {
                incomparable += 1
              }
              next.push({
                path: child.path,
                frameKey: child.frameKey,
                history: child.history,
                stateKey: child.stateKey,
                mask: child.mask,
                key: child.key,
              })
            }
            // 見つかった状態と検査の結果を、層の終わりを待たずに他のワーカーへ配る。
            // 同じ層の子どうし（同じ深さ）なので、途中で配っても畳み方は健全
            if (config.dedup || config.probeMemo) {
              for (const other of workers) {
                if (other === worker) continue
                send(other, {
                  type: 'share',
                  seen: config.dedup ? accepted : [],
                  memo: message.memo,
                  views: newViews,
                })
              }
            }
            violations.push(...message.violations)
            if (config.scheduleCheck) drainPairs(pairs, false)
            for (const example of message.mismatchExamples) {
              if (mismatchExamples.length < 3) mismatchExamples.push(example)
            }
          } else if (message.type === 'error') {
            worker.busy = false
          }
          const now = Date.now()
          if (now - lastProgress >= config.progressSeconds * 1000) {
            lastProgress = now
            const t = totals()
            const elapsed = now - startedAt
            const free = freeBytes(config.workRoot)
            if (free < minFreeBytes) diskStop = true
            out(
              `[${formatDuration(elapsed)}] 深さ ${String(depth + 1)}/${String(config.depth)} ` +
                `仕事 ${String(done)}/${String(units.length)} ・ 状態 ${String(stateSet.size)} ・ ` +
                `遷移 ${String(t.transitions)} ・ 検査の同期 ${String(t.probeSyncs)} ・ ` +
                `${(t.transitions / (elapsed / 1000)).toFixed(0)} 遷移/秒 ・ 空き ${(free / 1024 ** 3).toFixed(1)}GB\n`
            )
          }
          dispatch(worker)
        })
      }
      for (const worker of workers) dispatch(worker)
    })

    layers.push({
      depth: depth + 1,
      frontier: frontier.length,
      expanded: expandedInLayer,
      newStates: stateSet.size - statesBefore,
      newNodes: config.dedup ? nodeCount - nodesBefore : next.length,
      seconds: (Date.now() - layerStart) / 1000,
    })
    skippedIncomparable += incomparable
    if (diskStop || errors.length > 0) break

    // 残っている突き合わせを片付ける（見え方がまだ届いていない節は、違反のあった状態なので比べない）
    drainPairs(pairs, true)
    if (config.stopAtFirst && violations.length > 0) break
    frontier = next
  }

  /**
   * 挟み方の食い違いの代表例（違反ではない。§8.1 第11版）。強いほうを優先し、
   * 無ければ弱いほうを1つだけ書き下す。
   */
  const scheduleExample: Conflict | null =
    strongExample ??
    (weakExample as {
      runs: { path: number[]; start: number }[]
      length: number
      summary: string
    } | null)
  let scheduleReport: string | null = null
  if (scheduleExample !== null && errors.length === 0 && !diskStop) {
    scheduleReport = await new Promise<string>((resolve) => {
      const describer = workers[0]
      onMessage.set(describer.index, (message) => {
        if (message.type === 'described') resolve(message.report)
        else if (message.type === 'error')
          resolve(`（書き下しに失敗した: ${message.message}）`)
      })
      send(describer, {
        type: 'describe',
        runs: scheduleExample.runs,
        summary: scheduleExample.summary,
      })
    })
  }

  // 後始末。層の処理の受け口を外してから止める（止めた知らせで次の節を配らないように）
  for (const worker of workers) onMessage.set(worker.index, () => undefined)
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve) => {
          if (worker.child.exitCode !== null) {
            resolve()
            return
          }
          worker.child.once('exit', () => resolve())
          send(worker, { type: 'stop' })
        })
    )
  )
  const elapsed = Date.now() - startedAt
  const t = totals()
  const expandedNodes = layers.reduce((sum, layer) => sum + layer.expanded, 0)
  fs.rmSync(config.workRoot, { recursive: true, force: true })

  const statsLines = [
    `  範囲: ${describeConfig(config)}`,
    `  削減手: ${describeReductions(config)}`,
    config.dedup
      ? `  調べた状態（性質を検査した、互いに異なる状態。根を含む）: ${String(stateSet.size)}`
      : `  たどった節（重複排除なし。同じ状態も別々に数える）: ${String(treeNodes)}（うち異なる状態: ${String(stateSet.size)}）`,
    `  展開した節（子を生やした節。最深の層は展開しない）: ${String(expandedNodes)}` +
      (config.dedup
        ? `（重複排除の単位 (状態, 事実の集合, 次に操作してよい端末) の節は全部で ${String(nodeCount)}）`
        : ''),
    `  当てた遷移: ${String(t.transitions)}`,
    ...(config.scheduleCheck
      ? [
          `  挟み方の検査（違反ではなく件数の記録。設計書 §8.1 第11版）: ` +
            `発行した操作の列 ${String(historyIndex.size)} 通りについて見え方を突き合わせた` +
            `（強い食い違い ${String(strongConflicts)} 組・弱い食い違い ${String(weakConflicts)} 組。history.ts の「比べない履歴」に当たるので突き合わせなかった節 ${String(skippedIncomparable)}）`,
        ]
      : []),
    `  順序の畳み込みで当てずに済んだ遷移: ${String(t.porSkipped)}`,
    `  重複で捨てた子: ワーカーの手元で ${String(t.localDuplicates)} / 親で ${String(parentDuplicates)}`,
    `  収束の検査: ${String(t.probes)} 回（検査で回した同期 ${String(t.probeSyncs)} 回、使い回しで打ち切り ${String(t.memoHits)} 回）`,
    `  再生して違う状態に戻った節: ${String(t.replayMismatches)}` +
      mismatchExamples
        .map(
          (example) =>
            `\n    例: ${example.map((index) => describeTransition(transitions[index])).join(' → ')}`
        )
        .join(''),
    `  層ごと: ${layers.map((layer) => `深さ${String(layer.depth)}: 節${String(layer.frontier)}→新しい状態${String(layer.newStates)}（${layer.seconds.toFixed(1)}秒）`).join(' / ')}`,
    `  かかった時間: ${formatDuration(elapsed)}（ワーカー ${String(config.workers)}）`,
    `  STATS ${JSON.stringify({ states: stateSet.size, histories: historyIndex.size, strongConflicts, weakConflicts, expanded: expandedNodes, nodes: config.dedup ? nodeCount : treeNodes, transitions: t.transitions, porSkipped: t.porSkipped, probes: t.probes, probeSyncs: t.probeSyncs, memoHits: t.memoHits, replayMismatches: t.replayMismatches, seconds: elapsed / 1000, workers: config.workers })}`,
  ]

  /**
   * 挟み方の食い違いの代表例（1つだけ）。**反例ではない**ので、罫線で囲まず、
   * 「（強）が破れた形の観察」として統計のあとに添える（設計書 §8.1・§9.25）。
   */
  const scheduleLines =
    scheduleReport === null
      ? []
      : [
          '',
          '-'.repeat(78),
          `（強）が破れた形の観察 —— 挟み方の食い違いの代表例（いちばん短い${strongExample === null ? '弱い' : '強い'}もの1つ）。`,
          '案A では `_sns_ts` の引き上げ（設計書 §1.2.1）があるので、これは違反ではない（§9.25）。',
          '-'.repeat(78),
          '',
          scheduleReport,
          '-'.repeat(78),
        ]

  if (errors.length > 0) {
    out(
      `\n検査器そのものが失敗した（結果は信用できない）:\n${errors.join('\n')}\n\n${statsLines.join('\n')}\n`
    )
    return 2
  }
  if (diskStop) {
    out(
      `\n作業ディレクトリの場所の空きが ${String(config.minFreeMb)}MB を割ったので止めた（範囲を全部は見ていない）。\n\n${statsLines.join('\n')}\n`
    )
    return 2
  }

  if (violations.length > 0) {
    violations.sort(
      (a, b) =>
        a.path.length - b.path.length ||
        a.probeSyncs - b.probeSyncs ||
        (JSON.stringify(a.path) < JSON.stringify(b.path) ? -1 : 1)
    )
    const best = violations[0]
    out(
      [
        '',
        '='.repeat(78),
        `反例が見つかった（遷移 ${String(best.path.length)} 回。幅優先なので、この範囲で最短の深さ）`,
        '='.repeat(78),
        '',
        best.report,
        '',
        '='.repeat(78),
        violations.length > 1
          ? `（同じ層で他に ${String(violations.length - 1)} 件。いちばん短いものだけを出した。` +
            `種類: ${[...new Set(violations.map((v) => v.kind))].join(', ')}）`
          : '',
        '',
        ...statsLines,
        ...scheduleLines,
        '',
      ].join('\n')
    )
    return 1
  }

  out(
    [
      '',
      `反例は無かった。この範囲（深さ ${String(config.depth)} までの全ての遷移の列）には反例が無い。`,
      '範囲の外（台数・表・値の種類・深さを超えた列）については何も言っていない。',
      '',
      ...statsLines,
      ...scheduleLines,
      '',
    ].join('\n')
  )
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    process.exitCode = 2
  }
)
