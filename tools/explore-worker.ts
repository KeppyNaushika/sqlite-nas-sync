/**
 * 探索のワーカー。親から渡された節を展開し、子の状態を検査して返す。
 *
 * **自分専用の作業ディレクトリと自分専用の `TMPDIR` しか触らない。** 共有すると、
 * 片方が世界を作り直すときの `rm -rf` がもう片方の走行中のDBを消し、「同期が壊れた」に
 * 見える偽の失敗が出る（実測: 12連続の偽失敗）。`TMPDIR` は親が `fork` の環境変数で
 * 分けて渡す（ライブラリは相手のDBを `os.tmpdir()/sqlite-nas-sync` へ写してから開くので、
 * 分けないと残骸が混ざる）。`worker_threads` ではなく子プロセスにしているのもこのためで、
 * `os.tmpdir()` はプロセス全体の環境変数を読むのでスレッドごとには分けられない。
 *
 * @module tools/explore-worker
 */
import * as path from 'path'
import { ExploreConfig, TABLE_SETS } from './explore/config'
import {
  Transition,
  clientName,
  describeTransition,
  enumerateTransitions,
} from './explore/ops'
import {
  ProbeTrace,
  ProbeVerdict,
  Prober,
  failureWarning,
} from './explore/probe'
import {
  ExpandUnit,
  FromWorker,
  SeenEntry,
  ToWorker,
  Violation,
  WorkerStats,
} from './explore/protocol'
import { dominates, fullMask, maskAfterOp } from './explore/reduction'
import {
  History,
  ORACLES,
  ViewInfo,
  Oracle,
  historyKey,
  isAppWrite,
  isComparableHistory,
} from './explore/history'
import { CanonicalState, TimeLabeler } from './explore/state'
import {
  Library,
  World,
  applyTransition,
  buildTemplate,
  closeWorld,
  createWorld,
  loadLibrary,
  purgeRemoteTmp,
  restoreWorld,
  snapshotWorld,
} from './explore/world'

type Context = {
  config: ExploreConfig
  lib: Library
  transitions: Transition[]
  labeler: TimeLabeler
  prober: Prober
  dirs: { template: string; work: string; snap: string; probeSnap: string }
  /** 重複排除の手元の写し。親が他のワーカーの分を配ってくる分と、自分が出した分 */
  seen: Map<string, number[]>
  /** 検査を済ませた状態（親が見つけた分を含む） */
  checked: Set<string>
  /** 状態の鍵 → 不動点での見え方（null は端末ごとに違って定まらない）。違反のあった状態は載らない */
  views: Map<string, ViewInfo>
  /** 見え方を突き合わせる参照実装（無ければ null） */
  oracle: Oracle | null
  stats: WorkerStats
}

let context: Context | null = null
let stopping = false
/** メッセージは順に処理する（展開の途中で `seen` が割り込むと、手元の写しが揺れる） */
let queue: Promise<void> = Promise.resolve()

function send(message: FromWorker): void {
  process.send?.(message)
}

function freshStats(): WorkerStats {
  return {
    transitions: 0,
    porSkipped: 0,
    localDuplicates: 0,
    probes: 0,
    probeSyncs: 0,
    memoHits: 0,
    replayMismatches: 0,
  }
}

function addSeen(seen: Map<string, number[]>, entry: SeenEntry): void {
  const masks = seen.get(entry.key)
  if (masks === undefined) {
    seen.set(entry.key, [entry.mask])
  } else if (!masks.some((mask) => dominates(mask, entry.mask))) {
    masks.push(entry.mask)
  }
}

function isSeen(seen: Map<string, number[]>, entry: SeenEntry): boolean {
  return (
    seen.get(entry.key)?.some((mask) => dominates(mask, entry.mask)) ?? false
  )
}

