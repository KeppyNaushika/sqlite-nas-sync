/**
 * 行を1つへ畳む —— 敗者を指している子を勝者へ付け替え、敗者行を消し、帳簿へ記録する。
 *
 * 順番がすべてである。**先に消すとカスケードで子が道連れになる**ので、
 * 付け替え → 削除 → 記録の順に進む。
 *
 * 子の付け替えが子自身のユニーク制約にぶつかると、子どうしをまた同じLWWで1行へ畳む
 * ことになる（そのまた子＝孫がぶら下がっているので、{@link foldRowInto} と
 * {@link repointChild} は互いを呼び合う）。**この相互再帰があるので、この3つの関数は
 * 同じファイルに置いてある。** 分けると読む側が2ファイルを往復することになるうえ、
 * import が循環する。
 *
 * @module conflict/fold
 * @internal
 */
import Database from 'better-sqlite3'
import { RecordFold } from '../types'
import {
  escapeIdentifier,
  findReferencingForeignKeys,
  ForeignKeyRef,
  getTableColumns,
  foldIdentifier,
  isSameIdentifier,
  readColumn,
} from './schema'
import { foldTimestampOf, resolveTimestampColumn } from './timestamp'
import {
  findUniqueRivals,
  outranksAllRivals,
  primaryKeyAsUniqueKey,
  readSecondaryUniqueKeys,
  selectSurvivingRival,
} from './unique'
import { recordFold, recordMerge } from './ledger'
import {
  hasChangelogDelete,
  maxChangelogId,
  writeFoldDeletion,
} from './fold-changelog'
import {
  carryChildrenThroughDelete,
  ChildCarry,
  countChildrenLostToDelete,
  countChildrenReferencing,
  emptyChildCarry,
} from './child-carry'
import { runInSavepoint } from './transaction'
/**
 * 敗者行を指している子を勝者行へ付け替える。
 *
 * 付け替えが子自身のユニーク制約にぶつかった場合（勝者側に「同じもの」が既にある場合）は、
 * 子どうしを同じLWWで1行に畳む。畳んで消える側の子には、その子の子（孫）が
 * ぶら下がっている可能性があるため、{@link foldRowInto} を再帰的に使う。
 *
 * @param deletesLosingRow - 呼び出し元がこのあと敗者行を **DELETE する** なら true。
 *   主キー以外のユニーク列を指す外部キーでは、敗者と勝者で参照先の値が同じになることが
 *   あり（勝者はまだその値を持っていない＝書き込みは畳みの後）、そのとき子は付け替え
 *   ようが無い。値が同じでも敗者の削除は子に及ぶので、削除する場合だけ子を守る
 *   （{@link carryChildrenThroughDelete}）。付け替えで敗者行のidが動くだけの経路
 *   （{@link repointChild} の再入）では削除が起きないため false。
 * @internal
 */
