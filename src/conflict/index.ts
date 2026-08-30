/**
 * レコードレベルの競合解決ロジックを提供するモジュール。
 *
 * INSERT（UPSERT fallback）、UPDATE（LWW）、DELETE の3つの操作を処理する。
 * 実装は役割ごとに分かれている:
 *
 * | モジュール | 受け持ち |
 * | --- | --- |
 * | {@link module:conflict/schema} | `PRAGMA` によるスキーマの読み取りとキャッシュ |
 * | {@link module:conflict/timestamp} | 時刻の比較・時刻列の解決・同時刻の決着 |
 * | {@link module:conflict/unique} | ユニークキーの読み取りと衝突相手の特定 |
 * | {@link module:conflict/ledger} | `_id_merge` / `_tombstone` / `_changelog` への記録 |
 * | {@link module:conflict/remap} | 畳まれて消えた親を指す外部キーの向け直し |
 * | {@link module:conflict/fold} | 行を1つへ畳む（子の付け替えと削除） |
 * | {@link module:conflict/stalemate} | どちらも勝てない食い違いの報告 |
 * | {@link module:conflict/apply} | 上記を束ねた INSERT / UPDATE / DELETE の適用 |
 *
 * @module conflict
 */
export {
  applyDelete,
  applyInsert,
  applyMergedDelete,
  applyUpdate,
} from './apply';
export { isLaterTimestamp } from './timestamp';
export { isShadowedByTombstone } from './ledger';
export type { ResurrectionProbe } from './ledger';
export type { TimestampColumnFor } from './timestamp';
