/**
 * リモートの INSERT / UPDATE / DELETE をローカルDBへ適用する（公開API）。
 *
 * @module conflict/apply
 * @internal
 */
import Database from 'better-sqlite3';
import { ConflictInfo, RecordFold } from '../types';
import { escapeIdentifier } from './schema';
import {
  foldTimestampOf,
  isLaterTimestamp,
  isSameTimestamp,
  TimestampColumnFor,
} from './timestamp';
import { describeStalemate } from './stalemate';
import {
  findUniqueRivals,
  outranksAllRivals,
  readSecondaryUniqueKeys,
  selectSurvivingRival,
} from './unique';
import {
  hasIdMerges,
  isShadowedByTombstone,
  recordFold,
  recordMerge,
  recordMergeWithoutLocalRow,
  resolveFoldChain,
  ResurrectionProbe,
} from './ledger';
import { remapMergedForeignKeys } from './remap';
import {
  foldAndReplace,
  foldRowInto,
  runDeferringForeignKeys,
  runInSavepoint,
} from './fold';

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

/**
 * 「この行は消えたのではなく、あの行へ畳まれた」という削除をローカルへ適用する。
 *
 * リモートの `_tombstone.mergedInto` から呼ばれる。敗者行を消す前に、敗者を指している
 * 子を畳み先へ付け替えるため、**自分では競合を経験していないクライアントでも子を失わない**。
 *
 * 畳み先の行がローカルに無ければ `winningRow`（リモートから読んだ勝者行）を使って
 * 入れ替える。それも無い場合は**敗者行を消さない** — 消すと子が道連れになるためで、
 * 勝者行が届いた時点でセカンダリUNIQUE違反の解決が同じ畳みを行う。
 *
 * 敗者行に後から入った属性は勝者に取り込まれない（「勝者が総取り」の既知の穴のまま）。
 *
 * @param losingId - 畳まれて消えた側のid（`_tombstone.recordId`）
 * @param winningId - 畳み先のid（`_tombstone.mergedInto`）
 * @param winningRow - リモートから読んだ畳み先の行。読めなければ undefined
 * @param columns - ローカルテーブルのカラム名配列
 * @param foldedAt - 畳みが決まった時刻（`_tombstone.deletedAt`）。渡すと、ローカルの
 *   敗者行がそれより後に更新されている場合はこの畳みを適用しない。畳みは削除ではなく
 *   ユニーク制約が強制する統合なので、**衝突していた版**より新しい行にまで及ばせては
 *   いけない（例: 敗者行のユニークキーがその後変更され、もう衝突しない場合）。
 *   見送ってもデータは失われず、その行を送り返した時点で相手側が同じLWWを
 *   今度は逆向きに適用して収束する。
 * @returns 畳んだか（`folded`）、何もしなかったか（`skipped`）と、畳んだ記録、
 *   および利用者へ伝える文言（`warnings`）
 * @internal
 */