function resolveOracle(name: string | null): Oracle | null {
  if (name === null) return null
  const oracle = ORACLES[name]
  if (oracle === undefined) {
    throw new Error(
      `知らない参照実装: ${name}（登録済み: ${Object.keys(ORACLES).join(', ') || 'なし'}）`
    )
  }
  return oracle
}

async function init(config: ExploreConfig, workDir: string): Promise<void> {
  const lib = loadLibrary(config.libDir)
  const labeler = new TimeLabeler(config)
  const dirs = {
    template: path.join(workDir, 'template'),
    work: path.join(workDir, 'work'),
    snap: path.join(workDir, 'snap'),
    probeSnap: path.join(workDir, 'probe-snap'),
  }
  buildTemplate(lib, dirs.template, config)
  const prober = new Prober(lib, config, labeler)
  context = {
    config,
    lib,
    transitions: enumerateTransitions(config),
    labeler,
    prober,
    dirs,
    seen: new Map(),
    checked: new Set(),
    views: new Map(),
    oracle: resolveOracle(config.oracle),
    stats: freshStats(),
  }
  const world = createWorld(dirs.template, dirs.work, config)
  const root = prober.canonical(world)
  closeWorld(world)
  // 根（何も書いていない空の世界）の見え方は空。事実の集合が空の列は、どう同期を挟んでもこれになるべき
  context.views.set(root.key, { kind: 'view', view: '[]' })
  send({ type: 'ready', rootKey: root.key })
}

function emptyHistory(ctx: Context): History {
  return Array.from({ length: ctx.config.clients }, () => [])
}

/** 遷移がアプリの書き込みを含むなら、その端末の操作の列へ足す。 */
function recordIssued(
  history: History,
  transition: Transition,
  status: string | null
): void {
  if (transition.kind !== 'op' && transition.kind !== 'syncWrite') return
  if (!isAppWrite(transition.op)) return
  history[transition.client].push({ op: transition.op, status: status ?? '' })
}

/**
 * 重複排除の鍵に使う操作の列の鍵と、アプリが受け取った結果つきの鍵（食い違いの強さの判定に使う。
 * tools/explore-convergence.ts の「強い食い違い・弱い食い違い」）。
 */
function historyKeys(
  ctx: Context,
  history: History
): { historyKey: string; statusKey: string } {
  if (!ctx.config.scheduleCheck) return { historyKey: '', statusKey: '' }
  return {
    historyKey: historyKey(history, ctx.config.scheduleKey),
    statusKey: historyKey(history, 'ops+status'),
  }
}

/** 列を空の世界から再生する。書き込みが作った事実も数え直す。 */
async function materialize(
  ctx: Context,
  path: number[]
): Promise<{ world: World; history: History }> {
  const world = createWorld(ctx.dirs.template, ctx.dirs.work, ctx.config)
  const history = emptyHistory(ctx)
  for (const index of path) {
    const outcome = await applyTransition(
      ctx.lib,
      world,
      ctx.transitions[index]
    )
    recordIssued(history, ctx.transitions[index], outcome.status)
  }
  return { world, history }
}

const KIND_LABEL: Record<Violation['kind'], string> = {
  exception:
    '例外（performSync が投げた。作り直しの確定ごとの判定8・10・13 と、操作ごとの原則2・3 の確かめの違反もここに入る）',
  'sync-failed':
    '取り込みの失敗（Sync failed / Failed to open / Rebuild failed / Rebuild deferred）',
  'silent-divergence': '黙った食い違い（収束しても端末ごとに中身が違う）',
  oscillation: '振動（round-robin の同期が状態を行き来して止まらない）',
  'no-fixpoint': '上限まで同期しても状態が動き続けた',
  // **違反ではない**（設計書 §8.1）。件数と代表例として出す種類
  'schedule-dependence':
    '同期の挟み方で見え方が変わる（案A では `_sns_ts` の引き上げがあるので、これは設計どおり。§9.25）',
  'oracle-mismatch': '参照実装の見え方と食い違う',
  judgment:
    '判定5〜7 の違反（版の食い違い・Max が弱くなった・アプリの表が制約を満たさない）',
}

