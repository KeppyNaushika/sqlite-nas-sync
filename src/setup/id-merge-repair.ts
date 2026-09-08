/**
 * 起動時の帳簿の手当て —— `_id_merge` に残った**畳み先の鎖**と**循環**を畳み直す。
 *
 * 読み替えは1段しか辿らない前提で使われているので、鎖が残っていると遅れて届いた子が
 * **既に死んでいる中間の行**へ向けられて捨てられる。書き込み側は終端まで辿ってから
 * 記録するようになったので鎖はもう増えないが、そうなる前に書かれたぶんがDBに残る。
 *
 * `_id_merge` は同期されないローカル索引なので、**自分のDBを一度直せば、他の端末が
 * 古いライブラリでも鎖は入ってこない**。
 *
 * @module setup/id-merge-repair
 * @internal
 */
import Database from 'better-sqlite3';
import { isLaterTimestamp } from '../conflict/timestamp';
import { foldIdentifier } from '../conflict/schema';
import { escapeIdentifier } from './sql';

/**
 * `_id_merge` に残っている**畳み先の鎖**を、終端まで畳み直す。
 *
 * 記録は「参照が常に1段で解ける」ことを前提に使われる（`remapMergedForeignKeys` は
 * 1回しか引かない）。鎖が残っていると、遅れて届いた子が**既に死んでいる中間の行**へ
 * 向けられ、`ON DELETE` に従って捨てられる（実測）。
 *
 * 書き込み側は終端まで辿ってから記録するようになったので、鎖は**もう増えません**。
 * ここで畳むのは、そうなる前に書かれたぶんです。`_id_merge` は同期されない
 * ローカル索引（`_` 始まりで自動検出から外れ、リモートからも読まない）なので、
 * **自分のDBを一度直せば、他の端末が古いライブラリでも鎖は入ってきません。**
 * したがって起動時の一回で足ります。
 *
 * - **時刻は動かしません。** `A→C` を `A→B` へ張り替えても「`A` が畳まれた時刻」は
 *   変わらないためです（畳み先の張り替えと同じ扱い）
 * - 記録に**循環**（`A→B` と `B→A` が同時に立つ矛盾した形。畳む向きが反転したときに
 *   旧バージョンが残しえた）がある場合は、**いちばん新しい主張だけを残します**
 *   （他と同じ「新しい主張が勝つ」。同時刻なら敗者idの辞書順で1つに決める）
 * - **`_tombstone.mergedInto` も同じだけ動かします。** 畳み先は2か所に載っており、
 *   片方だけ直すと帳簿が食い違う（刈ったのに tombstone が畳み先を名乗り続けると、
 *   `remapMergedForeignKeys` が読み替えをやめ、遅れて届いた子が消えた親を指したまま
 *   入って外部キー検査で取り込みが巻き戻る）
 * - 何度走らせても同じ結果になります（鎖が短くなる方向にしか動きません）
 *
 * **走査は1回では足りません。** 循環へ流れ込む鎖（`D→A` があり `A↔B` が循環）は、
 * 1回目の走査では終端が循環の中に居るため張り替えられず、循環を刈った結果
 * `D→A→B` が残ります。刈ったあとの形をもう一度見る必要があるので、
 * **何も変わらなくなるまで**繰り返します（鎖は短くなる方向にしか動かないので必ず止まる）。
 * @internal
 */
export function collapseIdMergeChains(
  db: Database.Database,
  primaryKey: string
): void {
  // 1回の走査で直せるのは、その時点で見えている形だけ。刈り取りで形が変われば
  // もう一度見る（打ち切りの上限は、鎖が1回の走査で最低1段は縮むことから置いている）
  for (let pass = 0; pass < ID_MERGE_COLLAPSE_MAX_PASSES; pass++) {
    if (!collapseIdMergeChainsOnce(db, primaryKey)) return;
  }
}

/**
 * その id の行が、いま手元に在るか。
 *
 * 表が無い（同期対象でない・まだ作られていない）ときは false —— 確かめられないことを
 * 「在る」に倒さない。削除の記録は、余分に残る方が失うものが小さい。
 * @internal
 */