export function applyMergedDelete(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  losingId: string,
  winningId: string,
  winningRow: Record<string, unknown> | undefined,
  columns: string[],
  timestampColumn: string = 'updatedAt',
  foldedAt?: string,
  isResurrected?: ResurrectionProbe,
  timestampColumnFor?: TimestampColumnFor
): { action: 'folded' | 'skipped'; folds: RecordFold[]; warnings: string[] } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);
  const folds: RecordFold[] = [];

  // 届いた畳み先が、こちらでは既に別の行へ畳まれていることがある
  // （`_tombstone.mergedInto` は同期で渡るので `A→C` と `C→B` の鎖がそのまま届く。実測）。
  // 中間の `C` は既に死んでいるため、そのまま使うと「畳み先が見つからない」と判断して
  // 敗者行を畳めない。終端まで辿ってから探す。
  if (hasIdMerges(localDb)) {
    winningId = resolveFoldChain(localDb, tableName, winningId, losingId);
    if (losingId === winningId) {
      return { action: 'skipped', folds, warnings: [] };
    }
  }

  const losingRow = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(losingId) as Record<string, unknown> | undefined;

  // 敗者行がこの畳みより後に更新されていれば、畳みは既に古い判断である。
  // `_id_merge` にも書かない（行が生きているので、その子は今のままで正しい）。
  if (
    losingRow &&
    foldedAt &&
    isLaterTimestamp(
      localDb,
      String(losingRow[timestampColumn] ?? ''),
      foldedAt
    )
  ) {
    return { action: 'skipped', folds, warnings: [] };
  }

  // 畳みを実行できるかに関わらず、敗者idの読み替えは先に覚える。
  // これが無いと、あとから届く敗者の子が存在しない親を指したままになる。
  recordMerge(localDb, tableName, losingId, winningId, foldedAt);

  if (!losingRow) return { action: 'skipped', folds, warnings: [] };

  const localWinningRow = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(winningId) as Record<string, unknown> | undefined;

  if (localWinningRow) {
    runDeferringForeignKeys(localDb, () => {
      foldRowInto(
        localDb,
        tableName,
        primaryKey,
        losingRow,
        localWinningRow,
        timestampColumn,
        new Set(),
        folds,
        // これは**よそで下された1回の判断**を適用しているだけなので、その判断の時刻を
        // そのまま刻む（ローカルの勝者行の時刻ではない）。適用のたびに手元の時刻へ
        // 寄せ替えると、畳みを適用した端末を1つ経るごとにしきい値が現在へ近づき、
        // まだ届いていない新しい版が捨てられる範囲が広がっていく。
        // 判断の時刻が分からないとき（公開APIを直接呼ぶ場合）だけ、勝ち残る行の版に落とす。
        foldedAt ?? foldTimestampOf(localWinningRow, timestampColumn)
      );
    });
    return { action: 'folded', folds, warnings: [] };
  }

  // **渡された勝者行は、鎖を辿る前の畳み先のもの。** 終端が動いていたら、その行は
  // ここで入れてよい行ではない。入れると、**この端末が既に畳んで tombstone まで
  // 書いた中間の id が復活する**（`_id_merge` には終端しか載っていないので、その行の
  // 子は行き先の無い id へ読み替えられて捨てられる）。呼び出し元が終端の行を読んで
  // 渡し直すまで、敗者行はそのまま残す（消さなければ子は道連れにならない）。
  if (winningRow && String(winningRow[primaryKey]) !== winningId) {
    return { action: 'skipped', folds, warnings: [] };
  }

  if (winningRow) {
    // 勝者行もローカルに無い → 敗者を畳んでから勝者を入れる。
    // 勝者行の外部キーも、既に畳まれた行を指しているかもしれないので読み替える。
    const remap = remapMergedForeignKeys(
      localDb,
      tableName,
      primaryKey,
      winningRow,
      timestampColumn,
      isResurrected,
      timestampColumnFor
    );
    // 勝者行そのものが、消えた親を指していて採れないと決まることがある。
    // その場合は敗者も畳まない（畳み先が入らないのだから、消せば子が道連れになる）。
    if (remap.record === null) {
      return { action: 'skipped', folds, warnings: remap.warnings };
    }

    foldAndReplace(
      localDb,
      tableName,
      primaryKey,
      [losingRow],
      remap.record,
      columns,
      timestampColumn,
      folds,
      // 適用しているのは**よそで下された1回の判断**。その時刻をそのまま刻む
      // （勝者行がその後に編集されていても、畳みが決まった時刻は動かない）。
      foldedAt
    );
    return { action: 'folded', folds, warnings: remap.warnings };
  }

  // 畳み先がどこにも無い → 敗者行はそのまま残す（消すと子が道連れになる）
  return { action: 'skipped', folds, warnings: [] };
}


/**
 * {@link applyInsert} の返り値。
 * @internal
 */
export interface ApplyInsertResult {
  action: 'inserted' | 'upserted' | 'skipped';
  conflict?: ConflictInfo;
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[];
  /**
   * 利用者へ伝えるべきこと（`SyncResult.warnings` へ出る）。
   *
   * いま載るのは「読み替え先の親が消えていたので `ON DELETE` に従った」だけ
   * （行を採らなかった／外部キーの列を NULL にした）。**黙って捨てない**ための口。
   */
  warnings: string[];
}

