/**
 * レコードレベルの競合解決ロジックを提供するモジュール。
 *
 * INSERT（UPSERT fallback）、UPDATE（LWW）、DELETE の3つの操作を処理する。
 *
 * @module conflict
 */
import Database from 'better-sqlite3';
import { ConflictInfo } from './types';
import { ensureTombstoneMergedIntoColumn } from './setup';

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * UNIQUE制約エラーのメッセージから違反したカラム名を抽出する。
 *
 * better-sqlite3のエラーメッセージ形式:
 * `UNIQUE constraint failed: Table.colA, Table.colB`
 *
 * @returns 違反したカラム名の配列。解析できない場合は空配列。
 * @internal
 */
function parseUniqueConflictColumns(
  err: unknown,
  tableName: string
): string[] {
  const message = err instanceof Error ? err.message : String(err);
  const match = /UNIQUE constraint failed: (.+)$/.exec(message);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${tableName}.`))
    .map((part) => part.slice(tableName.length + 1));
}

/**
 * 外部キー1本ぶんの参照関係。
 *
 * SQLiteの `PRAGMA foreign_key_list` が返す行を、複合外部キー（同一 `id` の複数行）
 * ごとにまとめた形。
 * @internal
 */
interface ForeignKeyRef {
  /** 外部キーを宣言している側（子）のテーブル名 */
  childTable: string;
  /** 参照されている側（親）のテーブル名 */
  parentTable: string;
  /** 子の列と、それが指す親の列の対応 */
  columns: { childColumn: string; parentColumn: string }[];
}

/** @internal SQLiteの `PRAGMA foreign_key_list` が返す行 */
interface ForeignKeyListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  /** 親の列。`REFERENCES parent` のように省略された場合は null（＝親の主キー） */
  to: string | null;
}

/** @internal SQLiteの `PRAGMA table_info` が返すカラム情報 */
interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * SQLiteの識別子は大文字小文字を区別しないため、テーブル名を畳んで比較する。
 * @internal
 */
function isSameIdentifier(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 指定テーブルが宣言している外部キー（＝このテーブルから他テーブルへの参照）を返す。
 * @internal
 */
function readForeignKeys(
  db: Database.Database,
  childTable: string,
  primaryKey: string
): ForeignKeyRef[] {
  const rows = db
    .prepare(`PRAGMA foreign_key_list(${escapeIdentifier(childTable)})`)
    .all() as ForeignKeyListRow[];

  const byId = new Map<number, ForeignKeyRef>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    const column = {
      childColumn: row.from,
      // `to` が null のときは親の主キーを指す
      parentColumn: row.to ?? primaryKey,
    };
    if (existing) {
      existing.columns.push(column);
    } else {
      byId.set(row.id, {
        childTable,
        parentTable: row.table,
        columns: [column],
      });
    }
  }
  return Array.from(byId.values());
}

/**
 * 指定テーブルを指している外部キー（＝他テーブルからこのテーブルへの参照）を返す。
 *
 * `PRAGMA foreign_key_list` は「このテーブルが何を指しているか」しか答えないため、
 * DB内の全テーブルを走査して逆向きに集める。スキーマの事前知識は要らない。
 * @internal
 */
function findReferencingForeignKeys(
  db: Database.Database,
  parentTable: string,
  primaryKey: string
): ForeignKeyRef[] {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];

  const refs: ForeignKeyRef[] = [];
  for (const { name } of tables) {
    for (const foreignKey of readForeignKeys(db, name, primaryKey)) {
      if (isSameIdentifier(foreignKey.parentTable, parentTable)) {
        refs.push(foreignKey);
      }
    }
  }
  return refs;
}

/**
 * テーブルのカラム名一覧を返す。
 * @internal
 */
function getTableColumns(db: Database.Database, tableName: string): string[] {
  const columns = db
    .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
    .all() as ColumnInfo[];
  return columns.map((column) => column.name);
}

/**
 * LWW比較に使うタイムスタンプ列を決める。
 *
 * 畳んだ親の設定（`timestampColumn`）を優先し、子テーブルにその列が無ければ
 * ライブラリ既定の `updatedAt` を使う。どちらも無ければ null（時刻では決められない）。
 * @internal
 */
function resolveTimestampColumn(
  db: Database.Database,
  tableName: string,
  preferred: string
): string | null {
  const columns = getTableColumns(db, tableName);
  if (columns.includes(preferred)) return preferred;
  if (columns.includes('updatedAt')) return 'updatedAt';
  return null;
}

/**
 * `_id_merge` テーブルを作成する（冪等）。
 *
 * このテーブルは「セカンダリUNIQUE違反を畳んだ結果、どの行がどの行に吸収されたか」を
 * 記録する。あとから届く子の外部キーを、生き残った行へ向け直すために使う。
 * @internal
 */
function ensureIdMergeTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _id_merge (
      tableName TEXT NOT NULL,
      losingId  TEXT NOT NULL,
      winningId TEXT NOT NULL,
      mergedAt  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tableName, losingId)
    )
  `);
}

