/**
 * `_id_merge` —— 「この id は、あの id へ、この時刻に畳まれた」というローカル索引。
 *
 * 同期では渡らない（`_` 始まりで自動検出から外れ、リモートからも読まない）。
 * 他端末へ同じ主張を伝えるのは対になる `_tombstone.mergedInto`
 * （`conflict/tombstone`）の役目で、**2つの帳簿は常に同じ勝者・同じ時刻を
 * 名乗っていなければならない**。そのための「主張を置いてよいか」の判断が
 * {@link foldClaimWins} で、断るならどちらの帳簿にも書かない。
 *
 * 記録も行と同じLWWの下に置く、というのがこの層の読み方である。
 *
 * @module conflict/ledger
 * @internal
 */
import Database from 'better-sqlite3';
import { RecordFold } from '../types';
import { NOW_SQL } from '../setup';
import { escapeIdentifier, hasTable } from './schema';
import { isLaterTimestamp, resolveTimestampColumn } from './timestamp';
import { recordTombstoneMerge } from './tombstone';

/**
 * `_id_merge` テーブルを作成する（冪等）。
 *
 * このテーブルは「セカンダリUNIQUE違反を畳んだ結果、どの行がどの行に吸収されたか」を
 * 記録する。あとから届く子の外部キーを、生き残った行へ向け直すために使う。
 * @internal
 */
