/**
 * 既に畳まれて消えた行を指す外部キーを、吸収先へ向け直す。
 *
 * @module conflict/remap
 * @internal
 */
import Database from 'better-sqlite3'
import {
  areColumnsNullable,
  escapeIdentifier,
  evaluateColumnDefaults,
  ForeignKeyRef,
  foreignKeysEnforced,
  hasTable,
  includesPrimaryKeyColumn,
  isSameIdentifier,
  readColumn,
  readForeignKeys,
} from './schema'
import { hasIdMerges, isFoldRecordStale, lookupIdMerge } from './ledger'
import { isKnownDeleted, ResurrectionProbe } from './tombstone'
import { TimestampColumnFor } from './timestamp'

/**
 * {@link remapMergedForeignKeys} の結果。
 * @internal
 */
export interface RemapOutcome {
  /**
   * 採るべき行（読み替え済み）。**読み替え先が消えていて採らないと決めた場合は null**
   * （{@link remapMergedForeignKeys} の「読み替え先が消えているとき」を参照）。
   */
  record: Record<string, unknown> | null
  /** 見送った・列をNULLにした、と利用者へ伝える文言（`SyncResult.warnings` へ出る） */
  warnings: string[]
}

/**
 * その外部キーが、SQLite にとって**そもそも検査されない**形か。
 *
 * 子の列がどこか1列でも NULL なら、SQLite はその参照を満たされたものとして扱う
 * （複合外部キーの NULL 規則。UNIQUE が NULL 同士を衝突させないのと同じ考え方）。
 * 検査されない参照には `ON DELETE` の動作も及ばないので、親が消えていても
 * その子には何も起きない。
 * @internal
 */
export function isForeignKeyUnchecked(
  foreignKey: ForeignKeyRef,
  record: Record<string, unknown>
): boolean {
  return foreignKey.columns.some((column) => {
    const value = record[column.childColumn]
    return value === null || value === undefined
  })
}

/**
 * その外部キーが指している親の行が、ローカルに在るか。
 *
 * 複合外部キーは**全列そろって**1行を指すので、全列で引く。
 *
 * **NULL を含む参照には使わないこと** — `列 = NULL` は真にならないので必ず
 * 「居ない」と答える。SQLite はその参照をそもそも検査しないので、聞く前に
 * {@link isForeignKeyUnchecked} で振り分ける。
 * @internal
 */
export function parentRowExists(
  db: Database.Database,
  foreignKey: ForeignKeyRef,
  record: Record<string, unknown>
): boolean {
  if (!hasTable(db, foreignKey.parentTable)) return false

  const matchClause = foreignKey.columns
    .map((column) => `${escapeIdentifier(column.parentColumn)} = ?`)
    .join(' AND ')
  const values = foreignKey.columns.map((column) => record[column.childColumn])
  return (
    db
      .prepare(
        `SELECT 1 FROM ${escapeIdentifier(foreignKey.parentTable)} WHERE ${matchClause}`
      )
      .get(...values) !== undefined
  )
}

