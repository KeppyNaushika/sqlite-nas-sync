/**
 * 自分が書いた行にも、同じ LWW を当てる。
 *
 * 取り込み経路は「削除より古い挿入・更新は採らない」（{@link isShadowedByTombstone}）
 * という規則を守っているが、**アプリがローカルへ直接書いた行はその検査を通らない**。
 * そのため、既にある削除より古い時刻で行が書かれると、
 *
 * - 書いた端末はその行を持ち続け、
 * - 受け取る端末は（規則どおり）その行を採らず、
 *
 * **警告も例外も出ないまま永久に食い違います**（実測: 端末Cが行を作って消したあと、
 * 同じ id を削除より古い時刻で作り直すと、その端末だけが持ち続けた）。
 * アプリが `updatedAt` に現在時刻を入れているかぎり起きませんが、
 * 過去の時刻を入れる余地がある以上、ライブラリ側の規則として閉じておく。
 *
 * ここでは**自分の `_changelog` を手掛かりに**、前回見た位置より後の書き込みだけを
 * 見直す。保持期間ぶん（既定7日）を毎回なめ直さないための位置は `_sync_meta` に置く
 * （表を増やさずに済む）。
 *
 * @module sync/self-check
 * @internal
 */
import Database from 'better-sqlite3'
import { SyncResult, TableConfig } from '../types'
import { readChangelog } from '../changelog'
import { readTombstoneClaim } from '../conflict/tombstone'
import { lookupIdMerge, recordMerge } from '../conflict/ledger'
import { isLaterTimestamp } from '../conflict/timestamp'
import { readColumn } from '../conflict/schema'
import { escapeIdentifier } from './sql'
import { makeTableConfigLookup, makeTimestampColumnFor } from './remote'

/** 見直した位置を覚えておく `_sync_meta` のキー。 */
const CURSOR_KEY = 'selfCheckedChangelogId'

/**
 * 前回どこまで見直したか。
 *
 * 読めないとき（表が無い・まだ書いていない）は 0。**大きい値へ倒してはいけない** ——
 * 見直していない書き込みを「見た」と扱うと、食い違いがそのまま残る。
 * @internal
 */
