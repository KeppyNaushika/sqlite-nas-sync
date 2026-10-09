/**
 * 手元へ写した DB の整合性検査（`PRAGMA integrity_check`）。
 *
 * 検査は写しを**全部**読むので、写しの大きさに比例して時間がかかる（N100 の
 * Windows で 5 MB あたり約 30 ms）。同期を呼んだスレッドで行うと、そのあいだ
 * イベントループが止まる —— Electron の主プロセスなら画面が応答しない。
 * そこで、ワーカー（`src/worker-host.ts`）で検査する。
 *
 * **ワーカーが答えを返さなければ、呼んだスレッドで検査する。** 検査そのものは
 * 飛ばさない。飛ばすと、NAS から読みかけの壊れた写しを取り込みうる。止まるほうがまし。
 *
 * @module integrity
 * @internal
 */
import Database from 'better-sqlite3'
import type { SyncWorker } from './worker-host'

/**
 * 呼んだスレッドで検査する。
 *
 * @returns `PRAGMA integrity_check` の結果（問題が無ければ `'ok'`）
 */
export function checkIntegrityOnThisThread(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.pragma('integrity_check', { simple: true }) as string
  } finally {
    db.close()
  }
}

/**
 * 検査する。`worker` があればそこで、答えが返らなければ呼んだスレッドで行う。
 *
 * @returns `PRAGMA integrity_check` の結果（問題が無ければ `'ok'`）
 * @throws 写しを開けない・DB でないとき（呼んだスレッドで検査したときの例外）
 */
export async function checkIntegrity(
  dbPath: string,
  worker?: SyncWorker
): Promise<string> {
  if (worker !== undefined) {
    const outcome = await worker.run({ kind: 'integrity-check', dbPath })
    if (outcome.done) return outcome.value
  }
  return checkIntegrityOnThisThread(dbPath)
}
