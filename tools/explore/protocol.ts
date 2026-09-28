/**
 * 親（tools/explore-convergence.ts）とワーカー（tools/explore-worker.ts）のあいだで
 * 流すメッセージ。
 *
 * 形を1か所で決めておく（親と子で別々に書くと、片方だけ直したときに
 * 「反例が届かない」「進捗が出ない」が黙って起きる）。
 *
 * @module tools/explore/protocol
 */
import { ExploreConfig } from './config'
import type { History, ViewInfo } from './history'
import { ProbeVerdict, ViolationKind } from './probe'

/** 探索の節。`path` は遷移の添字の列（{@link enumerateTransitions} の並び）。 */
export type FrontierNode = {
  path: number[]
  /** 端末ごとの、発行した操作の列（history.ts）。子の鍵を節ごとに計算するのに要る */
  history: History
  /**
   * 正規化した状態の鍵（state.ts の CanonicalState.key）。同じ状態の節を1つの組にまとめて
   * 遷移を1回だけ実行する（tools/explore-worker.ts の expand）、再生して同じ状態に戻ったかを
   * 確かめる、見え方を引く、の3つに使う
   */
  stateKey: string
  /** この列の世界での「次に操作してよい端末」（reduction.ts の PorMask） */
  mask: number
  /**
   * 重複排除の鍵 = 状態の鍵 + 発行した操作の列の鍵（tools/explore/history.ts）。
   * 状態だけで畳むと、違う操作の列から同じ状態へ合流した列の片方を見失い、
   * 「同じ操作なら挟み方によらず同じ見え方」を調べ落とす
   */
  key: string
}

/** 展開の仕事の単位。 */
export type ExpandUnit = { nodes: FrontierNode[]; from: number; to: number }

/** 検査の結果の覚え（(状態, 次の端末) の鍵 → 結論）。 */
export type MemoEntry = [string, ProbeVerdict]

/** 重複排除の単位（鍵と、次に操作してよい端末の集合）。 */
export type SeenEntry = { key: string; stateKey: string; mask: number }

export type Violation = {
  kind: ViolationKind
  /** 反例に至る遷移の添字の列 */
  path: number[]
  /** 違反の要約 */
  summary: string
  /** 検査の同期で見つかった場合、何番目の端末から round-robin したか（遷移で見つかった場合は null） */
  probeStart: number | null
  /** 検査で回した同期の回数 */
  probeSyncs: number
  /** 人が読める再現手順（ワーカーが再生し直して書く） */
  report: string
}

export type WorkerStats = {
  /** 当てた遷移の数（重複で捨てたものを含む） */
  transitions: number
  /** 順序の畳み込みで当てずに済んだ遷移の数 */
  porSkipped: number
  /** ワーカーの手元で重複と分かって捨てた子の数 */
  localDuplicates: number
  /** 収束の検査を回した回数 / 検査で回した同期の回数 / 使い回しで打ち切った回数 */
  probes: number
  probeSyncs: number
  memoHits: number
  /** 列を再生したら、見つけたときと違う状態になった回数（同期の中の時刻の揺れ） */
  replayMismatches: number
}

export type ToWorker =
  | { type: 'init'; config: ExploreConfig; workDir: string }
  /**
   * 節を展開する。`from`〜`to`（含まない）は当てる遷移の添字の範囲。節の少ない層では
   * 1つの節の遷移を範囲に分けて複数のワーカーへ配る（根の層は節が1つしか無い）
   */
  | { type: 'expand'; work: ExpandUnit[] }
  /**
   * 他のワーカーが見つけた状態と、検査の結果の覚え。**層の終わりを待たずに**配る
   * （待つと、同じ層で同じ状態を何度も検査し、並列度を上げても縮まない。実測）
   */
  | {
      type: 'share'
      seen: SeenEntry[]
      memo: MemoEntry[]
      /** 状態の鍵 → 見え方の記録（history.ts の ViewInfo） */
      views: [string, ViewInfo][]
    }
  /** 挟み方の違う2つの列について、再現手順と見え方を書いてもらう */
  | {
      type: 'describe'
      runs: { path: number[]; start: number }[]
      summary: string
    }
  | { type: 'stop' }

export type FromWorker =
  | { type: 'ready'; rootKey: string }
  | {
      type: 'expanded'
      children: (FrontierNode & {
        /** 発行した操作の列の鍵 */
        historyKey: string
        /** アプリが受け取った結果も含めた操作の列の鍵 */
        statusKey: string
        /** 見え方を突き合わせてよい履歴か（history.ts の「比べない履歴」に当たらないか） */
        comparable: boolean
        /** 見え方の記録（分かっていれば。undefined は未確定か違反） */
        view?: ViewInfo
      })[]
      violations: Violation[]
      stats: WorkerStats
      /** 再生して違う状態に戻った節の列（原因を調べるための見本。数件まで） */
      mismatchExamples: number[][]
      /** この展開で新しく覚えた検査の結果（親が他のワーカーへ配る） */
      memo: MemoEntry[]
    }
  | { type: 'described'; report: string }
  | { type: 'error'; message: string }
