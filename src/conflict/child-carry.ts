/**
 * 敗者行の DELETE を越えて、子を勝者へ引き渡す。
 *
 * `PRAGMA defer_foreign_keys` が遅らせるのは**検査**であって `ON DELETE` の**動作**では
 * ないので、敗者行を消す前に手当てが要る。ここに居るのは、その手当てと、
 * 実際に何行救えて何行失われたかの数え上げ。
 *
 * **黙って消えるのがいちばん悪い**、というのがこのモジュールの立場である。
 * 憶測で「及ばないはず」と決めず、削除の前後で数えて差を取る。
 *
 * @module conflict/child-carry
 * @internal
 */
import Database from 'better-sqlite3';
import {
  areColumnsNullable,
  escapeIdentifier,
  ForeignKeyRef,
  foreignKeysEnforced,
  isSameIdentifier,
  rowKeyColumns,
} from './schema';

/**
 * 敗者の子をどう引き取ったかの集計。
 *
 * 一部の子は**敗者行を消したあとでないと結末が決まらない**ため、`afterDelete` に
 * その後始末を積む。積んだ関数は {@link foldRowInto} が DELETE の直後に走らせ、
 * そのとき `movedChildren` / `lostChildren` を確定させる。
 * @internal
 */
export interface ChildCarry {
  /** 敗者から勝者へ引き継げた直接の子の行数 */
  movedChildren: number;
  /** 引き継げずに失われた直接の子の行数（{@link RecordFold.lostChildren}） */
  lostChildren: number;
  /** 敗者行の DELETE 直後に走らせる後始末 */
  afterDelete: (() => void)[];
}

/** @internal */
export function emptyChildCarry(): ChildCarry {
  return { movedChildren: 0, lostChildren: 0, afterDelete: [] };
}

/**
 * 敗者と勝者で参照先の値が同じ子を、敗者の DELETE を越えて勝者へ引き継ぐ。
 *
 * この形は**主キー以外のユニーク列を指す外部キー**でだけ起きる。値そのものが勝者へ
 * 移るので子の列は書き換えなくてよく、危ないのは敗者行の DELETE だけ:
 *
 * - `NO ACTION` — 何も起きない。外部キーの**検査**は
 *   {@link runDeferringForeignKeys} が終端まで遅らせてあり、そのときには勝者が
 *   この値を持っているので通る。子はそのまま勝者の子になる
 * - `CASCADE` / `SET NULL` / `SET DEFAULT` / `RESTRICT` — **子に及ぶ**。
 *   `PRAGMA defer_foreign_keys` が遅らせるのは検査であって動作ではない。
 *   参照列を一旦 NULL にして敗者から外し、削除後に元の値へ戻す（この間の
 *   宙ぶらりんは、遅延された検査が終端で見るときには解消している）
 *
 * 参照列が `NOT NULL` の場合は外せない。そのときは黙って消させず、**実際に何行
 * 失われたかを数えて** {@link RecordFold.lostChildren} で呼び出し元へ伝える。
 * @internal
 */
export function carryChildrenThroughDelete(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[],
  carry: ChildCarry
): void {
  const childCount = countChildrenReferencing(db, foreignKey, referencedValues);
  if (childCount === 0) return;

  // 外部キーが効いていない接続、または削除が子に及ばない宣言なら、子は放っておいてよい
  // （検査は終端まで遅れており、そのときには勝者がこの値を持っている）
  if (foreignKey.onDelete === 'NO ACTION' || !foreignKeysEnforced(db)) {
    carry.movedChildren += childCount;
    return;
  }

  const detached = detachChildren(db, foreignKey, referencedValues);
  if (!detached) {
    countChildrenLostToDelete(db, foreignKey, referencedValues, childCount, carry);
    return;
  }

  carry.afterDelete.push(() => {
    detached.reattach();
    carry.movedChildren += childCount;
  });
}