export function repointChildren(
  db: Database.Database,
  parentTable: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  winningRow: Record<string, unknown>,
  timestampColumn: string,
  folded: Set<string>,
  folds: RecordFold[],
  deletesLosingRow: boolean
): ChildCarry {
  const carry = emptyChildCarry()
  for (const foreignKey of findReferencingForeignKeys(
    db,
    parentTable,
    primaryKey
  )) {
    const losingValues = foreignKey.columns.map(
      (column) => losingRow[column.parentColumn]
    )
    const winningValues = foreignKey.columns.map(
      (column) => winningRow[column.parentColumn]
    )

    // 敗者側の参照先がNULLなら、その参照で敗者を指している子は居ない
    if (losingValues.some((value) => value === null || value === undefined)) {
      continue
    }
    // 勝者側の参照先がNULLなら、そこへは付け替えられない（付け替えると外部キーが壊れる）。
    // 衝突したユニーク列の値はNULLになり得ない（SQLiteのUNIQUEはNULL同士を衝突させない）ので、
    // 主キー以外を指す外部キーの、さらに限られた形でしか起こらない。
    if (winningValues.some((value) => value === null || value === undefined)) {
      if (deletesLosingRow) {
        // 付け替え先が無いまま敗者を消すので、`ON DELETE` の動作がそのまま子に及ぶ。
        // 黙らせず、実際に失われた数を数えて伝える。
        countChildrenLostToDelete(
          db,
          foreignKey,
          losingValues,
          countChildrenReferencing(db, foreignKey, losingValues),
          carry
        )
      }
      continue
    }
    // 参照先の値が同じ。**「子は既に勝者を指している」とは限らない。**
    // 主キーを指す外部キーならその通りだが（敗者と勝者で主キーは必ず違うので、
    // そもそもここへ来ない）、主キー以外のユニーク列を指す外部キーでは、
    // 勝者はまだその値を持っていない — 書き込み（UPDATE / INSERT）は畳みの**あと**に
    // 走るため。子は敗者の行に繋がったままで、敗者を消せば道連れになる。
    if (losingValues.every((value, index) => value === winningValues[index])) {
      if (deletesLosingRow) {
        carryChildrenThroughDelete(db, foreignKey, losingValues, carry)
      }
      continue
    }

    const escapedChildTable = escapeIdentifier(foreignKey.childTable)
    const matchClause = foreignKey.columns
      .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
      .join(' AND ')

    const childRows = db
      .prepare(`SELECT * FROM ${escapedChildTable} WHERE ${matchClause}`)
      .all(...losingValues) as Record<string, unknown>[]

    for (const childRow of childRows) {
      carry.movedChildren += repointChild(
        db,
        foreignKey,
        primaryKey,
        childRow,
        winningValues,
        timestampColumn,
        folded,
        folds
      )
    }
  }
  return carry
}

/**
 * 既にある行の中身を、渡した行の値で上書きする（主キーは触らない）。
 *
 * 「席は1つしか無いが、そこに座るべき中身は別の行が持っている」場面で使う
 * （{@link repointChild} で、付け替え先の主キーを別の行が占めている場合）。
 * 行を消して入れ直すのではなく上書きするのは、消すとその行の子が
 * `ON DELETE` の動作で道連れになるため。
 *
 * 主キー以外に列が無い表では何もしない。
 * @internal
 */
export function overwriteRow(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  row: Record<string, unknown>
): void {
  const updateColumns = getTableColumns(db, tableName).filter(
    (column) => !isSameIdentifier(column, primaryKey)
  )
  if (updateColumns.length === 0) return

  db.prepare(
    `UPDATE ${escapeIdentifier(tableName)} SET ${updateColumns
      .map((column) => `${escapeIdentifier(column)} = ?`)
      .join(', ')} WHERE ${escapeIdentifier(primaryKey)} = ?`
  ).run(
    ...updateColumns.map((column) => row[column]),
    readColumn(row, primaryKey)
  )
}

/**
 * 子1行の外部キーを勝者へ向け直す。
 *
 * @returns 書き換えた行数（0 または 1）。この子自身が畳まれて消えた場合は 0
 *   （付け替えたのではないため。その子ぶんの {@link RecordFold} が別に出る）。
 * @internal
 */