/**
 * 「敗者id → 勝者id」を、ローカル索引 `_id_merge` と、他クライアントへ伝わる
 * `_tombstone.mergedInto` の両方に記録する。
 *
 * 既存の記録が今回の敗者を勝者として指していた場合は、その記録も終端（今回の勝者）へ
 * 張り替える。こうすることで参照は常に1段で解決でき、鎖をたどる必要が無い。
 * @internal
 */
function recordMerge(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string
): void {
  if (losingId === winningId) return;
  ensureIdMergeTable(db);

  db.prepare(
    `UPDATE _id_merge SET winningId = ?, mergedAt = datetime('now')
     WHERE tableName = ? COLLATE NOCASE AND winningId = ?`
  ).run(winningId, tableName, losingId);

  db.prepare(
    `INSERT INTO _id_merge (tableName, losingId, winningId) VALUES (?, ?, ?)
     ON CONFLICT(tableName, losingId)
     DO UPDATE SET winningId = excluded.winningId, mergedAt = datetime('now')`
  ).run(tableName, losingId, winningId);

  // 畳む向きが後から反転した場合（敗者idの方に新しい更新が届き、勝者を畳んだ場合）、
  // 上の張り替えで自分自身を指す記録が生まれる。意味を持たないので捨てる。
  db.prepare(
    `DELETE FROM _id_merge WHERE tableName = ? COLLATE NOCASE AND losingId = winningId`
  ).run(tableName);

  recordTombstoneMerge(db, tableName, losingId, winningId);
}

/**
 * 畳み先を `_tombstone` に載せる（他クライアントへはこの列で伝わる）。
 *
 * - `remote_wins`（敗者行を削除した側）— DELETEトリガーが作った行に畳み先を書き込む。
 *   トリガーは `INSERT OR REPLACE` なので、**削除より後に**呼ぶこと。
 * - `local_wins`（敗者行を持っていない側）— 削除が起きないので行ごと新しく書く。
 *   敗者idは全クライアントで永久に死んでいるため、tombstoneとして正しい。
 *   結果として {@link isShadowedByTombstone} がその id の復活を止めるが、
 *   復活しても同じユニークキーで再び衝突するだけなので意図した振る舞いである。
 *
 * `deletedAt` には触れない（削除時刻の判定は既存のLWWのまま）。
 * `_tombstone` を持たないDBでは何もしない。
 * @internal
 */
