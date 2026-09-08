/**
 * リモートの INSERT をローカルDBへ適用する。
 *
 * **INSERT が落ちる理由は2つあり、両方同時に成り立つ** —— 同じ主キーの行が在ることと、
 * **別の行**が書こうとしているセカンダリユニークキーを既に持っていること。
 * したがって「同じ主キーの行が在るか」だけで分岐してはいけない（両方成り立つ入力が
 * 畳みの経路へ辿り着かなくなる）。分岐の根拠は**例外の種類**である。
 *
 * @module conflict/insert
 */
import Database from 'better-sqlite3'
import { ConflictInfo, RecordFold } from '../types'
import { escapeIdentifier, readColumn } from './schema'
import {
  isLaterTimestamp,
  isSameTimestamp,
  TimestampColumnFor,
} from './timestamp'
import { describeStalemate } from './stalemate'
import {
  findUniqueRivals,
  outranksAllRivals,
  readSecondaryUniqueKeys,
  selectSurvivingRival,
} from './unique'
import { recordFold } from './ledger'
import { isShadowedByTombstone, ResurrectionProbe } from './tombstone'
import { recordMergeWithoutLocalRow } from './fold-changelog'
import { remapMergedForeignKeys } from './remap'
import { foldAndReplace } from './fold'
import { overwriteExistingRow } from './overwrite'

/**
 * {@link applyInsert} の返り値。
 */
export interface ApplyInsertResult {
  action: 'inserted' | 'upserted' | 'skipped'
  conflict?: ConflictInfo
  /** 別id・同一ユニークキーの行を1つへ畳んだ記録（畳んでいなければ空） */
  folds: RecordFold[]
  /**
   * 利用者へ伝えるべきこと（`SyncResult.warnings` へ出る）。
   *
   * いま載るのは「読み替え先の親が消えていたので `ON DELETE` に従った」だけ
   * （行を採らなかった／外部キーの列を NULL にした）。**黙って捨てない**ための口。
   */
  warnings: string[]
}

/**
 * リモートのINSERT操作をローカルDBに適用する。
 *
 * 通常のINSERTを試み、UNIQUE制約違反（PK重複やユニークカラム重複）が
 * 発生した場合はLWW（Last-Write-Wins）でUPSERTにフォールバックする。
 * ローカル `_tombstone` により、より新しい削除が記録済みのレコードは
 * 再挿入せずスキップする（決定論的LWW）。
 *
 * 別PK・同一ユニークキーの行を畳む際は、敗者行を指している子を勝者行へ付け替えてから
 * 敗者を削除する（先に削除するとカスケードで子が道連れになる）。また、既に畳まれて
 * 消えた行を指す外部キーは、挿入前に吸収先へ向け直す。
 *
 * **INSERTが落ちる理由は2つあり、両方同時に成り立つ。** 同じ主キーの行が在ることと、
 * **別の行**が書こうとしているセカンダリユニークキーを既に持っていること。
 * したがって「同じ主キーの行が在るか」だけで分岐してはいけない — 両方成り立つ入力が
 * 畳みの経路へ辿り着かなくなる。同一PKへの上書きは内部の共通経路
 * （`overwriteExistingRow`）に任せ、そこで落ちたぶんも畳む。
 *
 * @param localDb - ローカルSQLiteデータベース接続
 * @param tableName - 対象テーブル名
 * @param primaryKey - 主キーカラム名
 * @param remoteRecord - 挿入するリモートレコード
 * @param columns - テーブルのカラム名配列
 * @returns 実行されたアクション（`inserted` / `upserted` / `skipped`）と競合情報、
 *   畳んだ記録（{@link RecordFold}）、および利用者へ伝える文言（`warnings`）
 * @throws UNIQUE制約以外のSQLiteエラー
 */
