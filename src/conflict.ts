/**
 * レコードレベルの競合解決ロジックを提供するモジュール。
 *
 * INSERT（UPSERT fallback）、UPDATE（LWW）、DELETE の3つの操作を処理する。
 *
 * @module conflict
 */
import Database from 'better-sqlite3';
import { ConflictInfo, RecordFold } from './types';
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
 * UNIQUE違反を起こしたエラーから、ローカルで衝突している相手の行を引く。
 *
 * 違反したカラムをエラーメッセージから特定できない場合や、その値を持つ行が
 * 見つからない場合は undefined。呼び出し元は**握りつぶさずエラーを投げ直す**こと
 * （相手が分からないまま畳むと、どちらを消したのか説明できない）。
 * @internal
 */
function findUniqueRival(
  db: Database.Database,
  tableName: string,
  record: Record<string, unknown>,
  err: unknown
): Record<string, unknown> | undefined {
  const uniqueColumns = parseUniqueConflictColumns(err, tableName);
  if (uniqueColumns.length === 0) return undefined;

  return db
    .prepare(
      `SELECT * FROM ${escapeIdentifier(tableName)} WHERE ${uniqueColumns
        .map((column) => `${escapeIdentifier(column)} = ?`)
        .join(' AND ')}`
    )
    .get(...uniqueColumns.map((column) => record[column])) as
    | Record<string, unknown>
    | undefined;
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
 * DB接続ごとに「スキーマから導かれる情報」を覚えておく（`PRAGMA` の往復を減らす）。
 *
 * 畳みが一度でも起きたDBでは {@link remapMergedForeignKeys} が毎回の
 * {@link applyInsert}/{@link applyUpdate} から外部キーを走査し、
 * {@link findReferencingForeignKeys} に至っては畳み1回ごとにDB内の全テーブルへ
 * `PRAGMA` を投げる。同期の最中にスキーマは変わらないので使い回せる。
 *
 * 世代の判定には `PRAGMA schema_version`（SQLiteがスキーマ変更のたびに進める値）を使う。
 * 利用者側のマイグレーションでもフルマージ中のトリガー付け外しでも進むため、
 * 古い形のまま答え続けることはない。
 * @internal
 */
const schemaCache = new WeakMap<
  Database.Database,
  { schemaVersion: number; entries: Map<string, unknown> }
>();

/**
 * スキーマが変わっていない間だけ結果を使い回す。
 * @internal
 */
function cachedBySchema<T>(
  db: Database.Database,
  key: string,
  compute: () => T
): T {
  const schemaVersion = db.pragma('schema_version', {
    simple: true,
  }) as number;

  let cache = schemaCache.get(db);
  if (!cache || cache.schemaVersion !== schemaVersion) {
    cache = { schemaVersion, entries: new Map<string, unknown>() };
    schemaCache.set(db, cache);
  }

  if (cache.entries.has(key)) return cache.entries.get(key) as T;
  const value = compute();
  cache.entries.set(key, value);
  return value;
}

/**
 * テーブルが存在するか。
 *
 * 同期用の内部テーブル（`_changelog` / `_tombstone` など）は、利用者のDBが
 * `setupChangelog` を通していない場合や、旧バージョン由来の場合に無い。触る前に確かめる。
 * @internal
 */
function hasTable(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(tableName) !== undefined
  );
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
  return cachedBySchema(
    db,
    `fk:${childTable.toLowerCase()}:${primaryKey}`,
    () => {
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
  );
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
  return cachedBySchema(
    db,
    `refs:${parentTable.toLowerCase()}:${primaryKey}`,
    () => {
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
  );
}

/**
 * テーブルのカラム名一覧を返す。
 * @internal
 */
function getTableColumns(db: Database.Database, tableName: string): string[] {
  return cachedBySchema(db, `cols:${tableName.toLowerCase()}`, () => {
    const columns = db
      .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
      .all() as ColumnInfo[];
    return columns.map((column) => column.name);
  });
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
 *
 * @param foldedAt - 畳みが決まった時刻。`_tombstone.deletedAt` に使う。
 *   敗者行の削除が実際には起きていない経路では**勝者行のタイムスタンプ**を渡すこと
 *   （理由は {@link recordTombstoneMerge}）。省略時は現在時刻。
 * @internal
 */
function recordMerge(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  foldedAt?: string
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

  recordTombstoneMerge(db, tableName, losingId, winningId, foldedAt);
}

/**
 * 呼び出し元へ返す畳みの一覧へ1件足す（`_id_merge` への記録と対になる）。
 *
 * `_id_merge` と同じく**畳み先の鎖を作らない**: 今回の敗者を勝者として持っていた
 * 記録は、今回の勝者へ張り替える。同じ敗者が二度畳まれた場合も、記録は1件のまま
 * 終端の勝者を指す（呼び出し元は行が消えた件数をこの一覧から数えるため、
 * 同じ行を二度数えてはいけない）。
 * @internal
 */
function recordFold(
  folds: RecordFold[],
  tableName: string,
  losingId: string,
  winningId: string,
  removedLocalRow: boolean
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
    return;
  }

  folds.push({ tableName, losingId, winningId, removedLocalRow });
}

/**
 * 畳み先を `_tombstone` に載せる（他クライアントへはこの列で伝わる）。
 *
 * - `remote_wins`（敗者行を削除した側）— DELETEトリガーが作った行に畳み先を書き込む。
 *   トリガーは `INSERT OR REPLACE` なので、**削除より後に**呼ぶこと。
 * - `local_wins`（敗者行を持っていない側）— 削除が起きないので行ごと新しく書く。
 *   敗者idは全クライアントで永久に死んでいるため、tombstoneとして正しい。
 *
 * `foldedAt` には「畳みが決まった時刻」を入れる（省略時は現在時刻）。
 * **敗者行の削除が実際には起きていない経路では、勝者行のタイムスタンプを渡すこと。**
 * 現在時刻を刻むと、実データの `updatedAt` は必ずそれより過去なので
 * {@link isShadowedByTombstone} がその id の到着を無条件に止め、ユニークキーが変わって
 * もう衝突しなくなった行まで黙って捨てることになる。勝者のタイムスタンプなら
 * 「畳みに負けた版より新しいものだけ通す」というLWWそのものの意味になる。
 *
 * 既存の行があれば `deletedAt` は**新しい方へ進める**。畳みは今下した判断なので、
 * 昔の削除記録（消えたあと再作成された行など）の古い時刻が残っていると、
 * 受け取った側のLWWがこの畳みを「古い決定」として捨ててしまう。
 *
 * `_tombstone` を持たないDBでは何もしない。
 * @internal
 */
function recordTombstoneMerge(
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

  // 時刻の大小はフォーマット差（ISO-T vs スペース形式）を吸収するため julianday で見る。
  // 解析できない値のときだけ文字列比較へ落とす（{@link isLaterTimestamp} と同じ方針）。
  db.prepare(
    `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
     VALUES (?, ?, COALESCE(?, datetime('now')), ?)
     ON CONFLICT(tableName, recordId) DO UPDATE SET
       mergedInto = excluded.mergedInto,
       deletedAt = CASE
         WHEN COALESCE(
                julianday(excluded.deletedAt) > julianday(_tombstone.deletedAt),
                excluded.deletedAt > _tombstone.deletedAt
              )
         THEN excluded.deletedAt
         ELSE _tombstone.deletedAt
       END`
  ).run(tableName, losingId, foldedAt ? foldedAt : null, winningId);

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
function maxChangelogId(db: Database.Database): number | null {
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
function hasChangelogDelete(
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
function writeFoldDeletion(
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
     VALUES (?, ?, 'DELETE', datetime('now'))`
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
function recordMergeWithoutLocalRow(
  db: Database.Database,
  tableName: string,
  losingId: string,
  winningId: string,
  winningTimestamp?: string
): void {
  // 参照する前に用意する（`_id_merge` がまだ無いDBでも動くように）
  ensureIdMergeTable(db);
  const alreadyRecorded = lookupIdMerge(db, tableName, losingId) === winningId;

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
function hasIdMerges(db: Database.Database): boolean {
  if (!hasTable(db, '_id_merge')) return false;
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
 *
 * **同点を主キーで決められるのは、主キーが端末をまたいで一意（uuid等）だから。**
 * 両端末が同じ2つのidを見て同じ答えに達するので、判定は対称で決定的になる
 * （前提そのものは {@link SyncConfig.primaryKey} に書いてある）。時刻で決まらない
 * ぶんを端末ごとに違う向きで決めると、互いに相手を畳んで生き残るidが毎周入れ替わり、
 * 永久に収束しない。**親（この行）と子（付け替えた先）で同じ規則を使うこと。**
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
  folded: Set<string>,
  folds: RecordFold[]
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
        folded,
        folds
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
  folded: Set<string>,
  folds: RecordFold[]
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
    const changelogIdBefore = maxChangelogId(db) ?? 0;
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
        folded,
        folds
      );
      // ここは行が1つ消えたのではなく、1行のidが動いただけなので `folds` には載せない
      // （利用者へ「2つを1つにまとめた」と伝える対象ではない）。
      recordMerge(db, foreignKey.childTable, previousId, nextId);

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
        writeFoldDeletion(db, foreignKey.childTable, previousId);
      }
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
    const rivalRow = findUniqueRival(
      db,
      foreignKey.childTable,
      repointedRow,
      err
    );

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
        folded,
        folds
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
      folded,
      folds
    );
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
 * @internal
 */
function foldRowInto(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  losingRow: Record<string, unknown>,
  winningRow: Record<string, unknown>,
  timestampColumn: string,
  folded: Set<string>,
  folds: RecordFold[]
): void {
  const losingId = String(losingRow[primaryKey]);
  const winningId = String(winningRow[primaryKey]);
  if (losingId === winningId) return;

  // 自己参照する外部キーがあると同じ行へ戻ってくる可能性があるため、
  // **子の付け替えだけ**は繰り返さない（無限再帰になる）。
  // 削除と記録は再入のたびに行う — ここへ再入するのは「この行は消える」と二度決まった
  // ときであり、何もせず戻ると、畳まれて消える親を指したままの子が残って
  // COMMIT時に外部キー違反になる（その相手ぶんの取り込みが丸ごと巻き戻る）。
  const marker = `${tableName.toLowerCase()}:${losingId}`;
  const revisited = folded.has(marker);
  folded.add(marker);

  if (!revisited) {
    repointChildren(
      db,
      tableName,
      primaryKey,
      losingRow,
      winningRow,
      timestampColumn,
      folded,
      folds
    );
  }

  const changelogIdBefore = maxChangelogId(db) ?? 0;

  db.prepare(
    `DELETE FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(primaryKey)} = ?`
  ).run(losingRow[primaryKey]);

  recordMerge(db, tableName, losingId, winningId);

  // 「この行とこの行が1つになった」を呼び出し元へ伝える（利用者への説明に使われる）。
  // この経路は行を消しているので removedLocalRow は true。
  recordFold(folds, tableName, losingId, winningId, true);

  // 通常はいま起こしたDELETEでトリガーが `_changelog` に記録している。フルマージは
  // トリガーを外して走るのでそれが無く、畳みが差分経路に載らないまま埋もれる。手で書く。
  if (!hasChangelogDelete(db, tableName, losingId, changelogIdBefore)) {
    writeFoldDeletion(db, tableName, losingId);
  }
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
  timestampColumn: string,
  folds: RecordFold[]
): void {
  runDeferringForeignKeys(db, () => {
    foldRowInto(
      db,
      tableName,
      primaryKey,
      losingRow,
      record,
      timestampColumn,
      new Set(),
      folds
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
function runDeferringForeignKeys<T>(
  db: Database.Database,
  apply: () => T
): T {
  const run = (): T => {
    db.pragma('defer_foreign_keys = ON');
    return apply();
  };

  if (db.inTransaction) return run();
  return db.transaction(run)();
}

/**
 * 自分だけの区切り（SAVEPOINT）を張って処理を実行する。外部キーの検査は終端まで遅らせる。
 *
 * {@link runDeferringForeignKeys} と違い、**既にトランザクションの中でも外側へ相乗り
 * しない**（better-sqlite3 の入れ子トランザクションは SAVEPOINT になる）。途中で例外を
 * 投げれば、この区切りで行ったぶんだけが巻き戻り、外側の取り込みはそのまま続けられる。
 *
 * 「畳んでから書き込む」ような、**途中でやめると片方だけ残る**処理に使う。
 * @internal
 */
function runInSavepoint<T>(db: Database.Database, apply: () => T): T {
  return db.transaction((): T => {
    db.pragma('defer_foreign_keys = ON');
    return apply();
  })();
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
 * @returns 畳んだか（`folded`）、何もしなかったか（`skipped`）と、畳んだ記録
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
  foldedAt?: string
): { action: 'folded' | 'skipped'; folds: RecordFold[] } {
  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);
  const folds: RecordFold[] = [];

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
    return { action: 'skipped', folds };
  }

  // 畳みを実行できるかに関わらず、敗者idの読み替えは先に覚える。
  // これが無いと、あとから届く敗者の子が存在しない親を指したままになる。
  recordMerge(localDb, tableName, losingId, winningId, foldedAt);

  if (!losingRow) return { action: 'skipped', folds };

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
        folds
      );
    });
    return { action: 'folded', folds };
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
      timestampColumn,
      folds
    );
    return { action: 'folded', folds };
  }

  // 畳み先がどこにも無い → 敗者行はそのまま残す（消すと子が道連れになる）
  return { action: 'skipped', folds };
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

/**
 * {@link applyInsert} の返り値。
 * @internal
 */
interface ApplyInsertResult {
  action: 'inserted' | 'upserted' | 'skipped';
  conflict?: ConflictInfo;
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[];
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
 * @param remoteRecord - 挿入するリモートレコード
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`inserted` / `upserted` / `skipped`）と競合情報、
 *   および畳んだ記録（{@link RecordFold}）
 * @throws UNIQUE制約以外のSQLiteエラー
 */
export function applyInsert(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt'
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
    return { action: 'skipped', folds };
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
    return { action: 'inserted', folds };
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
            folds,
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
          folds,
        };
      }

      // ケース2: 別PK・同一ユニークキーの行が存在する（セカンダリUNIQUE違反）。
      // 各クライアントが独立に同じ論理エンティティの行を作成した場合に発生する。
      // 違反したカラムからローカルの競合行を特定し、LWWで一方に収束させる。
      const conflictRow = findUniqueRival(localDb, tableName, record, err);

      if (!conflictRow) {
        // 競合行を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
        throw err;
      }

      const localUpdatedAt = String(conflictRow[timestampColumn] ?? '');

      // 同時刻は主キーの辞書順で決める（{@link isPreferredOverRival}）。ここを
      // 「同点ならローカルが勝つ」にすると、相手側の {@link applyUpdate} が同じ2行を
      // 逆向きに畳み、生き残るidが毎周入れ替わって永久に収束しない。
      if (
        isPreferredOverRival(
          localDb,
          record,
          conflictRow,
          timestampColumn,
          primaryKey
        )
      ) {
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
        String(conflictRow[primaryKey]),
        localUpdatedAt
      );

      // 敗者行はそもそもローカルに無いので、行は消えていない（数には出さない）。
      // それでも「2つが1つになった」ことは利用者へ伝える。
      recordFold(
        folds,
        tableName,
        String(pkValue),
        String(conflictRow[primaryKey]),
        false
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
        folds,
      };
    }

    throw err;
  }
}

/**
 * {@link applyUpdate} の返り値。
 * @internal
 */
interface ApplyUpdateResult {
  action: 'updated' | 'skipped' | 'inserted';
  conflict?: ConflictInfo;
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[];
}

/**
 * 「畳みかけたが、届いた更新は結局採用しない」と決まったことを表す。
 *
 * ユニークが2本以上ある表では、1回の書き込みが索引ごとに別々の相手へぶつかる。
 * 相手はエラー文からしか分からず**1本ずつしか見えない**ため、先に見えた相手を
 * 畳んでから、次の相手に負けることがある。そのまま `skipped` を返すと
 * **更新は拒まれたのに、先に畳んだ行だけが消えたまま**になる。
 *
 * そこで畳みはセーブポイントの中で行い、負けが分かった時点でこれを投げて
 * **それまでの畳みごと巻き戻す**。呼び出し元（{@link applyUpdate}）が必ず受け止めるので、
 * 同期を止める側へは抜けない。
 * @internal
 */
class UpdateRejectedByRival extends Error {
  constructor(readonly rivalRow: Record<string, unknown>) {
    super('update rejected by a rival row on another unique index');
    this.name = 'UpdateRejectedByRival';
  }
}

/**
 * リモートのUPDATE操作をローカルDBに適用する。
 *
 * LWW（Last-Write-Wins）方式で `updatedAt` を比較し、
 * リモートの方が新しい場合のみローカルを更新する。
 * ローカルにレコードが存在しない場合はINSERTする。
 *
 * 書き込みがローカルの**別の行**のセカンダリUNIQUEに当たった場合は、
 * {@link applyInsert} と同じ畳み（LWWで1行へ統合する）で解決する。作成の衝突と違い
 * **更新対象の行はローカルに既に在る**ため、どちらが負けても実際に行が1つ消える:
 *
 * - 届いた更新が勝つ → 邪魔なローカル行を畳んでから書き込む
 * - ローカル行が勝つ → 更新対象の行の方を勝者へ畳む。届いた更新を黙って捨てると、
 *   相手は送り続けこちらは断り続けて**分岐したまま収束しない**。畳み先は
 *   `_tombstone.mergedInto` に載って相手にも届き、相手が同じ畳みを行う
 *
 * どちらの向きでも、消える行の子は先に生き残る行へ付け替えられる。
 *
 * ユニークが2本以上ある表では、1回の書き込みが索引ごとに別々の相手へぶつかる。
 * 相手はエラー文からしか分からず1本ずつしか見えないため、**先に見えた相手を畳んでから、
 * 次の相手に負ける**ことがある。畳みは区切り（SAVEPOINT）の中で行い、負けが分かった
 * 時点で {@link UpdateRejectedByRival} を投げてそこまでの畳みごと巻き戻す
 * （そうしないと、更新は拒まれたのに先に畳んだ行だけが消えたままになる）。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - リモート側のレコードデータ
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`updated` / `skipped` / `inserted`）と競合情報、
 *   および畳んだ記録（{@link RecordFold}）
 */
export function applyUpdate(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt'
): ApplyUpdateResult {
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
      return { action: 'inserted', folds: insertResult.folds };
    }
    return {
      action:
        insertResult.conflict?.resolution === 'remote_wins'
          ? 'updated'
          : 'skipped',
      conflict: insertResult.conflict,
      folds: insertResult.folds,
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
    const updateStatement = localDb.prepare(
      `UPDATE ${escapedTable} SET ${setClause} WHERE ${escapedPk} = ?`
    );

    const remoteWins = (folds: RecordFold[]): ApplyUpdateResult => ({
      action: 'updated',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: 'remote_wins',
      },
      folds,
    });

    const localWins = (folds: RecordFold[]): ApplyUpdateResult => ({
      action: 'skipped',
      conflict: {
        table: tableName,
        recordId: String(pkValue),
        localUpdatedAt,
        remoteUpdatedAt,
        resolution: 'local_wins',
      },
      folds,
    });

    let rejectingRival: Record<string, unknown>;
    try {
      updateStatement.run(...values);
      return remoteWins([]);
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string };
      if (sqliteErr.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;

      // 書き込みがローカルの**別の行**のセカンダリUNIQUEに当たった
      // （利用者が編集できる名前の列で、両端末が独立に同じ名前へ辿り着いた場合）。
      // 畳みと書き直しは1つの区切りで行う（片方だけ残さない）。
      try {
        return runInSavepoint(localDb, (): ApplyUpdateResult => {
          const folds: RecordFold[] = [];
          // 1回の更新が別々のユニーク索引で別々の行にぶつかることがあるため、
          // 畳み切るまで繰り返す。畳みは必ず1行を消すので、この繰り返しは必ず止まる。
          let uniqueError: unknown = err;
          for (;;) {
            const rivalRow = findUniqueRival(
              localDb,
              tableName,
              record,
              uniqueError
            );
            // 衝突相手を特定できない場合は黙って握りつぶさず呼び出し元に委ねる。
            // 相手が自分自身なら畳んでも1行も減らず、同じ所を回り続ける。
            if (!rivalRow || String(rivalRow[primaryKey]) === String(pkValue)) {
              throw uniqueError;
            }

            if (
              !isPreferredOverRival(
                localDb,
                record,
                rivalRow,
                timestampColumn,
                primaryKey
              )
            ) {
              // 相手が勝つ → 届いた更新は採用しない。ここまでの畳みは
              // 「この更新を通すため」に行ったものなので、区切りごと巻き戻す。
              throw new UpdateRejectedByRival(rivalRow);
            }

            // 届いた更新が勝つ → 邪魔なローカル行を、更新される行へ畳んでから書き直す。
            // 敗者の子は先に勝者へ付け替わるので、カスケードで道連れにならない。
            foldRowInto(
              localDb,
              tableName,
              primaryKey,
              rivalRow,
              record,
              timestampColumn,
              new Set(),
              folds
            );

            try {
              updateStatement.run(...values);
              return remoteWins(folds);
            } catch (retryErr: unknown) {
              const retrySqliteErr = retryErr as { code?: string };
              if (retrySqliteErr.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
                throw retryErr;
              }
              uniqueError = retryErr;
            }
          }
        });
      } catch (thrown: unknown) {
        // 畳みかけたぶんは巻き戻り済み。この1本だけは投げた側で受け止める
        // （同期を止める側へ抜かさない）。
        if (!(thrown instanceof UpdateRejectedByRival)) throw thrown;
        rejectingRival = thrown.rivalRow;
      }
    }

    // ローカル行が勝った → 届いた更新は採用しない。ただし**黙って捨てない**。
    // 捨てるだけでは、相手はこの行を送り続け、こちらは断り続けて分岐したまま
    // 収束しない。ユニークキーが同じ以上この2行は同じものなので、更新対象の行の方を
    // 勝者へ畳み、その事実（`_tombstone.mergedInto`）を相手にも伝える。
    // 相手はそれを受けて同じ畳みを行い、両者が1行へ揃う。
    const folds: RecordFold[] = [];
    runDeferringForeignKeys(localDb, () => {
      foldRowInto(
        localDb,
        tableName,
        primaryKey,
        localRecord,
        rejectingRival,
        timestampColumn,
        new Set(),
        folds
      );
    });
    return localWins(folds);
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
    folds: [],
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
