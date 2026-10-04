/**
 * DB から同期の仕組み（トリガーと内部の表）を取り除く。
 *
 * `setupSync` はアプリの DB の中にトリガーと内部の表を作る。同期をやめたあとも残すと、
 * アプリの書き込みのたびにトリガーが内部の表を書き、誰も刈らない記録が伸び続ける。
 * トリガーの時刻列の検査（前提 P15）も、アプリの書き込みを縛り続ける。
 *
 * 取り除く対象は、このライブラリが作るものに限る。
 *
 * | 種類 | 名前 | 作るところ |
 * | --- | --- | --- |
 * | トリガー | `_sns_` で始まるもの | `rows/triggers.ts` |
 * | トリガー（旧方式） | `_changelog_after_{insert,update,delete}_` で始まるもの | `rows/migrate.ts` の `dropLegacyTriggers`・`dropHeartbeat` が落とすもの |
 * | 表 | `_sns_` で始まるもの | `rows/schema.ts`（`_sns_` は予約接頭辞） |
 * | 表 | `_tombstone`・`_changelog` | `rows/schema.ts` |
 * | 表 | `_changelog_prune` | `changelog.ts` |
 * | 表 | `_sync_state`・`_sync_meta` | `setup/rows-ledgers.ts`・`rows/meta.ts` |
 * | 表（旧方式） | `_id_merge`・`_heartbeat` | `rows/migrate.ts` が落とすもの |
 *
 * 索引（`idx_sns_shown_shown`・`idx_changelog_id`）と、`_changelog` の `sqlite_sequence` の
 * 行は、表を落とすと SQLite が一緒に消す。アプリの表とその行には触らない。
 *
 * @module teardown
 */

import Database from 'better-sqlite3'
import { escapeIdentifier } from './setup/sql'

/** 予約接頭辞（`rows/schema.ts` の `RESERVED_PREFIX` と同じ） */
const RESERVED_PREFIX = '_sns_'

/** 予約接頭辞を持たない、このライブラリの表 */
const LIBRARY_TABLES: readonly string[] = [
  '_tombstone',
  '_changelog',
  '_changelog_prune',
  '_sync_state',
  '_sync_meta',
  '_id_merge',
  '_heartbeat',
]

/**
 * このライブラリが使ったことのある DB かを見分ける表。
 *
 * どの版の `setupSync` も、旧方式なら `_sync_state`、案A なら `_sync_meta` と `_sns_` の表を
 * 作る。どれも無い DB では、`_changelog` などの名前の表があってもアプリのものなので触らない。
 */
const LEDGER_TABLES: readonly string[] = ['_sync_state', '_sync_meta']

/** 旧方式のトリガーの接頭辞 */
const LEGACY_TRIGGER_PREFIXES: readonly string[] = [
  '_changelog_after_insert_',
  '_changelog_after_update_',
  '_changelog_after_delete_',
]

const isLibraryTrigger = (name: string): boolean =>
  name.startsWith(RESERVED_PREFIX) ||
  LEGACY_TRIGGER_PREFIXES.some((prefix) => name.startsWith(prefix))

const isLibraryTable = (name: string): boolean =>
  name.startsWith(RESERVED_PREFIX) || LIBRARY_TABLES.includes(name)

const listNames = (
  db: Database.Database,
  type: 'table' | 'trigger'
): string[] =>
  db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`
    )
    .all(type)
    .map((row) => row.name)

/**
 * DB から同期の仕組みを取り除く。
 *
 * 1つのトランザクションで行うので、途中で失敗したら何も変わらない。トリガーを先に、
 * 表を後に落とす。このライブラリが使ったことのない DB（{@link LEDGER_TABLES} も `_sns_` の
 * 表も無い）では何もしない。
 *
 * **この DB に対する `SyncInstance` を閉じてから呼ぶこと**（`SyncInstance.close()`）。
 * 動いているインスタンスは、取り除いた表とトリガーを作り直す。
 *
 * 取り除いた DB で、同じ `nasPath` に同じ `clientId` のまま `setupSync` し直すと、NAS 上の
 * 自分のコピーより手元の記録が古いので、バックアップから戻した DB として警告が出る。
 * 同期に戻すなら、別の `clientId` を使うか、別の `nasPath` で始めること。
 *
 * @param dbPath 取り除く DB のパス
 * @returns 取り除いたトリガーと表の名前（トリガーが先）。何も無ければ空の配列
 */
export function removeSync(dbPath: string): string[] {
  const db = new Database(dbPath)
  try {
    const tables = listNames(db, 'table')
    const usedByLibrary = tables.some(
      (name) => name.startsWith(RESERVED_PREFIX) || LEDGER_TABLES.includes(name)
    )
    if (!usedByLibrary) return []

    const triggers = listNames(db, 'trigger').filter(isLibraryTrigger)
    const libraryTables = tables.filter(isLibraryTable)
    db.transaction(() => {
      for (const trigger of triggers) {
        db.exec(`DROP TRIGGER IF EXISTS ${escapeIdentifier(trigger)}`)
      }
      for (const table of libraryTables) {
        db.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(table)}`)
      }
    })()
    return [...triggers, ...libraryTables]
  } finally {
    db.close()
  }
}
