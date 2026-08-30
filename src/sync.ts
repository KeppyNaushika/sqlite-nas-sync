/**
 * コア同期オーケストレーションを提供するモジュール。
 *
 * 1回の `performSync` はこう進む:
 *
 * 1. ローカルDBをNASへコピーする（相手はこのコピーを読む）
 * 2. NAS上の相手を1人ずつ開き、通常経路かフルマージかを選んで取り込む
 *    （`sync/pull`）
 * 3. `_heartbeat` を更新して「まだ生きている」と伝え、changelog を掃除する
 *
 * 実装は役割ごとに分かれている:
 *
 * | モジュール | 受け持ち |
 * | --- | --- |
 * | `sync/sql` | この層でだけ使う SQLite の小道具 |
 * | `sync/state` | `_sync_state` / `_heartbeat` の読み書き |
 * | `sync/remote` | 取り込み元のDBを読む（バージョン差を吸収する） |
 * | `sync/entries` | changelog エントリ1件ずつの適用 |
 * | `sync/full-merge` | 隙間があるときの全件突き合わせ |
 * | `sync/triggers` | フルマージ中のトリガー付け外し |
 * | `sync/pull` | 相手1人ぶんの取り込み（トランザクションの単位） |
 *
 * @module sync
 */
import Database from 'better-sqlite3';
import { DEFAULTS, SyncConfig, SyncResult, TableConfig } from './types';
import { cleanupChangelog, hasChangelogGap } from './changelog';
import {
  copyToNas,
  ensureDirectory,
  listRemoteClients,
  openRemoteDbViaLocalCopy,
} from './nas';
import {
  computeSchemaHash,
  ensureTombstoneMergedIntoColumn,
  readSchemaVersion,
  writeSchemaVersion,
} from './setup';
import { getSyncState, recordSkippedRemote, updateHeartbeat } from './sync/state';
import { pullFullMerge, pullNormal } from './sync/pull';

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
    folds: [],
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