/** 遷移の列を、人が読める再現手順へ書き下す。 */
function renderSteps(
  ctx: Context,
  path: number[],
  warningsByStep: string[][]
): string[] {
  let clock = 0
  const lines: string[] = []
  path.forEach((index, step) => {
    const transition = ctx.transitions[index]
    const stamp = transition.kind === 'op' ? `[時刻 C${String(clock)}] ` : ''
    lines.push(
      `  ${String(step + 1)}. ${stamp}${describeTransition(transition)}`
    )
    const warnings = warningsByStep[step] ?? []
    if (warnings.length > 0) {
      lines.push(`       warnings: ${JSON.stringify(warnings)}`)
    }
    if (transition.kind !== 'op') clock += 1
  })
  return lines
}

/**
 * 反例を再生し直して、再現手順を書く。
 *
 * 検査の途中は使い回しの結果で打ち切っていることがあるので、ここでは**使い回しを
 * 使わずに**頭から回し直す。回し直して同じ結論にならなければ、そのことも書く
 * （使い回しの誤り、または同期の中の時刻の揺れ）。
 */
async function writeReport(
  ctx: Context,
  path: number[],
  probeStart: number | null,
  expected: { kind: Violation['kind']; summary: string }
): Promise<{ report: string; probeSyncs: number }> {
  const world = createWorld(ctx.dirs.template, ctx.dirs.work, ctx.config)
  const warningsByStep: string[][] = []
  let edgeFailure: string | null = null
  try {
    for (const index of path) {
      try {
        const outcome = await applyTransition(
          ctx.lib,
          world,
          ctx.transitions[index]
        )
        warningsByStep.push(outcome.warnings)
        edgeFailure = failureWarning(outcome.warnings)
      } catch (error) {
        warningsByStep.push([`例外: ${String(error)}`])
        edgeFailure = String(error)
      }
    }
    const header = [
      `反例: ${KIND_LABEL[expected.kind]}`,
      `要約: ${expected.summary}`,
      '',
      `端末 ${Array.from({ length: ctx.config.clients }, (_, i) => clientName(i)).join(', ')}` +
        `（スキーマは __tests__/helpers/sync-fixtures.ts と同じ。同期対象の表は ${world.tables.map((t) => t.name).join(', ')}、` +
        `primaryKey 'id'、changelogRetentionDays 7）。空の世界から、この順に:`,
      '',
      ...renderSteps(ctx, path, warningsByStep),
    ]
    const clockNote =
      '  ※ [時刻 Ck] は、その操作のトリガーが刻む _changelog.changedAt・_tombstone.deletedAt と、' +
      '削除の版の _sns_ts のうち実行した時刻が入ったものを Ck にそろえるという意味。' +
      'C0 < C1 < … はどれも行の時刻（2026-01-01…）より後で、' +
      '同期と「時計を進める」のたびに1つ進む。同じ Ck の操作は同じ瞬間に起きた。'
    if (probeStart === null) {
      return {
        report: [
          ...header,
          clockNote,
          '',
          `最後の遷移で: ${edgeFailure ?? '（再生では再現しなかった）'}`,
        ].join('\n'),
        probeSyncs: 0,
      }
    }
    const state = ctx.prober.canonical(world)
    const trace: ProbeTrace = { startClient: probeStart, steps: [], detail: '' }
    const verdict = await ctx.prober.run(world, state, probeStart, trace)
    const probeLines = trace.steps.map((step, index) => {
      const name = clientName(step.client)
      const line = `  ${String(path.length + index + 1)}. ${name}: await performSync(${name}.db, ${name}.config, TABLES)`
      return step.warnings.length > 0
        ? `${line}\n       warnings: ${JSON.stringify(step.warnings)}`
        : line
    })
    const reproduced =
      !verdict.ok && verdict.kind === expected.kind
        ? ''
        : `\n※ 使い回しを使わずに回し直したら結論が変わった（${verdict.ok ? '収束した' : verdict.kind}）。` +
          '同期の中の時刻の揺れか、検査器の誤りの可能性がある。'
    return {
      report: [
        ...header,
        '',
        `そのあと ${clientName(probeStart)} から round-robin で、状態が動かなくなるまで同期する:`,
        '',
        ...probeLines,
        '',
        clockNote,
        '',
        trace.detail,
        reproduced,
      ].join('\n'),
      probeSyncs: trace.steps.length,
    }
  } finally {
    closeWorld(world)
  }
}