function rowIsPresent(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  recordId: string
): boolean {
  try {
    return (
      db
        .prepare(
          `SELECT 1 FROM ${escapeIdentifier(tableName)}
           WHERE ${escapeIdentifier(primaryKey)} = ?`
        )
        .get(recordId) !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * 走査の打ち切り上限。
 *
 * 1回の走査は必ず鎖を縮めるか循環を1つ刈るので、記録の件数を超えて回ることはない。
 * それでも上限を置くのは、記録が想定外の形でも**起動が止まらない**ようにするため。
 * @internal
 */
const ID_MERGE_COLLAPSE_MAX_PASSES = 16;

/**
 * {@link collapseIdMergeChains} の1回ぶんの走査。
 *
 * @returns 記録を1件でも書き換えた（＝もう一度見る価値がある）か
 * @internal
 */
function collapseIdMergeChainsOnce(
  db: Database.Database,
  primaryKey: string
): boolean {
  const rows = db
    .prepare(`SELECT tableName, losingId, winningId, mergedAt FROM _id_merge`)
    .all() as {
    tableName: string;
    losingId: string;
    winningId: string;
    mergedAt: string;
  }[];
  if (rows.length === 0) return false;

  let changed = false;

  const byTable = new Map<
    string,
    Map<string, { winningId: string; mergedAt: string }>
  >();
  for (const row of rows) {
    // `_id_merge` の主キーは大小を区別するが、引くときは常に `COLLATE NOCASE` なので、
    // 表名の大小だけが違う2件は**同じ1件として扱われる**（下の UPDATE / DELETE も
    // 両方に当たる）。索引の側だけ後勝ちにすると、辿る鎖と書き換える対象がずれるので、
    // 他と同じ「新しい主張が勝つ」で1つに決める（同時刻なら先に読んだ方を残す）。
    const key = foldIdentifier(row.tableName);
    const records = byTable.get(key) ?? new Map();
    const existing = records.get(row.losingId);
    // 時刻は**字面で比べない**。ここが掃除する相手は旧版が書いた記録で、
    // `datetime('now')` のスペース形式（`2026-06-01 10:00:00`）と `NOW_SQL` の
    // ISO-T形式（`2026-06-01T09:00:00.000Z`）が混在する。字面だと ' '(0x20) <
    // 'T'(0x54) なので**古い方が常に勝ち**、辿る鎖が本来と逆向きに決まる。
    if (
      existing === undefined ||
      isLaterTimestamp(db, row.mergedAt, existing.mergedAt)
    ) {
      records.set(row.losingId, {
        winningId: row.winningId,
        mergedAt: row.mergedAt,
      });
    }
    byTable.set(key, records);
  }

  // 畳み先は `_id_merge`（ローカル索引）と `_tombstone.mergedInto`（他クライアントへ
  // 渡る側）の2か所に載っている。**片方だけ直すと帳簿が食い違う。** 刈ったのに
  // `_tombstone.mergedInto` を残すと、`lookupIdMerge` は null を返すのに tombstone は
  // 畳み先を名乗り続け、`remapMergedForeignKeys` が読み替えをやめる。遅れて届いた子は
  // 消えた親を指したまま入り、COMMIT時の外部キー検査でその相手ぶんの取り込みが丸ごと
  // 巻き戻る —— この仕組みが防ぐためにある失敗そのものになる。
  const hasTombstone =
    db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
      )
      .get() !== undefined;

  const update = db.prepare(
    `UPDATE _id_merge SET winningId = ?
     WHERE tableName = ? COLLATE NOCASE AND losingId = ?`
  );
  const remove = db.prepare(
    `DELETE FROM _id_merge WHERE tableName = ? COLLATE NOCASE AND losingId = ?`
  );
  const repointTombstone = hasTombstone
    ? db.prepare(
        `UPDATE _tombstone SET mergedInto = ?
         WHERE tableName = ? COLLATE NOCASE AND recordId = ?
           AND mergedInto IS NOT NULL`
      )
    : null;
  // 刈る循環の記録は `_tombstone` にも同じ主張として載っている。**その主張は捨てるが、
  // 「消えた」という事実まで捨ててはいけない。** 刈られる側の `recordId` について
  // この関数が知っているのは**帳簿の上で生き残る**ということだけで、その行が
  // **実際に手元に在るか**は別の話である。2つの場合を分ける:
  //
  // - **手元に行が在る** — 畳みの主張も、削除という記録そのものも間違っている。
  //   行ごと消す。`mergedInto` を NULL にするだけでは「B はただ消された」という主張に
  //   なり、`_tombstone` は同期で渡るので、向こうの `applyTombstoneDelete` が
  //   **生きている B を子ごと DELETE する**（消えた B は相手から入り直せるし、
  //   張り替えた `D→B` の行き先が実在するようになるので辻褄も合う）
  // - **手元に行が無い** — その id は本当に消えている。畳み先の主張だけを外して
  //   「ただ消された」に戻す。行ごと消すと**削除の記録が失われ**、
  //   `isShadowedByTombstone` が効かなくなって、相手の古い版がそのまま復活する
  //
  // どちらの場合も、利用者操作によるただの削除（`mergedInto IS NULL`）は触らない。
  // **どの畳み先を指しているかは問わない** —— 生きていると決めた行に載っている畳みの
  // 主張は行き先が何であれ矛盾するし、一致を条件にすると、2つの帳簿が既にずれている
  // ときだけ `_id_merge` の行は消えて `_tombstone` の主張が残る。
  const dropTombstoneClaim = hasTombstone
    ? db.prepare(
        `DELETE FROM _tombstone
         WHERE tableName = ? COLLATE NOCASE AND recordId = ?
           AND mergedInto IS NOT NULL`
      )
    : null;
  const clearTombstoneClaim = hasTombstone
    ? db.prepare(
        `UPDATE _tombstone SET mergedInto = NULL
         WHERE tableName = ? COLLATE NOCASE AND recordId = ?
           AND mergedInto IS NOT NULL`
      )
    : null;

  /** 刈られた循環の主張を `_tombstone` からも落とす（上のコメントの2つの場合分け）。 */
  const dropCycleClaim = (tableName: string, recordId: string): void => {
    if (rowIsPresent(db, tableName, primaryKey, recordId)) {
      dropTombstoneClaim?.run(tableName, recordId);
      return;
    }
    clearTombstoneClaim?.run(tableName, recordId);
  };

  for (const row of rows) {
    const records = byTable.get(foldIdentifier(row.tableName));
    if (!records) continue;

    // 終端まで辿る。通った記録を控えておき、出発点へ戻ったら循環と分かる
    const walked: { losingId: string; mergedAt: string }[] = [
      { losingId: row.losingId, mergedAt: row.mergedAt },
    ];
    const seen = new Set<string>([row.losingId]);
    let terminal = row.winningId;
    let cycles = false;
    for (;;) {
      if (terminal === row.losingId) {
        cycles = true;
        break;
      }
      if (seen.has(terminal)) break;
      seen.add(terminal);
      const next = records.get(terminal);
      if (next === undefined) break;
      walked.push({ losingId: terminal, mergedAt: next.mergedAt });
      terminal = next.winningId;
    }

    if (cycles) {
      // 「A は B へ畳まれた」と「B は A へ畳まれた」が同時に立っている矛盾した記録。
      // どちらが正しいかは決められないので、**いちばん新しい主張だけを残す**
      // （他と同じ「新しい主張が勝つ」。同時刻なら敗者idの辞書順で1つに決める）。
      // 比較は `julianday()` で正規化する（索引を作るときと同じ理由 —— 旧版の
      // スペース形式と ISO-T 形式が混在するので、字面で比べると古い方が勝つ）
      const strongest = walked.reduce((best, candidate) => {
        if (isLaterTimestamp(db, candidate.mergedAt, best.mergedAt))
          return candidate;
        if (isLaterTimestamp(db, best.mergedAt, candidate.mergedAt)) return best;
        return candidate.losingId < best.losingId ? candidate : best;
      });
      if (strongest.losingId !== row.losingId) {
        remove.run(row.tableName, row.losingId);
        dropCycleClaim(row.tableName, row.losingId);
        changed = true;
      }
      continue;
    }

    if (terminal !== row.winningId) {
      update.run(terminal, row.tableName, row.losingId);
      repointTombstone?.run(terminal, row.tableName, row.losingId);
      changed = true;
    }
  }

  return changed;
}
