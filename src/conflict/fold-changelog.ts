/**
 * 畳みを**通常の差分経路（`_changelog`）にも載せる**ための書き込み。
 *
 * 畳みがフルマージ（changelogの隙間を検出したときの経路）でしか渡らないと、
 * 隙間ができるのは保持期間を超えて同期しなかった端末だけなので、**行儀よく毎日
 * 同期している端末ほど受け取れない**という逆転になる。ここはその逆転を塞ぐ。
 *
 * @module conflict/fold-changelog
 * @internal
 */
import Database from 'better-sqlite3';
import { NOW_SQL } from '../setup';
import { hasTable } from './schema';
import { ensureIdMergeTable, lookupIdMerge, recordMerge } from './ledger';

/**
 * `_changelog` の現在の最大id。`_changelog` を持たないDBでは null。
 * @internal
 */
export function maxChangelogId(db: Database.Database): number | null {
  if (!hasTable(db, '_changelog')) return null;
  const row = db.prepare(`SELECT MAX(id) AS maxId FROM _changelog`).get() as {
    maxId: number | null;
  };
  return row.maxId ?? 0;
}

/**
 * `_changelog` に、そのレコードのDELETEが載っているか。
 *
 * @param sinceId - 指定するとそのidより後のエントリだけを数える。「今起こした削除で
 *   トリガーが記録したか」を見るときに使う（ずっと前の削除と取り違えないように）。
 * @internal
 */
export function hasChangelogDelete(
  db: Database.Database,
  tableName: string,
  recordId: string,
  sinceId: number = 0
): boolean {
  if (!hasTable(db, '_changelog')) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM _changelog
       WHERE tableName = ? COLLATE NOCASE AND recordId = ?
         AND operation = 'DELETE' AND id > ?`
    )
    .get(tableName, recordId, sinceId);
  return row !== undefined;
}

/**
 * 畳んで消えたidのDELETEを `_changelog` へ手で書く。
 *
 * 畳みは**通常の差分経路にも乗せる**必要がある。フルマージ（changelogの隙間を検出した
 * ときの経路）でしか渡らないと、隙間ができるのは保持期間を超えて同期しなかった端末だけ
 * なので、**行儀よく毎日同期している端末ほど受け取れない**という逆転になる。
 *
 * `_changelog` は既に「自分が自分の行に行った操作の記録」ではない
 * （フルマージが相手のエントリをそのまま自分の changelog へ複製する）ので、
 * 自分が持っていない行のエントリが載ること自体は元から起きている。
 *
 * `changedAt` は「記録した今」にする（トリガーと同じ）。畳みの時刻を入れると、それが
 * 保持期間より古いときに**生まれた直後の掃除で消え、二度と載らない**。受け取る側のLWWは
 * `_changelog.changedAt` ではなく `_tombstone.deletedAt` を見るので、判断はぶれない。
 *
 * tombstone を書けていない場合は書かない（畳み先の無い削除として届くと、
 * 受け取った側で子が道連れになる）。
 * @internal
 */
export function writeFoldDeletion(
  db: Database.Database,
  tableName: string,
  losingId: string
): void {
  if (!hasTable(db, '_changelog')) return;
  if (!hasTable(db, '_tombstone')) return;

  const tombstone = db
    .prepare(
      `SELECT 1 FROM _tombstone
       WHERE tableName = ? COLLATE NOCASE AND recordId = ?`
    )
    .get(tableName, losingId);
  if (!tombstone) return;

  db.prepare(
    `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
     VALUES (?, ?, 'DELETE', ${NOW_SQL})`
  ).run(tableName, losingId);
}

/**
 * 敗者行をローカルに持っていない側（`local_wins`）で畳みを記録する。
 *
 * この側では敗者行のDELETEが起きないため、DELETEトリガーによる `_changelog` の記録も
 * 生まれない。{@link writeFoldDeletion} で1行だけ手書きし、通常の差分経路にも乗せる。
 *
 * @param winningTimestamp - 勝ち残ったローカル行のタイムスタンプ。tombstone の
 *   `deletedAt` に使う（理由は {@link recordTombstoneMerge}）。
 * @internal
 */
export function recordMergeWithoutLocalRow(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  winningTimestamp?: string
): void {
  // 参照する前に用意する（`_id_merge` がまだ無いDBでも動くように）
  ensureIdMergeTable(db);
  const alreadyRecorded =
    lookupIdMerge(db, tableName, losingId)?.winningId === winningId;

  recordMerge(db, tableName, losingId, winningId, winningTimestamp);

  // 同じエントリが増え続けないように、既に公開済みなら書かない。
  // 「`_id_merge` に記録済み」だけを根拠にはしない — 記録が残ったまま `_changelog` の側が
  // 掃除で消えていたり、`_changelog` がまだ無いDBで記録だけ先に入っていたりして、
  // それだと畳みが二度と差分経路に載らなくなる。
  if (alreadyRecorded && hasChangelogDelete(db, tableName, losingId)) return;

  writeFoldDeletion(db, tableName, losingId);
}


