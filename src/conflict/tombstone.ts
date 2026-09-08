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
 * `_tombstone` に載っているこの id の主張1件。
 * @internal
 */
export interface TombstoneClaim {
  /** 消えたと主張している時刻 */
  deletedAt: string;
  /** 畳み先。ただの削除なら null */
  mergedInto: string | null;
}

/**
 * `_tombstone` からこの id の主張を読む（**いちばん新しいもの1件**）。
 *
 * 表名は `COLLATE NOCASE` で引く。DELETEトリガは**自分の設定どおりの表記**で書き、
 * 届くエントリは**相手の設定どおりの表記**を持つので、`Users` と `users` のように
 * 綴りが違う端末どうしでは、区別して引くと取り逃がす。
 *
 * ただし**書き込み側の主キーは BINARY で照合される**（`ON CONFLICT(tableName, recordId)`
 * も DELETEトリガも表名をそのまま入れる）ので、綴りの違う2行が同時に載りうる。
 * どちらが返るかを走査順まかせにすると**古い方を拾って削除を見落とす**ので、
 * 時刻で並べて新しい方を採る（このライブラリの他の判断と同じ「新しい主張が勝つ」）。
 * @internal
 */
export function readTombstoneClaim(
  db: Database.Database,
  tableName: string,
  recordId: string
): TombstoneClaim | null {
  if (!hasTable(db, '_tombstone')) return null;
  ensureTombstoneMergedIntoColumn(db);

  // **1行を選ぶのではなく、合成する。**
  // 綴り違いの2行は「同じ id についての別々の主張の断片」であって、どちらか一方が
  // 正しいわけではない。実測では、同期経路が相手の綴りで書いた
  // `('Users', L, mergedInto: W, 1月)` と、ローカルのDELETEトリガが
  // `INSERT OR REPLACE` で書いた `('users', L, mergedInto: NULL, 6月)` が並び、
  // 「新しい方」を採ると**畳み先を持たない方**が返る。受け取った側はそれを
  // ただの削除として適用し、L の子を道連れにする。
  // 削除時刻は最も新しいものを、畳み先は**主張されている中でいちばん新しいもの**を採る。
  const row = db
    .prepare(
      `SELECT
         (SELECT deletedAt FROM _tombstone
           WHERE tableName = ? COLLATE NOCASE AND recordId = ?
           ORDER BY julianday(deletedAt) DESC, deletedAt DESC
           LIMIT 1) AS deletedAt,
         (SELECT mergedInto FROM _tombstone
           WHERE tableName = ? COLLATE NOCASE AND recordId = ?
             AND mergedInto IS NOT NULL
           ORDER BY julianday(deletedAt) DESC, deletedAt DESC
           LIMIT 1) AS mergedInto`
    )
    .get(tableName, recordId, tableName, recordId) as {
    deletedAt: string | null;
    mergedInto: string | null;
  };
  if (row.deletedAt === null) return null;

  return {
    deletedAt: String(row.deletedAt),
    mergedInto: row.mergedInto === null ? null : String(row.mergedInto),
  };
}

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
  foldedAt?: string
): void {
  if (!hasTable(db, '_tombstone')) return;
  ensureTombstoneMergedIntoColumn(db);

  // 畳み先の鎖を作らない（`_id_merge` と同じ扱い）
  db.prepare(
    `UPDATE _tombstone SET mergedInto = ?
     WHERE tableName = ? COLLATE NOCASE AND mergedInto = ?`
  ).run(winningId, tableName, losingId);

  // **ここは比べない。置く。**
  //
  // 「この主張を受け入れてよいか」は {@link recordMerge} が**2つの帳簿の両方を見て
  // 一度だけ**決めており、ここへ来る時点で受け入れは確定している。ここで独自にもう一度
  // 比べると、`_id_merge` 側と**違う物差しで違う答え**を出しうる —— 実測では、
  // `_id_merge` の記録が無く `_tombstone` にだけ新しい削除がある状態で古い畳みを受けると、
  // `_id_merge` は受け入れ `_tombstone` は断り、**2つの帳簿が別々の勝者を名乗った**
  // （ローカルでは子が畳み先へ読み替えられ、他端末には「ただ削除された」と伝わって、
  // 向こうの生きている行が子ごと消える）。
  //
  // 判断を1か所に集めたので、書き込みは1つの決定から素直に導かれる。
  const explicitFoldedAt = foldedAt ? foldedAt : null;
  db.prepare(
    `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
     VALUES (?, ?, COALESCE(?, ${NOW_SQL}), ?)
     ON CONFLICT(tableName, recordId) DO UPDATE SET
       mergedInto = excluded.mergedInto,
       deletedAt = excluded.deletedAt`
  ).run(tableName, losingId, explicitFoldedAt, winningId);

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
  const tombstone = readTombstoneClaim(db, tableName, recordId);
  if (tombstone === null) return false;

  // **`_tombstone` は「いつか消された」の記録であって「今も消えている」ではない。**
  // 同じ取り込みの中で作り直された行が、この子より**後**に処理されることがあり、
  // そのとき tombstone だけを見て子を捨てると、親は蘇ったのに子だけ失われる（実測）。
  // 取り込み元にその行が現存するかを見て、作り直されたものは「消えていない」と扱う
  // （`applyTombstoneDelete` が tombstone を無視するのと同じ物差し）。
  return !(
    isResurrected?.(tableName, recordId, tombstone.deletedAt) ?? false
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
  const ts = readTombstoneClaim(localDb, tableName, recordId);
  if (ts === null) return false;

  // record が削除より「厳密に新しい」場合のみ採用。さもなくば（同時刻含め）削除が勝つ。
  return !isLaterTimestamp(localDb, recordTimestamp, ts.deletedAt);
}
