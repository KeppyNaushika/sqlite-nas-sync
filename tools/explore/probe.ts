/**
 * 各状態で調べる性質。
 *
 * 1. **取り込みが失敗として飲み込まれないこと** —— `result.warnings` に
 *    `Sync failed for client …` が1件でも出たら違反（その相手からの同期が永久に止まる。
 *    唯一許されない壊れ方）。フルマージ経路の同じ壊れ方 `Full merge failed for client …`、
 *    相手のDBを開けなかった `Failed to open remote database` も同じ扱いにする。
 *    `performSync` が例外を投げた場合も違反。
 * 2. **収束すること** —— その状態から全端末を round-robin で同期し、状態が動かなく
 *    なったとき全端末の中身が一致すること。一致しない行が1つでも残れば違反
 *    （逃げ道は無い）。
 *
 * ## 「動かなくなった」の定義と上限
 *
 * 同期は（時計を除いて）決定的なので、round-robin の列は (状態, 次に同期する端末) の
 * 組が一度出た組へ戻った時点で繰り返しに入る。戻った先から一巡のあいだ**状態が1つも
 * 変わっていなければ不動点**、変わっていれば**振動**（違反）。上限
 * `maxProbeRounds × 端末数` 回の同期で不動点に届かなければ、それも違反として報告する
 * （changelog が同期のたびに伸び続ける形は、繰り返しに入らないのでここで捕まる）。
 *
 * ## 開始端末
 *
 * **全ての開始端末から**回す。1つに固定すると「端末 b から始めたときだけ収束しない」を
 * 見逃すうえ、端末の入れ替えの対称性で状態を畳めなくなる（reduction.ts）。
 *
 * ## 使い回し
 *
 * round-robin の途中の状態は、他の状態の検査の途中にもよく現れる（同期で行き着く先は
 * 限られる）。そこで (正準な状態, 正準な並びでの次の端末) → 結果 を覚えておき、
 * 列が覚えた組に当たったらそこで打ち切る。結果は「不動点まで何回か」と
 * 「その不動点が違反か」なので、途中から合流しても答えは同じ。
 *
 * @module tools/explore/probe
 */
import { ExploreConfig, TABLE_SETS } from './config'
import { viewOf } from './history'
import { JudgmentLedger, checkAppTables, collectVersions } from './judgments'
import { clientName } from './ops'
import {
  CanonicalState,
  NormalizeOptions,
  TimeLabeler,
  allDifferingKeys,
  canonicalize,
  normalizeOptionsFrom,
  readWorld,
  snapshotData,
} from './state'
import { Library, World, applyTransition } from './world'

/**
 * 取り込みの失敗として扱う警告（性質の1「同期が止まらない」）。
 *
 * 案A（docs/rows-table-design.md §8.1）の作り直しの失敗も数える。
 * `Rebuild deferred`（他の接続が居るので作り直しを先送りした）も**検査器の中では違反**である
 * ——検査器は端末ごとに接続を1本しか開かないので、先送りが起きたなら判定の前提が崩れている。
 */
export function failureWarning(warnings: string[]): string | null {
  return (
    warnings.find(
      (warning) =>
        warning.startsWith('Sync failed for client ') ||
        warning.startsWith('Full merge failed for client ') ||
        warning.startsWith('Failed to open remote database') ||
        warning.startsWith('Rebuild failed') ||
        warning.startsWith('Rebuild deferred')
    ) ?? null
  )
}

export type ViolationKind =
  | 'exception'
  | 'sync-failed'
  | 'silent-divergence'
  | 'oscillation'
  | 'no-fixpoint'
  | 'schedule-dependence'
  | 'oracle-mismatch'
  /** 判定5・6・7（設計書 §8.1。tools/explore/judgments.ts） */
  | 'judgment'

/**
 * 検査の結果。`syncs` は開始状態から、結論が出るまでに回した同期の回数。
 * `view` は不動点での見え方（tools/explore/history.ts の viewOf。端末ごとに違えば null）。
 */
export type ProbeVerdict =
  | { ok: true; syncs: number; view: string | null }
  | { ok: false; kind: ViolationKind; syncs: number; summary: string }

/** 検査を回した記録（反例の書き下し用）。 */
export type ProbeTrace = {
  startClient: number
  steps: { client: number; warnings: string[] }[]
  detail: string
}

type MemoEntry = { verdict: ProbeVerdict }

export type ProbeStats = {
  probes: number
  probeSyncs: number
  memoHits: number
}