function recordTombstoneMerge(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string
): void {
  const hasTombstone = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get();
  if (!hasTombstone) return;
  ensureTombstoneMergedIntoColumn(db);

  // 畳み先の鎖を作らない（`_id_merge` と同じ扱い）
  db.prepare(
    `UPDATE _tombstone SET mergedInto = ?
     WHERE tableName = ? COLLATE NOCASE AND mergedInto = ?`
  ).run(winningId, tableName, losingId);

  db.prepare(
    `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(tableName, recordId) DO UPDATE SET mergedInto = excluded.mergedInto`
  ).run(tableName, losingId, winningId);

  // 自分自身を指す畳み先は意味を持たない（畳む向きが反転したときに生まれる）
  db.prepare(
    `UPDATE _tombstone SET mergedInto = NULL
     WHERE tableName = ? COLLATE NOCASE AND recordId = mergedInto`
  ).run(tableName);
}

/**
 * 敗者行をローカルに持っていない側（`local_wins`）で畳みを記録する。
 *
 * この側では敗者行のDELETEが起きないため、DELETEトリガーによる `_changelog` の記録も
 * 生まれない。それでは畳み先が**フルマージ経路でしか**他クライアントに渡らないが、
 * 隙間（{@link hasChangelogGap}）ができるのは保持期間を超えて同期しなかった端末だけなので、
 * **行儀よく毎日同期している端末ほど受け取れない**という逆転になる。
 * そこで `_changelog` へ DELETE を1行だけ手書きし、通常の差分経路にも乗せる。
 *
 * `_changelog` は既に「自分が自分の行に行った操作の記録」ではない
 * （{@link mergeChangelog} が相手のエントリをそのまま自分の changelog へ複製する）ので、
 * 持っていない行のエントリが載ること自体は元から起きている。
 *
 * `changedAt` は tombstone の `deletedAt` に揃える（受け取った側のLWWの判断がぶれないように）。
 * 既に同じ畳みを知っていれば書かない（同じエントリが増え続けないように）。
 * @internal
 */
function recordMergeWithoutLocalRow(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string
): void {
  // 参照する前に用意する（`_id_merge` がまだ無いDBでも動くように）
  ensureIdMergeTable(db);
  const alreadyRecorded = lookupIdMerge(db, tableName, losingId) === winningId;
  recordMerge(db, tableName, losingId, winningId);
  if (alreadyRecorded) return;

  const hasChangelog = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_changelog'`
    )
    .get();
  if (!hasChangelog) return;

  // tombstone を書けていない場合は畳み先も伝わらないので、削除だけを伝えない
  // （畳み先の無い削除として届くと、受け取った側で子が道連れになる）
  const tombstone = db
    .prepare(
      `SELECT deletedAt FROM _tombstone
       WHERE tableName = ? COLLATE NOCASE AND recordId = ?`
    )
    .get(tableName, losingId) as { deletedAt: string } | undefined;
  if (!tombstone) return;

  db.prepare(
    `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
     VALUES (?, ?, 'DELETE', ?)`
  ).run(tableName, losingId, String(tombstone.deletedAt));
}

/**
 * `_id_merge` に1件でも記録があるか。
 *
 * 競合が一度も起きていないDB（大多数）ではここで打ち切り、外部キーの走査をしない。
 * @internal
 */
function hasIdMerges(db: Database.Database): boolean {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_id_merge'`
    )
    .get();
  if (!exists) return false;
  return db.prepare(`SELECT 1 FROM _id_merge LIMIT 1`).get() !== undefined;
}

/**
 * 畳まれて消えた行のidを、吸収先のidに読み替える。記録が無ければ null。
 * @internal
 */
function lookupIdMerge(
  db: Database.Database,
  tableName: string,
  losingId: string
): string | null {
  const row = db
    .prepare(
      `SELECT winningId FROM _id_merge
       WHERE tableName = ? COLLATE NOCASE AND losingId = ?`
    )
    .get(tableName, losingId) as { winningId: string } | undefined;
  return row ? String(row.winningId) : null;
}