/**
 * 子の参照列を一旦 NULL にして敗者から外す（`ON DELETE` の動作を空振りさせる）。
 *
 * 外せた場合は、敗者の削除後に元の値へ戻す手続きを返す。外せない形なら null を返す:
 *
 * - 参照列が `NOT NULL`
 * - 参照列が子自身の主キーを兼ねている（NULL にすると戻す行を指せなくなる）
 * - `CHECK (column IS NOT NULL)` のように、`NOT NULL` 以外の書き方で NULL を
 *   禁じている（実際に NULL を入れてみるまで分からないので、失敗を拾って null を返す）
 *
 * NULL にしても子のユニーク制約は壊れない（SQLiteのUNIQUEはNULL同士を衝突させない）。
 * @internal
 */
export function detachChildren(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[]
): { reattach: () => void } | null {
  const childColumns = foreignKey.columns.map((column) => column.childColumn);
  if (!areColumnsNullable(db, foreignKey.childTable, childColumns)) return null;

  const keyColumns = rowKeyColumns(db, foreignKey.childTable);
  if (
    childColumns.some((childColumn) =>
      keyColumns.some((keyColumn) => isSameIdentifier(keyColumn, childColumn))
    )
  ) {
    return null;
  }

  const escapedChildTable = escapeIdentifier(foreignKey.childTable);
  const matchClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
    .join(' AND ');
  const escapedKeyColumns = keyColumns.map((keyColumn) =>
    escapeIdentifier(keyColumn)
  );

  // 戻す行を指すための鍵を、外す前に控える
  const keyRows = db
    .prepare(
      `SELECT ${escapedKeyColumns.join(', ')} FROM ${escapedChildTable} WHERE ${matchClause}`
    )
    .all(...referencedValues) as Record<string, unknown>[];

  try {
    db.prepare(
      `UPDATE ${escapedChildTable} SET ${childColumns
        .map((childColumn) => `${escapeIdentifier(childColumn)} = NULL`)
        .join(', ')} WHERE ${matchClause}`
    ).run(...referencedValues);
  } catch {
    // 外せないと分かっただけ。ここで投げて取り込みを止めてしまわない
    // （止めるとその相手からの同期が永久に止まる）。数えて伝える方へ落とす。
    return null;
  }

  const keyMatchClause = escapedKeyColumns
    .map((escapedKeyColumn) => `${escapedKeyColumn} = ?`)
    .join(' AND ');
  const reattachStatement = db.prepare(
    `UPDATE ${escapedChildTable} SET ${foreignKey.columns
      .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
      .join(', ')} WHERE ${keyMatchClause}`
  );

  return {
    reattach: (): void => {
      for (const keyRow of keyRows) {
        reattachStatement.run(
          ...referencedValues,
          ...keyColumns.map((keyColumn) => keyRow[keyColumn])
        );
      }
    },
  };
}

/**
 * 敗者の DELETE で子が実際に何行消えた（外された）かを、削除のあとに数える。
 *
 * `ON DELETE` の動作が本当に及ぶかを憶測で決めず、**削除の前後で数えて差を取る**。
 * まだ在って、まだ同じ値を指している子だけを引き継げたものとして数え、残りを
 * {@link RecordFold.lostChildren} に載せる。黙って消えるのがいちばん悪い。
 * @internal
 */
export function countChildrenLostToDelete(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[],
  childCountBefore: number,
  carry: ChildCarry
): void {
  if (childCountBefore === 0) return;

  carry.afterDelete.push(() => {
    const after = countChildrenReferencing(db, foreignKey, referencedValues);
    carry.movedChildren += Math.min(after, childCountBefore);
    carry.lostChildren += Math.max(childCountBefore - after, 0);
  });
}

/**
 * その参照先の値を指している子の行数。
 * @internal
 */
export function countChildrenReferencing(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  referencedValues: unknown[]
): number {
  const matchClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
    .join(' AND ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS childCount FROM ${escapeIdentifier(foreignKey.childTable)}
       WHERE ${matchClause}`
    )
    .get(...referencedValues) as { childCount: number };
  return row.childCount;
}