/**
 * リモートのINSERT操作をローカルDBに適用する。
 *
 * 通常のINSERTを試み、UNIQUE制約違反（PK重複やユニークカラム重複）が
 * 発生した場合はLWW（Last-Write-Wins）でUPSERTにフォールバックする。
 * ローカル `_tombstone` により、より新しい削除が記録済みのレコードは
 * 再挿入せずスキップする（決定論的LWW）。
 *
 * 別PK・同一ユニークキーの行を畳む際は、敗者行を指している子を勝者行へ付け替えてから
 * 敗者を削除する（先に削除するとカスケードで子が道連れになる）。また、既に畳まれて
 * 消えた行を指す外部キーは、挿入前に吸収先へ向け直す。
 *
 * **INSERTが落ちる理由は2つあり、両方同時に成り立つ。** 同じ主キーの行が在ることと、
 * **別の行**が書こうとしているセカンダリユニークキーを既に持っていること。
 * したがって「同じ主キーの行が在るか」だけで分岐してはいけない — 両方成り立つ入力が
 * 畳みの経路へ辿り着かなくなる。同一PKへの上書きは {@link overwriteExistingRow} に
 * 任せ、そこで落ちたぶんも畳む。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - 挿入するリモートレコード
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`inserted` / `upserted` / `skipped`）と競合情報、
 *   畳んだ記録（{@link RecordFold}）、および利用者へ伝える文言（`warnings`）
 * @throws UNIQUE制約以外のSQLiteエラー
 */