/**
 * レコードの外部キーのうち、既に畳まれて消えた行を指しているものを、吸収先へ向け直す。
 *
 * 自分が勝った側（`local_wins`）のクライアントには敗者行が入らないため、あとから届く
 * 相手の子は存在しない親を指す。向け直さないと外部キー違反でその相手ぶんの取り込みが
 * 丸ごと巻き戻り、同期がその相手から永久に止まる。
 *
 * 親の主キー以外を指す外部キー（`REFERENCES parent(uniqueColumn)` の形）は対象外。
 * `_id_merge` が覚えているのは主キーの対応だけであり、また衝突したユニーク列の値は
 * 敗者と勝者で同一なので、その列を指す参照は向け直す必要が無い。
 * @internal
 */
function remapMergedForeignKeys(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  if (!hasIdMerges(db)) return record;

  let remapped: Record<string, unknown> | null = null;
  for (const foreignKey of readForeignKeys(db, tableName, primaryKey)) {
    for (const { childColumn, parentColumn } of foreignKey.columns) {
      if (parentColumn !== primaryKey) continue;
      const current = record[childColumn];
      if (current === null || current === undefined) continue;

      const winningId = lookupIdMerge(
        db,
        foreignKey.parentTable,
        String(current)
      );
      if (winningId === null || winningId === String(current)) continue;

      remapped = remapped ?? { ...record };
      remapped[childColumn] = winningId;
    }
  }
  return remapped ?? record;
}

/**
 * 2つの行のうち、どちらを生かすかをLWWで決める。
 *
 * タイムスタンプ列が無い（または同時刻の）場合は主キーの辞書順で決める。
 * どの端末で解決しても同じ側が残るように、端末ごとに異なる情報は使わない。
 * @internal
 */
function isPreferredOverRival(
  db: Database.Database,
  row: Record<string, unknown>,
  rival: Record<string, unknown>,
  timestampColumn: string | null,
  primaryKey: string
): boolean {
  if (timestampColumn) {
    const rowTimestamp = String(row[timestampColumn] ?? '');
    const rivalTimestamp = String(rival[timestampColumn] ?? '');
    if (rowTimestamp !== rivalTimestamp) {
      return isLaterTimestamp(db, rowTimestamp, rivalTimestamp);
    }
  }
  return String(row[primaryKey]) < String(rival[primaryKey]);
}

/**
 * 敗者行を指している子を勝者行へ付け替える。
 *
 * 付け替えが子自身のユニーク制約にぶつかった場合（勝者側に「同じもの」が既にある場合）は、
 * 子どうしを同じLWWで1行に畳む。畳んで消える側の子には、その子の子（孫）が
 * ぶら下がっている可能性があるため、{@link foldRowInto} を再帰的に使う。
 * @internal
 */
function repointChildren(
  db: Database.Database,
  parentTable: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  winningRow: Record<string, unknown>,
  timestampColumn: string,
  folded: Set<string>
): void {
  for (const foreignKey of findReferencingForeignKeys(
    db,
    parentTable,
    primaryKey
  )) {
    const losingValues = foreignKey.columns.map(
      (column) => losingRow[column.parentColumn]
    );
    const winningValues = foreignKey.columns.map(
      (column) => winningRow[column.parentColumn]
    );

    // 敗者側の参照先がNULLなら、その参照で敗者を指している子は居ない
    if (losingValues.some((value) => value === null || value === undefined)) {
      continue;
    }
    // 勝者側の参照先がNULLなら、そこへは付け替えられない（付け替えると外部キーが壊れる）。
    // 衝突したユニーク列の値はNULLになり得ない（SQLiteのUNIQUEはNULL同士を衝突させない）ので、
    // 主キー以外を指す外部キーの、さらに限られた形でしか起こらない。
    if (winningValues.some((value) => value === null || value === undefined)) {
      continue;
    }
    // 参照先の値が同じなら、子は既に勝者を指していることになる
    if (losingValues.every((value, index) => value === winningValues[index])) {
      continue;
    }

    const escapedChildTable = escapeIdentifier(foreignKey.childTable);
    const matchClause = foreignKey.columns
      .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
      .join(' AND ');

    const childRows = db
      .prepare(`SELECT * FROM ${escapedChildTable} WHERE ${matchClause}`)
      .all(...losingValues) as Record<string, unknown>[];

    for (const childRow of childRows) {
      repointChild(
        db,
        foreignKey,
        primaryKey,
        childRow,
        winningValues,
        timestampColumn,
        folded
      );
    }
  }
}

