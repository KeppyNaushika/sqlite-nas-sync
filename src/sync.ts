/**
 * コア同期オーケストレーションを提供するモジュール。
 *
 * ローカルDBのNASコピー → リモートchangelog読み取り → 差分適用 →
 * sync状態更新 → changelog掃除 の一連のフローを実行する。
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

/**
 * changelogギャップ時のフルテーブルスキャンフォールバック。
 *
 * changelogが掃除されて差分追跡ができない場合に、
 * `updatedAt` ベースでリモートの全レコードをスキャンし同期する。
 *
 * @remarks
 * このフォールバックではDELETE操作を検知できない。
 * 次回以降のchangelogベース同期で追跡される。
 *
 * @internal
 */
function performFullTableFallback(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tables: TableConfig[],
  primaryKey: string,
  lastSyncedAt: string | null,
  result: SyncResult
): void {
  result.warnings.push(
    'Changelog gap detected, performing full-table fallback (deletes cannot be detected)'
  );

  for (const tableConfig of tables) {
    const table = tableConfig.name;
    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt';
    const escapedTable = escapeIdentifier(table);
    const escapedTimestamp = escapeIdentifier(timestampColumn);

    // リモートDBにテーブルが存在するか確認
    const exists = remoteDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      )
      .get(table);
    if (!exists) continue;

    const columns = getTableColumns(localDb, table);

    let remoteRecords: Record<string, unknown>[];
    if (lastSyncedAt) {
      remoteRecords = remoteDb
        .prepare(
          `SELECT * FROM ${escapedTable} WHERE ${escapedTimestamp} > ?`
        )
        .all(lastSyncedAt) as Record<string, unknown>[];
    } else {
      // 初回: 全レコード
      remoteRecords = remoteDb
        .prepare(`SELECT * FROM ${escapedTable}`)
        .all() as Record<string, unknown>[];
    }

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
 * 各リモートクライアントからchangelogを読み取り、ローカルDBに適用する。
 *
 * @returns いずれかのリモートでchangelogギャップが検出されたかどうか
 * @internal
 */
function pullFromRemotes(
  localDb: Database.Database,
  remoteClients: { clientId: string; filePath: string }[],
  config: SyncConfig,
  primaryKey: string,
  result: SyncResult
): boolean {
  let hadGap = false;

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

      // schemaVersionチェック: バージョンが一致しないリモートはスキップ
      if (config.schemaVersion) {
        const remoteVersion = readSchemaVersion(remoteDb);
        if (remoteVersion !== config.schemaVersion) {
          result.warnings.push(
            `Skipping client ${remote.clientId}: schema version mismatch (local=${config.schemaVersion}, remote=${remoteVersion ?? 'unknown'})`
          );
          continue;
        }
      }

      const { lastSeenId, lastSyncedAt } = getSyncState(
        localDb,
        remote.clientId
      );

      // ギャップチェック
      if (hasChangelogGap(remoteDb, lastSeenId)) {
        hadGap = true;
        const transaction = localDb.transaction(() => {
          performFullTableFallback(
            localDb,
            remoteDb!,
            config.tables,
            primaryKey,
            lastSyncedAt,
            result
          );
        });
        transaction();

        const maxId = getMaxChangelogId(remoteDb);
        updateSyncState(localDb, remote.clientId, maxId);
        result.clientsSynced++;
        continue;
      }

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

  return hadGap;
}

/**
 * 同期処理を実行する。
 *
 * 以下のステップを順に実行する:
 *
 * **通常フロー（ギャップなし）:**
 * 1. ローカルDBをNASにアトミックコピー
 * 2. 各リモートクライアントからchangelogベースでpull
 *
 * **ギャップ検出時（pull-firstフロー）:**
 * 1. NASへのアップロードを**スキップ**（staleデータの拡散を防止）
 * 2. 各リモートからfull-table fallbackでpull
 * 3. ローカルの古いchangelogをクリア（staleなchangelogの拡散を防止）
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
 *
 * ギャップ検出時、staleクライアントのローカル変更はリモートより古い場合
 * LWWにより上書きされる。これは意図的な設計で、staleクライアントが
 * 他のクライアントに悪影響を与えないことを優先する。
 */
export async function performSync(
  localDb: Database.Database,
  config: SyncConfig
): Promise<SyncResult> {
  const primaryKey = config.primaryKey ?? DEFAULTS.primaryKey;
  const retentionDays =
    config.changelogRetentionDays ?? DEFAULTS.changelogRetentionDays;

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

      // schemaVersionが不一致ならこのリモートはスキップ対象なのでギャップ判定不要
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
    // === Pull-first フロー ===
    // staleクライアントのデータをNASに撒き散らさないため、
    // まずリモートから全変更を取り込み、その後にアップロードする

    result.hadChangelogGap = true;

    // 3a. リモートから変更をpull（アップロード前）
    pullFromRemotes(localDb, remoteClients, config, primaryKey, result);

    // 3b. ローカルのstaleなchangelogをクリア
    //     pull時にトリガーが新しいchangelogエントリを生成するが、
    //     それ以前の古いエントリは他クライアントに読まれると害になるため削除
    localDb.exec(`DELETE FROM _changelog`);

    // 3c. クリーンな状態をNASにアップロード
    await copyToNas(localDb, config.nasPath, config.clientId);
  } else {
    // === 通常フロー ===
    // 4a. ローカルDBをNASにコピー（schemaVersion込み）
    await copyToNas(localDb, config.nasPath, config.clientId);

    // 4b. リモートから変更をpull
    pullFromRemotes(localDb, remoteClients, config, primaryKey, result);
  }

  // 5. 古い_changelogエントリの掃除
  cleanupChangelog(localDb, retentionDays);

  // 6. onAfterSync コールバック
  if (config.onAfterSync) {
    config.onAfterSync(localDb, result);
  }

  return result;
}
