/**
 * 長い同期の処理の途中で、イベントループへ戻す。
 *
 * @module event-loop
 * @internal
 */

/**
 * 長い処理を、イベントループへ戻らずに続ける時間の目安（ミリ秒）。
 *
 * 自分の写しを作る処理（`src/nas.ts`）と、相手の取り込み（`src/sync/rows-sync.ts`）が使う。
 * 取り込みは区切りごとにトランザクションを確定するが、N100 の Windows で相手8台・9,000 行のフルマージを
 * 10 ms で区切っても、区切らないときより約6%延びるだけだった（止まる時間の最長は約 0.53 秒から約 43 ms）。
 */
export const STEP_MS = 10

/** イベントループへ一度戻す（溜まっている入出力とタイマーを先に通す）。 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