/**
 * 子1行の外部キーを勝者へ向け直す。
 * @internal
 */
function repointChild(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  primaryKey: string,
  childRow: Record<string, unknown>,
  winningValues: unknown[],
  timestampColumn: string,
  folded: Set<string>
): void {
  const escapedChildTable = escapeIdentifier(foreignKey.childTable);
  const escapedPk = escapeIdentifier(primaryKey);
  const setClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.childColumn)} = ?`)
    .join(', ');
  const updateStatement = db.prepare(
    `UPDATE ${escapedChildTable} SET ${setClause} WHERE ${escapedPk} = ?`
  );

  // 付け替え後の姿
  const repointedRow = { ...childRow };
  foreignKey.columns.forEach((column, index) => {
    repointedRow[column.childColumn] = winningValues[index];
  });

  const runRepoint = (): void => {
    updateStatement.run(...winningValues, childRow[primaryKey]);

    // 親と主キーを共有する1:1のテーブルでは、外部キーが主キーそのものなので
    // 付け替えで子のidが動く。孫は古いidを指したままになるため、ここで引き取る。
    const previousId = String(childRow[primaryKey]);
    const nextId = String(repointedRow[primaryKey]);
    if (previousId !== nextId) {
      repointChildren(
        db,
        foreignKey.childTable,
        primaryKey,
        childRow,
        repointedRow,
        timestampColumn,
        folded
      );
      recordMerge(db, foreignKey.childTable, previousId, nextId);
    }
  };

  try {
    runRepoint();
    return;
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (
      sqliteErr.code !== 'SQLITE_CONSTRAINT_UNIQUE' &&
      sqliteErr.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      throw err;
    }

    // 勝者側に「同じもの」が既にある。子どうしを親と同じLWWで1行へ畳む。
    const uniqueColumns = parseUniqueConflictColumns(err, foreignKey.childTable);
    if (uniqueColumns.length === 0) throw err;

    const rivalRow = db
      .prepare(
        `SELECT * FROM ${escapedChildTable} WHERE ${uniqueColumns
          .map((column) => `${escapeIdentifier(column)} = ?`)
          .join(' AND ')}`
      )
      .get(...uniqueColumns.map((column) => repointedRow[column])) as
      | Record<string, unknown>
      | undefined;

    // 衝突相手を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
    if (!rivalRow) throw err;

    const childTimestampColumn = resolveTimestampColumn(
      db,
      foreignKey.childTable,
      timestampColumn
    );

    if (
      isPreferredOverRival(
        db,
        repointedRow,
        rivalRow,
        childTimestampColumn,
        primaryKey
      )
    ) {
      // 付け替える側が残る → 先に衝突相手を畳んでから、もう一度付け替える
      foldRowInto(
        db,
        foreignKey.childTable,
        primaryKey,
        rivalRow,
        repointedRow,
        timestampColumn,
        folded
      );
      runRepoint();
      return;
    }

    // 衝突相手が残る → 付け替える側を衝突相手へ畳む（孫は衝突相手へ引き取られる）
    foldRowInto(
      db,
      foreignKey.childTable,
      primaryKey,
      childRow,
      rivalRow,
      timestampColumn,
      folded
    );
  }
}

/**
 * 敗者行を勝者行へ畳む。
 *
 * 1. 敗者を指している子を勝者へ付け替える（先に消すとカスケードで道連れになる）
 * 2. 敗者行を削除する
 * 3. 「敗者id → 勝者id」を `_id_merge` に記録する
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
 * @internal
 */
function foldRowInto(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  winningRow: Record<string, unknown>,
  timestampColumn: string,
  folded: Set<string>
): void {
  const losingId = String(losingRow[primaryKey]);
  const winningId = String(winningRow[primaryKey]);
  if (losingId === winningId) return;

  // 自己参照する外部キーがあると同じ行へ戻ってくる可能性があるため、一度畳んだ行は畳まない
  const marker = `${tableName.toLowerCase()}:${losingId}`;
  if (folded.has(marker)) return;
  folded.add(marker);

  repointChildren(
    db,
    tableName,
    primaryKey,
    losingRow,
    winningRow,
    timestampColumn,
    folded
  );

  db.prepare(
    `DELETE FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(primaryKey)} = ?`
  ).run(losingRow[primaryKey]);

  recordMerge(db, tableName, losingId, winningId);
}

/**
 * 敗者行を勝者行へ畳み、勝者行を挿入する。
 *
 * 付け替えの時点では勝者行がまだ存在しないため、外部キーの**検査**をトランザクション
 * 終端まで遅らせる（`PRAGMA defer_foreign_keys`）。制約を切るのではなく検査を遅らせる
 * だけなので、COMMIT時に矛盾が残っていれば通常どおり失敗する。
 *
 * この pragma はCOMMIT/ROLLBACKで自動的に戻る。トランザクションの外では効かない
 * （文ごとに暗黙のCOMMITが起きるため）ので、外から呼ばれた場合はここで張る。
 * @internal
 */
function foldAndReplace(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  record: Record<string, unknown>,
  columns: string[],
  timestampColumn: string
): void {
  runDeferringForeignKeys(db, () => {
    foldRowInto(
      db,
      tableName,
      primaryKey,
      losingRow,
      record,
      timestampColumn,
      new Set()
    );
    db.prepare(
      `INSERT INTO ${escapeIdentifier(tableName)} (${columns
        .map((column) => escapeIdentifier(column))
        .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...columns.map((column) => record[column]));
  });
}

