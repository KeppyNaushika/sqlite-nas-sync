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
import { applyInsert, applyUpdate, applyDelete } from './conflict';
import { copyToNas, ensureDirectory, listRemoteClients, openRemoteDb } from './nas';
import { readSchemaVersion, writeSchemaVersion } from './setup';

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
      // deleteProtected の場合はスキップ
      if (tableConfig.deleteProtected) continue;

      const { action } = applyDelete(
        localDb,
        entry.tableName,
        primaryKey,
        entry.recordId
      );
      if (action === 'deleted') result.deleted++;
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

  const tombstones = remoteDb
    .prepare(`SELECT tableName, recordId, deletedAt FROM _tombstone`)
    .all() as TombstoneEntry[];

  for (const ts of tombstones) {
    const tableConfig = tableConfigMap.get(ts.tableName);
    if (!tableConfig) continue;
    if (tableConfig.deleteProtected) continue;

    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt';
    const escapedTable = escapeIdentifier(ts.tableName);
    const escapedPk = escapeIdentifier(primaryKey);
    const escapedTimestamp = escapeIdentifier(timestampColumn);

    // リモートにレコードが再作成されている場合はtombstoneを無視
    // （削除後に再INSERTされたケース）
    const remoteRecord = remoteDb
      .prepare(`SELECT ${escapedPk} FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .get(ts.recordId);
    if (remoteRecord) continue;

    // ローカルにレコードが存在し、deletedAt > updatedAt の場合のみ削除
    const localRecord = localDb
      .prepare(`SELECT ${escapedPk}, ${escapedTimestamp} FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .get(ts.recordId) as Record<string, unknown> | undefined;

    if (!localRecord) continue;

    const localUpdatedAt = String(localRecord[timestampColumn] ?? '');
    if (ts.deletedAt > localUpdatedAt) {
      localDb
        .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .run(ts.recordId);
      // tombstone をローカルにもコピー
      localDb
        .prepare(`INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt) VALUES (?, ?, ?)`)
        .run(ts.tableName, ts.recordId, ts.deletedAt);
      result.deleted++;
    }
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
 * 通常のchangelogベース差分同期を実行する。
 *
 * @internal
 */
function pullNormal(
  localDb: Database.Database,
  remoteClients: { clientId: string; filePath: string }[],
  config: SyncConfig,
  primaryKey: string,
  result: SyncResult
): void {
  for (const remote of remoteClients) {
    let remoteDb: Database.Database | null = null;

    try {
      remoteDb = openRemoteDb(remote.filePath);
      if (!remoteDb) {
        result.warnings.push(
          `Failed to open remote database: ${remote.clientId}`
        );
        continue;
      }

      // schemaVersionチェック
      if (config.schemaVersion) {
        const remoteVersion = readSchemaVersion(remoteDb);
        if (remoteVersion !== config.schemaVersion) {
          result.warnings.push(
            `Skipping client ${remote.clientId}: schema version mismatch (local=${config.schemaVersion}, remote=${remoteVersion ?? 'unknown'})`
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

      // トランザクション内で適用
      const transaction = localDb.transaction(() => {
        processChangelogEntries(
          localDb,
          remoteDb!,
          deduplicated,
          primaryKey,
          config.tables,
          result
        );
      });
      transaction();

      // lastSeenId更新
      const maxId = entries[entries.length - 1].id;
      updateSyncState(localDb, remote.clientId, maxId);

      result.clientsSynced++;
    } catch (err) {
      result.warnings.push(
        `Sync failed for client ${remote.clientId}: ${err}`
      );
    } finally {
      if (remoteDb) {
        try {
          remoteDb.close();
        } catch {
          // ignore close errors
        }
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
  primaryKey: string,
  retentionDays: number,
  result: SyncResult
): void {
  result.warnings.push(
    'Changelog gap detected, performing full merge with tombstone support'
  );

  // トリガー無効化
  disableTriggers(localDb, config.tables);

  try {
    for (const remote of remoteClients) {
      let remoteDb: Database.Database | null = null;

      try {
        remoteDb = openRemoteDb(remote.filePath);
        if (!remoteDb) {
          result.warnings.push(
            `Failed to open remote database: ${remote.clientId}`
          );
          continue;
        }

        // schemaVersionチェック
        if (config.schemaVersion) {
          const remoteVersion = readSchemaVersion(remoteDb);
          if (remoteVersion !== config.schemaVersion) {
            result.warnings.push(
              `Skipping client ${remote.clientId}: schema version mismatch (local=${config.schemaVersion}, remote=${remoteVersion ?? 'unknown'})`
            );
            continue;
          }
        }

        // トランザクション内でフルマージ
        const transaction = localDb.transaction(() => {
          // 1. 全レコードをLWWでマージ
          performFullMergeData(localDb, remoteDb!, config.tables, primaryKey, result);

          // 2. tombstone適用
          applyTombstones(localDb, remoteDb!, config.tables, primaryKey, result);

          // 3. changelogマージ（7日以内）
          mergeChangelog(localDb, remoteDb!, retentionDays);
        });
        transaction();

        // lastSeenId更新
        const maxId = getMaxChangelogId(remoteDb);
        updateSyncState(localDb, remote.clientId, maxId);
        result.clientsSynced++;
      } catch (err) {
        result.warnings.push(
          `Full merge failed for client ${remote.clientId}: ${err}`
        );
      } finally {
        if (remoteDb) {
          try {
            remoteDb.close();
          } catch {
            // ignore close errors
          }
        }
      }
    }
  } finally {
    // トリガー再有効化（必ず実行）
    reEnableTriggers(localDb, config.tables, primaryKey);
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
 * @returns 同期結果の統計情報
 * @throws NASへのコピーに失敗した場合
 *
 * @remarks
 * 個別のリモートクライアントの処理失敗は警告として記録され、
 * 他のクライアントの処理には影響しない。
 */
export async function performSync(
  localDb: Database.Database,
  config: SyncConfig
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
    let remoteDb: Database.Database | null = null;
    try {
      remoteDb = openRemoteDb(remote.filePath);
      if (!remoteDb) continue;

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
      if (remoteDb) {
        try { remoteDb.close(); } catch { /* ignore */ }
      }
    }
  }

  if (hasAnyGap) {
    // === Pull-first フルマージフロー ===
    result.hadChangelogGap = true;

    // 3a. トリガーOFFでフルマージ（データ + tombstone + changelog）
    pullFullMerge(localDb, remoteClients, config, primaryKey, retentionDays, result);

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
    pullNormal(localDb, remoteClients, config, primaryKey, result);

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
