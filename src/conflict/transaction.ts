/**
 * 書き込みを、途中でやめても片方だけ残らない形に包む。
 *
 * 外部キーの**検査**をトランザクション終端まで遅らせる（`PRAGMA defer_foreign_keys`）。
 * 制約を切るのではなく検査を遅らせるだけなので、COMMIT時に矛盾が残っていれば
 * 通常どおり失敗する。
 *
 * @module conflict/transaction
 * @internal
 */
import Database from 'better-sqlite3'

/**
 * 外部キーの検査をトランザクション終端まで遅らせて処理を実行する。
 *
 * 既にトランザクションの中ならそこへ相乗りする（pragmaは外側のCOMMITまで効く）。
 * トランザクションの外では pragma が効かない（文ごとに暗黙のCOMMITが起きる）ため、
 * ここで張る。
 * @internal
 */
export function runDeferringForeignKeys<T>(
  db: Database.Database,
  apply: () => T
): T {
  const run = (): T => {
    db.pragma('defer_foreign_keys = ON')
    return apply()
  }

  if (db.inTransaction) return run()
  return db.transaction(run)()
}

/**
 * 自分だけの区切り（SAVEPOINT）を張って処理を実行する。外部キーの検査は終端まで遅らせる。
 *
 * {@link runDeferringForeignKeys} と違い、**既にトランザクションの中でも外側へ相乗り
 * しない**（better-sqlite3 の入れ子トランザクションは SAVEPOINT になる）。途中で例外を
 * 投げれば、この区切りで行ったぶんだけが巻き戻り、外側の取り込みはそのまま続けられる。
 *
 * 「畳んでから書き込む」ような、**途中でやめると片方だけ残る**処理に使う。
 * @internal
 */
export function runInSavepoint<T>(db: Database.Database, apply: () => T): T {
  return db.transaction((): T => {
    db.pragma('defer_foreign_keys = ON')
    return apply()
  })()
}
