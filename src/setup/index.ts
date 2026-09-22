/**
 * 起動時の下ごしらえ（案A）。
 *
 * 旧方式の `setupChangelog`（`_changelog` の3本のトリガー・`_id_merge`・
 * `_tombstone` の畳み用の列）は**段階6 で消した**。案A でアプリの表に付く
 * トリガーは `src/rows/triggers.ts` の4本だけで、表に触らない帳簿は
 * `setup/rows-ledgers.ts` が作る。
 *
 * 実装は役割ごとに分かれている:
 *
 * | モジュール | 受け持ち |
 * | --- | --- |
 * | `setup/sql` | 時刻の書式（`NOW_SQL`）と SQL の小道具 |
 * | `setup/rows-ledgers` | `_sync_state` / `_changelog_prune` / `_heartbeat` / `_sync_meta` |
 * | `setup/rows-preflight` | 前提の確認（§1.8 の P1〜P8） |
 * | `setup/schema-version` | スキーマの指紋の読み書き |
 *
 * @module setup
 */
export { NOW_SQL } from './sql'
export {
  computeSchemaHash,
  readSchemaVersion,
  writeSchemaVersion,
} from './schema-version'
export { setupRowsLedgers } from './rows-ledgers'
export { checkRowsPreconditions } from './rows-preflight'