export function applyInsert(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt',
  isResurrected?: ResurrectionProbe,
  timestampColumnFor?: TimestampColumnFor
): ApplyInsertResult {
  const escapedTable = escapeIdentifier(tableName);
  const escapedColumns = columns.map((c) => escapeIdentifier(c));
  const placeholders = columns.map(() => '?').join(', ');
  const folds: RecordFold[] = [];

  // より新しい削除(tombstone)が記録済みのスロットには再挿入しない（決定論的LWW: 削除が勝つ）
  if (
    isShadowedByTombstone(
      localDb,
      tableName,
      String(remoteRecord[primaryKey]),
      String(remoteRecord[timestampColumn] ?? '')
    )
  ) {
    return { action: 'skipped', folds, warnings: [] };
  }

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す。
  // 向け直した先が消えていれば、その外部キーの `ON DELETE` に従う（採らないこともある）。
  const remap = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord,
    timestampColumn,
    isResurrected,
    timestampColumnFor
  );
  const warnings = remap.warnings;
  if (remap.record === null) {
    return { action: 'skipped', folds, warnings };
  }

  const record = remap.record;
  const values = columns.map((c) => record[c]);

  try {
    localDb
      .prepare(
        `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`
      )
      .run(...values);
    return { action: 'inserted', folds, warnings };
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (
      sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      const escapedPk = escapeIdentifier(primaryKey);
      const pkValue = record[primaryKey];
      const remoteUpdatedAt = String(record[timestampColumn] ?? '');

      // ケース1: 同一PKの行が存在する（PK重複）→ LWWで上書き。
      //
      // **INSERTが落ちた理由がこれだけとは限らない。** 同一PKの行が在るのと同時に、
      // 別の行が書こうとしているセカンダリユニークキーを既に持っていることがあり、
      // その場合ここでの上書きも同じユニークで落ちる。上書きは
      // {@link overwriteExistingRow} に任せ、落ちたら畳む（ケース2と同じ扱い）。
      // ここに素の UPDATE を書くと、それは既に catch の中なので、例外が
      // `applyInsert` の外まで抜けて取り込みが丸ごと巻き戻る。
      const localRecord = localDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(pkValue) as Record<string, unknown> | undefined;

      if (localRecord) {
        const localUpdatedAt = String(localRecord[timestampColumn] ?? '');
        const conflictOf = (
          resolution: 'remote_wins' | 'local_wins'
        ): ConflictInfo => ({
          table: tableName,
          recordId: String(pkValue),
          localUpdatedAt,
          remoteUpdatedAt,
          resolution,
        });

        if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
          const outcome = overwriteExistingRow(
            localDb,
            tableName,
            primaryKey,
            record,
            localRecord,
            columns,
            timestampColumn
          );
          return {
            action: 'upserted',
            conflict: conflictOf(outcome.resolution),
            folds: outcome.folds,
            warnings,
          };
        }

        // 同じ時刻で中身が違うなら、どちらも勝てない。解けないので**報告する**。
        // 同時刻かどうかは字面ではなく時刻として見る（書式が違うだけの同時刻を
        // 取り逃がすと、膠着に気づけないまま黙って捨て合うことになる）
        if (isSameTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
          const stalemate = describeStalemate(
            tableName,
            String(pkValue),
            localUpdatedAt,
            record,
            localRecord,
            columns,
            timestampColumn
          );
          if (stalemate !== null) warnings.push(stalemate);
        }

        return {
          action: 'upserted',
          conflict: conflictOf('local_wins'),
          folds,
          warnings,
        };
      }

      // ケース2: 別PK・同一ユニークキーの行が存在する（セカンダリUNIQUE違反）。
      // 各クライアントが独立に同じ論理エンティティの行を作成した場合に発生する。
      // ローカルの競合行を**索引から先に全部**引き、全員ぶんの勝敗を決めてから畳む。
      const rivalRows = findUniqueRivals(
        localDb,
        tableName,
        primaryKey,
        record,
        pkValue,
        readSecondaryUniqueKeys(localDb, tableName)
      );

      if (rivalRows.length === 0) {
        // 競合行を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
        throw err;
      }

      const survivingRival = selectSurvivingRival(
        localDb,
        rivalRows,
        timestampColumn,
        primaryKey
      );
      const localUpdatedAt = String(survivingRival[timestampColumn] ?? '');

      // 同時刻は主キーの辞書順で決める（{@link isPreferredOverRival}）。ここを
      // 「同点ならローカルが勝つ」にすると、相手側の {@link applyUpdate} が同じ2行を
      // 逆向きに畳み、生き残るidが毎周入れ替わって永久に収束しない。
      if (
        outranksAllRivals(
          localDb,
          record,
          rivalRows,
          timestampColumn,
          primaryKey
        )
      ) {
        // リモートが新しい → ローカルの競合行を全て勝者（リモート行）へ畳んで置き換える。
        // 敗者を指している子は勝者へ付け替えてから削除する。
        // DELETEトリガーが発火するため、敗者行の削除はchangelog/tombstone経由で
        // 他クライアントにも伝播し、全体が勝者行に収束する。
        foldAndReplace(
          localDb,
          tableName,
          primaryKey,
          rivalRows,
          record,
          columns,
          timestampColumn,
          folds
        );

        return {
          action: 'upserted',
          conflict: {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'remote_wins',
          },
          folds,
          warnings,
        };
      }

      // ローカルが新しい → リモート行は採用しない。
      // ただし「リモートの敗者idはローカルのこの行に畳まれた」ことを記録し、
      // 他クライアントへも伝わるようにする（この側では敗者行のDELETEが起きないため、
      // tombstone と changelog を手で書く）。記録しないと、あとから届くリモート側の子が
      // 存在しない親を指したままになり、外部キー違反でその相手ぶんの取り込みが
      // 丸ごと巻き戻る（同期が止まる）。
      recordMergeWithoutLocalRow(
        localDb,
        tableName,
        String(pkValue),
        String(survivingRival[primaryKey]),
        localUpdatedAt
      );

      // 敗者行はそもそもローカルに無いので、行は消えていない（数には出さない）。
      // それでも「2つが1つになった」ことは利用者へ伝える。
      recordFold(
        folds,
        tableName,
        String(pkValue),
        String(survivingRival[primaryKey]),
        false,
        // 敗者行をローカルに持っていないので、付け替える子も失う子も居ない
        0,
        0
      );

      return {
        action: 'upserted',
        conflict: {
          table: tableName,
          recordId: String(survivingRival[primaryKey]),
          localUpdatedAt,
          remoteUpdatedAt,
          resolution: 'local_wins',
        },
        folds,
        warnings,
      };
    }

    throw err;
  }
}

/**
 * {@link applyUpdate} の返り値。
 * @internal
 */
export interface ApplyUpdateResult {
  action: 'updated' | 'skipped' | 'inserted';
  conflict?: ConflictInfo;
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[];
  /** 利用者へ伝えるべきこと（{@link ApplyInsertResult.warnings} と同じ） */
  warnings: string[];
}