export function repointChild(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  primaryKey: string,
  childRow: Record<string, unknown>,
  winningValues: unknown[],
  timestampColumn: string,
  folded: Set<string>,
  folds: RecordFold[]
): number {
  const escapedChildTable = escapeIdentifier(foreignKey.childTable)
  const escapedPk = escapeIdentifier(primaryKey)
  const setClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
    .join(', ')
  const updateStatement = db.prepare(
    `UPDATE ${escapedChildTable} SET ${setClause} WHERE ${escapedPk} = ?`
  )

  // 付け替え後の姿
  const repointedRow = { ...childRow }
  foreignKey.columns.forEach((column, index) => {
    repointedRow[column.childColumn] = winningValues[index]
  })

  // **子の時刻列は、親の時刻列と同じ名前とは限らない。** 畳みの記録に刻む時刻は
  // ここで解決した列から読むこと。親の列名のまま子の行を引くと値が取れず、記録は
  // 黙って現在時刻に落ちる（＝畳みではなく「今消した」と主張してしまう）。
  const childTimestampColumn = resolveTimestampColumn(
    db,
    foreignKey.childTable,
    timestampColumn
  )

  const runRepoint = (): number => {
    const changelogIdBefore = maxChangelogId(db) ?? 0
    const { changes } = updateStatement.run(
      ...winningValues,
      readColumn(childRow, primaryKey)
    )

    // 親と主キーを共有する1:1のテーブルでは、外部キーが主キーそのものなので
    // 付け替えで子のidが動く。孫は古いidを指したままになるため、ここで引き取る。
    const previousId = String(readColumn(childRow, primaryKey))
    const nextId = String(readColumn(repointedRow, primaryKey))
    if (previousId !== nextId) {
      // 孫がここで動いた数は、どの `RecordFold` にも載らない（行が消えたのではなく
      // 1行のidが動いただけなので、畳みとして記録されないため）。
      // この子1行を付け替えたことだけを数える（{@link RecordFold.movedChildren}）。
      repointChildren(
        db,
        foreignKey.childTable,
        primaryKey,
        childRow,
        repointedRow,
        timestampColumn,
        folded,
        folds,
        // この経路は行を消さない（1行のidが動くだけ）ので、
        // 子を削除から守る細工は要らないし、してはいけない
        false
      )
      // ここは行が1つ消えたのではなく、1行のidが動いただけなので `folds` には載せない
      // （利用者へ「2つを1つにまとめた」と伝える対象ではない）。
      // 刻む時刻は動いた先の行が名乗っている版の時刻。現在時刻にすると、古いidへの
      // 到着を無条件に止めるしきい値になってしまう（{@link recordTombstoneMerge}）。
      //
      // **これは主張ではなく、たった今この手で起こした移動である**（上の UPDATE で
      // 行はもう `previousId` に無い）。だから `replacesOwnDeletion` を渡して、
      // 古い記録との比較で断られないようにする。断られると、帳簿は `previousId` を
      // 古い勝者へ向けたまま、実体は `nextId` に在るという食い違いが残り、しかも下の
      // `writeFoldDeletion` は走るので**古い畳み先を名乗る DELETE を公開してしまう**
      // （行が既に消えている点は、同じ形の `foldRowInto` の記録と変わらない）。
      recordMerge(
        db,
        foreignKey.childTable,
        previousId,
        nextId,
        foldTimestampOf(repointedRow, childTimestampColumn),
        true
      )

      // idが動いた＝古いidの行はもうどこにも無い。UPDATEトリガーが残すのは新しいidの
      // UPDATEだけなので、「古いid → 新しいid」の畳みは自分で差分経路へ載せる。
      if (
        !hasChangelogDelete(
          db,
          foreignKey.childTable,
          previousId,
          changelogIdBefore
        )
      ) {
        writeFoldDeletion(db, foreignKey.childTable, previousId)
      }
    }

    return changes
  }

  try {
    return runRepoint()
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string }
    if (
      sqliteErr.code !== 'SQLITE_CONSTRAINT_UNIQUE' &&
      sqliteErr.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      throw err
    }

    // 勝者側に「同じもの」が既にある。子どうしを親と同じLWWで1行へ畳む。
    // 相手は索引から**先に全部**引く（1本目を畳んでから2本目が見える、が起きないように）。
    // 付け替えで子のidそのものが動く形（外部キーが主キーを兼ねる1:1）では、
    // 動いた先のidを占めている行も相手なので、主キーの組も足して引く。
    const rivalRows = findUniqueRivals(
      db,
      foreignKey.childTable,
      primaryKey,
      repointedRow,
      readColumn(childRow, primaryKey),
      [
        primaryKeyAsUniqueKey(primaryKey),
        ...readSecondaryUniqueKeys(db, foreignKey.childTable),
      ]
    )

    // 衝突相手を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
    if (rivalRows.length === 0) throw err

    // 付け替え先の主キーを既に占めている行（外部キーが子の主キーを兼ねる1:1で、
    // 付け替えによって子のidが動く場合にだけ現れる）。
    //
    // **これは畳みの候補にできない。** 畳みは「敗者idの行を消して勝者idへ寄せる」
    // ことだが、この相手のidは付け替え後の自分のidそのものなので、敗者idと勝者idが
    // 同じになる。{@link foldRowInto} は何もせずに戻り、そのあと同じ付け替えを
    // もう一度走らせて主キー違反を投げる（どの catch にも捕まらない）。
    //
    // 席は1つしか無いのだから、**どちらが勝っても残る行はこの席の行1つ**。
    // 勝敗が決めるのは中身であって、どちらの行が消えるかではない。
    const nextId = String(readColumn(repointedRow, primaryKey))
    const slotOccupant = rivalRows.find(
      (rivalRow) => String(readColumn(rivalRow, primaryKey)) === nextId
    )
    const foldableRivals = rivalRows.filter(
      (rivalRow) => rivalRow !== slotOccupant
    )

    if (
      outranksAllRivals(
        db,
        repointedRow,
        rivalRows,
        childTimestampColumn,
        primaryKey
      )
    ) {
      // 付け替える側の中身が残る → 先に衝突相手を全員畳む
      const allFolded = foldableRivals
        .map((rivalRow) =>
          foldRowInto(
            db,
            foreignKey.childTable,
            primaryKey,
            rivalRow,
            repointedRow,
            timestampColumn,
            folded,
            folds,
            // 勝ち残るのは付け替える側の子。その行が名乗っている版の時刻を刻む
            foldTimestampOf(repointedRow, childTimestampColumn)
          )
        )
        .every((didFold) => didFold)

      // 畳めなかった相手が居るのに付け替えを走らせると、同じ違反をもう一度、
      // 今度は誰も受け取らない形で投げることになる。握りつぶさず呼び出し元へ渡す。
      if (!allFolded) throw err

      if (!slotOccupant) return runRepoint()

      // 席が埋まっているので行そのものは動かせない。動かす側の行を席へ畳んでから、
      // 中身だけ席へ移す（孫は席の行へ引き取られる）。
      //
      // **この順序を逆にしてはいけない。** 明け渡す側の行がまだ在るうちに中身を席へ
      // 書くと、その行が握っているユニークな値（子自身のセカンダリUNIQUE）と衝突して
      // 投げる。畳んで消したあとなら、その値は空いている。
      foldRowInto(
        db,
        foreignKey.childTable,
        primaryKey,
        childRow,
        repointedRow,
        timestampColumn,
        folded,
        folds,
        // 席に残るのは付け替える側の中身。その版の時刻を刻む
        foldTimestampOf(repointedRow, childTimestampColumn)
      )
      overwriteRow(db, foreignKey.childTable, primaryKey, repointedRow)
      // 付け替えたのではなく畳まれて消えた（この子ぶんの `RecordFold` が別に1件出る）
      return 0
    }

    // 衝突相手が残る → 付け替える側を衝突相手へ畳む（孫は衝突相手へ引き取られる）
    const survivingChild = selectSurvivingRival(
      db,
      rivalRows,
      childTimestampColumn,
      primaryKey
    )
    foldRowInto(
      db,
      foreignKey.childTable,
      primaryKey,
      childRow,
      survivingChild,
      timestampColumn,
      folded,
      folds,
      // 勝ち残るのは衝突相手の子。その行が名乗っている版の時刻を刻む
      foldTimestampOf(survivingChild, childTimestampColumn)
    )

    // この子は付け替えたのではなく畳まれて消えた。数えるのは付け替えた行だけなので 0
    // （この子ぶんの `RecordFold` が別に1件出ており、孫の数はそちらに載る）。
    return 0
  }
}

