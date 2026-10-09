/**
 * 同期の重い読み取りを行うワーカーの入口。
 *
 * このファイルは**ワーカーの入口**で、他から `import` して使うものではない
 * （`src/worker-host.ts` の `createSyncWorker` が `new Worker(...)` で起動する）。
 * 届いた順に1件ずつ行い、`id` を付けて答えを返す。
 *
 * **`defaultSafeIntegers(true)` は接続に立てない。** 立てると `PRAGMA` の
 * 戻り値（`hidden`・`pk`・`seq` など）まで `BigInt` になり、`=== 0` の判定が
 * 黙って外れて、生成列が普通の列として扱われる。大きい整数を守るのは
 * **文ごとの `safeIntegers(true)`**（`src/rows/rebuild-plan.ts`）の役目である。
 *
 * @module worker
 * @internal
 */
import Database from 'better-sqlite3'
import { parentPort } from 'node:worker_threads'
import { checkIntegrityOnThisThread } from './integrity'
import { computeRebuildPlan } from './rows/rebuild-plan'
import type { WorkerRequest, WorkerResponse, WorkerTask } from './worker-host'

/** 仕事を1つ行う。 */
function perform(task: WorkerTask): unknown {
  switch (task.kind) {
    case 'integrity-check':
      return checkIntegrityOnThisThread(task.dbPath)
    case 'rebuild-plan': {
      // 手元の DB（WAL が前提）を読み取り専用で開く
      const db = new Database(task.dbPath, { readonly: true })
      try {
        return computeRebuildPlan(db, task.options)
      } finally {
        db.close()
      }
    }
  }
}

void (function main(): void {
  const port = parentPort
  if (port === null) return
  port.on('message', (request: WorkerRequest) => {
    try {
      port.postMessage({
        id: request.id,
        ok: true,
        value: perform(request.task),
      } satisfies WorkerResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        message: String((error as Error).message),
        sqlite: error instanceof Database.SqliteError,
      } satisfies WorkerResponse)
    }
  })
})()