/**
 * 外部キーの検査をトランザクション終端まで遅らせて処理を実行する。
 *
 * 既にトランザクションの中ならそこへ相乗りする（pragmaは外側のCOMMITまで効く）。
 * トランザクションの外では pragma が効かない（文ごとに暗黙のCOMMITが起きる）ため、
 * ここで張る。
 * @internal
 */
function runDeferringForeignKeys(
  db: Database.Database,
  apply: () => void
): void {
  const run = (): void => {
    db.pragma('defer_foreign_keys = ON');
    apply();
  };

  if (db.inTransaction) {
    run();
  } else {
    db.transaction(run)();
  }
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
 * @param losingId - 畳まれて消えた側のid（`_tombstone.recordId`）
 * @param winningId - 畳み先のid（`_tombstone.mergedInto`）
 * @param winningRow - リモートから読んだ畳み先の行。読めなければ undefined
 * 削除時刻のLWW（`deletedAt` vs `updatedAt`）は**見ない**。畳まれた行はどの端末でも
 * 永久に死んでおり、蘇らせても同じユニークキーで再び衝突するだけだからである。
 * 敗者行に後から入った属性は勝者に取り込まれない（「勝者が総取り」の既知の穴のまま）。
 *
 * @param columns - ローカルテーブルのカラム名配列
 * @returns 畳んだか（`folded`）、何もしなかったか（`skipped`）
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
  timestampColumn: string = 'updatedAt'
): { action: 'folded' | 'skipped' } {
  // 畳みを実行できるかに関わらず、敗者idの読み替えは先に覚える。
  // これが無いと、あとから届く敗者の子が存在しない親を指したままになる。
  recordMerge(localDb, tableName, losingId, winningId);

  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  const losingRow = localDb
    .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .get(losingId) as Record<string, unknown> | undefined;
  if (!losingRow) return { action: 'skipped' };

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
        new Set()
      );
    });
    return { action: 'folded' };
  }

  if (winningRow) {
    // 勝者行もローカルに無い → 敗者を畳んでから勝者を入れる。
    // 勝者行の外部キーも、既に畳まれた行を指しているかもしれないので読み替える。
    foldAndReplace(
      localDb,
      tableName,
      primaryKey,
      losingRow,
      remapMergedForeignKeys(localDb, tableName, primaryKey, winningRow),
      columns,
      timestampColumn
    );
    return { action: 'folded' };
  }

  // 畳み先がどこにも無い → 敗者行はそのまま残す（消すと子が道連れになる）
  return { action: 'skipped' };
}