export class Prober {
  private readonly memo = new Map<string, MemoEntry>()
  /**
   * 判定5・6（設計書 §8.1）の帳簿。**実行のあいだ通して**持つ（版の鍵は端末をまたいで
   * 突き合わせるものなので、状態ごとに作り直しては意味が無い）。案A の `_sns_rows_*` が
   * 無いあいだは何も集まらないので、何も言わない
   */
  private readonly ledger = new JudgmentLedger()
  /** 前回 {@link drainFresh} してから自分で覚えた分（他のワーカーへ配る） */
  private fresh: [string, ProbeVerdict][] = []
  readonly stats: ProbeStats = { probes: 0, probeSyncs: 0, memoHits: 0 }

  private readonly normalize: NormalizeOptions

  constructor(
    private readonly lib: Library,
    private readonly config: ExploreConfig,
    private readonly labeler: TimeLabeler,
    private readonly permutations: number[][]
  ) {
    this.normalize = normalizeOptionsFrom(config)
  }

  canonical(world: World): CanonicalState {
    return canonicalize(
      readWorld(world, this.config),
      this.labeler,
      this.permutations,
      this.normalize
    )
  }

  /**
   * 正準な並びでの (状態, 次の端末) の鍵。自己対称な状態では候補の中で最小の端末番号を採る
   * （どれも同じ軌道なので、どれを採っても答えは同じ）。
   */
  private memoKey(state: CanonicalState, client: number): string {
    let best = Number.POSITIVE_INFINITY
    for (const permutation of state.permutations) {
      best = Math.min(best, permutation[client])
    }
    return `${state.key}#${String(best)}`
  }

  /** 覚えてある結果だけで答えられるか（開始端末ごと）。 */
  cached(state: CanonicalState, client: number): ProbeVerdict | null {
    if (!this.config.probeMemo) return null
    return this.memo.get(this.memoKey(state, client))?.verdict ?? null
  }

  /**
   * 世界を `startClient` から round-robin で同期して結論を出す。**世界を動かす。**
   *
   * @param trace - 渡すと、回した同期と最後の食い違いを書き留める（使い回しは使わない）
   */
  async run(
    world: World,
    start: CanonicalState,
    startClient: number,
    trace?: ProbeTrace
  ): Promise<ProbeVerdict> {
    this.stats.probes += 1
    // 判定6 は1つの世界の中でしか意味を持たない（{@link JudgmentLedger.beginRun}）
    this.ledger.beginRun()
    const n = this.config.clients
    const limit = this.config.maxProbeRounds * n
    const useMemo = this.config.probeMemo && trace === undefined

    // chain[i] は (状態_i, 次の端末_i) の鍵。状態_0 は開始状態。chain[i] から1回同期すると
    // 状態_{i+1} になる。結論の `syncs` は、ループを抜けた時点では「chain の末尾の次の位置
    // （＝ chain.length）から数えた回数」で持ち、最後に開始からの回数へずらす
    const chain: string[] = []
    const chainStates: string[] = []
    const position = new Map<string, number>()
    let state = start
    let client = startClient
    let verdict: ProbeVerdict

    for (;;) {
      const key = this.memoKey(state, client)
      if (useMemo) {
        const hit = this.memo.get(key)
        if (hit !== undefined) {
          this.stats.memoHits += 1
          verdict = hit.verdict
          break
        }
      }
      const seenAt = position.get(key)
      if (seenAt !== undefined) {
        // 繰り返しに入った。一巡ぶん（seenAt 以降）の状態が全部同じなら不動点
        const cycle = chainStates.slice(seenAt)
        const still = cycle.every((stateKey) => stateKey === state.key)
        if (still) {
          const differing = allDifferingKeys(world, this.config)
          if (differing.keys.length === 0) {
            const tables = TABLE_SETS[this.config.tableSet]
            verdict = {
              ok: true,
              syncs: 0,
              view: viewOf(
                world.clients.map((client) => snapshotData(client.db, tables))
              ),
            }
            if (trace)
              trace.detail = `不動点での見え方: ${verdict.view ?? '（端末ごとに違う）'}`
          } else {
            verdict = {
              ok: false,
              kind: 'silent-divergence',
              syncs: 0,
              summary: `往復しても一致しない行: ${differing.keys.join(', ')}`,
            }
            if (trace) {
              trace.detail = `食い違っている行（updatedAt は julianday）:\n${differing.describe(differing.keys)}`
            }
          }
        } else {
          verdict = {
            ok: false,
            kind: 'oscillation',
            syncs: 0,
            summary: `round-robin の同期が ${String(chain.length - seenAt)} 回周期で状態を行き来し、不動点に届かない`,
          }
          if (trace) {
            trace.detail = `周期 ${String(chain.length - seenAt)} 回の同期で、同じ (状態, 次の端末) へ戻った`
          }
        }
        break
      }
      if (chain.length >= limit) {
        verdict = {
          ok: false,
          kind: 'no-fixpoint',
          syncs: chain.length,
          summary: `${String(limit)} 回同期しても状態が動き続けた（上限 --max-probe-rounds ${String(this.config.maxProbeRounds)} 巡）`,
        }
        if (trace) {
          trace.detail = `上限 ${String(limit)} 回まで同期しても不動点に届かなかった`
        }
        // 上限で打ち切った結論は、途中の組には当てはまらない（残りの回数が違う）ので覚えない
        return verdict
      }

      position.set(key, chain.length)
      chain.push(key)
      chainStates.push(state.key)

      let warnings: string[]
      try {
        this.stats.probeSyncs += 1
        warnings = (
          await applyTransition(this.lib, world, { kind: 'sync', client })
        ).warnings
      } catch (error) {
        trace?.steps.push({ client, warnings: [] })
        verdict = {
          ok: false,
          kind: 'exception',
          syncs: 0,
          summary: `${clientName(client)} の performSync が例外を投げた: ${String(error)}`,
        }
        if (trace) trace.detail = verdict.summary
        break
      }
      trace?.steps.push({ client, warnings })
      const judgment = this.checkJudgments(world)
      if (judgment !== null) {
        verdict = { ok: false, kind: 'judgment', syncs: 0, summary: judgment }
        if (trace) trace.detail = judgment
        break
      }
      const failure = failureWarning(warnings)
      if (failure !== null) {
        verdict = {
          ok: false,
          kind: 'sync-failed',
          syncs: 0,
          summary: `${clientName(client)} の同期で取り込みが失敗として飲み込まれた: ${failure}`,
        }
        if (trace) trace.detail = verdict.summary
        break
      }
      state = this.canonical(world)
      client = (client + 1) % n
    }

    if (useMemo) this.remember(chain, verdict)
    return { ...verdict, syncs: verdict.syncs + chain.length }
  }

