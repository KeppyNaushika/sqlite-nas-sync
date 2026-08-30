/**
 * changelog テーブル・トリガーのセットアップ機能を提供するモジュール。
 *
 * `_changelog` テーブル、`_sync_state` テーブル、`_tombstone` テーブル、
 * `_heartbeat` テーブル、および対象テーブルごとのINSERT/UPDATE/DELETEトリガーを作成する。
 *
 * @module setup
 */
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { TableConfig } from './types';

/**
 * 「今」をユーザーレコードの `updatedAt` と同じ精度・同じ書式で得るSQL式。
 *
 * `datetime('now')` は**秒に切り捨てた**スペース形式（`2026-05-02 02:19:56`）を返す。
 * これを削除や畳みの時刻に使うと、同じ秒の中で起きた更新との前後が失われる:
 * 12:00:00.800 の削除が `12:00:00`（= .000）として記録されるので、その前に起きた
 * 12:00:00.400 の更新の方が新しいと判定され、**消したはずの行が復活する**。
 * アプリが書く `updatedAt` はふつうミリ秒まで持つ（`toISOString()` 等）ので、
 * こちらだけ粗いと比較が成り立たない。
 *
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now')` はミリ秒までのISO-T形式
 * （`2026-05-02T02:19:56.111Z`）を返し、`updatedAt` とそのまま比べられる。
 *
 * 古いDBに残る秒精度・スペース形式の値と混在しても、比較はすべて
 * `julianday()` で正規化しているので前後は正しく決まる。
 * @internal
 */
export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/**
 * 秒精度の `datetime('now')` で作られた古いトリガを落とす（冪等）。
 *
 * トリガは `CREATE TRIGGER IF NOT EXISTS` で作るため、**既に在るDBでは中身が
 * 古いまま残る**。時刻の精度を上げても、旧版で作られたトリガが動いているかぎり
 * `_changelog.changedAt` と `_tombstone.deletedAt` は秒のままになる。
 * 定義そのものを見て、古い書き方をしているものだけ作り直す
 * （新しい定義で作られていれば何もしないので、毎回の起動でスキーマは動かない）。
 *
 * @internal
 */
