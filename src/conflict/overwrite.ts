/**
 * 「ローカルに既に在るこの行の上へ、届いたレコードを書く。邪魔な相手が居れば畳む」。
 *
 * {@link applyUpdate} の書き込みと、{@link applyInsert} が**同じ主キーの行に当たった**
 * ときの書き込みは、同じ状況であり同じ壊れ方をする。**同じ形は同じ場所に置く** ——
 * 片方にだけ畳みを実装すると、もう片方は例外を外へ通し、取り込みトランザクションが
 * 丸ごと巻き戻って**その相手からの同期が永久に止まる**（しかも成功として返る）。
 *
 * @module conflict/overwrite
 * @internal
 */
import Database from 'better-sqlite3';
import { RecordFold } from '../types';
import { escapeIdentifier } from './schema';
import { foldTimestampOf } from './timestamp';
import {
  findUniqueRivals,
  outranksAllRivals,
  readSecondaryUniqueKeys,
  selectSurvivingRival,
} from './unique';
import { foldRowInto } from './fold';
import { runDeferringForeignKeys, runInSavepoint } from './transaction';


/**
 * {@link overwriteExistingRow} の結果。
 *
 * 呼び出し元が返す `action` の語彙（`upserted` / `updated` / `skipped`）は経路ごとに
 * 違うので、ここでは**どちらが勝ったか**だけを返す。
 * @internal
 */
export interface OverwriteOutcome {
  /**
   * `remote_wins` — 届いた版を書けた（邪魔な相手が居れば畳んでから書いた）。
   * `local_wins` — 書けなかったので、**書き込み先の行の方**を勝者へ畳んだ。
   */
  resolution: 'remote_wins' | 'local_wins';
  folds: RecordFold[];
}

/**
 * 「ローカルに既に在るこの行の上へ、届いたレコードを書く。邪魔な相手が居れば畳む」。
 *
 * この処理を必要とする経路は2つある — {@link applyUpdate} の書き込みと、
 * {@link applyInsert} が**同じ主キーの行に当たった**ときのLWWによる書き込み。
 * どちらも「行はもう在り、そこへ新しい版を流し込む」という同じ状況で、同じ壊れ方をする。
 * 片方にだけ畳みを実装すると、もう片方は例外を外へ通し、
 * `performSync` の取り込みトランザクションが丸ごと巻き戻って**その相手からの同期が
 * 永久に止まる**（しかも `performSync` は成功として返る）。**同じ形は同じ場所に置く。**
 *
 * 分岐の根拠は「例外の種類」であって「同じ主キーの行が在るか」ではない。
 * 主キーとセカンダリユニークが**同時に**ぶつかるとき SQLite が報告するのは
 * `SQLITE_CONSTRAINT_UNIQUE` の方なので、主キーの有無で先に振り分けると、
 * 両方ぶつかる入力は畳みの経路へ永久に辿り着かない。
 *
 * ユニークが2本以上ある表では、1回の書き込みが索引ごとに別々の相手へぶつかる。
 * 相手は {@link findUniqueRivals} で**索引から先に全部引ける**ので、1つも畳む前に
 * 全員ぶんの勝敗を決める（「先に見えた相手を畳んでから次の相手に負け、書き込みは
 * 拒まれたのに畳んだ行だけが消えたまま」という穴が、そもそも開かない形にしてある）。
 *
 * @param localRow - 書き込み先の行（ローカルの現在の姿）。届いた版が負けたときは
 *   **この行が**勝者へ畳まれる。届いた版を黙って捨てると、相手は送り続けこちらは
 *   断り続けて分岐したまま収束しない。
 * @throws 相手を引けないUNIQUE違反（部分索引・式索引）と、UNIQUE以外のSQLiteエラー。
 *   握りつぶさず呼び出し元へ委ねる。
 * @internal
 */
