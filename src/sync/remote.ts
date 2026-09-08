/**
 * 取り込み元（リモート）のDBを読む。
 *
 * リモートは**別のバージョンのライブラリで書かれている**ことがあるので、この層は
 * 「その列はあるか」「その表はあるか」を確かめてから読む。無ければ「分からない」と
 * 答えるだけで、例外にしない —— 1つの相手の形が違うだけで同期全体を止めないため。
 *
 * @module sync/remote
 * @internal
 */
import Database from 'better-sqlite3'
import { TableConfig } from '../types'
import { isLaterTimestamp } from '../conflict'
import type { ResurrectionProbe, TimestampColumnFor } from '../conflict'
import { foldIdentifier, isSameIdentifier } from '../conflict/schema'
import { ColumnInfo, escapeIdentifier, getTableColumns } from './sql'

/**
 * DBの `_tombstone` が `mergedInto` 列を持つか。
 *
 * v0.14.0以前のクライアントのDBには無いため、読む前に確認する
 * （テーブルの有無を `sqlite_master` で見るのと同じ形の後方互換チェック）。
 * @internal
 */
export function hasMergedIntoColumn(db: Database.Database): boolean {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get()
  if (!exists) return false
  const columns = db
    .prepare(`PRAGMA table_info(_tombstone)`)
    .all() as ColumnInfo[]
  return columns.some((column) => isSameIdentifier(column.name, 'mergedInto'))
}

/**
 * リモートDBの `_tombstone` から指定レコードの削除時刻と畳み先を取得する。
 * `_tombstone` を持たない（旧バージョン由来の）クライアントでは null。
 * @internal
 */
export function getRemoteTombstone(
  remoteDb: Database.Database,
  tableName: string,
  recordId: string
): { deletedAt: string; mergedInto: string | null } | null {
  const exists = remoteDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get()
  if (!exists) return null

  // v0.14.0以前のクライアントには `mergedInto` 列が無い。その場合は「畳み先は無い」
  // と読む（式として `NULL` を置く。`AS` は付けない —— 下では列名ではなく式として使う）
  const mergedIntoColumn = hasMergedIntoColumn(remoteDb) ? 'mergedInto' : 'NULL'
  // 取り込み元の `_tombstone` も、表名の綴り違いで2行ありうる（主キーは BINARY）。
  // **1行を選ばず合成する** —— 削除時刻は最も新しいものを、畳み先は主張されている
  // 中でいちばん新しいものを採る。「新しい方の行」を丸ごと採ると、ローカルの
  // DELETEトリガが `INSERT OR REPLACE` で書いた**畳み先の無い行**が勝ってしまい、
  // 受け取った側が畳まずに DELETE して子を道連れにする（`readTombstoneClaim` と同じ）。
  const row = remoteDb
    .prepare(
      `SELECT
         (SELECT deletedAt FROM _tombstone
           WHERE tableName = ? COLLATE NOCASE AND recordId = ?
           ORDER BY julianday(deletedAt) DESC, deletedAt DESC
           LIMIT 1) AS deletedAt,
         (SELECT ${mergedIntoColumn} FROM _tombstone
           WHERE tableName = ? COLLATE NOCASE AND recordId = ?
             AND ${mergedIntoColumn} IS NOT NULL
           ORDER BY julianday(deletedAt) DESC, deletedAt DESC
           LIMIT 1) AS mergedInto`
    )
    .get(tableName, recordId, tableName, recordId) as {
    deletedAt: string | null
    mergedInto: string | null
  }
  if (row.deletedAt === null) return null

  return {
    deletedAt: String(row.deletedAt),
    mergedInto: row.mergedInto === null ? null : String(row.mergedInto),
  }
}

/**
 * tombstone の `mergedInto` を「畳み先」として使える値に正規化する。
 *
 * 自分自身を指す値は畳みではない（畳む向きが反転したときの後始末で生まれうる）。
 * @internal
 */
export function resolveFoldTarget(
  recordId: string,
  mergedInto: string | null | undefined
): string | null {
  if (mergedInto === null || mergedInto === undefined) return null
  return mergedInto === recordId ? null : mergedInto
}

/**
 * リモートDBから畳み先の行を読む。リモートにも無ければ undefined。
 * @internal
 */
export function readRemoteRecord(
  remoteDb: Database.Database,
  tableName: string,
  primaryKey: string,
  recordId: string
): Record<string, unknown> | undefined {
  try {
    return remoteDb
      .prepare(
        `SELECT * FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(primaryKey)} = ?`
      )
      .get(recordId) as Record<string, unknown> | undefined
  } catch {
    // リモートに当該テーブルが無い（スキーマ違い）場合は読めないものとして扱う
    return undefined
  }
}

/**
 * 表の名前から `TableConfig` を引く索引を作る。**大小は畳む。**
 *
 * `_changelog` / `_tombstone` のエントリが名乗る表名は**相手の設定どおりの綴り**である
 * （相手のトリガが自分の設定を `'${table}'` として埋め込む）。素の `Map` で引くと、
 * 相手が `Users`・こちらが `users` というだけで**全エントリが素通りし**、しかも
 * `_sync_state` のカーソルは進むので、その変更は二度と提供されない（`clientsSynced` は
 * 成功として報告される）。このライブラリは他のあらゆる場所で表名の大小を畳んでいる
 * （`readTombstoneClaim` / `lookupIdMerge` / `hasChangelogDelete` /
 * `findReferencingForeignKeys`）ので、ここだけ字面で引いてはいけない。
 * @internal
 */
