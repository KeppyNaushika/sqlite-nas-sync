/**
 * 「この行は消えたのではなく、あの行へ畳まれた」という削除をローカルへ適用する。
 *
 * リモートの `_tombstone.mergedInto` から呼ばれる。**自分では競合を経験していない
 * クライアントでも子を失わない**ようにするのがこの経路の役目で、そのために敗者行を
 * 消す前に、敗者を指している子を畳み先へ付け替える。
 *
 * @module conflict/merged-delete
 * @internal
 */
import Database from 'better-sqlite3';
import { RecordFold } from '../types';
import { escapeIdentifier, readColumn } from './schema';
import {
  foldTimestampOf,
  isLaterTimestamp,
  TimestampColumnFor,
} from './timestamp';
import { hasIdMerges, recordMerge, resolveFoldChain } from './ledger';
import { ResurrectionProbe } from './tombstone';
import { remapMergedForeignKeys } from './remap';
import { foldAndReplace, foldRowInto } from './fold';
import { runDeferringForeignKeys } from './transaction';

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

  // 呼び出し元が読んだ勝者行は、この id のもの（鎖を辿る前の畳み先）
  const requestedWinningId = winningId;

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
      String(readColumn(losingRow, timestampColumn) ?? ''),
      foldedAt
    )
  ) {
    return { action: 'skipped', folds, warnings: [] };
  }

  const localWinningRow = losingRow
    ? (localDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(winningId) as Record<string, unknown> | undefined)
    : undefined;

  // **渡された勝者行は、鎖を辿る前の畳み先のもの。** 終端が動いていたら、その行は
  // ここで入れてよい行ではない。入れると、**この端末が既に畳んで tombstone まで
  // 書いた中間の id が復活する**（`_id_merge` には終端しか載っていないので、その行の
  // 子は行き先の無い id へ読み替えられて捨てられる）。呼び出し元が終端の行を読んで
  // 渡し直すまで、敗者行はそのまま残す（消さなければ子は道連れにならない）。
  //
  // **帳簿にも書かずに戻る。** 先に `recordMerge` を通してからここで見送ると、
  // `_id_merge` と `_tombstone.mergedInto` には「敗者は終端へ畳まれた」と載るのに
  // 敗者行は消されないまま残る。渡し直す呼び出し元は無い（`applyTombstoneDelete` は
  // `ts.mergedInto` から勝者行を一度しか読まず、changelog経路はカーソルが進んで
  // 同じ削除が二度来ない）ので、その行は**永久に生きたまま「畳まれた」と記録された
  // 幽霊**になり、遅れて届いた子だけが終端へ読み替えられて本当の親から切り離される。
  // 終端が動いていても、畳み先が手元に在る（`localWinningRow`）ときは実際に畳めるので
  // ここには来ない。
  //
  // **この畳みは自動では戻ってこない。** リモートの `_tombstone` を全件読み直す
  // `applyTombstones` はギャップ検出時（`pullFullMerge`）にしか走らず、ふだんの増分
  // 同期は changelog のカーソルが進んで同じ削除を二度運ばない。終端の行がこの端末へ
  // 届いても、それだけでは畳みはやり直されない（その行に新しい変更が載って初めて
  // 通りかかる）。幽霊を作るよりは残す方が安全だが、**黙って落とすと分岐に気づけない**
  // ので警告として伝える。
  //
  // **判定の根拠は「終端が動いたか」であって「渡された勝者行があるか」ではない。**
  // 鎖が動いた理由は中間の勝者自身が畳まれて消えたことなので、**取り込み元にもその行は
  // もう無く**、`winningRow` は `undefined` で来るのがふつうである（`readRemoteRecord`
  // は動く前の id で引く）。行の有無で振り分けると、いちばん起きやすい経路が素通りして
  // 幽霊が生まれる。渡された行が終端と違う id を名乗っている場合も同じ扱い。
  //
  // 第2項（渡された行が終端と違う id を名乗っている）は、同期経路からは起きない
  // ——`readRemoteRecord` は必ず `requestedWinningId` で引くので、真になるときは
  // 第1項も真である。**公開APIを直接呼ぶ利用者**が、鎖と無関係な行を渡した場合の
  // ためだけに残してある（渡された行をそのまま入れると別の id が復活する）。
  const foldTargetMoved =
    winningId !== requestedWinningId ||
    (winningRow !== undefined && String(readColumn(winningRow, primaryKey)) !== winningId);

  if (losingRow && !localWinningRow && foldTargetMoved) {
    return {
      action: 'skipped',
      folds,
      warnings: [
        `Fold of ${tableName}:${losingId} into ${winningId} was not applied: ` +
          `the fold target has moved and its row is not here. ` +
          `${losingId} stays until ${winningId} arrives.`,
      ],
    };
  }

  // **勝者行の読み替えは、帳簿へ書く前に済ませる。** 勝者行そのものが消えた親を
  // 指していて採れないと決まることがあり（下の `remap.record === null`）、その場合は
  // 敗者行も畳まない。先に `recordMerge` を通してからそこで見送ると、上と同じ
  // 「生きたまま畳まれたと記録された幽霊」になる。
  const remap =
    losingRow && !localWinningRow && winningRow && !foldTargetMoved
      ? remapMergedForeignKeys(
          localDb,
          tableName,
          primaryKey,
          winningRow,
          timestampColumn,
          isResurrected,
          timestampColumnFor
        )
      : null;
  if (remap && remap.record === null) {
    return { action: 'skipped', folds, warnings: remap.warnings };
  }
  const remappedWinner = remap?.record ?? null;

  // 畳みを実行できるかに関わらず、敗者idの読み替えは先に覚える。
  // これが無いと、あとから届く敗者の子が存在しない親を指したままになる。
  recordMerge(localDb, tableName, losingId, winningId, foldedAt);

  if (!losingRow) return { action: 'skipped', folds, warnings: [] };

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

  if (winningRow && remap && remappedWinner) {
    // 勝者行もローカルに無い → 敗者を畳んでから勝者を入れる。
    // 勝者行の外部キーの読み替え（既に畳まれた行を指しているかもしれない）は、
    // 帳簿へ書く前に上で済ませてある。
    foldAndReplace(
      localDb,
      tableName,
      primaryKey,
      [losingRow],
      remappedWinner,
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
