/**
 * レコードレベルの競合解決ロジックを提供するモジュール。
 *
 * INSERT（UPSERT fallback）、UPDATE（LWW）、DELETE の3つの操作を処理する。
 * 実装は役割ごとに分かれている:
 *
 * | モジュール | 受け持ち |
 * | --- | --- |
 * | `conflict/schema` | `PRAGMA` によるスキーマの読み取りとキャッシュ |
 * | `conflict/timestamp` | 時刻の比較・時刻列の解決・同時刻の決着 |
 * | `conflict/unique` | ユニークキーの読み取りと衝突相手の特定 |
 * | `conflict/ledger` | `_id_merge` / `_tombstone` / `_changelog` への記録 |
 * | `conflict/remap` | 畳まれて消えた親を指す外部キーの向け直し |
 * | `conflict/fold` | 行を1つへ畳む（子の付け替えと削除） |
 * | `conflict/stalemate` | どちらも勝てない食い違いの報告 |
 * | `conflict/apply` | 上記を束ねた INSERT / UPDATE / DELETE の適用 |
 *
 * @module conflict
 */
export { applyInsert } from './insert';
export type { ApplyInsertResult } from './insert';
export { applyDelete, applyUpdate } from './update';
export type { ApplyUpdateResult } from './update';
export { applyMergedDelete } from './merged-delete';
export { isLaterTimestamp } from './timestamp';
export { isShadowedByTombstone } from './tombstone';
export type { ResurrectionProbe } from './tombstone';
export type { TimestampColumnFor } from './timestamp';
