/**
 * 畳みの帳簿 —— `_id_merge` / `_tombstone` / `_changelog` への記録と読み取り。
 *
 * 「この id は、あの id へ、この時刻に畳まれた」という**主張**を書き、読み、
 * それがまだ有効かを判断する。記録も行と同じLWWの下に置く、というのがこの層の読み方。
 *
 * @module conflict/ledger
 * @internal
 */
import Database from 'better-sqlite3';
import { RecordFold } from '../types';
import { ensureTombstoneMergedIntoColumn, NOW_SQL } from '../setup';
import { escapeIdentifier, hasTable } from './schema';
import { isLaterTimestamp, resolveTimestampColumn } from './timestamp';

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
  // **張り替えても「A が畳まれた時刻」は変わらない。** 新しい畳みの時刻をそのまま置くと、
  // それが古いときに既存の記録が過去へ引き戻され、`isFoldRecordStale` の判定が変わる
  // （実測: 6月に確定した `A→B` が、1月の `B→C` の巻き添えで1月へ戻った）。遅い方を採る。
  db.prepare(
    `UPDATE _id_merge
     SET winningId = ?,
         mergedAt = CASE
           WHEN COALESCE(
                  julianday(COALESCE(?, ${NOW_SQL})) > julianday(mergedAt),
                  COALESCE(?, ${NOW_SQL}) > mergedAt
                )
           THEN COALESCE(?, ${NOW_SQL})
           ELSE mergedAt
         END
     WHERE tableName = ? COLLATE NOCASE AND winningId = ?`
  ).run(winningId, mergedAt, mergedAt, mergedAt, tableName, losingId);

  // **`mergedAt` は巻き戻さない。** 同じ畳みが違う時刻を名乗って二度届くことがある
  // （相手の `_tombstone.deletedAt` が旧版で書かれていた場合など）。あとから来た方を
  // そのまま置くと記録だけが過去へ戻り、`_tombstone.deletedAt`（{@link
  // TOMBSTONE_CLAIM_WINS} が守っている）との間で食い違う。そうなると
  // {@link isFoldRecordStale} がその間に居る敗者行を「記録より新しい」と見て読み替えを
  // やめ、遅れて届いた子が**存在しない親を指したまま入り**、COMMIT時の外部キー検査で
  // その相手ぶんの取り込みが丸ごと巻き戻る。上の張り替えと同じく遅い方を採る。
  db.prepare(
    `INSERT INTO _id_merge (tableName, losingId, winningId, mergedAt)
     VALUES (?, ?, ?, COALESCE(?, ${NOW_SQL}))
     ON CONFLICT(tableName, losingId)
     DO UPDATE SET
       winningId = excluded.winningId,
       mergedAt = CASE
         WHEN COALESCE(
                julianday(excluded.mergedAt) > julianday(_id_merge.mergedAt),
                excluded.mergedAt > _id_merge.mergedAt
              )
         THEN excluded.mergedAt
         ELSE _id_merge.mergedAt
       END`
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
 * `_tombstone` の既存行を、いま書こうとしている記録で置き換えてよいか（SQLの条件式）。
 *
 * 「既存より古い主張では上書きしない」。ただし**自分がいま消した行**
 * （`replacesOwnDeletion`）だけは、DELETEトリガが書いた現在時刻を畳みの時刻で
 * 置き直す必要があるので無条件に通す。
 * @internal
 */
export const TOMBSTONE_CLAIM_WINS = `(
  ? = 1
  OR NOT COALESCE(
       julianday(_tombstone.deletedAt) > julianday(excluded.deletedAt),
       _tombstone.deletedAt > excluded.deletedAt
     )
)`;

/**
 * 畳み先を `_tombstone` に載せる（他クライアントへはこの列で伝わる）。
 *
 * - `remote_wins`（敗者行を削除した側）— DELETEトリガーが作った行に畳み先を書き込む。
 *   トリガーは `INSERT OR REPLACE` なので、**削除より後に**呼ぶこと。
 * - `local_wins`（敗者行を持っていない側）— 削除が起きないので行ごと新しく書く。
 *   敗者idは全クライアントで永久に死んでいるため、tombstoneとして正しい。
 *
 * `foldedAt` には**畳みが確定した時刻**（＝勝った行の `updatedAt`）を入れる。
 * 同期を回した時刻を刻んではいけない。実データの `updatedAt` は必ずそれより過去なので、
 * {@link isShadowedByTombstone} がその id の到着を無条件に止め、**勝者より新しい版を
 * 持っていた端末ごと**黙って捨てることになる。勝者のタイムスタンプなら
 * 「畳みに負けた版より新しいものだけ通す」というLWWそのものの意味になる。
 *
 * **`foldedAt` の有無が、本物の削除と畳みを分ける境目である。**
 *
 * - `foldedAt` あり（畳み）— その値を**置く**。進めるのではない。
 *   敗者行を実際に消した側では、DELETEトリガーが先に `now` を書いてしまっているため、
 *   「新しい方へ進める」では畳みの時刻が必ず負けて上書きできない。それでは畳んだ側と
 *   畳まなかった側が同じ1回の畳みに違う時刻を刻み、しきい値が端末ごとにずれる
 *   （しかも片方は現在時刻＝最強のしきい値になる）
 * - `foldedAt` なし（本物の削除）— 現在時刻を入れ、既存の記録があれば**新しい方へ進める**。
 *   削除は「今」起きた事実であり、昔の削除記録（消えたあと再作成された行など）の
 *   古い時刻が残っていると、受け取った側のLWWがこの削除を「古い決定」として捨てる
 *
 * `_tombstone` を持たないDBでは何もしない。
 * @internal
 */
export function recordTombstoneMerge(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  foldedAt?: string,
  replacesOwnDeletion = false
): void {
  if (!hasTable(db, '_tombstone')) return;
  ensureTombstoneMergedIntoColumn(db);

  // 畳み先の鎖を作らない（`_id_merge` と同じ扱い）
  db.prepare(
    `UPDATE _tombstone SET mergedInto = ?
     WHERE tableName = ? COLLATE NOCASE AND mergedInto = ?`
  ).run(winningId, tableName, losingId);

  // **新しい主張が勝つ。古い畳みが新しい記録を上書きしてはいけない。**
  // 既存が利用者の削除（2026年）で、あとから2020年の畳みが届いたときにそれを置くと、
  // `deletedAt` が過去へ戻って {@link isShadowedByTombstone} を素通りし、
  // **消したはずの行が別の端末の版で復活する**（実測）。`mergedInto` も同じで、
  // 実削除の NULL を古い畳み先で塗り替えると、受け取った側はその削除を畳みとして扱う。
  //
  // 例外は `replacesOwnDeletion` —— **いま自分がこの畳みのために消した行**。
  // DELETEトリガが直前に現在時刻を書いているので、比べる形にすると畳みの時刻が必ず負け、
  // 畳んだ端末だけが「今消した」という強すぎるしきい値を持つことになる。ここは置く。
  //
  // 時刻の大小はフォーマット差（ISO-T vs スペース形式）を吸収するため julianday で見る。
  // 解析できない値のときだけ文字列比較へ落とす（{@link isLaterTimestamp} と同じ方針）。
  const explicitFoldedAt = foldedAt ? foldedAt : null;
  db.prepare(
    `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
     VALUES (?, ?, COALESCE(?, ${NOW_SQL}), ?)
     ON CONFLICT(tableName, recordId) DO UPDATE SET
       mergedInto = CASE WHEN ${TOMBSTONE_CLAIM_WINS}
         THEN excluded.mergedInto ELSE _tombstone.mergedInto END,
       deletedAt = CASE WHEN ${TOMBSTONE_CLAIM_WINS}
         THEN excluded.deletedAt ELSE _tombstone.deletedAt END`
  ).run(
    tableName,
    losingId,
    explicitFoldedAt,
    winningId,
    replacesOwnDeletion ? 1 : 0,
    replacesOwnDeletion ? 1 : 0
  );

  // 自分自身を指す畳み先は意味を持たない（畳む向きが反転したときに生まれる）
  db.prepare(
    `UPDATE _tombstone SET mergedInto = NULL
     WHERE tableName = ? COLLATE NOCASE AND recordId = mergedInto`
  ).run(tableName);
}


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


/**
 * 「その行は取り込み元に現存するか」を答える手続き。
 *
 * `_tombstone` に載っている行が**作り直された**かどうかを見分けるために使う。
 * 同期経路では取り込み元のDBを引く。渡されなければ「作り直されていない」と扱う。
 *
 * **「取り込み元にその行がある」だけでは作り直しの証拠にならない。** 削除をまだ
 * 受け取っていない相手はその行を持ったままなので、存在だけを見ると「生きている」と
 * 誤って答える。渡した `deletedAt`（こちらの `_tombstone`）より**厳密に新しい**行が
 * あるときだけ true を返すこと。
 * @internal
 */
export type ResurrectionProbe = (
  tableName: string,
  recordId: string,
  deletedAt: string
) => boolean;


/**
 * その id が「消えた」と分かっているか（`_tombstone` に載っているか）。
 *
 * 単に「ローカルにまだ無い」ことと区別するために見る。取り込みは外部キーの検査を
 * トランザクション終端まで遅らせているので、**親がこのあと同じ取り込みで届く**ことは
 * 普通に起きる。証拠が無いのに子を捨てると、順番が違うだけの行を殺すことになる。
 * @internal
 */
export function isKnownDeleted(
  db: Database.Database,
  tableName: string,
  recordId: string,
  isResurrected: ResurrectionProbe | undefined
): boolean {
  if (!hasTable(db, '_tombstone')) return false;
  const tombstone = db
    .prepare(
      `SELECT deletedAt FROM _tombstone
       WHERE tableName = ? COLLATE NOCASE AND recordId = ?`
    )
    .get(tableName, recordId) as { deletedAt: string } | undefined;
  if (tombstone === undefined) return false;

  // **`_tombstone` は「いつか消された」の記録であって「今も消えている」ではない。**
  // 同じ取り込みの中で作り直された行が、この子より**後**に処理されることがあり、
  // そのとき tombstone だけを見て子を捨てると、親は蘇ったのに子だけ失われる（実測）。
  // 取り込み元にその行が現存するかを見て、作り直されたものは「消えていない」と扱う
  // （`applyTombstoneDelete` が tombstone を無視するのと同じ物差し）。
  return !(
    isResurrected?.(tableName, recordId, String(tombstone.deletedAt)) ?? false
  );
}


/**
 * ローカル `_tombstone` に、指定レコードの削除が `recordTimestamp` と同時刻以降で
 * 記録されているか（＝そのレコードの挿入/更新はLWW上スキップすべきか）を返す。
 *
 * これにより「削除済みより古い（or 同時刻の）挿入/更新」による行の復活を防ぎ、
 * クライアント処理順に依存しない決定論的LWWを実現する。
 * `_tombstone` テーブルが無いDBでは常に false。
 *
 * @internal
 */
export function isShadowedByTombstone(
  localDb: Database.Database,
  tableName: string,
  recordId: string,
  recordTimestamp: string
): boolean {
  if (!hasTable(localDb, '_tombstone')) return false;

  const ts = localDb
    .prepare(
      `SELECT deletedAt FROM _tombstone WHERE tableName = ? AND recordId = ?`
    )
    .get(tableName, recordId) as { deletedAt: string } | undefined;
  if (!ts) return false;

  // record が削除より「厳密に新しい」場合のみ採用。さもなくば（同時刻含め）削除が勝つ。
  return !isLaterTimestamp(localDb, recordTimestamp, String(ts.deletedAt));
}

