/**
 * 同期の重い読み取りを `worker_threads` で行うための窓口。
 *
 * ワーカーで行うのは2つ:
 *
 * | 仕事 | 中身 | 呼ぶところ |
 * | --- | --- | --- |
 * | `integrity-check` | 手元へ写した DB の `PRAGMA integrity_check` | `src/integrity.ts` |
 * | `rebuild-plan` | 作り直しの計算（設計書 §3.7.1） | `src/rows/rebuild.ts` |
 *
 * どちらも DB を全部読むので、大きさに比例して長くなる。同期を呼んだスレッドで行うと、
 * そのあいだイベントループが止まる —— Electron の主プロセスなら画面が応答しない。
 *
 * **ワーカーが答えを返さなかったら、呼んだスレッドで同じ仕事をやり直す。** 窓口は
 * 答えか「返せなかった」かだけを返し、やり直すのは呼ぶ側である。返せない理由は問わない:
 * 入口の JS が無い（TypeScript のまま走らせている・束ねられている）、起動できない
 * （Electron の asar の中など）、ネイティブアドオンをワーカーで読み込めない、
 * 途中で落ちた、仕事が例外で終わった。答えを決めるのはいつも呼んだスレッドでの結果なので、
 * ワーカーの側の事情で答えが変わることは無い。壊れた写しは、呼んだスレッドで
 * もう一度検査して壊れていると分かる。
 *
 * ワーカーそのものが使えないと分かったら（SQLite 以外の例外、起動の失敗、終了）、
 * その窓口ではもう使わない。毎回起動に失敗するのを繰り返さないためである。
 * SQLite の例外（写しが壊れている・開けない）は仕事の側の問題なので、ワーカーは使い続ける。
 *
 * **寿命は `SyncInstance` と同じ**で、起こすのは最初の仕事のときである。同期を
 * またいで使い回すので、起動（ネイティブアドオンの読み込みを含む）は1回で済む。
 * ワーカーを1度も使わなかった同期の終わりに止める（{@link SyncWorker.endSync}）。
 * 何も書かれていない間はワーカーを残さない。仕事を待っていない間は `unref` しておき、
 * アプリが `close` を呼ばずに終わろうとしても、プロセスを引き止めない。
 *
 * @module worker-host
 * @internal
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { RebuildPlan, RebuildPlanOptions } from './rows/rebuild-plan'

/** ワーカーへ頼む仕事。 */
export type WorkerTask =
  | { kind: 'integrity-check'; dbPath: string }
  | { kind: 'rebuild-plan'; dbPath: string; options: RebuildPlanOptions }

/** 仕事ごとの答えの型。 */
export interface WorkerAnswers {
  /** `PRAGMA integrity_check` の結果（問題が無ければ `'ok'`） */
  'integrity-check': string
  /** 構造化複製を通った計画（BLOB は `Uint8Array`。`reviveRebuildPlan` で戻す） */
  'rebuild-plan': RebuildPlan
}

/** {@link SyncWorker.run} の結果。`done` が偽なら、呼んだスレッドでやり直す。 */
export type WorkerOutcome<T> = { done: true; value: T } | { done: false }

/** ワーカーへ送るもの。 */
export interface WorkerRequest {
  id: number
  task: WorkerTask
}

/** ワーカーから返るもの。 */
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | {
      id: number
      ok: false
      message: string
      /** SQLite の例外か（偽ならワーカーそのものの問題とみなす） */
      sqlite: boolean
    }

/** 同期の重い読み取りの窓口。 */
export interface SyncWorker {
  /** 仕事を頼む。ワーカーが答えを返さなければ `{ done: false }` */
  run<K extends WorkerTask['kind']>(
    task: Extract<WorkerTask, { kind: K }>
  ): Promise<WorkerOutcome<WorkerAnswers[K]>>
  /** 同期1回の終わり。その同期でワーカーを使わなかったら止める */
  endSync(): Promise<void>
  /** ワーカーを止め、以後は使わない。2回目以降は何もしない */
  close(): Promise<void>
}

/** {@link createSyncWorker} の設定。 */
export interface SyncWorkerOptions {
  /**
   * ワーカーの入口の位置。既定は同じ場所の `worker.js`
   * （`dist/` では隣にある。試験からは、組み上げた JS を指す）
   */
  workerPath?: string
  /** ワーカーを使わない（試験・網羅検査器）。`run` はいつも `{ done: false }` を返す */
  forceMainThread?: boolean
}

/** 窓口を作る。ワーカーは最初の仕事のときに起こす。 */
export function createSyncWorker(options: SyncWorkerOptions = {}): SyncWorker {
  const workerPath = options.workerPath ?? join(__dirname, 'worker.js')
  /** ワーカーを使えるか。`null` はまだ確かめていない */
  let usable: boolean | null = options.forceMainThread === true ? false : null
  let worker: Worker | null = null
  /** この同期でワーカーを使ったか */
  let used = false
  let nextId = 1
  const pending = new Map<number, (outcome: WorkerOutcome<unknown>) => void>()

  const settle = (id: number, outcome: WorkerOutcome<unknown>): void => {
    const resolve = pending.get(id)
    if (resolve === undefined) return
    pending.delete(id)
    if (pending.size === 0) worker?.unref()
    resolve(outcome)
  }

  /**
   * ワーカーそのものが使えない（または閉じる）。待っている仕事はすべて呼んだスレッドへ返す。
   * 戻り値はワーカーが止まり終わるまで
   */
  const giveUp = async (): Promise<void> => {
    usable = false
    const running = worker
    worker = null
    for (const resolve of pending.values()) resolve({ done: false })
    pending.clear()
    if (running !== null) await running.terminate()
  }

  const start = (): Worker => {
    const started = new Worker(workerPath)
    started.on('message', (response: WorkerResponse) => {
      if (worker !== started) return
      if (response.ok) {
        settle(response.id, { done: true, value: response.value })
        return
      }
      settle(response.id, { done: false })
      if (!response.sqlite) void giveUp()
    })
    started.on('error', () => {
      if (worker === started) void giveUp()
    })
    started.on('exit', () => {
      if (worker === started) void giveUp()
    })
    return started
  }

  return {
    run<K extends WorkerTask['kind']>(
      task: Extract<WorkerTask, { kind: K }>
    ): Promise<WorkerOutcome<WorkerAnswers[K]>> {
      usable ??= existsSync(workerPath)
      if (!usable) return Promise.resolve({ done: false })
      used = true
      let running = worker
      if (running === null) {
        try {
          running = start()
        } catch {
          void giveUp()
          return Promise.resolve({ done: false })
        }
        worker = running
      }
      const id = nextId++
      const target = running
      return new Promise<WorkerOutcome<WorkerAnswers[K]>>((resolve) => {
        pending.set(id, resolve as (outcome: WorkerOutcome<unknown>) => void)
        // 待っている間だけプロセスを引き止める（答えを待たずに終わらないように）
        target.ref()
        try {
          target.postMessage({ id, task } satisfies WorkerRequest)
        } catch {
          settle(id, { done: false })
        }
      })
    },

    async endSync(): Promise<void> {
      const keep = used
      used = false
      if (keep || worker === null || pending.size > 0) return
      const running = worker
      worker = null
      await running.terminate()
    },

    close(): Promise<void> {
      return giveUp()
    },
  }
}