/**
 * 敗者行を勝者行へ畳む。
 *
 * 1. 敗者を指している子を勝者へ付け替える（先に消すとカスケードで道連れになる）
 * 2. 敗者行を削除する
 * 3. 「敗者id → 勝者id」を `_id_merge` と `_tombstone.mergedInto` に記録する
 * 4. 畳みが `_changelog` に載っていなければ載せる（フルマージ中はトリガーが外れていて、
 *    2. のDELETEが何も記録しないため）
 *
 * **勝者行はこの時点でまだ存在していなくてよい。** 呼び出し元が外部キーの検査を
 * トランザクション終端まで遅延させているため（{@link foldAndReplace} を参照）。
 *
 * **敗者行の属性はマージしない。** 列の意味を知らないので、勝者が総取りする。
 * 既知の穴として据え置く（例: 「表に出す」「箱ひげ図に出す」のような真偽値の列は、
 * 本来なら両者のORを取るべきだが、ライブラリからはただの列にしか見えない）。
 *
 * **孫は動かさない。** 子の主キーは変わらないので、孫は子を指したままで正しい。
 * 子自身が畳まれて消える場合（ユニーク衝突）に限り、この関数が再帰して孫を引き取る。
 *
 * @param folded - 同じ行を二度たどらないための印（子の付け替えの再入防止）
 * @param folds - 畳んだ記録の集め先。呼び出し元を通って {@link SyncResult.folds} へ出る
 * @param foldedAt - **畳みが確定した時刻＝勝者行が名乗っている版の時刻。**
 *   呼び出し元が供給する（この関数は勝者行のどの列が時刻かを知らない — 子どうしの
 *   畳みでは列名が親と違いうる。{@link foldTimestampOf} で取り出すこと）。
 *   undefined を渡すと記録は現在時刻に落ちる。それは**本物の削除**の意味であり、
 *   畳みでは決して渡してはいけない（理由は {@link recordTombstoneMerge}）。
 * @returns 畳んだか。**敗者idと勝者idが同じなら何もせず false**（畳みは
 *   「敗者idの行を消して勝者idへ寄せる」ことなので、同じidでは成り立たない）。
 *   呼び出し元は、畳めたつもりで先へ進まないためにこれを見ること。
 * @internal
 */