/**
 * 2つのタイムスタンプを「時刻」として比較する。
 *
 * `updatedAt` はISO-T形式（例: `2026-05-13T23:17:35.111+00:00`）、
 * `_tombstone.deletedAt` / `_changelog.changedAt` はトリガの `datetime('now')` による
 * スペース形式（例: `2026-05-02 02:19:56`）で、**文字列としては比較できない**
 * （同日でも ' '(0x20) < 'T'(0x54) となり削除側が常に小さく扱われる）。
 * SQLiteの `julianday()` で正規化して数値比較し、解析不能時のみ文字列比較に
 * フォールバックする。
 *
 * @returns `a` が `b` より後（新しい）なら true
 * @internal
 */
export function isLaterTimestamp(
  db: Database.Database,
  a: string,
  b: string
): boolean {
  const row = db
    .prepare(`SELECT julianday(?) AS ja, julianday(?) AS jb`)
    .get(a, b) as { ja: number | null; jb: number | null };
  if (row.ja != null && row.jb != null) return row.ja > row.jb;
  return a > b;
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
  const hasTombstone = localDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get();
  if (!hasTombstone) return false;

  const ts = localDb
    .prepare(
      `SELECT deletedAt FROM _tombstone WHERE tableName = ? AND recordId = ?`
    )
    .get(tableName, recordId) as { deletedAt: string } | undefined;
  if (!ts) return false;

  // record が削除より「厳密に新しい」場合のみ採用。さもなくば（同時刻含め）削除が勝つ。
  return !isLaterTimestamp(localDb, recordTimestamp, String(ts.deletedAt));
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
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param record - 挿入するリモートレコード
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`inserted` / `upserted` / `skipped`）と競合情報
 * @throws UNIQUE制約以外のSQLiteエラー
 */
export function applyInsert(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt'
): { action: 'inserted' | 'upserted' | 'skipped'; conflict?: ConflictInfo } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedColumns = columns.map((c) => escapeIdentifier(c));
  const placeholders = columns.map(() => '?').join(', ');

  // より新しい削除(tombstone)が記録済みのスロットには再挿入しない（決定論的LWW: 削除が勝つ）
  if (
    isShadowedByTombstone(
      localDb,
      tableName,
      String(remoteRecord[primaryKey]),
      String(remoteRecord[timestampColumn] ?? '')
    )
  ) {
    return { action: 'skipped' };
  }

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す
  const record = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord
  );
  const values = columns.map((c) => record[c]);

  try {
    localDb
      .prepare(
        `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`
      )
      .run(...values);
    return { action: 'inserted' };
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (
      sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      const escapedPk = escapeIdentifier(primaryKey);
      const pkValue = record[primaryKey];
      const remoteUpdatedAt = String(record[timestampColumn] ?? '');

      // ケース1: 同一PKの行が存在する（PK重複）→ LWWでUPDATE
      const localRecord = localDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(pkValue) as Record<string, unknown> | undefined;

      if (localRecord) {
        const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

        if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
          const updateColumns = columns.filter((c) => c !== primaryKey);
          const setClause = updateColumns
            .map((c) => `${escapeIdentifier(c)} = ?`)
            .join(', ');
          const updateValues = [
            ...updateColumns.map((c) => record[c]),
            pkValue,
          ];

          localDb
            .prepare(
              `UPDATE ${escapedTable} SET ${setClause} WHERE ${escapedPk} = ?`
            )
            .run(...updateValues);

          return {
            action: 'upserted',
            conflict: {
              table: tableName,
              recordId: String(pkValue),
              localUpdatedAt,
              remoteUpdatedAt,
              resolution: 'remote_wins',
            },
          };
        }

        return {
          action: 'upserted',
          conflict: {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'local_wins',
          },
        };
      }

      // ケース2: 別PK・同一ユニークキーの行が存在する（セカンダリUNIQUE違反）。
      // 各クライアントが独立に同じ論理エンティティの行を作成した場合に発生する。
      // 違反したカラムからローカルの競合行を特定し、LWWで一方に収束させる。
      const uniqueColumns = parseUniqueConflictColumns(err, tableName);
      const conflictRow =
        uniqueColumns.length > 0
          ? (localDb
              .prepare(
                `SELECT * FROM ${escapedTable} WHERE ${uniqueColumns
                  .map((c) => `${escapeIdentifier(c)} = ?`)
                  .join(' AND ')}`
              )
              .get(...uniqueColumns.map((c) => record[c])) as
              | Record<string, unknown>
              | undefined)
          : undefined;

      if (!conflictRow) {
        // 競合行を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
        throw err;
      }

      const localUpdatedAt = String(conflictRow[timestampColumn] ?? '');

      if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
        // リモートが新しい → ローカルの競合行を勝者（リモート行）へ畳んで置き換える。
        // 敗者を指している子は勝者へ付け替えてから削除する。
        // DELETEトリガーが発火するため、敗者行の削除はchangelog/tombstone経由で
        // 他クライアントにも伝播し、全体が勝者行に収束する。
        foldAndReplace(
          localDb,
          tableName,
          primaryKey,
          conflictRow,
          record,
          columns,
          timestampColumn
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
        String(conflictRow[primaryKey])
      );

      return {
        action: 'upserted',
        conflict: {
          table: tableName,
          recordId: String(conflictRow[primaryKey]),
          localUpdatedAt,
          remoteUpdatedAt,
          resolution: 'local_wins',
        },
      };
    }

    throw err;
  }
}