  /**
   * 同期のたびに当てる判定（設計書 §8.1）。
   *
   * - **判定7**: アプリの表が UNIQUE・外部キー・NOT NULL・CHECK を満たす（いまの `src/` でも効く）
   * - **判定5・6**: 版を集めて突き合わせる（案A の `_sns_rows_*` が無いうちは何も集まらない）
   *
   * @returns 違反の説明（`null` なら違反なし）
   */
  private checkJudgments(world: World): string | null {
    const tables = TABLE_SETS[this.config.tableSet]
    for (const client of world.clients) {
      const broken = checkAppTables(client.db, tables)
      if (broken !== null) return `${client.id}: ${broken}`
      const violations = this.ledger.observe(
        collectVersions(client.db, client.id, tables)
      )
      if (violations.length > 0) return `${client.id}: ${violations[0]}`
    }
    return null
  }

  /**
   * 列の各組に結論を覚える。組 i からの回数は (列の長さ - i) + 末尾の次からの回数。
   *
   * 繰り返し（不動点・振動）の中の組にも同じ式を当てるが、そこでは回数は
   * 「繰り返しの入口まで」になるので、厳密な回数より多めに出る。回数は反例の短さを
   * 比べるのにしか使わないので、それで構わない。
   */
  private remember(chain: string[], verdict: ProbeVerdict): void {
    // 覚えすぎてメモリを食い潰さないよう、上限を超えたら捨てて覚え直す（捨てても答えは同じ）
    if (this.memo.size > 2_000_000) this.memo.clear()
    chain.forEach((key, index) => {
      const shifted = {
        ...verdict,
        syncs: verdict.syncs + (chain.length - index),
      }
      this.memo.set(key, { verdict: shifted })
      this.fresh.push([key, shifted])
    })
  }

  /** 自分で覚えた分を取り出して空にする。 */
  drainFresh(): [string, ProbeVerdict][] {
    const drained = this.fresh
    this.fresh = []
    return drained
  }

  /**
   * 他のワーカーが覚えた分を取り込む。鍵は正準な並びなので、どのワーカーの世界でも同じ意味。
   * 取り込んだ分は配り直さない（配り直すと往復が際限なく続く）。
   */
  importMemo(entries: [string, ProbeVerdict][]): void {
    if (!this.config.probeMemo) return
    if (this.memo.size > 2_000_000) this.memo.clear()
    for (const [key, verdict] of entries) this.memo.set(key, { verdict })
  }
}