export function foldRowInto(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  winningRow: Record<string, unknown>,
  timestampColumn: string,
  folded: Set<string>,
  folds: RecordFold[],
  foldedAt: string | undefined
): boolean {
  const losingId = String(readColumn(losingRow, primaryKey))
  const winningId = String(readColumn(winningRow, primaryKey))
  if (losingId === winningId) return false

  // 自己参照する外部キーがあると同じ行へ戻ってくる可能性があるため、
  // **子の付け替えだけ**は繰り返さない（無限再帰になる）。
  // 削除と記録は再入のたびに行う — ここへ再入するのは「この行は消える」と二度決まった
  // ときであり、何もせず戻ると、畳まれて消える親を指したままの子が残って
  // COMMIT時に外部キー違反になる（その相手ぶんの取り込みが丸ごと巻き戻る）。
  const marker = `${foldIdentifier(tableName)}:${losingId}`
  const revisited = folded.has(marker)
  folded.add(marker)

  // 付け替えた子の数は利用者へ返す（{@link RecordFold.movedChildren}）。
  // 再入したときは付け替えを繰り返さないので 0。
  const carry = revisited
    ? emptyChildCarry()
    : repointChildren(
        db,
        tableName,
        primaryKey,
        losingRow,
        winningRow,
        timestampColumn,
        folded,
        folds,
        // このあと敗者行を消す。値で繋がっている子は削除から守る必要がある
        true
      )

  const changelogIdBefore = maxChangelogId(db) ?? 0

  db.prepare(
    `DELETE FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(primaryKey)} = ?`
  ).run(readColumn(losingRow, primaryKey))

  // 削除を越えて子を引き継ぐ後始末（外した参照を戻す・失われた数を数える）。
  // ここで `carry` の数が確定する。
  for (const finishCarry of carry.afterDelete) finishCarry()

  // 刻むのは畳みが確定した時刻であって、いま削除を走らせた時刻ではない。
  // 直前のDELETEでトリガーが `_tombstone` に現在時刻を書いているので、ここだけは
  // 比べずに**置く**（`replacesOwnDeletion`）。比べる形にすると必ず負ける。
  recordMerge(db, tableName, losingId, winningId, foldedAt, true)

  // 「この行とこの行が1つになった」を呼び出し元へ伝える（利用者への説明に使われる）。
  // この経路は行を消しているので removedLocalRow は true。
  recordFold(
    folds,
    tableName,
    losingId,
    winningId,
    true,
    carry.movedChildren,
    carry.lostChildren
  )

  // 通常はいま起こしたDELETEでトリガーが `_changelog` に記録している。フルマージは
  // トリガーを外して走るのでそれが無く、畳みが差分経路に載らないまま埋もれる。手で書く。
  if (!hasChangelogDelete(db, tableName, losingId, changelogIdBefore)) {
    writeFoldDeletion(db, tableName, losingId)
  }

  return true
}