/** 状態の検査の結論。違反が無ければ見え方の記録（history.ts の ViewInfo）。 */
type StateCheck =
  | { violation: { verdict: ProbeVerdict & { ok: false }; start: number } }
  | { info: ViewInfo }

/**
 * 状態を全ての開始端末から検査する。**世界を動かす**ので、呼んだあとは捨てること。
 *
 * 開始端末ごとに不動点での見え方も集め、見え方どうしが違えば、それも違反として返す
 * （挟み方の検査が有効なとき）。端末ごとに違って見え方が定まらない場合（null）は比べない。
 */
async function checkState(
  ctx: Context,
  world: World,
  state: CanonicalState
): Promise<StateCheck> {
  const n = ctx.config.clients
  const limit = ctx.config.maxProbeRounds * n
  const pending: number[] = []
  let found: { verdict: ProbeVerdict & { ok: false }; start: number } | null =
    null
  const views: { start: number; view: string | null }[] = []
  const judge = (verdict: ProbeVerdict, start: number): void => {
    if (found !== null) return
    if (!verdict.ok) {
      found = { verdict, start }
    } else if (verdict.syncs > limit) {
      // 覚えてある「不動点まで d 回」を足した結果、上限を超えた
      found = {
        verdict: {
          ok: false,
          kind: 'no-fixpoint',
          syncs: verdict.syncs,
          summary: `不動点まで ${String(verdict.syncs)} 回の同期が要る（上限 ${String(limit)} 回）`,
        },
        start,
      }
    } else {
      views.push({ start, view: verdict.view })
    }
  }
  for (let start = 0; start < n; start += 1) {
    const cached = ctx.prober.cached(state, start)
    if (cached === null) pending.push(start)
    else judge(cached, start)
  }

  if (found === null && pending.length > 0) {
    // 2つ以上の開始端末を回すなら、動かす前の世界を取っておく
    const needsRestore = pending.length > 1
    if (needsRestore) snapshotWorld(world, ctx.dirs.probeSnap)
    let current = needsRestore
      ? restoreWorld(ctx.dirs.probeSnap, ctx.dirs.work, ctx.config)
      : world
    try {
      for (let i = 0; i < pending.length; i += 1) {
        if (i > 0) {
          closeWorld(current)
          current = restoreWorld(ctx.dirs.probeSnap, ctx.dirs.work, ctx.config)
        }
        const verdict = await ctx.prober.run(current, state, pending[i])
        judge(verdict, pending[i])
        if (found !== null) break
      }
    } finally {
      closeWorld(current)
    }
  } else {
    closeWorld(world)
  }
  if (found !== null) return { violation: found }

  const comparable = views.filter(
    (entry): entry is { start: number; view: string } => entry.view !== null
  )
  const differing = comparable.find(
    (entry) => entry.view !== comparable[0].view
  )
  const info: ViewInfo =
    differing !== undefined
      ? {
          kind: 'rotation',
          starts: [comparable[0].start, differing.start],
          views: [comparable[0].view, differing.view],
        }
      : {
          kind: 'view',
          view: comparable.length > 0 ? comparable[0].view : null,
        }
  ctx.views.set(state.key, info)
  return { info }
}