export function applyInsert(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  remoteRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string = 'updatedAt',
  isResurrected?: ResurrectionProbe,
  timestampColumnFor?: TimestampColumnFor
): ApplyInsertResult {
  const escapedTable = escapeIdentifier(tableName)
  const escapedColumns = columns.map((c) => escapeIdentifier(c))
  const placeholders = columns.map(() => '?').join(', ')
  const folds: RecordFold[] = []

  // より新しい削除(tombstone)が記録済みのスロットには再挿入しない（決定論的LWW: 削除が勝つ）
  if (
    isShadowedByTombstone(
      localDb,
      tableName,
      String(readColumn(remoteRecord, primaryKey)),
      String(readColumn(remoteRecord, timestampColumn) ?? '')
    )
  ) {
    return { action: 'skipped', folds, warnings: [] }
  }

  // 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す。
  // 向け直した先が消えていれば、その外部キーの `ON DELETE` に従う（採らないこともある）。
  const remap = remapMergedForeignKeys(
    localDb,
    tableName,
    primaryKey,
    remoteRecord,
    timestampColumn,
    isResurrected,
    timestampColumnFor
  )
  const warnings = remap.warnings
  if (remap.record === null) {
    return { action: 'skipped', folds, warnings }
  }

  const record = remap.record
  const values = columns.map((c) => record[c])

  try {
    localDb
      .prepare(
        `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`
      )
      .run(...values)
    return { action: 'inserted', folds, warnings }
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string }
    if (
      sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      const escapedPk = escapeIdentifier(primaryKey)
      const pkValue = readColumn(record, primaryKey)
      const remoteUpdatedAt = String(readColumn(record, timestampColumn) ?? '')

      // ケース1: 同一PKの行が存在する（PK重複）→ LWWで上書き。
      //
      // **INSERTが落ちた理由がこれだけとは限らない。** 同一PKの行が在るのと同時に、
      // 別の行が書こうとしているセカンダリユニークキーを既に持っていることがあり、
      // その場合ここでの上書きも同じユニークで落ちる。上書きは
      // {@link overwriteExistingRow} に任せ、落ちたら畳む（ケース2と同じ扱い）。
      // ここに素の UPDATE を書くと、それは既に catch の中なので、例外が
      // `applyInsert` の外まで抜けて取り込みが丸ごと巻き戻る。
      const localRecord = localDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(pkValue) as Record<string, unknown> | undefined

      if (localRecord) {
        const localUpdatedAt = String(
          readColumn(localRecord, timestampColumn) ?? ''
        )
        // 同時刻かどうかは膠着の報告と競合の有無の**両方**が見る。`julianday` の
        // 問い合わせを1レコードにつき二度投げないよう、一度だけ引く
        const sameTimestamp = isSameTimestamp(
          localDb,
          remoteUpdatedAt,
          localUpdatedAt
        )
        const conflictOf = (
          resolution: 'remote_wins' | 'local_wins'
        ): ConflictInfo => ({
          table: tableName,
          recordId: String(pkValue),
          localUpdatedAt,
          remoteUpdatedAt,
          resolution,
        })

        if (isLaterTimestamp(localDb, remoteUpdatedAt, localUpdatedAt)) {
          const outcome = overwriteExistingRow(
            localDb,
            tableName,
            primaryKey,
            record,
            localRecord,
            columns,
            timestampColumn
          )
          return {
            // 届いた行を採らなかった場合は `upserted` と言ってはいけない。
            // 上書きに負けた側では**リモートの行は捨てられ、ローカルのPK行が
            // 畳まれて消えている**だけなので、`action` だけを見る呼び出し元が
            // 「リモートを適用した」と読むと数え方がずれる（`processChangelogEntries`
            // は `upserted` を `conflictsResolved` に、`skipped` を `skipped` に数える）。
            // 同じ結果を `applyUpdate` は `skipped` と呼ぶので、そちらへ揃える。
            action:
              outcome.resolution === 'remote_wins' ? 'upserted' : 'skipped',
            conflict: conflictOf(outcome.resolution),
            folds: outcome.folds,
            warnings,
          }
        }

        // 同じ時刻で中身が違うなら、どちらも勝てない。解けないので**報告する**。
        // 同時刻かどうかは字面ではなく時刻として見る（書式が違うだけの同時刻を
        // 取り逃がすと、膠着に気づけないまま黙って捨て合うことになる）
        if (sameTimestamp) {
          const stalemate = describeStalemate(
            tableName,
            String(pkValue),
            localUpdatedAt,
            record,
            localRecord,
            columns,
            timestampColumn
          )
          if (stalemate !== null) warnings.push(stalemate)
        }

        // ローカルの方が新しい ＝ **届いた行は書いていない**。`upserted` は
        // 「リモートの行を入れた」ときの名前なので、ここで名乗ってはいけない
        // （同じ結果を `applyUpdate` は `skipped` と呼ぶ）。
        //
        // **膠着は「ローカルが勝った」ではない。** どちらも勝てないのだから
        // `local_wins` の競合として報告すると、`Stalemate on …` と
        // `Conflict on …: local_wins` が並んで矛盾する。しかも同じ膠着が UPDATE の
        // エントリで届いた場合は `applyUpdate` が競合を返さないので、**同じ状態が
        // 届き方で違って見える**。競合は時刻に差があるときだけ返す。
        return {
          action: 'skipped',
          conflict: sameTimestamp ? undefined : conflictOf('local_wins'),
          folds,
          warnings,
        }
      }

      // ケース2: 別PK・同一ユニークキーの行が存在する（セカンダリUNIQUE違反）。
      // 各クライアントが独立に同じ論理エンティティの行を作成した場合に発生する。
      // ローカルの競合行を**索引から先に全部**引き、全員ぶんの勝敗を決めてから畳む。
      const rivalRows = findUniqueRivals(
        localDb,
        tableName,
        primaryKey,
        record,
        pkValue,
        readSecondaryUniqueKeys(localDb, tableName)
      )

      if (rivalRows.length === 0) {
        // 競合行を特定できない場合は黙って握りつぶさず呼び出し元に委ねる
        throw err
      }

      const survivingRival = selectSurvivingRival(
        localDb,
        rivalRows,
        timestampColumn,
        primaryKey
      )
      const localUpdatedAt = String(
        readColumn(survivingRival, timestampColumn) ?? ''
      )

      // 同時刻は主キーの辞書順で決める（{@link isPreferredOverRival}）。ここを
      // 「同点ならローカルが勝つ」にすると、相手側の {@link applyUpdate} が同じ2行を
      // 逆向きに畳み、生き残るidが毎周入れ替わって永久に収束しない。
      if (
        outranksAllRivals(
          localDb,
          record,
          rivalRows,
          timestampColumn,
          primaryKey
        )
      ) {
        // リモートが新しい → ローカルの競合行を全て勝者（リモート行）へ畳んで置き換える。
        // 敗者を指している子は勝者へ付け替えてから削除する。
        // DELETEトリガーが発火するため、敗者行の削除はchangelog/tombstone経由で
        // 他クライアントにも伝播し、全体が勝者行に収束する。
        foldAndReplace(
          localDb,
          tableName,
          primaryKey,
          rivalRows,
          record,
          columns,
          timestampColumn,
          folds
        )

        return {
          action: 'upserted',
          conflict: {
            table: tableName,
            recordId: String(pkValue),
            localUpdatedAt,
            remoteUpdatedAt,
            resolution: 'remote_wins',
          },
          folds,
          warnings,
        }
      }

      // ローカルが新しい → リモート行は採用しない。
      // ただし「リモートの敗者idはローカルのこの行に畳まれた」ことを記録し、
      // 他クライアントへも伝わるようにする（この側では敗者行のDELETEが起きないため、
      // tombstone と changelog を手で書く）。記録しないと、あとから届くリモート側の子が
      // 存在しない親を指したままになり、外部キー違反でその相手ぶんの取り込みが
      // 丸ごと巻き戻る（同期が止まる）。
      recordMergeWithoutLocalRow(
        localDb,
        tableName,
        String(pkValue),
        String(readColumn(survivingRival, primaryKey)),
        localUpdatedAt
      )

      // 敗者行はそもそもローカルに無いので、行は消えていない（数には出さない）。
      // それでも「2つが1つになった」ことは利用者へ伝える。
      recordFold(
        folds,
        tableName,
        String(pkValue),
        String(readColumn(survivingRival, primaryKey)),
        false,
        // 敗者行をローカルに持っていないので、付け替える子も失う子も居ない
        0,
        0
      )

      return {
        // 同一PKの経路と同じ理由で、ここでも `upserted` と名乗ってはいけない。
        // **届いたリモート行は書いていない**（勝ったのはローカルの競合行）。
        // `action` だけを見る呼び出し元が「リモートを適用した」と読むとずれる。
        // 行が1つに畳まれたことは `folds` が伝える（`processChangelogEntries` は
        // `folds` を `conflictsResolved` に数える）。
        action: 'skipped',
        conflict: {
          table: tableName,
          recordId: String(readColumn(survivingRival, primaryKey)),
          localUpdatedAt,
          remoteUpdatedAt,
          resolution: 'local_wins',
        },
        folds,
        warnings,
      }
    }

    throw err
  }
}
