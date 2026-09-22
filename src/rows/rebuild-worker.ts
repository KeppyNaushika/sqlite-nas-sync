/**
 * 作り直しの計算を `worker_threads` の中で行う（設計書
 * `docs/rows-table-design.md` §3.7.1）。
 *
 * このファイルは**ワーカーの入口**で、他から `import` して使うものではない
 * （`src/rows/rebuild.ts` の `computeRebuildPlanInWorker` が `new Worker(...)`
 * で起動する）。
 *
 * **`defaultSafeIntegers(true)` は接続に立てない。** 立てると `PRAGMA` の
 * 戻り値（`hidden`・`pk`・`seq` など）まで `BigInt` になり、`=== 0` の判定が
 * 黙って外れて、生成列が普通の列として扱われる。大きい整数を守るのは
 * **文ごとの `safeIntegers(true)`**（`src/rows/rebuild-plan.ts`）の役目である。
 *
 * @module rows/rebuild-worker
 * @internal
 */
import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'
import { RebuildPlanOptions, computeRebuildPlan } from './rebuild-plan'

/** 主スレッドから渡されるもの。 */
export interface RebuildWorkerInput {
  /** 読み取り専用で開く DB の位置（WAL が前提） */
  dbPath: string
  options: RebuildPlanOptions
}

/** 主スレッドへ返すもの。 */
export type RebuildWorkerOutput =
  { ok: true; plan: unknown } | { ok: false; message: string }

void (function main(): void {
  const input = workerData as RebuildWorkerInput | undefined
  if (parentPort === null || input === undefined) return
  try {
    const db = new Database(input.dbPath, { readonly: true })
    try {
      const plan = computeRebuildPlan(db, input.options)
      parentPort.postMessage({ ok: true, plan } satisfies RebuildWorkerOutput)
    } finally {
      db.close()
    }
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: String((error as Error).message),
    } satisfies RebuildWorkerOutput)
  }
})()