export function overwriteExistingRow(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  record: Record<string, unknown>,
  localRow: Record<string, unknown>,
  columns: string[],
  timestampColumn: string
): OverwriteOutcome {
  const pkValue = record[primaryKey];
  const updateColumns = columns.filter((column) => column !== primaryKey);

  // 主キー以外に書く列が無いと `SET` 句が空になり、SQLite は原因を指さない
  // `near "WHERE": syntax error` を投げる（実測）。**同期経路からはここへ来ない** —
  // {@link discoverTables} がタイムスタンプ列の無い表を同期対象から外し、`columns` は
  // 表の全列なので、その列が必ず残るため。来るのは公開APIを直接呼んだ場合だけで、
  // そのとき起きているのは「`columns` が表や `record` と食い違っている」であって
  // 構文の誤りではない。何が食い違っているかを名指しして止める。
  if (updateColumns.length === 0) {
    throw new Error(
      `Cannot write ${tableName}: "columns" holds only the primary key ` +
        `"${primaryKey}", leaving nothing to write. Pass every column of the row.`
    );
  }

  const setClause = updateColumns
    .map((column) => `${escapeIdentifier(column)} = ?`)
    .join(', ');
  const values = [...updateColumns.map((column) => record[column]), pkValue];
  const updateStatement = db.prepare(
    `UPDATE ${escapeIdentifier(tableName)} SET ${setClause}
     WHERE ${escapeIdentifier(primaryKey)} = ?`
  );

  let rivalRows: Record<string, unknown>[];
  try {
    updateStatement.run(...values);
    return { resolution: 'remote_wins', folds: [] };
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (sqliteErr.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;

    // 書き込みがローカルの**別の行**のセカンダリUNIQUEに当たった
    // （利用者が編集できる名前の列で、両端末が独立に同じ名前へ辿り着いた場合など）。
    // 相手は索引から先に全部引ける。1本ずつ畳んで確かめる必要はもう無い。
    rivalRows = findUniqueRivals(
      db,
      tableName,
      primaryKey,
      record,
      pkValue,
      readSecondaryUniqueKeys(db, tableName)
    );

    // 衝突相手を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
    // （部分索引・式索引で張られたユニークなど、列の値から相手を引けない形）。
    if (rivalRows.length === 0) throw err;
  }

  // 同時刻は主キーの辞書順で決める（{@link isPreferredOverRival}）。ここを
  // 「同点ならローカルが勝つ」にすると、相手側が同じ2行を逆向きに畳み、
  // 生き残るidが毎周入れ替わって永久に収束しない。
  if (outranksAllRivals(db, record, rivalRows, timestampColumn, primaryKey)) {
    // 届いた版が全員に勝つ → 邪魔なローカル行を全て書き込み先の行へ畳んでから書き直す。
    // 敗者の子は先に勝者へ付け替わるので、カスケードで道連れにならない。
    // 畳みと書き直しは1つの区切りで行う（片方だけ残さない）。
    const folds: RecordFold[] = [];
    // 勝者は書き込む `record`。畳みが確定した時刻はその行が名乗る版の時刻
    const foldedAt = foldTimestampOf(record, timestampColumn);
    runInSavepoint(db, () => {
      const folded = new Set<string>();
      for (const rivalRow of rivalRows) {
        foldRowInto(
          db,
          tableName,
          primaryKey,
          rivalRow,
          record,
          timestampColumn,
          folded,
          folds,
          foldedAt
        );
      }
      updateStatement.run(...values);
    });
    return { resolution: 'remote_wins', folds };
  }

  // ローカル行が勝った → 届いた版は採用しない。ただし**黙って捨てない**。
  // 捨てるだけでは、相手はこの行を送り続け、こちらは断り続けて分岐したまま収束しない。
  // ユニークキーが同じ以上この2行は同じものなので、書き込み先の行の方を勝者へ畳み、
  // その事実（`_tombstone.mergedInto`）を相手にも伝える。
  // 相手はそれを受けて同じ畳みを行い、両者が1行へ揃う。
  //
  // 畳むのは**書き込み先の行だけ**にする。勝てなかった相手が複数居ても、それらは
  // 「採用しないと決めた版」を通してしか結び付いていないので、まとめて畳まない。
  const folds: RecordFold[] = [];
  const survivingRival = selectSurvivingRival(
    db,
    rivalRows,
    timestampColumn,
    primaryKey
  );
  runDeferringForeignKeys(db, () => {
    foldRowInto(
      db,
      tableName,
      primaryKey,
      localRow,
      survivingRival,
      timestampColumn,
      new Set(),
      folds,
      // 勝者はローカルに残る相手の行。その行が名乗る版の時刻を刻む
      foldTimestampOf(survivingRival, timestampColumn)
    );
  });
  return { resolution: 'local_wins', folds };
}