export function makeTableConfigLookup(
  tables: TableConfig[]
): (tableName: string) => TableConfig | undefined {
  const byName = new Map<string, TableConfig>()
  for (const tableConfig of tables) {
    byName.set(foldIdentifier(tableConfig.name), tableConfig)
  }
  return (tableName) => byName.get(foldIdentifier(tableName))
}

/**
 * 表の名前から、その表の時刻列を答える手続きを作る。
 *
 * **時刻列は表ごとに違う**（`TableConfig.timestampColumn`）。子の設定を親の表に
 * 当てると列が見つからず、その先の判断が黙って既定値へ落ちるため、表をまたいで
 * 時刻を読む場面ではここから引く。設定に無い表（内部テーブルなど）は既定の
 * `updatedAt`。
 * @internal
 */
export function makeTimestampColumnFor(
  tables: TableConfig[]
): TimestampColumnFor {
  const byName = new Map<string, string>()
  for (const tableConfig of tables) {
    byName.set(
      foldIdentifier(tableConfig.name),
      tableConfig.timestampColumn ?? 'updatedAt'
    )
  }
  return (tableName) => byName.get(foldIdentifier(tableName)) ?? 'updatedAt'
}

/**
 * 「その行は取り込み元に現存するか」を答える手続きを作る。
 *
 * `_tombstone` は「いつか消された」の記録であって「今も消えている」ではない。
 * 消したあとに作り直された行は取り込み元に現存するので、それを見て
 * 「消えていない」と扱う（{@link applyTombstoneDelete} が tombstone を無視するのと
 * 同じ物差し）。これが無いと、**同じ取り込みの中で親が作り直されるのに、先に届いた
 * 子だけが `ON DELETE` に従って捨てられる**（順番だけで結果が変わる）。
 *
 * **聞かれる表は、呼び出し元の表とは限らない**（子の取り込みから親の表を聞かれる）。
 * 時刻列は表ごとに違いうるので、`timestampColumnFor` でその表の設定を引く。
 * 子の列名で親を引くと列が見つからず、作り直された親を**認識できないまま子を捨てる**。
 *
 * 取り込み1回につき1つ作れば足りる（表ごとの `prepare` を中で使い回す）。
 * @internal
 */
export function makeResurrectionProbe(
  remoteDb: Database.Database,
  primaryKey: string,
  timestampColumnFor: TimestampColumnFor
): ResurrectionProbe {
  const escapedPk = escapeIdentifier(primaryKey)
  // 表ごとの `SELECT`。レコードごとに `prepare` し直さない（null は「引けない表」）
  const statements = new Map<string, Database.Statement | null>()

  const statementFor = (tableName: string): Database.Statement | null => {
    const cached = statements.get(tableName)
    if (cached !== undefined) return cached

    let statement: Database.Statement | null = null
    try {
      // 列名の比較は大小を畳む（取り込み元の綴りと設定の綴りが揃うとは限らない）。
      // 取り逃がすと「作り直された親」を認識できず、届いた子を捨ててしまう
      const columns = getTableColumns(remoteDb, tableName)
      const preferred = timestampColumnFor(tableName)
      const match = (name: string): string | undefined =>
        columns.find((candidate) => isSameIdentifier(candidate, name))
      const column = match(preferred) ?? match('updatedAt') ?? null
      if (column !== null) {
        statement = remoteDb.prepare(
          `SELECT ${escapeIdentifier(column)} AS ts
           FROM ${escapeIdentifier(tableName)} WHERE ${escapedPk} = ?`
        )
      }
    } catch {
      // 取り込み元にその表が無い（スキーマ違い）なら、作り直しの証拠も無い
      statement = null
    }
    statements.set(tableName, statement)
    return statement
  }

  return (tableName, recordId, deletedAt) => {
    const statement = statementFor(tableName)
    if (statement === null) return false

    try {
      // **「行がある」だけでは作り直しの証拠にならない。** 削除をまだ受け取っていない
      // 相手はその行を持ったままなので、存在だけで判断すると「生きている」と誤って
      // 答え、消えた親を指す子をそのまま入れて外部キー違反を起こす（＝その相手ぶんの
      // 取り込みが丸ごと巻き戻り、同期がその相手から永久に止まる）。
      // 削除より**厳密に新しい**行だけを作り直しとみなす。
      const row = statement.get(recordId) as { ts: unknown } | undefined
      if (!row) return false

      return isLaterTimestamp(remoteDb, String(row.ts ?? ''), deletedAt)
    } catch {
      return false
    }
  }
}

/** @internal tombstone エントリの型 */
export interface TombstoneEntry {
  tableName: string
  recordId: string
  deletedAt: string
  /** 畳み先のid。普通の削除では null（v0.14.0以前のクライアントでも null） */
  mergedInto: string | null
}