/**
 * レコードの外部キーのうち、既に畳まれて消えた行を指しているものを、吸収先へ向け直す。
 *
 * 自分が勝った側（`local_wins`）のクライアントには敗者行が入らないため、あとから届く
 * 相手の子は存在しない親を指す。向け直さないと外部キー違反でその相手ぶんの取り込みが
 * 丸ごと巻き戻り、同期がその相手から永久に止まる。
 *
 * 親の主キー以外を指す外部キー（`REFERENCES parent(uniqueColumn)` の形）は対象外。
 * `_id_merge` が覚えているのは主キーの対応だけであり、また衝突したユニーク列の値は
 * 敗者と勝者で同一なので、その列を指す参照は向け直す必要が無い。
 *
 * **記録は永久の真理ではない。** 畳みの記録も行と同じLWWの下に置く:
 *
 * - **読み替えるのは、記録が敗者行より新しいときだけ**（{@link isFoldRecordStale}）。
 *   敗者行がその後もっと新しく更新されていれば、畳みはもう古い判断である
 * - **読み替えても、この行の時刻には触らない。** 書き換わるのは外部キーの列だけで、
 *   他の列は元の書き手のものだから、行全体で畳みの時刻を名乗ると外部キー以外の列に
 *   ついて過大に申告することになる（詳しくは関数末尾のコメント）
 *
 * **読み替え先が消えているとき**は、`ON DELETE` の宣言に従う（原則は「手元に居たら
 * 何が起きていたかを、そのまま再現する」）:
 *
 * | `onDelete` | 扱い |
 * | --- | --- |
 * | `CASCADE` | その子を採らない |
 * | `SET NULL`（対象列がすべて nullable） | **その外部キーの全列**を null にして採る |
 * | `SET NULL`（NOT NULL 列を含む） | 採らずに警告（実質 `RESTRICT`） |
 * | `SET DEFAULT`（既定値の親が居る／既定値にNULLを含む） | **全列**を既定値にして採る |
 * | `SET DEFAULT`（既定値の親が居ない） | 採らずに警告（SQLiteでは削除自体が失敗する形） |
 * | `RESTRICT` / `NO ACTION` | 採らずに警告 |
 *
 * null にするのは**その外部キーの全列**で、読み替えの対象（主キーを指す列だけ）とは
 * 範囲が違う。SQLite 自身がそうするからで、一部だけ null にすると残った列が孤児を
 * 指し続ける。
 *
 * 見るのは**読み替えの対象になった参照だけ**、しかも**消えたと分かっている**
 * （`_tombstone` に載っている）場合だけ。単に「まだ届いていない親」を指す子は
 * 今までどおりそのまま採る。子の列がどこか1列でも NULL の参照は、SQLite が
 * そもそも検査しないので触らない（{@link isForeignKeyUnchecked}）。
 *
 * **採らないと決めた行は戻ってこない。** 呼び出し元は `skipped` を返し、
 * changelog のカーソルはそのまま進むので、あとで親が復活しても同じ行は
 * もう届かない（`SyncResult.warnings` に残る文言だけが手掛かりになる）。
 * 素の `REFERENCES parent(id)` は `NO ACTION` として報告されるため、
 * これが**既定の経路**である点に注意（`CASCADE` を宣言していなくても捨てられる）。
 *
 * @param timestampColumn - この行（子）の時刻列
 * @param timestampColumnFor - 表ごとの時刻列を答える手続き。**親の記録がまだ有効かを
 *   見るときは親の表の列で引く**ため。渡されなければ `timestampColumn` を使う
 * @internal
 */