/**
 * リモートのUPDATE操作をローカルDBに適用する。
 *
 * LWW（Last-Write-Wins）方式で `updatedAt` を比較し、
 * リモートの方が新しい場合のみローカルを更新する。
 * ローカルにレコードが存在しない場合はINSERTする。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - リモート側のレコードデータ
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`updated` / `skipped` / `inserted`）と競合情報
 */
export function applyUpdate(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt'
): { action: 'updated' | 'skipped' | 'inserted'; conflict?: ConflictInfo } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す
  const record = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord
  );
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
      timestampColumn
    );
    if (insertResult.action === 'inserted') {
      return { action: 'inserted' };
    }
    return {
      action:
        insertResult.conflict?.resolution === 'remote_wins'
          ? 'updated'
          : 'skipped',
      conflict: insertResult.conflict,
    };
  }

  // LWW比較
  const remoteUpdatedAt = String(record[timestampColumn] ?? '');
  const localUpdatedAt = String(localRecord[timestampColumn] ?? '');

  if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
    const updateColumns = columns.filter((c) => c !== primaryKey);
    const setClause = updateColumns
      .map((c) => `${escapeIdentifier(c)} = ?`)
      .join(', ');
    const values = [...updateColumns.map((c) => record[c]), pkValue];

    localDb
      .prepare(
        `UPDATE ${escapedTable} SET ${setClause} WHERE ${escapedPk} = ?`
      )
      .run(...values);

    return {
      action: 'updated',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: 'remote_wins',
      },
    };
  }

  return {
    action: 'skipped',
    conflict:
      remoteUpdatedAt !== localUpdatedAt
        ? {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'local_wins',
          }
        : undefined,
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