export function ensureIdMergeTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _id_merge (
      tableName TEXT NOT NULL,
      losingId  TEXT NOT NULL,
      winningId TEXT NOT NULL,
      mergedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      PRIMARY KEY (tableName, losingId)
    )
  `);
}

/**
 * この畳みの主張を、既にある記録の上へ置いてよいか。
 *
 * **2つの帳簿（`_id_merge` と `_tombstone`）は、同じ主張を同じ条件で受け入れる/断る
 * 必要がある。** `_tombstone` 側は {@link TOMBSTONE_CLAIM_WINS} が古い主張を断るので、
 * `_id_merge` 側だけが無条件に受け入れると、**同じ敗者idについて2つの帳簿が別々の
 * 勝者を名乗る**。実測では、6月の `A→B` のあとに1月の `A→C` が届くと
 * `_id_merge = {A→C}` / `_tombstone = {A, mergedInto: B}` となり、`A` の遅れた子は
 * `C` へ送られる一方、他端末には `A→B` と伝わり、さらに
 * {@link isFoldRecordStale} は `C` への主張を `B` の時刻で判定した。
 *
 * したがって判断はここで**一度だけ**下し、断るなら**どちらの帳簿にも書かない**。
 *
 * - `replacesOwnDeletion` — **いま自分がこの畳みのために消した行**。手元で実際に
 *   起きたことなので、記録は現実に従う（断ると、消えた行の子が実在しない勝者を
 *   指したまま残る）
 * - `foldedAt` が無い（本物の削除・公開APIの直接呼び出し）— 主張の時刻は「今」なので
 *   必ず最新
 * - それ以外 — 既にある記録が**厳密に新しい**なら断る。同時刻なら新しい主張が勝つ
 *   （`_tombstone` 側と同じ向き）
 * @internal
 */
function foldClaimWins(
  db: Database.Database,
  tableName: string,
  losingId: string,
  foldedAt: string | undefined,
  replacesOwnDeletion: boolean
): boolean {
  if (replacesOwnDeletion) return true;
  if (foldedAt === undefined) return true;

  const existing = lookupIdMerge(db, tableName, losingId);
  if (existing === null) return true;

  return !isLaterTimestamp(db, existing.mergedAt, foldedAt);
}

/**
 * 「敗者id → 勝者id」を、ローカル索引 `_id_merge` と、他クライアントへ伝わる
 * `_tombstone.mergedInto` の両方に記録する。
 *
 * 既存の記録が今回の敗者を勝者として指していた場合は、その記録も終端（今回の勝者）へ
 * 張り替える。逆に、**今回の勝者が既に畳まれている場合は終端まで辿ってから書く**。
 * 両方そろって初めて、参照は常に1段で解決でき、鎖をたどる必要が無くなる。
 *
 * @param foldedAt - **畳みが確定した時刻**（＝勝った行の `updatedAt`）。
 *   `_id_merge.mergedAt` と `_tombstone.deletedAt` の両方に使う。
 *   同期を回した時刻を書いてはいけない — 帳簿も行と同じLWWの下に置く、というのが
 *   この2つのテーブルの読み方だから（理由は {@link recordTombstoneMerge}）。
 *   省略できるのは**本物の削除**（畳みではない削除）だけで、そのときは現在時刻。
 * @internal
 */
export function recordMerge(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  foldedAt?: string,
  replacesOwnDeletion = false
): void {
  if (losingId === winningId) return;
  ensureIdMergeTable(db);

  // **古い主張は、どちらの帳簿にも書かない。** `_tombstone` 側だけが断ると、2つの
  // 帳簿が別々の勝者を名乗ることになる（理由は {@link foldClaimWins}）。
  if (!foldClaimWins(db, tableName, losingId, foldedAt, replacesOwnDeletion)) {
    return;
  }

  // **勝者が既に畳まれていれば、終端まで辿ってから書く。**
  // 張り替え（下の UPDATE）が直せるのは「**いま**の敗者を勝者として持つ既存の記録」だけで、
  // **あとから届いた記録の勝者が既に畳まれている**場合は直せない。そのまま書くと
  // `A→C` と `C→B` が並ぶ鎖ができ、読み替えが1段で終わらなくなる。実測では、その状態で
  // 届いた `A` の子が**既に消えている `C` へ向けられ、`ON DELETE` に従って捨てられた**。
  winningId = resolveFoldChain(db, tableName, winningId, losingId);
  // 終端が自分自身なら、その畳みはもう意味を持たない
  if (losingId === winningId) return;

  const mergedAt = foldedAt ?? null;

  // 畳み先の鎖を作らない（`A→B` のあとに `B→C` が来たら `A→C` へ張り替える）。
  // **張り替えても「A が畳まれた時刻」は動かさない。** 向き先が変わっただけで、
  // 「A が畳まれた」という事実の時刻は変わらないからである（`collapseIdMergeChains`
  // が鎖を畳み直すときと同じ扱い）。過去へ引き戻さないのはもちろん、**新しい方へ
  // 進めてもいけない**: 張り替えは `_id_merge` にしか届かず、対になる
  // `_tombstone.deletedAt`（{@link recordTombstoneMerge} が書く）は `A` 自身の畳みの
  // 時刻のまま残るので、進めると2つの帳簿が食い違う。実測では、1月に畳まれた `A` が
  // 6月の `B→C` の巻き添えで `_id_merge` だけ6月になり、3月版の `A` が
  // `isShadowedByTombstone`（1月より新しい）を通って復活する一方、
  // `isFoldRecordStale`（6月より古い）は畳みを有効と見たため、**`A` が生きたまま
  // その子だけ `C` へ読み替えられた**。
  db.prepare(
    `UPDATE _id_merge
     SET winningId = ?
     WHERE tableName = ? COLLATE NOCASE AND winningId = ?`
  ).run(winningId, tableName, losingId);

  // ここへ来た時点で「この主張を置いてよい」は決まっている（{@link foldClaimWins}）。
  // **勝者と時刻は組で置く。** 片方だけ条件付きにすると、勝者だけが新しい主張、時刻は
  // 古い主張のまま、という組み合わせが生まれ、`_tombstone` との突き合わせが壊れる。
  db.prepare(
    `INSERT INTO _id_merge (tableName, losingId, winningId, mergedAt)
     VALUES (?, ?, ?, COALESCE(?, ${NOW_SQL}))
     ON CONFLICT(tableName, losingId)
     DO UPDATE SET
       winningId = excluded.winningId,
       mergedAt = excluded.mergedAt`
  ).run(tableName, losingId, winningId, mergedAt);

  // 畳む向きが後から反転した場合（敗者idの方に新しい更新が届き、勝者を畳んだ場合）、
  // 上の張り替えで自分自身を指す記録が生まれる。意味を持たないので捨てる。
  db.prepare(
    `DELETE FROM _id_merge WHERE tableName = ? COLLATE NOCASE AND losingId = winningId`
  ).run(tableName);

  recordTombstoneMerge(
    db,
    tableName,
    losingId,
    winningId,
    foldedAt,
    replacesOwnDeletion
  );
}

/**
 * 呼び出し元へ返す畳みの一覧へ1件足す（`_id_merge` への記録と対になる）。
 *
 * `_id_merge` と同じく**畳み先の鎖を作らない**: 今回の敗者を勝者として持っていた
 * 記録は、今回の勝者へ張り替える。同じ敗者が二度畳まれた場合も、記録は1件のまま
 * 終端の勝者を指す（呼び出し元は行が消えた件数をこの一覧から数えるため、
 * 同じ行を二度数えてはいけない）。
 *
 * @param movedChildren - この畳みで付け替えた**直接の子**の行数。同じ敗者へ二度目の
 *   記録が来た場合は足し合わせる（子の付け替えは再入のたびには起きないので、
 *   ふつう二度目は 0）。
 * @param lostChildren - この畳みで**引き継げずに失われた**直接の子の行数
 *   （{@link RecordFold.lostChildren}）。
 * @internal
 */
export function recordFold(
  folds: RecordFold[],
  tableName: string,
  losingId: string,
  winningId: string,
  removedLocalRow: boolean,
  movedChildren: number,
  lostChildren: number
): void {
  if (losingId === winningId) return;

  for (const fold of folds) {
    if (fold.tableName === tableName && fold.winningId === losingId) {
      fold.winningId = winningId;
    }
  }

  const existing = folds.find(
    (fold) => fold.tableName === tableName && fold.losingId === losingId
  );
  if (existing) {
    existing.winningId = winningId;
    existing.removedLocalRow = existing.removedLocalRow || removedLocalRow;
    existing.movedChildren += movedChildren;
    existing.lostChildren += lostChildren;
    return;
  }

  folds.push({
    tableName,
    losingId,
    winningId,
    removedLocalRow,
    movedChildren,
    lostChildren,
  });
}



/**
 * `_id_merge` に1件でも記録があるか。
 *
 * 競合が一度も起きていないDB（大多数）ではここで打ち切り、外部キーの走査をしない。
 * @internal
 */
export function hasIdMerges(db: Database.Database): boolean {
  if (!hasTable(db, '_id_merge')) return false;
  return db.prepare(`SELECT 1 FROM _id_merge LIMIT 1`).get() !== undefined;
}

/**
 * 畳みの記録1件。「この id は、あの id へ、この時刻に畳まれた」。
 * @internal
 */
export interface IdMergeRecord {
  /** 吸収先のid */
  winningId: string;
  /** 畳みが確定した時刻（＝勝った行の `updatedAt`。{@link recordMerge}） */
  mergedAt: string;
}

/**
 * 畳まれて消えた行のidの記録を引く。記録が無ければ null。
 *
 * 時刻まで返すのは、記録も**主張**であって永久の真理ではないため。あとから届いた
 * 敗者行の方が新しければ、その記録はもう古い判断であり、読み替えに使ってはいけない
 * （{@link isFoldRecordStale}）。
 * @internal
 */
export function lookupIdMerge(
  db: Database.Database,
  tableName: string,
  losingId: string
): IdMergeRecord | null {
  const row = db
    .prepare(
      `SELECT winningId, mergedAt FROM _id_merge
       WHERE tableName = ? COLLATE NOCASE AND losingId = ?`
    )
    .get(tableName, losingId) as
    | { winningId: string; mergedAt: string }
    | undefined;
  return row
    ? { winningId: String(row.winningId), mergedAt: String(row.mergedAt) }
    : null;
}

/**
 * 畳み先を、既に畳まれているぶんだけ終端まで辿る。
 *
 * `_tombstone.mergedInto` は**同期で他の端末へ渡る**ため、`A→C` と `C→B` のような鎖が
 * そのまま届く（実測）。届いた畳み先をそのまま使うと、中間の `C` は既に死んでいるので
 * 「畳み先が見つからない」と判断して**敗者行を畳めない**。終端の `B` まで辿れば畳める。
 *
 * 既訪問idを持って打ち切るので、記録に循環があっても止まらない。
 * @internal
 */
export function resolveFoldChain(
  db: Database.Database,
  tableName: string,
  winningId: string,
  losingId: string
): string {
  const seen = new Set<string>([losingId, winningId]);
  let terminal = winningId;
  for (;;) {
    const next = lookupIdMerge(db, tableName, terminal);
    if (next === null || seen.has(next.winningId)) return terminal;
    seen.add(next.winningId);
    terminal = next.winningId;
  }
}

/**
 * 畳みの記録が、もう古い判断になっていないか。
 *
 * **比較相手はローカルの敗者行であって、届いた子ではない。** 子と比べると、まだ敗者行が
 * 復活していない端末では「記録の方が古い」と判定されて読み替えが行われず、子が存在
 * しない親を指したまま入る（外部キー違反で、その相手ぶんの取り込みが丸ごと巻き戻る）。
 * 畳みが有効かどうかは畳まれた当人の版だけで決まるので、
 * {@link applyMergedDelete} が畳みを適用するかどうかに使っている物差しと同じにする。
 *
 * 敗者行がローカルに無ければ「まだ有効」（畳みに反する証拠がどこにも無い）。
 * @internal
 */
export function isFoldRecordStale(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingId: string,
  mergedAt: string,
  timestampColumn: string
): boolean {
  if (!hasTable(db, tableName)) return false;

  const losingTimestampColumn = resolveTimestampColumn(
    db,
    tableName,
    timestampColumn
  );
  if (!losingTimestampColumn) return false;

  const losingRow = db
    .prepare(
      `SELECT ${escapeIdentifier(losingTimestampColumn)} AS ts
       FROM ${escapeIdentifier(tableName)}
       WHERE ${escapeIdentifier(primaryKey)} = ?`
    )
    .get(losingId) as { ts: unknown } | undefined;
  if (!losingRow) return false;

  return isLaterTimestamp(db, String(losingRow.ts ?? ''), mergedAt);
}