export function remapMergedForeignKeys(
  db: Database.Database,
  tableName: string,
  primaryKey: string,
  record: Record<string, unknown>,
  timestampColumn: string,
  isResurrected?: ResurrectionProbe,
  timestampColumnFor?: TimestampColumnFor
): RemapOutcome {
  // 畳みが一度も起きていないDB（大多数）はここで打ち切る。
  // 外部キーの走査も、親の存在確認も、`_tombstone` 参照も一切増えない。
  if (!hasIdMerges(db)) return { record, warnings: [] }

  const warnings: string[] = []
  const recordId = String(readColumn(record, primaryKey))
  let remapped: Record<string, unknown> | null = null
  // 「読み替え先が消えていた」外部キーの後始末。**全部の外部キーを見終えてから**行う。
  // 1つの表が `CASCADE` の親と `SET NULL` の親を両方持つとき、途中で結論を出すと
  // 外部キーを見る順番（`PRAGMA foreign_key_list` の順）で結果が変わってしまう
  // （先に null にしてから採らないと決める、など）。採らないと決めた相手が1人でも
  // 居れば採らない、が順番によらない答え。
  const dropReasons: string[] = []
  const nullOutColumns: string[] = []
  const setDefaultColumns: { column: string; value: unknown }[] = []
  const nullOutWarnings: string[] = []

  for (const foreignKey of readForeignKeys(db, tableName, primaryKey)) {
    let repointedTo: string | null = null

    for (const { childColumn, parentColumn } of foreignKey.columns) {
      // **列名の比較は大小を畳む。** `PRAGMA foreign_key_list` は `REFERENCES` 句に
      // 書かれたとおりの綴りを返すので、`REFERENCES users(ID)` と設定の `id` は
      // 字面では一致しない。素の比較にすると読み替えが**一度も走らず**、畳まれた親を
      // 指す子がそのまま入って外部キー違反になる（その相手ぶんの取り込みが巻き戻る）。
      // 暗黙の `REFERENCES users` は `readForeignKeys` が主キー名で埋めるので無事だが、
      // 親の列を明示した宣言だけが落ちる、という見つけにくい形になる。
      if (!isSameIdentifier(parentColumn, primaryKey)) continue
      const current = record[childColumn]
      if (current === null || current === undefined) continue

      const merge = lookupIdMerge(db, foreignKey.parentTable, String(current))
      if (merge === null || merge.winningId === String(current)) continue
      if (
        isFoldRecordStale(
          db,
          foreignKey.parentTable,
          primaryKey,
          String(current),
          merge.mergedAt,
          // **見るのは親の表なので、親の時刻列で引く。** 子の列名を持ち込むと、
          // 表ごとに時刻列を変えている設定（`TableConfig.timestampColumn`）では
          // 列が見つからず、記録がいつも「まだ有効」に倒れる
          timestampColumnFor?.(foreignKey.parentTable) ?? timestampColumn
        )
      ) {
        continue
      }

      remapped = remapped ?? { ...record }
      remapped[childColumn] = merge.winningId
      repointedTo = merge.winningId
    }

    // 読み替えていない参照は、今までどおり触らない
    if (repointedTo === null || remapped === null) continue
    // 外部キーが効いていない接続では `ON DELETE` の動作も起きない。
    // 再現すべきものが無いのに子を捨てるのは、ただのデータ損失
    if (!foreignKeysEnforced(db)) continue
    // **子の列がどこか1列でも NULL なら、SQLite はその外部キーを検査しない**
    // （複合外部キーの NULL 規則。UNIQUE と同じ扱い）。検査されない＝親が居なくても
    // 何も起きないので、`ON DELETE` の動作も及ばない。ここを見落として全列を
    // `列 = ?` で引くと、`= NULL` が真にならないため「親が居ない」と判定され、
    // **SQLite ならそのまま通る行を捨てる**ことになる。
    if (isForeignKeyUnchecked(foreignKey, remapped)) continue
    if (parentRowExists(db, foreignKey, remapped)) continue
    if (
      !isKnownDeleted(db, foreignKey.parentTable, repointedTo, isResurrected)
    ) {
      continue
    }

    const gone = `parent ${foreignKey.parentTable}:${repointedTo} is gone`
    const childColumns = foreignKey.columns.map((column) => column.childColumn)

    if (
      (foreignKey.onDelete === 'SET NULL' ||
        foreignKey.onDelete === 'SET DEFAULT') &&
      includesPrimaryKeyColumn(db, tableName, childColumns)
    ) {
      // 外部キーが子の主キーを兼ねる1:1の形。SQLite は主キーでも書き換えるが、
      // このライブラリは行を主キーで同定しているので追随できない（理由は
      // {@link includesPrimaryKeyColumn}）。書き換えず、採らずに知らせる。
      dropReasons.push(
        `Dropped ${tableName}:${recordId}: ${gone} and ON DELETE ${foreignKey.onDelete} cannot apply (${childColumns.join(', ')} is part of the primary key)`
      )
      continue
    }

    if (foreignKey.onDelete === 'SET NULL') {
      if (areColumnsNullable(db, tableName, childColumns)) {
        // SQLite は複合外部キーの**全列**を null にする。一部だけでは
        // 残った列が孤児を指し続ける
        nullOutColumns.push(...childColumns)
        nullOutWarnings.push(
          `Kept ${tableName}:${recordId} with ${childColumns.join(', ')} set to NULL: ${gone} (ON DELETE SET NULL)`
        )
        continue
      }
      dropReasons.push(
        `Dropped ${tableName}:${recordId}: ${gone} and ON DELETE SET NULL cannot apply (${childColumns.join(', ')} is NOT NULL)`
      )
      continue
    }

    if (foreignKey.onDelete === 'SET DEFAULT') {
      // SQLite は**その外部キーの全列**を宣言された既定値にする（複合でも全列。実測）。
      // 既定値の宣言が無い列は NULL になるので、その場合は `SET NULL` と同じ形になる。
      const defaults = evaluateColumnDefaults(db, tableName, childColumns)
      if (defaults === null) {
        dropReasons.push(
          `Dropped ${tableName}:${recordId}: ${gone} and ON DELETE SET DEFAULT cannot apply (default for ${childColumns.join(', ')} is not evaluable)`
        )
        continue
      }

      const nullColumns = childColumns.filter(
        (_, index) => defaults[index] === null
      )
      // NULL を入れる列が NOT NULL なら、その既定値は入らない
      if (
        nullColumns.length > 0 &&
        !areColumnsNullable(db, tableName, nullColumns)
      ) {
        dropReasons.push(
          `Dropped ${tableName}:${recordId}: ${gone} and ON DELETE SET DEFAULT cannot apply (${nullColumns.join(', ')} is NOT NULL without a default)`
        )
        continue
      }

      // 既定値の組がどこか1列でも NULL なら、その参照は検査されない
      // （SQLiteのUNIQUEと同じで、NULLを含む外部キーは満たされたものとして扱われる）。
      // 全列が非NULLのときだけ、その既定値の親が本当に居るかを見る。
      const defaultRow = { ...remapped }
      childColumns.forEach((childColumn, index) => {
        defaultRow[childColumn] = defaults[index]
      })
      if (
        nullColumns.length === 0 &&
        !parentRowExists(db, foreignKey, defaultRow)
      ) {
        // SQLite ではこの形は削除そのものが外部キー違反で失敗する（実測）。
        // 「その削除は起きなかった」を再現する術は無いので、採らずに知らせる
        dropReasons.push(
          `Dropped ${tableName}:${recordId}: ${gone} and ON DELETE SET DEFAULT cannot apply (default parent ${foreignKey.parentTable} row is missing)`
        )
        continue
      }

      setDefaultColumns.push(
        ...childColumns.map((childColumn, index) => ({
          column: childColumn,
          value: defaults[index],
        }))
      )
      nullOutWarnings.push(
        `Kept ${tableName}:${recordId} with ${childColumns.join(', ')} set to its default: ${gone} (ON DELETE SET DEFAULT)`
      )
      continue
    }

    dropReasons.push(
      `Dropped ${tableName}:${recordId}: ${gone} (ON DELETE ${foreignKey.onDelete})`
    )
  }

  // 1人でも「採らない」が居れば採らない。null にする話はもう関係が無いので載せない
  if (dropReasons.length > 0) {
    warnings.push(...dropReasons)
    return { record: null, warnings }
  }

  if (
    remapped !== null &&
    (nullOutColumns.length > 0 || setDefaultColumns.length > 0)
  ) {
    for (const childColumn of nullOutColumns) remapped[childColumn] = null
    for (const { column, value } of setDefaultColumns) remapped[column] = value
    warnings.push(...nullOutWarnings)
  }

  if (remapped === null) return { record, warnings }

  // **読み替えても、行の時刻には触らない。**
  //
  // 書き換わるのは外部キーの列だけで、他の列は元の書き手のものだから、行全体で
  // 畳みの時刻を名乗ると**外部キー以外の列について過大に申告**することになる。
  // その分だけ「元の時刻〜畳みの時刻」の窓に入る**他端末の本物の編集を殺す**。
  // 実測では編集が消えたうえ、同じ時刻で内容が割れて永久に食い違った。
  //
  // 名乗れば解ける膠着（同じ子を両端末が別々の親へ繋いだまま同じ時刻で持ち合う形。
  // `docs/child-fold-not-revoked.md`）はあるが、**書かれたデータを消してまで
  // 解くものではない**。ライブラリはそれを解かず、代わりに {@link describeStalemate}
  // で**報告する**（消えた編集は取り戻せないが、食い違いは知らせれば人が直せる）。
  return { record: remapped, warnings }
}
