/**
 * コア同期オーケストレーションを提供するモジュール。
 *
 * 通常フロー: ローカルDBのNASコピー → リモートchangelog読み取り → 差分適用
 * ギャップ時: pull-first → トリガーOFFでフルマージ + tombstone適用 + changelogマージ
 *            → トリガーON → heartbeat更新 → NASアップロード
 *
 * @module sync
 */
import Database from 'better-sqlite3';
import { SyncConfig, SyncResult, ChangelogEntry, TableConfig, DEFAULTS } from './types';
import {
  readChangelog,
  getMaxChangelogId,
  hasChangelogGap,
  cleanupChangelog,
} from './changelog';
import {
  applyInsert,
  applyMergedDelete,
  applyUpdate,
  isLaterTimestamp,
} from './conflict';
import { copyToNas, ensureDirectory, listRemoteClients, openRemoteDbViaLocalCopy } from './nas';
import {
  ensureTombstoneMergedIntoColumn,
  readSchemaVersion,
  writeSchemaVersion,
} from './setup';

/**
 * SQL識別子をダブルクォートでエスケープする。
 * @internal
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
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
 * テーブルのカラム名一覧を取得する。
 * @internal
 */
function getTableColumns(
  db: Database.Database,
  tableName: string
): string[] {
  const columns = db
    .prepare(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
    .all() as ColumnInfo[];
  return columns.map((c) => c.name);
}

/**
 * 同一レコード（tableName:recordId）の重複changelogエントリを、
 * 最新のもの（後に出現したもの）だけに縮約する。
 *
 * @remarks
 * 同一レコードに対してINSERT → UPDATE → UPDATE と複数のエントリがある場合、
 * 最後のUPDATEのみを処理すれば十分なため、この最適化を行う。
 *
 * @internal
 */
function deduplicateEntries(entries: ChangelogEntry[]): ChangelogEntry[] {
  const map = new Map<string, ChangelogEntry>();
  for (const entry of entries) {
    const key = `${entry.tableName}:${entry.recordId}`;
    map.set(key, entry);
  }
  return Array.from(map.values());
}

/**
 * `_sync_state` テーブルからリモートクライアントの同期進捗を取得する。
 * @internal
 */
function getSyncState(
  localDb: Database.Database,
  remoteClientId: string
): { lastSeenId: number; lastSyncedAt: string | null } {
  const row = localDb
    .prepare(
      `SELECT lastSeenId, lastSyncedAt FROM _sync_state WHERE remoteClientId = ?`
    )
    .get(remoteClientId) as
    | { lastSeenId: number; lastSyncedAt: string | null }
    | undefined;

  return row ?? { lastSeenId: 0, lastSyncedAt: null };
}

/**
 * `_sync_state` テーブルのリモートクライアント同期進捗を更新する。
 * @internal
 */
function updateSyncState(
  localDb: Database.Database,
  remoteClientId: string,
  lastSeenId: number
): void {
  localDb
    .prepare(
      `INSERT OR REPLACE INTO _sync_state (remoteClientId, lastSeenId, lastSyncedAt)
       VALUES (?, ?, datetime('now'))`
    )
    .run(remoteClientId, lastSeenId);
}

/**
 * DBの `_tombstone` が `mergedInto` 列を持つか。
 *
 * v0.14.0以前のクライアントのDBには無いため、読む前に確認する
 * （テーブルの有無を `sqlite_master` で見るのと同じ形の後方互換チェック）。
 * @internal
 */
function hasMergedIntoColumn(db: Database.Database): boolean {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get();
  if (!exists) return false;
  const columns = db
    .prepare(`PRAGMA table_info(_tombstone)`)
    .all() as ColumnInfo[];
  return columns.some((column) => column.name === 'mergedInto');
}

/**
 * リモートDBの `_tombstone` から指定レコードの削除時刻と畳み先を取得する。
 * `_tombstone` を持たない（旧バージョン由来の）クライアントでは null。
 * @internal
 */
function getRemoteTombstone(
  remoteDb: Database.Database,
  tableName: string,
  recordId: string
): { deletedAt: string; mergedInto: string | null } | null {
  const exists = remoteDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get();
  if (!exists) return null;

  const mergedIntoColumn = hasMergedIntoColumn(remoteDb)
    ? 'mergedInto'
    : 'NULL AS mergedInto';
  const row = remoteDb
    .prepare(
      `SELECT deletedAt, ${mergedIntoColumn} FROM _tombstone
       WHERE tableName = ? AND recordId = ?`
    )
    .get(tableName, recordId) as
    | { deletedAt: string; mergedInto: string | null }
    | undefined;
  if (!row) return null;

  return {
    deletedAt: String(row.deletedAt),
    mergedInto: row.mergedInto === null ? null : String(row.mergedInto),
  };
}

/**
 * tombstone の `mergedInto` を「畳み先」として使える値に正規化する。
 *
 * 自分自身を指す値は畳みではない（畳む向きが反転したときの後始末で生まれうる）。
 * @internal
 */
function resolveFoldTarget(
  recordId: string,
  mergedInto: string | null | undefined
): string | null {
  if (mergedInto === null || mergedInto === undefined) return null;
  return mergedInto === recordId ? null : mergedInto;
}

/**
 * リモートDBから畳み先の行を読む。リモートにも無ければ undefined。
 * @internal
 */
function readRemoteRecord(
  remoteDb: Database.Database,
  tableName: string,
  primaryKey: string,
  recordId: string
): Record<string, unknown> | undefined {
  try {
    return remoteDb
      .prepare(
        `SELECT * FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(primaryKey)} = ?`
      )
      .get(recordId) as Record<string, unknown> | undefined;
  } catch {
    // リモートに当該テーブルが無い（スキーマ違い）場合は読めないものとして扱う
    return undefined;
  }
}

/**
 * tombstoneに基づく削除をローカルに適用する。
 *
 * - ローカル `_tombstone` に max(deletedAt) と畳み先を記録する（以降の挿入/更新による
 *   復活を抑止する根拠となる。{@link applyInsert} がこれを参照する）。
 * - **畳み先（`mergedInto`）がある場合**は、消す前に子を畳み先へ付け替える
 *   （{@link applyMergedDelete}）。この分岐が無いと、競合を経験していないクライアントが
 *   敗者行をただ消し、自分の子をカスケードで失い、その削除がさらに他クライアントの
 *   付け替え済みの子まで殺す。畳みは「衝突していた版より新しい行には及ばせない」という
 *   LWWだけを見る（削除ではなくユニーク制約が強制する統合なので、削除保護の対象外）。
 * - 畳み先が無い（＝利用者操作による普通の削除）場合は、ローカル行が存在し
 *   `deletedAt` がその `updatedAt` より新しいときだけ削除する。
 *
 * 無条件削除ではなくLWWで判定するため、クライアントの処理順に依存せず
 * 「最新の更新 > 最新の削除なら存続、さもなくば削除」へ決定論的に収束する。
 * 比較はフォーマット差（ISO-T vs スペース形式）を吸収する {@link isLaterTimestamp} で行う。
 * @internal
 */
function applyTombstoneDelete(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tableName: string,
  primaryKey: string,
  timestampColumn: string,
  columns: string[],
  recordId: string,
  deletedAt: string,
  mergedInto: string | null,
  result: SyncResult
): void {
  const hasTombstone = localDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get();
  if (hasTombstone) {
    ensureTombstoneMergedIntoColumn(localDb);
    // deletedAt は新しいときだけ進め、畳み先は一度載ったら消さない
    // （畳まれた事実は削除時刻のLWWとは独立に、永久に正しいため）
    localDb
      .prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tableName, recordId) DO UPDATE SET
           deletedAt = CASE
             WHEN COALESCE(
                    julianday(excluded.deletedAt) > julianday(_tombstone.deletedAt),
                    excluded.deletedAt > _tombstone.deletedAt
                  )
             THEN excluded.deletedAt
             ELSE _tombstone.deletedAt
           END,
           mergedInto = COALESCE(excluded.mergedInto, _tombstone.mergedInto)`
      )
      .run(tableName, recordId, deletedAt, mergedInto);
  }

  if (mergedInto !== null && mergedInto !== recordId) {
    // 畳み先が分かっている削除。消す前に子を引き取る。
    // `deletedAt` を渡すのは、畳みより後に更新された行にまで及ばせないため
    // （判断は {@link applyMergedDelete} 側で行う）。
    const { action } = applyMergedDelete(
      localDb,
      tableName,
      primaryKey,
      recordId,
      mergedInto,
      readRemoteRecord(remoteDb, tableName, primaryKey, mergedInto),
      columns,
      timestampColumn,
      deletedAt
    );
    if (action === 'folded') result.deleted++;
    return;
  }

  const escapedTable = escapeIdentifier(tableName);
  const escapedPk = escapeIdentifier(primaryKey);
  const escapedTs = escapeIdentifier(timestampColumn);

  const localRecord = localDb
    .prepare(
      `SELECT ${escapedTs} AS ts FROM ${escapedTable} WHERE ${escapedPk} = ?`
    )
    .get(recordId) as { ts: unknown } | undefined;
  if (!localRecord) return;

  const localUpdatedAt = String(localRecord.ts ?? '');
  if (isLaterTimestamp(localDb, deletedAt, localUpdatedAt)) {
    localDb
      .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .run(recordId);
    result.deleted++;
  }
}

/**
 * changelogエントリをローカルDBに適用する。
 *
 * 各エントリのoperationに応じてINSERT/UPDATE/DELETEを実行し、
 * 結果カウンターを更新する。
 *
 * @internal
 */
function processChangelogEntries(
  localDb: Database.Database,
  remoteDb: Database.Database,
  entries: ChangelogEntry[],
  primaryKey: string,
  configTables: TableConfig[],
  result: SyncResult
): void {
  // テーブルごとのカラム情報をキャッシュ
  const columnCache = new Map<string, string[]>();
  // テーブル名 → TableConfig のマップ
  const tableConfigMap = new Map<string, TableConfig>();
  for (const tc of configTables) {
    tableConfigMap.set(tc.name, tc);
  }

  for (const entry of entries) {
    // _heartbeat エントリは特別扱い: 直接適用
    if (entry.tableName === '_heartbeat') {
      if (entry.operation === 'DELETE') continue;
      const escapedPk = escapeIdentifier(primaryKey);
      const remoteRecord = remoteDb
        .prepare(`SELECT * FROM _heartbeat WHERE id = ?`)
        .get(entry.recordId) as Record<string, unknown> | undefined;
      if (!remoteRecord) continue;

      const columns = columnCache.get('_heartbeat') ?? getTableColumns(localDb, '_heartbeat');
      columnCache.set('_heartbeat', columns);

      applyUpdate(localDb, '_heartbeat', 'id', remoteRecord, columns, 'updatedAt');
      continue;
    }

    // config.tables に含まれないテーブルはスキップ
    const tableConfig = tableConfigMap.get(entry.tableName);
    if (!tableConfig) continue;

    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt';

    let columns = columnCache.get(entry.tableName);
    if (!columns) {
      columns = getTableColumns(localDb, entry.tableName);
      columnCache.set(entry.tableName, columns);
    }

    if (entry.operation === 'DELETE') {
      // 無条件削除は処理順により「削除 vs より新しい更新」の勝敗が変わる（非決定的）。
      // 削除時刻（_tombstone優先・無ければchangelogのchangedAt）を用いたLWWで適用する。
      // tombstoneに畳み先が載っていれば、削除ではなく畳みとして適用される。
      const remoteTombstone = getRemoteTombstone(
        remoteDb,
        entry.tableName,
        entry.recordId
      );
      const mergedInto = resolveFoldTarget(
        entry.recordId,
        remoteTombstone?.mergedInto
      );

      // deleteProtected は「利用者操作による削除を適用しない」ための設定。
      // 畳みはユニーク制約が強制する統合であって削除ではないので、その対象外とする。
      // 見送っても行は救えない — 勝者行が届いた時点で applyInsert が同じ畳みを行うだけで、
      // それまでのあいだ子が宙に浮き、両者が同じユニークキーを送り合い続ける。
      if (tableConfig.deleteProtected && mergedInto === null) continue;

      applyTombstoneDelete(
        localDb,
        remoteDb,
        entry.tableName,
        primaryKey,
        timestampColumn,
        columns,
        entry.recordId,
        remoteTombstone?.deletedAt ?? entry.changedAt,
        mergedInto,
        result
      );
    } else {
      // INSERT or UPDATE: リモートからレコード取得
      const escapedTable = escapeIdentifier(entry.tableName);
      const escapedPk = escapeIdentifier(primaryKey);
      const remoteRecord = remoteDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(entry.recordId) as Record<string, unknown> | undefined;

      if (!remoteRecord) continue; // レコードがリモートに存在しない（後続のDELETEで消えた等）

      if (entry.operation === 'INSERT') {
        const { action, conflict } = applyInsert(
          localDb,
          entry.tableName,
          primaryKey,
          remoteRecord,
          columns,
          timestampColumn
        );
        if (action === 'inserted') result.inserted++;
        if (action === 'upserted') result.conflictsResolved++;
        if (conflict) {
          result.warnings.push(
            `Conflict on ${entry.tableName}:${entry.recordId} resolved as ${conflict.resolution}`
          );
        }
      } else {
        // UPDATE
        const { action, conflict } = applyUpdate(
          localDb,
          entry.tableName,
          primaryKey,
          remoteRecord,
          columns,
          timestampColumn
        );
        if (action === 'updated') result.updated++;
        if (action === 'inserted') result.inserted++;
        if (action === 'skipped') result.skipped++;
        if (conflict) {
          result.warnings.push(
            `Conflict on ${entry.tableName}:${entry.recordId} resolved as ${conflict.resolution}`
          );
        }
      }
    }
  }
}

/** @internal tombstone エントリの型 */
interface TombstoneEntry {
  tableName: string;
  recordId: string;
  deletedAt: string;
  /** 畳み先のid。普通の削除では null（v0.14.0以前のクライアントでも null） */
  mergedInto: string | null;
}

/**
 * フルマージ: リモートの全レコードをLWWでローカルに適用する。
 *
 * トリガーは呼び出し元で無効化済みであること。
 *
 * @internal
 */
function performFullMergeData(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tables: TableConfig[],
  primaryKey: string,
  result: SyncResult
): void {
  for (const tableConfig of tables) {
    const table = tableConfig.name;
    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt';
    const escapedTable = escapeIdentifier(table);

    // リモートDBにテーブルが存在するか確認
    const exists = remoteDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      )
      .get(table);
    if (!exists) continue;

    const columns = getTableColumns(localDb, table);

    // 全レコードをスキャン
    const remoteRecords = remoteDb
      .prepare(`SELECT * FROM ${escapedTable}`)
      .all() as Record<string, unknown>[];

    for (const remoteRecord of remoteRecords) {
      const { action } = applyUpdate(
        localDb,
        table,
        primaryKey,
        remoteRecord,
        columns,
        timestampColumn
      );
      if (action === 'updated') result.updated++;
      if (action === 'inserted') result.inserted++;
      if (action === 'skipped') result.skipped++;
    }
  }
}

/**
 * リモートの `_tombstone` テーブルからDELETE操作を適用する。
 *
 * `deletedAt > ローカルのupdatedAt` の場合のみローカルレコードを削除する。
 * トリガーは呼び出し元で無効化済みであること。
 *
 * @internal
 */
function applyTombstones(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tables: TableConfig[],
  primaryKey: string,
  result: SyncResult
): void {
  // リモートに _tombstone テーブルが存在するか確認
  const exists = remoteDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_tombstone'`)
    .get();
  if (!exists) return;

  const tableConfigMap = new Map<string, TableConfig>();
  for (const tc of tables) {
    tableConfigMap.set(tc.name, tc);
  }

  // mergedInto は v0.14.0以前のクライアントには無い列
  const mergedIntoColumn = hasMergedIntoColumn(remoteDb)
    ? 'mergedInto'
    : 'NULL AS mergedInto';
  const tombstones = remoteDb
    .prepare(
      `SELECT tableName, recordId, deletedAt, ${mergedIntoColumn} FROM _tombstone`
    )
    .all() as TombstoneEntry[];

  const columnCache = new Map<string, string[]>();

  for (const ts of tombstones) {
    const tableConfig = tableConfigMap.get(ts.tableName);
    if (!tableConfig) continue;

    // 畳みは deleteProtected でも適用する（processChangelogEntries と同じ理由）
    const mergedInto = resolveFoldTarget(ts.recordId, ts.mergedInto);
    if (tableConfig.deleteProtected && mergedInto === null) continue;

    // リモートにレコードが現存する場合は再作成されたものとみなし、tombstoneを無視する。
    // （削除後に同一ソースで再INSERTされたケース。削除時刻との大小に依らず存続させる）
    const escapedTable = escapeIdentifier(ts.tableName);
    const escapedPk = escapeIdentifier(primaryKey);
    const remoteRecord = remoteDb
      .prepare(`SELECT ${escapedPk} FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .get(ts.recordId);
    if (remoteRecord) continue;

    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt';

    let columns = columnCache.get(ts.tableName);
    if (!columns) {
      columns = getTableColumns(localDb, ts.tableName);
      columnCache.set(ts.tableName, columns);
    }

    // フォーマット差(ISO-T vs スペース形式)を吸収したLWWで削除を適用する。
    applyTombstoneDelete(
      localDb,
      remoteDb,
      ts.tableName,
      primaryKey,
      timestampColumn,
      columns,
      ts.recordId,
      ts.deletedAt,
      mergedInto,
      result
    );
  }
}

/**
 * リモートの `_changelog` エントリをローカルにマージする（7日以内のもの）。
 *
 * トリガーは呼び出し元で無効化済みであること。
 * ローカルのchangelogに直接INSERTする（トリガー経由ではない）。
 *
 * @internal
 */
function mergeChangelog(
  localDb: Database.Database,
  remoteDb: Database.Database,
  retentionDays: number
): void {
  // リモートの7日以内のchangelogエントリを取得
  const entries = remoteDb
    .prepare(
      `SELECT tableName, recordId, operation, changedAt FROM _changelog
       WHERE changedAt >= datetime('now', '-' || ? || ' days')
       ORDER BY id`
    )
    .all(retentionDays) as { tableName: string; recordId: string; operation: string; changedAt: string }[];

  if (entries.length === 0) return;

  const insertStmt = localDb.prepare(
    `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
  );

  for (const entry of entries) {
    insertStmt.run(entry.tableName, entry.recordId, entry.operation, entry.changedAt);
  }
}

/**
 * 対象テーブルのトリガーを無効化する。
 *
 * フルマージ中にchangelogが汚染されるのを防ぐため。
 *
 * @returns 無効化したトリガー名のリスト（再有効化用）
 * @internal
 */
function disableTriggers(
  db: Database.Database,
  tables: TableConfig[]
): string[] {
  const triggers: string[] = [];
  for (const tableConfig of tables) {
    const table = tableConfig.name;
    const triggerNames = [
      `_changelog_after_insert_${table}`,
      `_changelog_after_update_${table}`,
      `_changelog_after_delete_${table}`,
    ];
    for (const name of triggerNames) {
      // トリガーが存在するか確認してからDROP
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`)
        .get(name);
      if (exists) {
        db.exec(`DROP TRIGGER ${escapeIdentifier(name)}`);
        triggers.push(name);
      }
    }
  }
  return triggers;
}

/**
 * 対象テーブルのトリガーを再作成する。
 *
 * @internal
 */
function reEnableTriggers(
  db: Database.Database,
  tables: TableConfig[],
  primaryKey: string
): void {
  const escapedPk = escapeIdentifier(primaryKey);

  for (const tableConfig of tables) {
    const table = tableConfig.name;
    const escapedTable = escapeIdentifier(table);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_insert_${table}
      AFTER INSERT ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('${table}', NEW.${escapedPk}, 'INSERT');
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_update_${table}
      AFTER UPDATE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('${table}', NEW.${escapedPk}, 'UPDATE');
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_delete_${table}
      AFTER DELETE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('${table}', OLD.${escapedPk}, 'DELETE');
        INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
        VALUES ('${table}', OLD.${escapedPk}, datetime('now'));
      END
    `);
  }
}

/**
 * _heartbeat を更新する（当日の正午、全クライアント共通の確定的な値）。
 *
 * 既に同じ値であればUPDATEしない（トリガー不発）。
 *
 * @internal
 */
function updateHeartbeat(localDb: Database.Database): void {
  const today = new Date().toISOString().slice(0, 10); // "2026-03-27"
  const noon = `${today}T12:00:00Z`;
  const HEARTBEAT_ID = '00000000-0000-0000-0000-000000000000';

  localDb.prepare(
    `INSERT INTO _heartbeat (id, updatedAt) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET updatedAt = ? WHERE updatedAt < ?`
  ).run(HEARTBEAT_ID, noon, noon, noon);
}

/**
 * スキーマバージョン不一致でスキップしたリモートを結果に記録する。
 *
 * 後方互換のため warnings にも文字列を追加する。
 * 同一クライアントは1回のsyncにつき1エントリのみ記録する。
 *
 * @internal
 */
function recordSkippedRemote(
  result: SyncResult,
  clientId: string,
  remoteVersion: string | null,
  localVersion: string
): void {
  if (result.skippedRemotes.some((s) => s.clientId === clientId)) return;
  result.skippedRemotes.push({ clientId, remoteVersion, localVersion });
  result.warnings.push(
    `Skipping client ${clientId}: schema version mismatch (local=${localVersion}, remote=${remoteVersion ?? 'unknown'})`
  );
}

/**
 * 通常のchangelogベース差分同期を実行する。
 *
 * @internal
 */
function pullNormal(
  localDb: Database.Database,
  remoteClients: { clientId: string; filePath: string }[],
  config: SyncConfig,
  tables: TableConfig[],
  primaryKey: string,
  result: SyncResult
): void {
  for (const remote of remoteClients) {
    let handle: ReturnType<typeof openRemoteDbViaLocalCopy> = null;

    try {
      handle = openRemoteDbViaLocalCopy(remote.filePath);
      if (!handle) {
        result.warnings.push(
          `Failed to open remote database: ${remote.clientId}`
        );
        continue;
      }
      const remoteDb = handle.db;

      // schemaVersionチェック
      if (config.schemaVersion) {
        const remoteVersion = readSchemaVersion(remoteDb);
        if (remoteVersion !== config.schemaVersion) {
          recordSkippedRemote(
            result,
            remote.clientId,
            remoteVersion,
            config.schemaVersion
          );
          continue;
        }
      }

      const { lastSeenId } = getSyncState(localDb, remote.clientId);

      // changelog読み取り
      const entries = readChangelog(remoteDb, lastSeenId);
      if (entries.length === 0) {
        result.clientsSynced++;
        continue;
      }

      // エントリの重複排除
      const deduplicated = deduplicateEntries(entries);
      const maxId = entries[entries.length - 1].id;

      // 適用と lastSeenId 更新を 1 つのトランザクションで原子的に。
      // ここで例外が出れば全てロールバックされ、次回 sync で同じ差分を再試行できる。
      const transaction = localDb.transaction(() => {
        // 外部キーの検査をトランザクション終端まで遅らせる。
        // changelogのエントリは「変更が起きた順」に並ぶが、レコードの中身はリモートの
        // 「現在の姿」を読むため、親より先に子が現れることがある（競合解決で子が
        // 別の親へ付け替えられた場合など）。1文ずつ検査すると、その順序だけで
        // 取り込み全体が巻き戻り、その相手からの同期が永久に止まる。
        // 制約を切るのではなく検査を遅らせるだけなので、COMMIT時に矛盾が残っていれば
        // 通常どおり失敗する。この pragma はCOMMIT/ROLLBACKで自動的に戻る。
        localDb.pragma('defer_foreign_keys = ON');
        processChangelogEntries(
          localDb,
          remoteDb,
          deduplicated,
          primaryKey,
          tables,
          result
        );
        updateSyncState(localDb, remote.clientId, maxId);
      });
      transaction();

      result.clientsSynced++;
    } catch (err) {
      result.warnings.push(
        `Sync failed for client ${remote.clientId}: ${err}`
      );
    } finally {
      if (handle) {
        handle.cleanup();
      }
    }
  }
}

/**
 * ギャップ検出時のフルマージを実行する。
 *
 * トリガーを無効化した状態で:
 * 1. リモートの全レコードをLWWでマージ
 * 2. リモートのtombstoneを適用
 * 3. リモートのchangelogをマージ（7日以内）
 *
 * @internal
 */
function pullFullMerge(
  localDb: Database.Database,
  remoteClients: { clientId: string; filePath: string }[],
  config: SyncConfig,
  tables: TableConfig[],
  primaryKey: string,
  retentionDays: number,
  result: SyncResult
): void {
  result.warnings.push(
    'Changelog gap detected, performing full merge with tombstone support'
  );

  // トリガー無効化
  disableTriggers(localDb, tables);

  try {
    for (const remote of remoteClients) {
      let handle: ReturnType<typeof openRemoteDbViaLocalCopy> = null;

      try {
        handle = openRemoteDbViaLocalCopy(remote.filePath);
        if (!handle) {
          result.warnings.push(
            `Failed to open remote database: ${remote.clientId}`
          );
          continue;
        }
        const remoteDb = handle.db;

        // schemaVersionチェック
        if (config.schemaVersion) {
          const remoteVersion = readSchemaVersion(remoteDb);
          if (remoteVersion !== config.schemaVersion) {
            recordSkippedRemote(
              result,
              remote.clientId,
              remoteVersion,
              config.schemaVersion
            );
            continue;
          }
        }

        // フルマージ本体と lastSeenId 更新を 1 つのトランザクションで原子的に。
        // 途中で例外が出れば mergeChangelog の大量INSERTを含めて全てロールバックされ、
        // 次回 sync で同じギャップが再検出されてやり直せる。
        // これがないと、changelogが膨張したまま lastSeenId が更新されず、毎回ループする。
        const transaction = localDb.transaction(() => {
          // 外部キーの検査をトランザクション終端まで遅らせる（pullNormal と同じ理由。
          // フルマージはテーブル名順に全行を流し込むため、親より先に子を入れる場面が
          // 通常フローよりさらに多い）。
          localDb.pragma('defer_foreign_keys = ON');
          performFullMergeData(localDb, remoteDb, tables, primaryKey, result);
          applyTombstones(localDb, remoteDb, tables, primaryKey, result);
          mergeChangelog(localDb, remoteDb, retentionDays);
          const maxId = getMaxChangelogId(remoteDb);
          updateSyncState(localDb, remote.clientId, maxId);
        });
        transaction();

        result.clientsSynced++;
      } catch (err) {
        result.warnings.push(
          `Full merge failed for client ${remote.clientId}: ${err}`
        );
      } finally {
        if (handle) {
          handle.cleanup();
        }
      }
    }
  } finally {
    // トリガー再有効化（必ず実行）
    reEnableTriggers(localDb, tables, primaryKey);
  }
}

/**
 * 同期処理を実行する。
 *
 * **通常フロー（ギャップなし）:**
 * 1. ローカルDBをNASにアトミックコピー
 * 2. 各リモートクライアントからchangelogベースでpull
 * 3. heartbeat更新
 *
 * **ギャップ検出時（pull-firstフロー）:**
 * 1. NASへのアップロードをスキップ（staleデータの拡散を防止）
 * 2. トリガー無効化 → 各リモートからフルマージ（データ + tombstone + changelog）→ トリガー有効化
 * 3. heartbeat更新（トリガーON → changelogに1件記録 → changelog延命）
 * 4. pull完了後にローカルDBをNASにアップロード（クリーンな状態）
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param config - 同期設定
 * @param tables - 同期対象テーブル設定の配列（{@link discoverTables} 等で解決済み）
 * @returns 同期結果の統計情報
 * @throws NASへのコピーに失敗した場合
 *
 * @remarks
 * 個別のリモートクライアントの処理失敗は警告として記録され、
 * 他のクライアントの処理には影響しない。
 */
export async function performSync(
  localDb: Database.Database,
  config: SyncConfig,
  tables: TableConfig[]
): Promise<SyncResult> {
  const primaryKey = config.primaryKey ?? DEFAULTS.primaryKey;
  const retentionDays =
    config.changelogRetentionDays ?? DEFAULTS.changelogRetentionDays;
  const heartbeatEnabled = config.heartbeatEnabled ?? DEFAULTS.heartbeatEnabled;

  const result: SyncResult = {
    clientsSynced: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    conflictsResolved: 0,
    warnings: [],
    skippedRemotes: [],
    hadChangelogGap: false,
  };

  // 0. schemaVersionが指定されている場合、ローカルDBに書き込む
  if (config.schemaVersion) {
    writeSchemaVersion(localDb, config.schemaVersion);
  }

  // 1. NASディレクトリを確保し、リモートクライアントを列挙
  ensureDirectory(config.nasPath);
  const remoteClients = listRemoteClients(config.nasPath, config.clientId);

  // 2. ギャップ事前チェック: いずれかのリモートにchangelogギャップがあるか確認
  let hasAnyGap = false;
  for (const remote of remoteClients) {
    let handle: ReturnType<typeof openRemoteDbViaLocalCopy> = null;
    try {
      handle = openRemoteDbViaLocalCopy(remote.filePath);
      if (!handle) continue;
      const remoteDb = handle.db;

      if (config.schemaVersion) {
        const remoteVersion = readSchemaVersion(remoteDb);
        if (remoteVersion !== config.schemaVersion) continue;
      }

      const { lastSeenId } = getSyncState(localDb, remote.clientId);
      if (hasChangelogGap(remoteDb, lastSeenId)) {
        hasAnyGap = true;
        break;
      }
    } finally {
      if (handle) {
        handle.cleanup();
      }
    }
  }

  if (hasAnyGap) {
    // === Pull-first フルマージフロー ===
    result.hadChangelogGap = true;

    // 3a. トリガーOFFでフルマージ（データ + tombstone + changelog）
    pullFullMerge(localDb, remoteClients, config, tables, primaryKey, retentionDays, result);

    // 3b. heartbeat更新（トリガーON状態 → changelogに1件 → changelog延命）
    if (heartbeatEnabled) {
      updateHeartbeat(localDb);
    }

    // 3c. クリーンな状態をNASにアップロード
    await copyToNas(localDb, config.nasPath, config.clientId);
  } else {
    // === 通常フロー ===
    // 4a. ローカルDBをNASにコピー（schemaVersion込み）
    await copyToNas(localDb, config.nasPath, config.clientId);

    // 4b. リモートから変更をpull
    pullNormal(localDb, remoteClients, config, tables, primaryKey, result);

    // 4c. heartbeat更新
    if (heartbeatEnabled) {
      updateHeartbeat(localDb);
    }
  }

  // 5. 古い_changelogエントリの掃除
  cleanupChangelog(localDb, retentionDays);

  // 6. onAfterSync コールバック
  if (config.onAfterSync) {
    config.onAfterSync(localDb, result);
  }

  return result;
}