/**
 * 挟み方の違う列（または同じ列の違う開始端末）について、再現手順と見え方を書く。
 *
 * それぞれを空の世界から再生し、使い回しを使わずに round-robin で不動点まで回して、
 * そこでの見え方を並べる。
 */
async function describeSchedules(
  ctx: Context,
  runs: { path: number[]; start: number }[],
  summary: string
): Promise<string> {
  const sections: string[] = [
    // 挟み方の食い違いは**違反ではない**（設計書 §8.1・§9.25）。
    // 「反例」と書かない（読み手が案A の破れと取り違える）
    `観察: ${KIND_LABEL['schedule-dependence']}`,
    `要約: ${summary}`,
    '',
    `端末 ${Array.from({ length: ctx.config.clients }, (_, i) => clientName(i)).join(', ')}` +
      `（スキーマは __tests__/helpers/sync-fixtures.ts と同じ。同期対象の表は ${TABLE_NAMES(ctx)}、` +
      `primaryKey 'id'、changelogRetentionDays 7）。`,
  ]
  const letters = ['A', 'B', 'C', 'D']
  for (let i = 0; i < runs.length; i += 1) {
    const { path, start } = runs[i]
    const world = createWorld(ctx.dirs.template, ctx.dirs.work, ctx.config)
    const history = emptyHistory(ctx)
    const warningsByStep: string[][] = []
    try {
      for (const index of path) {
        const outcome = await applyTransition(
          ctx.lib,
          world,
          ctx.transitions[index]
        )
        warningsByStep.push(outcome.warnings)
        recordIssued(history, ctx.transitions[index], outcome.status)
      }
      const state = ctx.prober.canonical(world)
      const trace: ProbeTrace = { startClient: start, steps: [], detail: '' }
      const verdict = await ctx.prober.run(world, state, start, trace)
      sections.push(
        '',
        `── 実行${letters[i] ?? String(i + 1)}: 空の世界から、この順に ──`,
        '',
        ...renderSteps(ctx, path, warningsByStep),
        `  そのあと ${clientName(start)} から round-robin で、状態が動かなくなるまで同期する（${String(trace.steps.length)} 回）`,
        '',
        '  端末ごとの、発行した操作の列（アプリが受け取った結果つき）:',
        ...history.map(
          (issued, client) =>
            `    ${clientName(client)}: ${issued.length === 0 ? '（なし）' : issued.map((entry) => `${JSON.stringify(entry.op)} → ${entry.status}`).join(' ; ')}`
        ),
        `  落ち着いた先の見え方: ${verdict.ok ? (verdict.view ?? '（端末ごとに違う）') : `（違反: ${verdict.summary}）`}`
      )
    } finally {
      closeWorld(world)
    }
  }
  sections.push(
    '',
    '  ※ [時刻 Ck] は、その操作のトリガーが刻む実行時刻（_changelog.changedAt・_tombstone.deletedAt・' +
      '削除の版の _sns_ts）を Ck にそろえるという意味（tools/explore/world.ts の「時計」）。' +
      '見え方の updatedAt は julianday。'
  )
  return sections.join('\n')
}

function TABLE_NAMES(ctx: Context): string {
  return TABLE_SETS[ctx.config.tableSet].join(', ')
}

/**
 * 仕事の単位を展開する。
 *
 * 単位は「**世界の上で同じ状態**にある節の組」と、当てる遷移の範囲（protocol.ts の ExpandUnit）。
 * 重複排除の単位には発行した操作の列が入る（history.ts）ので、同じ状態に操作の列だけが違う節が
 * 何個も来る。子の状態・アプリが受け取る結果・警告は操作の列によらず状態と遷移だけで決まるので、
 * **遷移は組ごとに1回だけ実行し**、子の鍵（操作の列・集合）だけを節ごとに計算する
 * （節ごとに実行すると、実測で同じ状態への同じ遷移を5倍実行していた）。
 *
 */