/**
 * 敗者行（複数可）を勝者行へ畳み、勝者行を挿入する。
 *
 * 1回の挿入がユニーク索引ごとに別々の行にぶつかることがあるため、敗者は**組で**受け取る。
 * 呼び出し元は全員ぶんの勝敗を先に決めてから渡すこと（途中で拒否が決まる形にしない）。
 *
 * 付け替えの時点では勝者行がまだ存在しないため、外部キーの**検査**をトランザクション
 * 終端まで遅らせる（`PRAGMA defer_foreign_keys`）。制約を切るのではなく検査を遅らせる
 * だけなので、COMMIT時に矛盾が残っていれば通常どおり失敗する。
 *
 * 畳みと挿入は1つの区切り（SAVEPOINT）で行う。想定していない制約で挿入が失敗したときに、
 * **畳んだぶんだけが残る**のを避けるため。
 *
 * @param decidedAt - **よそで下された判断を適用する場合の、その判断の時刻。**
 *   受け取った `_tombstone.deletedAt` をここへ渡すこと。省略すると勝者行が
 *   **いま名乗っている**時刻に落ちるが、勝者行はその判断のあとに編集されていることが
 *   あり、そのときは畳みのしきい値だけが未来へ動く。実測では、判断の時刻と勝者行の
 *   時刻の間にある敗者idの版が、この端末でだけ黙って捨てられ**永久に食い違った**
 *   （判断を下した端末はその版を持ったままなので）。理由は
 *   {@link recordTombstoneMerge}。
 * @internal
 */
export function foldAndReplace(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingRows: Record<string, unknown>[],
  record: Record<string, unknown>,
  columns: string[],
  timestampColumn: string,
  folds: RecordFold[],
  decidedAt?: string
): void {
  // 畳みが確定した時刻。**よそで下された判断を適用しているなら、その判断の時刻**を
  // 呼び出し元が渡す。渡されなければ、勝者は挿入される `record` なので、
  // その行が名乗る版の時刻を使う。
  const foldedAt = decidedAt ?? foldTimestampOf(record, timestampColumn)

  runInSavepoint(db, () => {
    const folded = new Set<string>()
    for (const losingRow of losingRows) {
      foldRowInto(
        db,
        tableName,
        primaryKey,
        losingRow,
        record,
        timestampColumn,
        folded,
        folds,
        foldedAt
      )
    }
    db.prepare(
      `INSERT INTO ${escapeIdentifier(tableName)} (${columns
        .map((column) => escapeIdentifier(column))
        .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...columns.map((column) => record[column]))
  })
}
