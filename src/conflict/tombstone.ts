/**
 * `_tombstone` —— 「この行は消えた」「この行はあの行へ畳まれた」という主張の置き場。
 *
 * `_id_merge`（`conflict/ledger`）が**この端末だけの索引**なのに対し、
 * `_tombstone` は**同期で他の端末へ渡る**。したがってここへ書く値は、こちらの都合
 * （同期を回した時刻など）ではなく、**どの端末で読んでも同じ意味になるもの**でなければ
 * ならない。畳みの時刻に勝った行の版を刻むのはそのためである。
 *
 * @module conflict/tombstone
 * @internal
 */
import Database from 'better-sqlite3';
import { ensureTombstoneMergedIntoColumn, NOW_SQL } from '../setup';
import { escapeIdentifier, hasTable } from './schema';
import { isLaterTimestamp } from './timestamp';

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
 * 「その行は取り込み元に現存するか」を答える手続き。
 *
 * `_tombstone` に載っている行が**作り直された**かどうかを見分けるために使う。
 * 同期経路では取り込み元のDBを引く。渡されなければ「作り直されていない」と扱う。
 *
 * **「取り込み元にその行がある」だけでは作り直しの証拠にならない。** 削除をまだ
 * 受け取っていない相手はその行を持ったままなので、存在だけを見ると「生きている」と
 * 誤って答える。渡した `deletedAt`（こちらの `_tombstone`）より**厳密に新しい**行が
 * あるときだけ true を返すこと。
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
      // 表名は `COLLATE NOCASE` で引く（`_tombstone` / `_id_merge` の読み取りは
      // すべてこれで揃えてある）。DELETEトリガは**自分の設定どおりの表記**で
      // 書き、届くエントリは**相手の設定どおりの表記**を持つので、`Users` と `users` の
      // ように綴りが違う端末どうしでは、ここだけ引きが外れて
      // {@link isKnownDeleted} が「消えている」と見る行が復活していた。
      `SELECT deletedAt FROM _tombstone
       WHERE tableName = ? COLLATE NOCASE AND recordId = ?`
    )
    .get(tableName, recordId) as { deletedAt: string } | undefined;
  if (!ts) return false;

  // record が削除より「厳密に新しい」場合のみ採用。さもなくば（同時刻含め）削除が勝つ。
  return !isLaterTimestamp(localDb, recordTimestamp, String(ts.deletedAt));
}