function dropStaleTrigger(db: Database.Database, name: string): void {
  const stale = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = ? AND sql LIKE '%datetime(''now'')%'`
    )
    .get(name);
  if (stale) db.exec(`DROP TRIGGER ${escapeIdentifier(name)}`);
}

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * `_tombstone` に `mergedInto` 列が無ければ追加する（冪等）。
 *
 * `CREATE TABLE IF NOT EXISTS` は既存テーブルには列を足さないため、
 * v0.14.0以前に作られたDBはこの経路で移行する。
 * `_tombstone` そのものが無いDB（{@link setupChangelog} を通していない場合）では何もしない。
 *
 * @internal
 */
export function ensureTombstoneMergedIntoColumn(db: Database.Database): void {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get();
  if (!exists) return;

  const columns = db
    .prepare(`PRAGMA table_info(_tombstone)`)
    .all() as ColumnInfo[];
  if (columns.some((column) => column.name === 'mergedInto')) return;

  db.exec(`ALTER TABLE _tombstone ADD COLUMN mergedInto TEXT`);
}

/**
 * changelog追跡に必要なテーブルとトリガーをセットアップする。
 *
 * 以下を冪等に（`IF NOT EXISTS`で）作成する:
 * - `_changelog` テーブル: 全変更操作のログを記録
 * - `_sync_state` テーブル: リモートクライアントごとの同期進捗を管理
 * - 各テーブルに3つのトリガー（AFTER INSERT / UPDATE / DELETE）
 * - WALジャーナルモードの有効化
 *
 * @param db - セットアップ対象のSQLiteデータベース接続
 * @param tables - トリガーを作成する対象テーブル名の配列
 * @param primaryKey - 主キーカラム名（トリガーで `NEW.{pk}` / `OLD.{pk}` として参照）
 *
 * @example
 * ```ts
 * const db = new Database('./local.sqlite');
 * setupChangelog(db, ['users', 'posts'], 'id');
 * // _changelog, _sync_state テーブルと6つのトリガーが作成される
 * ```
 */
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
 * - 何度走らせても同じ結果になります（鎖が短くなる方向にしか動きません）
 *
 * **走査は1回では足りません。** 循環へ流れ込む鎖（`D→A` があり `A↔B` が循環）は、
 * 1回目の走査では終端が循環の中に居るため張り替えられず、循環を刈った結果
 * `D→A→B` が残ります。刈ったあとの形をもう一度見る必要があるので、
 * **何も変わらなくなるまで**繰り返します（鎖は短くなる方向にしか動かないので必ず止まる）。
 * @internal
 */
function collapseIdMergeChains(db: Database.Database): void {
  // 1回の走査で直せるのは、その時点で見えている形だけ。刈り取りで形が変われば
  // もう一度見る（打ち切りの上限は、鎖が1回の走査で最低1段は縮むことから置いている）
  for (let pass = 0; pass < ID_MERGE_COLLAPSE_MAX_PASSES; pass++) {
    if (!collapseIdMergeChainsOnce(db)) return;
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
function collapseIdMergeChainsOnce(db: Database.Database): boolean {
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
    const key = row.tableName.toLowerCase();
    const records = byTable.get(key) ?? new Map();
    records.set(row.losingId, {
      winningId: row.winningId,
      mergedAt: row.mergedAt,
    });
    byTable.set(key, records);
  }

  const update = db.prepare(
    `UPDATE _id_merge SET winningId = ?
     WHERE tableName = ? COLLATE NOCASE AND losingId = ?`
  );
  const remove = db.prepare(
    `DELETE FROM _id_merge WHERE tableName = ? COLLATE NOCASE AND losingId = ?`
  );

  for (const row of rows) {
    const records = byTable.get(row.tableName.toLowerCase());
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
      const strongest = walked.reduce((best, candidate) =>
        candidate.mergedAt > best.mergedAt ||
        (candidate.mergedAt === best.mergedAt &&
          candidate.losingId < best.losingId)
          ? candidate
          : best
      );
      if (strongest.losingId !== row.losingId) {
        remove.run(row.tableName, row.losingId);
        changed = true;
      }
      continue;
    }

    if (terminal !== row.winningId) {
      update.run(terminal, row.tableName, row.losingId);
      changed = true;
    }
  }

  return changed;
}

export function setupChangelog(
  db: Database.Database,
  tables: TableConfig[],
  primaryKey: string
): void {
  // _changelog テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tableName TEXT    NOT NULL,
      recordId  TEXT    NOT NULL,
      operation TEXT    NOT NULL,
      changedAt TEXT    NOT NULL DEFAULT (${NOW_SQL})
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_changelog_id ON _changelog(id)`
  );

  // _sync_state テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_state (
      remoteClientId TEXT    PRIMARY KEY,
      lastSeenId     INTEGER NOT NULL DEFAULT 0,
      lastSyncedAt   TEXT
    )
  `);

  // _tombstone テーブル（DELETE記録の長期保持）。
  // `mergedInto` は「この行は消えたのではなく、この行へ畳まれた」ことを表す。
  // 削除の事実と畳み先が同じ1行に載るので、削除を適用する側は**消すと決めるその場で
  // 畳み先を必ず見る**ことになり、「畳まれた行を、子を付け替えないまま消す」ことが
  // 構造的に起こらなくなる（別テーブルで配ると、届く順によっては見ずに消せてしまう）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tombstone (
      tableName  TEXT NOT NULL,
      recordId   TEXT NOT NULL,
      deletedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      mergedInto TEXT,
      PRIMARY KEY (tableName, recordId)
    )
  `);
  // 既存DBには CREATE TABLE IF NOT EXISTS では列が増えないため、明示的に足す
  ensureTombstoneMergedIntoColumn(db);

  // _id_merge テーブル（畳んだ「敗者id → 勝者id」のローカル索引）。
  // 自分が勝った側のクライアントには敗者行が入らないため、あとから届く相手の子が
  // 存在しない親を指す。この記録を使って外部キーを勝者へ向け直す。
  // 自分で畳んだぶんも、リモートの `_tombstone.mergedInto` から受け取ったぶんも
  // ここへ入る。同期対象にはしない（`_` 始まりなので自動検出から外れる）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _id_merge (
      tableName TEXT NOT NULL,
      losingId  TEXT NOT NULL,
      winningId TEXT NOT NULL,
      mergedAt  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      PRIMARY KEY (tableName, losingId)
    )
  `);

  // 旧バージョンが書いた鎖（`A→C` と `C→B` が並ぶ形）をここで畳む。
  collapseIdMergeChains(db);

  // _heartbeat テーブル（changelog延命用）
  db.exec(`
    CREATE TABLE IF NOT EXISTS _heartbeat (
      id        TEXT PRIMARY KEY,
      updatedAt TEXT NOT NULL
    )
  `);

  // テーブルごとにトリガーを作成
  const escapedPk = escapeIdentifier(primaryKey);

  for (const tableConfig of tables) {
    const table = tableConfig.name;
    const escapedTable = escapeIdentifier(table);

    // INSERT トリガー
    dropStaleTrigger(db, `_changelog_after_insert_${table}`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_insert_${table}
      AFTER INSERT ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', NEW.${escapedPk}, 'INSERT', ${NOW_SQL});
      END
    `);

    // UPDATE トリガー
    dropStaleTrigger(db, `_changelog_after_update_${table}`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_update_${table}
      AFTER UPDATE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', NEW.${escapedPk}, 'UPDATE', ${NOW_SQL});
      END
    `);

    // DELETE トリガー（_tombstone にも記録）
    dropStaleTrigger(db, `_changelog_after_delete_${table}`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_delete_${table}
      AFTER DELETE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', OLD.${escapedPk}, 'DELETE', ${NOW_SQL});
        INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
        VALUES ('${table}', OLD.${escapedPk}, ${NOW_SQL});
      END
    `);
  }

  // _heartbeat のchangelogトリガー
  dropStaleTrigger(db, '_changelog_after_insert__heartbeat');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_insert__heartbeat
    AFTER INSERT ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'INSERT', ${NOW_SQL});
    END
  `);
  dropStaleTrigger(db, '_changelog_after_update__heartbeat');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _changelog_after_update__heartbeat
    AFTER UPDATE ON _heartbeat FOR EACH ROW
    BEGIN
      INSERT INTO _changelog (tableName, recordId, operation, changedAt)
      VALUES ('_heartbeat', NEW.id, 'UPDATE', ${NOW_SQL});
    END
  `);

  // _sync_meta テーブル（スキーマバージョン等のメタ情報）
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // WALモード設定
  db.pragma('journal_mode = WAL');
}