/**
 * リモートのUPDATE操作をローカルDBに適用する。
 *
 * LWW（Last-Write-Wins）方式で `updatedAt` を比較し、
 * リモートの方が新しい場合のみローカルを更新する。
 * ローカルにレコードが存在しない場合はINSERTする。
 *
 * 書き込み自体は {@link overwriteExistingRow} に任せる（{@link applyInsert} が
 * 同一PKの行に当たったときと**同じ状況・同じ壊れ方**なので、同じ場所に置く）。
 * 書き込みがローカルの**別の行**のセカンダリUNIQUEに当たれば、そこでLWWで1行へ畳まれる。
 * 作成の衝突と違い**更新対象の行はローカルに既に在る**ため、どちらが負けても実際に
 * 行が1つ消える — 届いた更新が負けた場合は `skipped` を返すが、`folds` には
 * 「更新対象の行が畳まれて消えた」ことが載る（`action` だけ見ると実態に合わない）。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - リモート側のレコードデータ
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`updated` / `skipped` / `inserted`）と競合情報、
 *   畳んだ記録（{@link RecordFold}）、および利用者へ伝える文言（`warnings`）
 */
export function applyUpdate(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt',
  isResurrected?: ResurrectionProbe,
  timestampColumnFor?: TimestampColumnFor
): ApplyUpdateResult {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す。
  // 向け直した先が消えていれば、その外部キーの `ON DELETE` に従う。
  //
  // **この判定は `applyInsert` へ委譲する経路とは別に、ここにも要る。** 委譲するのは
  // 「ローカルに行が無いとき」だけなので、行が在るときの上書きは素通りしてしまう。
  const remap = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord,
    timestampColumn,
    isResurrected,
    timestampColumnFor
  );
  const warnings = remap.warnings;
  if (remap.record === null) {
    return { action: 'skipped', folds: [], warnings };
  }

  const record = remap.record;
  const pkValue = record[primaryKey];

  const localRecord = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(pkValue) as Record<string, unknown> | undefined;

  if (!localRecord) {
    // ローカルに存在しない → INSERT（リモートでINSERT後UPDATEされた場合など）。
    // セカンダリUNIQUE違反（別PK・同一ユニークキー）の可能性があるため、
    // 競合解決込みのapplyInsertを経由する。
    const insertResult = applyInsert(
      localDb,
      tableName,
      primaryKey,
      record,
      columns,
      timestampColumn,
      isResurrected,
      timestampColumnFor
    );
    if (insertResult.action === 'inserted') {
      return {
        action: 'inserted',
        folds: insertResult.folds,
        warnings: [...warnings, ...insertResult.warnings],
      };
    }
    return {
      action:
        insertResult.conflict?.resolution === 'remote_wins'
          ? 'updated'
          : 'skipped',
      conflict: insertResult.conflict,
      folds: insertResult.folds,
      warnings: [...warnings, ...insertResult.warnings],
    };
  }

  // LWW比較
  const remoteUpdatedAt = String(record[timestampColumn] ?? '');
  const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

  if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
    const outcome = overwriteExistingRow(
      localDb,
      tableName,
      primaryKey,
      record,
      localRecord,
      columns,
      timestampColumn
    );
    return {
      // 届いた更新を採らなかった場合でも、更新対象の行は畳まれて消えている
      // （呼び出し元は `folds` の側でそれを数える）。
      action: outcome.resolution === 'remote_wins' ? 'updated' : 'skipped',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: outcome.resolution,
      },
      folds: outcome.folds,
      warnings,
    };
  }

  // 同じ時刻で中身が違うなら、どちらも勝てない。解けないので**報告する**
  // （同時刻かどうかは字面ではなく時刻として見る）
  if (isSameTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
    const stalemate = describeStalemate(
      tableName,
      String(pkValue),
      localUpdatedAt,
      record,
      localRecord,
      columns,
      timestampColumn
    );
    if (stalemate !== null) warnings.push(stalemate);
  }

  return {
    action: 'skipped',
    conflict: !isSameTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)
        ? {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'local_wins',
          }
        : undefined,
    folds: [],
    warnings,
  };
}

/**
 * リモートのDELETE操作をローカルDBに適用する。
 *
 * 指定された主キーのレコードをローカルDBから削除する。
 * レコードが存在しない場合はスキップする。
 *
 * **畳まれて消えた行のidは読み替えない。** 敗者行の削除が勝者行の削除に化けてしまう。
 * 敗者idの削除はローカルでは対象が無く、そのままスキップされるのが正しい。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param recordId - 削除対象レコードの主キー値
 * @returns 実行されたアクション（`deleted` or `skipped`）
 */
export function applyDelete(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  recordId: string
): { action: 'deleted' | 'skipped' } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  const result = localDb
    .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .run(recordId);

  return { action: result.changes > 0 ? 'deleted' : 'skipped' };
}