async function expand(work: ExpandUnit[]): Promise<void> {
  const ctx = context
  if (ctx === null) throw new Error('init の前に expand が来た')
  const { config } = ctx
  const children: (FromWorker & { type: 'expanded' })['children'] = []
  const violations: Violation[] = []
  const mismatchExamples: number[][] = []

  for (const { nodes, from, to } of work) {
    if (stopping) break
    const representative = nodes[0]
    const { world } = await materialize(ctx, representative.path)
    const parentState = ctx.prober.canonical(world)
    if (parentState.key !== representative.stateKey) {
      // 同じ列を再生したのに、見つけたときと違う状態になった。同期の中の刻みが
      // 同じミリ秒に収まったかどうかの揺れで起きうる（docs の「保証しないこと」）。
      // 黙って数えるだけにせず、列を親へ渡して出力に載せる
      ctx.stats.replayMismatches += 1
      if (mismatchExamples.length < 3)
        mismatchExamples.push(representative.path)
    }
    snapshotWorld(world, ctx.dirs.snap)

    for (let index = from; index < to; index += 1) {
      if (stopping) break
      const transition = ctx.transitions[index]
      // 順序の畳み込み: この操作を当ててよい節だけを残す（組の中で集合は節ごとに違う）
      const allowed =
        config.por && transition.kind === 'op'
          ? nodes.filter((node) => (node.mask & (1 << transition.client)) !== 0)
          : nodes
      ctx.stats.porSkipped += nodes.length - allowed.length
      if (allowed.length === 0) continue
      const firstPath = [...allowed[0].path, index]

      const child = restoreWorld(ctx.dirs.snap, ctx.dirs.work, config)
      let closed = false
      const close = (): void => {
        if (!closed) closeWorld(child)
        closed = true
      }
      try {
        ctx.stats.transitions += 1
        let warnings: string[]
        let status: string | null
        try {
          const outcome = await applyTransition(ctx.lib, child, transition)
          warnings = outcome.warnings
          status = outcome.status
        } catch (error) {
          close()
          const summary = `遷移 ${describeTransition(transition)} で例外: ${String(error)}`
          const { report } = await writeReport(ctx, firstPath, null, {
            kind: 'exception',
            summary,
          })
          violations.push({
            kind: 'exception',
            path: firstPath,
            summary,
            probeStart: null,
            probeSyncs: 0,
            report,
          })
          continue
        }
        // 「失敗として飲み込まれた」は重複排除より先に見る。行き着いた状態が既知でも、
        // この遷移そのものが壊れ方だから
        const failure = failureWarning(warnings)
        if (failure !== null) {
          close()
          const summary = `遷移 ${describeTransition(transition)} で取り込みの失敗: ${failure}`
          const { report } = await writeReport(ctx, firstPath, null, {
            kind: 'sync-failed',
            summary,
          })
          violations.push({
            kind: 'sync-failed',
            path: firstPath,
            summary,
            probeStart: null,
            probeSyncs: 0,
            report,
          })
          continue
        }

        const state = ctx.prober.canonical(child)

        // 子の状態の検査は、組の中で1回だけ（状態で決まる）
        if (!ctx.checked.has(state.key)) {
          ctx.checked.add(state.key)
          const checked = await checkState(ctx, child, state)
          closed = true // checkState が閉じる
          if ('violation' in checked) {
            const found = checked.violation
            const { report, probeSyncs } = await writeReport(
              ctx,
              firstPath,
              found.start,
              found.verdict
            )
            violations.push({
              kind: found.verdict.kind,
              path: firstPath,
              summary: found.verdict.summary,
              probeStart: found.start,
              probeSyncs,
              report,
            })
          }
        }
        const view = ctx.views.get(state.key)

        for (const node of allowed) {
          const childMask = !config.por
            ? fullMask(config.clients)
            : transition.kind === 'op'
              ? maskAfterOp(node.mask, transition.client)
              : fullMask(config.clients)
          const childPath = [...node.path, index]
          const childHistory = node.history.map((issued) => [...issued])
          recordIssued(childHistory, transition, status)
          // 鍵は (状態, 発行した操作の列, 集合)
          const chosen = historyKeys(ctx, childHistory)
          const comparable =
            config.scheduleCheck && isComparableHistory(childHistory)
          // 比べてよいかの印も鍵に入れる。操作の列が同じでも、アプリが受け取った結果（親を
          // 挿入したか）で比べてよいかが変わるので、入れないと、比べない節が先に来たときに
          // 比べるべき節が畳まれて突き合わせ落とす
          const entry = {
            key: `${state.key}|${chosen.historyKey}|${comparable ? 'c' : 'x'}`,
            stateKey: state.key,
            mask: childMask,
          }
          if (config.dedup) {
            if (isSeen(ctx.seen, entry)) {
              ctx.stats.localDuplicates += 1
              continue
            }
            addSeen(ctx.seen, entry)
          }
          if (
            ctx.oracle !== null &&
            view?.kind === 'view' &&
            typeof view.view === 'string' &&
            comparable
          ) {
            // 参照実装との突き合わせ（tools/explore/history.ts の「拡張の口」）
            const expected = ctx.oracle.expectedView(childHistory)
            if (expected !== null && expected !== view.view) {
              const summary = `参照実装 ${ctx.oracle.name} の見え方と、本物の見え方が違う`
              violations.push({
                kind: 'oracle-mismatch',
                path: childPath,
                summary,
                probeStart: 0,
                probeSyncs: 0,
                report:
                  (await describeSchedules(
                    ctx,
                    [{ path: childPath, start: 0 }],
                    summary
                  )) + `\n\n  参照実装が期待する見え方: ${expected}`,
              })
            }
          }
          children.push({
            path: childPath,
            history: childHistory,
            mask: childMask,
            key: entry.key,
            stateKey: state.key,
            historyKey: chosen.historyKey,
            statusKey: chosen.statusKey,
            comparable,
            ...(view === undefined ? {} : { view }),
          })
        }
      } finally {
        close()
      }
      if (violations.length > 0 && config.stopAtFirst) break
    }
    // 組を1つ展開し終えるたびに、取り込みの一時コピーの残骸を掃く
    purgeRemoteTmp()
    if (violations.length > 0 && config.stopAtFirst) break
  }

  const stats = ctx.stats
  stats.probes = ctx.prober.stats.probes
  stats.probeSyncs = ctx.prober.stats.probeSyncs
  stats.memoHits = ctx.prober.stats.memoHits
  send({
    type: 'expanded',
    children,
    violations,
    stats: { ...stats },
    mismatchExamples,
    memo: ctx.prober.drainFresh(),
  })
}

// 親が落ちたら自分も降りる（取り残されたワーカーが CPU とディスクを使い続けないように）
process.on('disconnect', () => process.exit(0))

process.on('message', (message: ToWorker) => {
  if (message.type === 'stop') {
    stopping = true
    // 手元の処理が終わったら降りる（親は全員の終了を待っている）
    queue = queue.then(() => process.exit(0))
    return
  }
  queue = queue
    .then(async () => {
      switch (message.type) {
        case 'init':
          await init(message.config, message.workDir)
          break
        case 'expand':
          await expand(message.work)
          break
        case 'share':
          if (context !== null) {
            for (const entry of message.seen) {
              addSeen(context.seen, entry)
              context.checked.add(entry.stateKey)
            }
            for (const [stateKey, view] of message.views) {
              context.views.set(stateKey, view)
            }
            context.prober.importMemo(message.memo)
          }
          break
        case 'describe':
          if (context !== null) {
            send({
              type: 'described',
              report: await describeSchedules(
                context,
                message.runs,
                message.summary
              ),
            })
          }
          break
      }
    })
    .catch((error: unknown) => {
      send({
        type: 'error',
        message:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      })
    })
})