/**
 * `_sync_meta` テーブルにスキーマバージョンを書き込む。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @param schemaVersion - 書き込むスキーマバージョン文字列
 */
export function writeSchemaVersion(
  db: Database.Database,
  schemaVersion: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('schemaVersion', ?)`
  ).run(schemaVersion);
}

/**
 * `_sync_meta` テーブルからスキーマバージョンを読み取る。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @returns スキーマバージョン文字列。未設定の場合は `null`
 */
export function readSchemaVersion(
  db: Database.Database
): string | null {
  // _sync_meta テーブルが存在しない場合も考慮
  try {
    const row = db
      .prepare(`SELECT value FROM _sync_meta WHERE key = 'schemaVersion'`)
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** @internal PRAGMA table_info が返すカラム情報 */
interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * 同期対象テーブルのスキーマからハッシュ値を自動生成する。
 *
 * 各テーブルの `PRAGMA table_info` からカラム名・型・notnull・pk を取得し、
 * テーブル名でソートした上でSHA-256ハッシュを生成する。
 * スキーマが変更されると自動的に異なるハッシュが返るため、
 * 手動でバージョンを管理する必要がない。
 *
 * @param db - 対象のSQLiteデータベース接続
 * @param tables - ハッシュ対象のテーブル設定配列
 * @returns スキーマのSHA-256ハッシュ（先頭16文字）
 */
export function computeSchemaHash(
  db: Database.Database,
  tables: TableConfig[]
): string {
  const parts: string[] = [];

  // テーブル名でソートして安定した順序にする
  const sortedTables = [...tables].sort((a, b) => a.name.localeCompare(b.name));

  for (const tableConfig of sortedTables) {
    const tableName = tableConfig.name;

    try {
      const columns = db
        .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
        .all() as ColumnInfo[];

      // カラムをcid順（定義順）で処理
      const colDescs = columns
        .sort((a, b) => a.cid - b.cid)
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`)
        .join(',');

      parts.push(`${tableName}(${colDescs})`);
    } catch {
      // テーブルが存在しない場合はスキップ
    }
  }

  const hash = crypto
    .createHash('sha256')
    .update(parts.join('|'))
    .digest('hex');

  return hash.slice(0, 16);
}
