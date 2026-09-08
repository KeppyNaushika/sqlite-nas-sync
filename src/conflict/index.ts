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
 * | `conflict/stalemate` | どちらも勝てない食い違いの報告 |
 * | `conflict/ledger` | `_id_merge`（ローカル索引）への記録と、**主張を受け入れるかの判断** |
 * | `conflict/tombstone` | `_tombstone`（他端末へ渡る主張）の読み書き |
 * | `conflict/fold-changelog` | 畳みを `_changelog`（差分経路）へも載せる |
 * | `conflict/remap` | 畳まれて消えた親を指す外部キーの向け直し |
 * | `conflict/child-carry` | 敗者行の DELETE を越えて子を勝者へ引き渡す |
 * | `conflict/transaction` | 外部キーの検査を終端まで遅らせる区切り |
 * | `conflict/fold` | 行を1つへ畳む（子の付け替えと削除。相互再帰する3関数） |
 * | `conflict/overwrite` | 既に在る行の上へ書く（邪魔な相手が居れば畳む） |
 * | `conflict/insert` | `applyInsert` |
 * | `conflict/update` | `applyUpdate` / `applyDelete` |
 * | `conflict/merged-delete` | `applyMergedDelete`（畳みとして届いた削除） |
 *
 * @module conflict
 */
export { applyInsert } from './insert'
export type { ApplyInsertResult } from './insert'
export { applyDelete, applyUpdate } from './update'
export type { ApplyUpdateResult } from './update'
export { applyMergedDelete } from './merged-delete'
export { isLaterTimestamp } from './timestamp'
export { isShadowedByTombstone } from './tombstone'
export type { ResurrectionProbe } from './tombstone'
export type { TimestampColumnFor } from './timestamp'