export function readSelfCheckCursor(db: Database.Database): number {
  try {
    const row = db
      .prepare(`SELECT value FROM _sync_meta WHERE key = ?`)
      .get(CURSOR_KEY) as { value: string } | undefined
    const parsed = Number(row?.value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  } catch {
    return 0
  }
}

/**
 * 見直した位置を進める。**前へしか動かさない。**
 * @internal
 */
function writeSelfCheckCursor(db: Database.Database, id: number): void {
  db.prepare(
    `INSERT INTO _sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(MAX(CAST(_sync_meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`
  ).run(CURSOR_KEY, String(id))
}

/**
 * 自分が書いた行のうち、既にある削除に負けているものを消す。
 *
 * 消すのは**その行が他の端末へ決して渡らない**からで、残しても食い違いが続くだけである。
 * 黙って消さず、何を消したかを `warnings` に載せる（アプリが過去の時刻を書いた、という
 * 直すべき事実がそこにあるため）。
 *
 * @returns 消した行数
 * @internal
 */
export function dropLocalWritesLostToDeletion(
  localDb: Database.Database,
  tables: TableConfig[],
  primaryKey: string,
  result: SyncResult
): number {
  const cursor = readSelfCheckCursor(localDb)
  const entries = readChangelog(localDb, cursor)
  if (entries.length === 0) return 0

  const tableConfigFor = makeTableConfigLookup(tables)
  const timestampColumnFor = makeTimestampColumnFor(tables)
  let dropped = 0
  // 同じ行が何度も出てくる（INSERT → UPDATE …）。見直すのは1回でよい
  const seen = new Set<string>()

  for (const entry of entries) {
    if (entry.operation === 'DELETE') continue
    const tableConfig = tableConfigFor(entry.tableName)
    // 設定に無い表（`_heartbeat` など）は対象外
    if (tableConfig === undefined) continue

    const key = `${tableConfig.name}:${entry.recordId}`
    if (seen.has(key)) continue
    seen.add(key)

    const escapedTable = escapeIdentifier(tableConfig.name)
    const escapedPk = escapeIdentifier(primaryKey)
    const row = localDb
      .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .get(entry.recordId) as Record<string, unknown> | undefined
    // もう無い行は見直すことが無い
    if (row === undefined) continue

    const claim = readTombstoneClaim(localDb, tableConfig.name, entry.recordId)
    if (claim === null) continue

    const rowTimestamp = String(
      readColumn(row, timestampColumnFor(tableConfig.name)) ?? ''
    )

    // 畳み先を名乗る tombstone（`mergedInto`）は「消えた」ではなく「この行へ
    // まとめられた」の記録で、削除とは別の物差しで見る（{@link dropLocalWriteToFold}）。
    if (claim.mergedInto !== null) {
      if (
        dropLocalWriteToFold(
          localDb,
          tableConfig.name,
          entry.recordId,
          escapedTable,
          escapedPk,
          rowTimestamp,
          timestampColumnFor(tableConfig.name),
          result
        )
      ) {
        dropped += 1
      }
      continue
    }

    // 消すのは**削除が厳密に新しい**ときだけ。
    //
    // 取り込み経路（{@link isShadowedByTombstone}）は同時刻を「削除が勝つ」と決めて
    // いるが、ここで同時刻まで消してはいけない。**畳みの記録は構造上、勝者行の時刻と
    // 同じ時刻の tombstone を残す**（`mergedAt` は勝者行の版から採る）ので、
    // 同時刻を消すと畳みで生き残った行を毎回消してしまう（実測: 3端末の畳みが
    // 収束したあと、全端末からその行が消えた）。畳み先を名乗る記録は上で分けたが、
    // 向きが覆ったあとに `mergedInto` だけ落ちた記録も残りうるので、ここでも守る。
    //
    // 取りこぼす corner は「作り直した行の時刻が、削除の時刻と*ぴったり*同じ」
    // 場合だけである。普通の削除は現在時刻を刻むので、アプリがその値を狙って
    // 書かないかぎり起きない。
    if (!isLaterTimestamp(localDb, claim.deletedAt, rowTimestamp)) continue

    // 消すと DELETE トリガが走り、`_tombstone` と `_changelog` にも載る。
    // それが他端末へ渡るので、食い違いはこの1回で閉じる
    localDb
      .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .run(entry.recordId)
    dropped += 1
    result.warnings.push(
      `Dropped local ${tableConfig.name}:${entry.recordId} written at ${rowTimestamp}: ` +
        `${tableConfig.name}:${entry.recordId} was deleted at ${claim.deletedAt}, which is newer. ` +
        `a newer deletion of the same row is already recorded, so the row would never ` +
        `reach other clients. Write ${timestampColumnFor(tableConfig.name)} as the current time.`
    )
  }

  // 見直した位置は、**消したことで増えたエントリより手前**で止める。
  // 消す前の最後のidまでを「見た」とすることで、自分が足した DELETE を
  // 次回また読み直さずに済む（DELETE は上で読み飛ばすので害は無いが、
  // 位置が進まないと保持期間ぶんを毎回なめ直すことになる）。
  writeSelfCheckCursor(localDb, entries[entries.length - 1].id)
  return dropped
}

/**
 * 畳まれて死んだ id へ、アプリがローカルで書き直した行を消す。
 *
 * 畳みの敗者idは**全端末で永久に死んでいる**。その id へアプリが後から書くと、
 * 受け取る側は {@link isShadowedByTombstone} が（同時刻も含めて）採らないので、
 * **書いた端末だけがその行を持ち続けて永久に食い違う**。実測（3端末）: `tags:g3` が
 * `g1` へ畳まれたあと、同じ端末が `g3` を同じ時刻で作り直し、その端末にだけ残った
 * （警告も例外も出ない）。
 *
 * **`_tombstone` の `mergedInto` だけを根拠にしてはいけない。** 畳みの向きが覆った
 * 端末では、復活した勝者行の tombstone を意図的に残してある（消すと、その id の
 * DELETE エントリが現在時刻を削除時刻として名乗り、他端末の生きた行を消す）。
 * 字面どおりに消すと、その勝者行を毎回消すことになる。
 *
 * 根拠にするのは**ローカル索引 `_id_merge` の、いま効いている記録**である。向きが
 * 覆ると `recordMerge` が逆向きの記録へ張り替え、自分自身を指す記録を捨てるので、
 * **復活した勝者の id はここに載っていない**。載っているのは「この id は今も死んで
 * いる」という意味だけになる。
 *
 * 時刻は取り込み側と同じ物差しで見る（同時刻は畳みが勝つ）。行がその畳みより
 * **厳密に新しい**なら、その畳みはもう古い判断（{@link isFoldRecordStale} と同じ）で、
 * 受け取る側も採るので消さない。
 *
 * 消したあとに畳みの主張を置き直すのが要点である。DELETEトリガは `INSERT OR REPLACE`
 * で**畳み先を持たない**行を書くので、そのままにすると「g3 はただ消された」と公開して
 * しまい、まだ畳みを知らない端末が g3 の子を `ON DELETE` で道連れにする。
 *
 * @returns 消したか
 * @internal
 */
function dropLocalWriteToFold(
  localDb: Database.Database,
  tableName: string,
  recordId: string,
  escapedTable: string,
  escapedPk: string,
  rowTimestamp: string,
  timestampColumn: string,
  result: SyncResult
): boolean {
  const merge = lookupIdMerge(localDb, tableName, recordId)
  // 記録が無い／自分自身を指す ＝ この id はもう敗者ではない（向きが覆った）
  if (merge === null || merge.winningId === recordId) return false
  // 行の方が厳密に新しいなら、その畳みは古い判断。取り込み側も採るので消さない
  if (isLaterTimestamp(localDb, rowTimestamp, merge.mergedAt)) return false

  localDb
    .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
    .run(recordId)

  // DELETEトリガが書いた「畳み先の無い削除」を、畳みの主張へ戻す。
  // 直前に自分で起こした削除なので、古い記録との比較で断られないよう
  // `replacesOwnDeletion` で置く（`foldRowInto` が畳んだ直後に行うのと同じ）。
  recordMerge(
    localDb,
    tableName,
    recordId,
    merge.winningId,
    merge.mergedAt,
    true
  )

  result.warnings.push(
    `Dropped local ${tableName}:${recordId} written at ${rowTimestamp}: ` +
      `${tableName}:${recordId} was merged into ${merge.winningId} at ${merge.mergedAt}, ` +
      `so that id is permanently dead on every client and the row would never reach ` +
      `them. Write to ${merge.winningId} instead, or write ${timestampColumn} as the ` +
      `current time.`
  )
  return true
}
