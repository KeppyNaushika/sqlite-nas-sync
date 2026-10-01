/**
 * 旧方式（`_changelog` ＋ `_tombstone` ＋ `_id_merge`）の DB を、案A の形へ移す。
 * 設計書 `docs/rows-table-design.md` §3.9。
 *
 * **1つのトランザクションで行う。** 途中で落ちたら何も起きなかったことになる。
 * 移行は「事実の作り直し」であって、半分だけ当たった形には意味が無い —— 版の
 * 3列が入った行と入っていない行が混ざると、順序が決まらないまま同期が始まる。
 *
 * ここでしている決めごと（設計書 §3.9 と、実機で確かめた訂正）:
 *
 * | 何 | どうする | なぜ |
 * | --- | --- | --- |
 * | `_tombstone` / `_changelog` | **作り直す** | 列が違うので `CREATE TABLE IF NOT EXISTS` では追いつかない。旧 `deletedAt` の NOT NULL で最初の DELETE が落ちる |
 * | 旧「畳み」の事実 | **捨てる**（`_id_merge` は落とし、`mergedInto` / `revokedAt` は写さない） | 案A では重複は両方そのまま残るので、畳みの帳簿が要らない |
 * | `_sns_rows_<t>` へ写す版 | `_sns_ts` ＝ 時刻列の値、`_sns_lamport = 0`、`_sns_instance` ＝ 自分 | NULL にすると2端末の勝敗が**起動ごとに変わる乱数**で決まる |
 * | 残す `_tombstone` の版 | `_sns_ts` ＝ 旧 `deletedAt`（ISO 8601 の文字列のときだけ。それ以外と、時刻列の無い表では NULL） | 削除はその削除を実行した時刻で比べる（原則2）。旧 `deletedAt` がその時刻である |
 * | アプリの表に居る id の墓標 | **消す** | 残すと版の鍵が完全に一致し、種類の規則で削除が勝って、最初の作り直しでその行が消える |
 * | `_changelog` | **刈らない** | 旧版の端末が残っている間に刈ると、その端末へ渡すべき事実が消える |
 * | 旧方式の `_heartbeat` | **表とトリガーを落とす**（トリガーが先） | `_changelog` が空でも `_changelog_prune.prunedThroughId` で隙間は判る。残すと無変更の日にも転送が起き続ける |
 * | 旧方式の `_id_merge` | **落とす**（案A の形の DB でも毎回） | 旧「畳み」の帳簿で、案A では誰も読まない |
 * | `_sns_rows_<t>` の主キー以外のアプリの列の型名 | **あれば外す**（表を作り直して行をそのまま写す） | 型名を写すと、STRICT の表の `ANY` 列の値が NUMERIC 親和性で変わる（{@link dropRowsColumnTypes}） |
 * | 誰も読まない内部の列（{@link UNUSED_COLUMNS}） | **あれば落とす**（`_heartbeat` のトリガーを落としたあと） | `CREATE TABLE IF NOT EXISTS` では既存の DB から消えない。使わない列を利用者の DB に残さない |
 *
 * `_sns_rebuilding` の残りは、呼び出し側が `clearRebuildingFlag`（`src/rows/restore-detect.ts`）で先に消す（`setupSync` と同期の段階0）。
 * 残ったままトリガーを作ると、番人が効いてアプリの書き込みが版にならない。
 *
 * @module rows/migrate
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, foldIdentifier, NOW_SQL } from '../setup/sql'
import { ROWS_FORMAT, readSnsFormat } from './import'
import {
  SNS_META_KEYS,
  dropLegacyDeleteProtected,
  ensureSyncMetaTable,
  newInstanceId,
  readSnsMeta,
  writeSnsMeta,
} from './meta'
import {
  DEFAULT_TIMESTAMP_COLUMN,
  RowsColumn,
  RowsTableSpec,
  VERSION_COLUMNS,
  createRowsTables,
  primaryKeyColumn,
  quoteLiteral,
  rowsColumnsSql,
  rowsTableName,
  syncedColumns,
} from './schema'
import { canonicalTableSpecs } from './table-name'
import {
  createRowsTriggers,
  dropRowsTriggers,
  isIsoTimeSql,
  maxTsSql,
} from './triggers'
import { SqlValue } from './versions'

/** {@link migrateToRows} の設定。 */
interface RowsMigrationOptions {
  /** 同期する表（綴りは入り口で `sqlite_master` へ畳む。§1.11） */
  tables: (RowsTableSpec | string)[]
  /**
   * この端末の id。省略すると {@link newInstanceId} で作る
   * （`setupSync` のたびに作り直すのが正しい。§3.2）
   */
  instanceId?: string
  /**
   * `_sync_meta.schemaVersion` のアプリ側の部分。省略すると、いま書かれている
   * 値から `sns-format=` の欄だけを差し替える（§3.8）
   */
  appSchemaVersion?: string
}

/** 1つの表について、移行が何をしたか。 */
interface RowsMigrationTableReport {
  /** 畳んだ綴りの表名 */
  table: string
  /** `_sns_rows_<t>` へ入れた行数 */
  rows: number
  /** アプリの表に居たので写さなかった墓標の数 */
  droppedTombstones: number
  /** `_sns_rows_<t>` に足した列 */
  addedColumns: string[]
  /** `_sns_rows_<t>` から落とした列 */
  removedColumns: string[]
  /** 列の増減があって、全行を新しい版として書き直したか（§3.9 の E） */
  rewritten: boolean
}

/**
 * 移行の前の DB の形。
 *
 * - `legacy`: 以前のバージョンのライブラリの形（`_changelog` か `_tombstone` があり、案A の表が無い）
 * - `fresh`: 同期の表が何も無い新しい DB
 * - `refresh`: 既に案A の形だった（`sns-format` の印が消えていた DB を含む）
 */
type RowsMigrationSource = 'legacy' | 'fresh' | 'refresh'

/** {@link migrateToRows} の結果。 */
interface RowsMigrationResult {
  from: RowsMigrationSource
  /** この移行で使った端末の id */
  instanceId: string
  /** 表ごとの内訳 */
  tables: RowsMigrationTableReport[]
  /** 利用者へ知らせること */
  warnings: string[]
}

/**
 * この DB が旧方式のままか（`sns-format` が `rows1` でないか）。
 *
 * 形式の欄は `_sync_meta.schemaVersion` の `;sns-format=rows1`（§3.8）。
 */
export function needsRowsMigration(db: Database.Database): boolean {
  return readSnsFormat(db) !== ROWS_FORMAT
}

/**
 * 旧方式の DB を案A の形へ移す（設計書 §3.9）。**1つのトランザクション**。
 *
 * 既に案A の DB に対して呼んでもよい。その場合は `_tombstone` と `_changelog` を
 * 作り直さず、列の増減（§3.9 の D・E）と仕掛けの取り付けだけを行う。
 * 途中で落ちれば丸ごと戻るので、**COMMIT 後・NAS への写しの前に落ちても、
 * 次の `setupSync` は「既に案A」として通る**。
 */
export function migrateToRows(
  db: Database.Database,
  options: RowsMigrationOptions
): RowsMigrationResult {
  const instanceId = options.instanceId ?? newInstanceId()
  const fromLegacy = needsRowsMigration(db)
  // 表の名前は**入り口で1回だけ**畳む。畳まずに持ち回ると、綴りの違う2端末で
  // 版の鍵（`_tombstone.tableName` とトリガーの中の字面）が割れる
  const specs = canonicalTableSpecs(db, options.tables)

  const result: RowsMigrationResult = {
    from: migrationSource(db, fromLegacy),
    instanceId,
    tables: [],
    warnings: [],
  }

  // `PRAGMA recursive_triggers` は接続の設定であってスキーマではないので、
  // トランザクションの外で立てておく（`createRowsTriggers` も立てるが、
  // 途中で落ちたときに中途半端な設定を残さないため先に済ませる）
  db.pragma('recursive_triggers = ON')

  const run = db.transaction(() => {
    // 1. 旧方式のトリガーを落とす。残すと、旧 DELETE トリガーの
    //    `INSERT OR REPLACE INTO _tombstone` が版の3列を NULL で塗り潰す
    if (fromLegacy) {
      dropLegacyTriggers(db, specs)
    }

    // 2. `_tombstone` と `_changelog` を作り直す（§3.9 の F）
    if (fromLegacy) {
      const dropped = rebuildLedgers(db, specs, instanceId)
      for (const [table, count] of dropped) {
        droppedOf(result, table).droppedTombstones = count
      }
    }

    // 3. 旧「畳み」の帳簿を捨てる（§3.9 の2）。案A では重複はそのまま両方残る。
    //    案A の形の DB でも毎回落とすので、以後 `_id_merge` がアプリの表として拾われることは無い
    db.exec(`DROP TABLE IF EXISTS _id_merge`)

    // 3.5. 旧方式の `_heartbeat` を撤去する。`_changelog` が空でも
    //      `_changelog_prune.prunedThroughId` で隙間は正しく判定できるので、
    //      この仕掛けはもう要らない（`hasChangelogGap`）。残すと、無変更の日にも
    //      1件ぶんの転送が起き続ける。**表より先にトリガーを落とす** ——
    //      トリガーが残ったまま表だけ消すと、以後の `ALTER TABLE … RENAME` が
    //      読み直しで落ちる
    dropHeartbeat(db)

    // 3.6. 誰も読まない内部の列を落とす。**`_heartbeat` のトリガーより後** ——
    //      `DROP COLUMN` は DB の全トリガーを読み直すので、存在しない表を指す
    //      トリガーが残っていると `error in trigger …` で落ちる
    dropUnusedColumns(db)

    // 4. 案A の表を作る（`_sns_clock` の行・`_sns_tick` の行も）
    const existed = new Map<string, boolean>()
    for (const spec of specs) {
      existed.set(spec.name, tableExists(db, rowsTableName(spec.name)))
    }
    createRowsTables(db, specs, instanceId)

    // 5. 表ごとに、中身を入れる／列の増減へ追従する
    for (const spec of specs) {
      const report = droppedOf(result, spec.name)
      if (existed.get(spec.name) === true) {
        dropRowsColumnTypes(db, spec)
        const shape = reconcileColumns(db, spec, result)
        report.addedColumns = shape.added
        report.removedColumns = shape.removed
        if (shape.added.length > 0 || shape.removed.length > 0) {
          // §3.9 の D: その表のトリガー4本を落として作り直す
          dropRowsTriggers(db, [spec])
          // §3.9 の E: 全行を新しい版として書き直す
          report.rows = rewriteRowsWithNewVersions(db, spec, instanceId)
          report.rewritten = true
        } else {
          report.rows = countOf(
            db,
            `SELECT COUNT(*) AS n FROM ${escapeIdentifier(rowsTableName(spec.name))}`
          )
        }
      } else {
        report.rows = seedRowsTable(db, spec, instanceId)
      }
    }

    // 6. トリガーを作る（落としたものはここで戻る）
    createRowsTriggers(db, specs)

    // 7. `_sync_state` を空にし、`_sync_meta` の鍵を書き、全表を `_sns_dirty` へ
    if (tableExists(db, '_sync_state')) db.exec(`DELETE FROM _sync_state`)
    ensureSyncMetaTable(db)
    writeSnsMeta(db, SNS_META_KEYS.instanceId, instanceId)
    if (fromLegacy || readSnsMeta(db, SNS_META_KEYS.generation) === null) {
      writeSnsMeta(db, SNS_META_KEYS.generation, 0)
    }
    // 写しはまだ書いていない。`lastLamport = 0` は手元の lamport 以下なので
    // §3.10 の「巻き戻り」を誤検出しない。`lastInstance` を自分にしておくのも同じ理由
    if (fromLegacy || readSnsMeta(db, SNS_META_KEYS.lastLamport) === null) {
      writeSnsMeta(db, SNS_META_KEYS.lastLamport, 0)
      writeSnsMeta(db, SNS_META_KEYS.lastInstance, instanceId)
    }
    // 旧版が書いていた `sns.deleteProtected` は、もう誰も読まない。読まれない
    // 設定が `_sync_meta` に残るのは紛らわしいので、ここで消す
    dropLegacyDeleteProtected(db)
    writeRowsSchemaVersion(db, options.appSchemaVersion)
    for (const spec of specs) {
      db.prepare(
        `INSERT INTO _sns_dirty (tableName) VALUES (?)
         ON CONFLICT (tableName) DO NOTHING`
      ).run(spec.name)
    }
  })
  run()
  return result
}

/* ------------------------------------------------------------------ *
 * `_sync_meta.schemaVersion`（§3.8）
 * ------------------------------------------------------------------ */

/**
 * `schemaVersion` を `<アプリの版>;sns-format=rows1` にする（設計書 §3.8）。
 *
 * 既に書かれている値から `sns-format=` の欄だけを差し替える。丸ごと上書きすると、
 * アプリの指紋が消えて**形の違う相手を取り込んでしまう**。
 */
function writeRowsSchemaVersion(
  db: Database.Database,
  appSchemaVersion: string | undefined
): void {
  const current = readSnsMeta(db, 'schemaVersion')
  const base =
    appSchemaVersion ??
    (current ?? '')
      .split(';')
      .filter((field) => field.split('=')[0].trim() !== 'sns-format')
      .join(';')
  writeSnsMeta(db, 'schemaVersion', `${base};sns-format=${ROWS_FORMAT}`)
}

/* ------------------------------------------------------------------ *
 * 移行の前の形・旧トリガー
 * ------------------------------------------------------------------ */

/**
 * 移行の前の DB の形（{@link RowsMigrationSource}）。**トランザクションより前**に呼ぶ。
 *
 * 利用者への知らせの文面を分けるためだけに使い、移行の中身は変えない。
 * `sns-format` の印が無ければ、どの形でも `_tombstone` と `_changelog` を作り直す。
 */
function migrationSource(
  db: Database.Database,
  fromLegacy: boolean
): RowsMigrationSource {
  if (!fromLegacy || tableExists(db, '_sns_clock')) return 'refresh'
  if (tableExists(db, '_changelog') || tableExists(db, '_tombstone')) {
    return 'legacy'
  }
  return 'fresh'
}

/**
 * 旧方式のトリガーを落とす。
 *
 * **残すと版の3列が NULL で塗り潰される。** 旧 DELETE トリガーの
 * `INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)` は
 * 書かなかった列を NULL にするので、新しいトリガーが書いた `_sns_lamport` が
 * 消え、その削除の版が順序を持たなくなる。
 */
function dropLegacyTriggers(
  db: Database.Database,
  tables: RowsTableSpec[]
): void {
  for (const table of tables) {
    for (const kind of ['insert', 'update', 'delete']) {
      db.exec(
        `DROP TRIGGER IF EXISTS ${escapeIdentifier(
          `_changelog_after_${kind}_${table.name}`
        )}`
      )
    }
  }
}

/**
 * 旧版が作っていた `_heartbeat` の表とトリガーを落とす（冪等）。
 *
 * `_heartbeat` は「変更が1件も無い日でも `_changelog` に1件入れて、保持期間で
 * changelog が空になるのを防ぐ」ための仕掛けだった。`_changelog` が空でも
 * `_changelog_prune.prunedThroughId` で隙間は正しく判定できる（`hasChangelogGap`）
 * ので廃止した。
 *
 * **トリガーを先に落とす。** 表だけ消してトリガーを残すと、以後
 * `ALTER TABLE … RENAME TO` がすべてのトリガーを読み直すときに
 * `no such table: main._heartbeat` で落ちる。
 */
function dropHeartbeat(db: Database.Database): void {
  db.exec(`DROP TRIGGER IF EXISTS "_changelog_after_insert__heartbeat"`)
  db.exec(`DROP TRIGGER IF EXISTS "_changelog_after_update__heartbeat"`)
  db.exec(`DROP TABLE IF EXISTS "_heartbeat"`)
}

/**
 * 書かれるだけで誰も読まない内部の列（0.20.0 までの DB に残っている）。
 *
 * | 列 | なぜ要らないか |
 * | --- | --- |
 * | `_tombstone.mergedInto` | 旧方式の「畳み」の先。案A のトリガーは書かず、移行も写さないので値が入らない |
 * | `_tombstone.revokedAt` | 旧方式の「畳み」の取り消し。同上 |
 * | `_sns_unplaceable.reasonKind` | 読むのは `tableName`・`trueId`・`reason`・`causeTable`・`causeId` だけ |
 * | `_sns_unplaceable.noticedAt` | 「同じ警告を繰り返さない」は行の有無で決まり、時刻を使わない |
 * | `_changelog_prune.prunedAt` | 隙間の判定（`hasChangelogGap`）は `prunedThroughId` しか見ない |
 * | `_sync_state.lastSyncedAt` | 相手ごとの読み位置は `lastSeenId` だけで決まり、時刻を使わない |
 *
 * どの列も、ライブラリのトリガー・索引・ビューから参照されていない（参照があると
 * `DROP COLUMN` が落ちる）。
 */
const UNUSED_COLUMNS: readonly { table: string; column: string }[] = [
  { table: '_tombstone', column: 'mergedInto' },
  { table: '_tombstone', column: 'revokedAt' },
  { table: '_sns_unplaceable', column: 'reasonKind' },
  { table: '_sns_unplaceable', column: 'noticedAt' },
  { table: '_changelog_prune', column: 'prunedAt' },
  { table: '_sync_state', column: 'lastSyncedAt' },
]

/**
 * {@link UNUSED_COLUMNS} を、**列があるときだけ**落とす（冪等）。
 *
 * 表が無ければ `PRAGMA table_info` は空を返すので、何もしない。
 */
function dropUnusedColumns(db: Database.Database): void {
  for (const { table, column } of UNUSED_COLUMNS) {
    const columns = db.pragma(
      `table_info(${escapeIdentifier(table)})`
    ) as RowsColumn[]
    if (!columns.some((entry) => entry.name === column)) continue
    db.exec(
      `ALTER TABLE ${escapeIdentifier(table)} DROP COLUMN ${escapeIdentifier(column)}`
    )
  }
}

/* ------------------------------------------------------------------ *
 * `_tombstone` と `_changelog` の作り直し（§3.9 の F）
 * ------------------------------------------------------------------ */

/**
 * `_tombstone` と `_changelog` を、案A の形で作り直す。
 *
 * `_changelog` は **id をそのまま写す**。振り直すと、相手の `_sync_state` が
 * 指している位置と食い違い、旧版の端末が隙間ありに落ちる（§3.9 の G）。
 *
 * @returns 表 → アプリの表に同じ id があるので写さなかった墓標の数
 */
function rebuildLedgers(
  db: Database.Database,
  tables: RowsTableSpec[],
  instanceId: string
): Map<string, number> {
  // **`legacy_alter_table` を立てる。** 素の `ALTER TABLE … RENAME TO` は、
  // その DB の**すべてのトリガーを読み直して**参照を書き換える。旧方式の DB に
  // 残っている `_heartbeat` のトリガーは `_changelog` を指しているので、作り直しの途中
  // （古い `_changelog` を落としたあと）では読み直しが
  // `no such table: main._changelog` で落ちる。ここで名前を付け替える相手
  // （`_sns_…_new`）を指しているものは1つも無いので、書き換えは要らない
  const previousLegacy = db.pragma('legacy_alter_table', { simple: true })
  db.pragma('legacy_alter_table = ON')
  try {
    return rebuildLedgersInner(db, tables, instanceId)
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacy === 1 ? 'ON' : 'OFF'}`)
  }
}

function rebuildLedgersInner(
  db: Database.Database,
  tables: RowsTableSpec[],
  instanceId: string
): Map<string, number> {
  const droppedByTable = new Map<string, number>()

  /* ---- `_tombstone` ---- */
  // 版の3列は `ensureTombstoneVersionColumns` と同じ形。`_sns_ts` は**型名なし**
  // （TEXT の親和性が付くと、入れた数値が文字列へ化けて群1 が群2 になる）
  db.exec(`
    CREATE TABLE "_sns_tombstone_new" (
      "tableName"  TEXT NOT NULL,
      "recordId"   TEXT NOT NULL,
      "deletedAt"  TEXT NOT NULL DEFAULT (${NOW_SQL}),
      ${escapeIdentifier(VERSION_COLUMNS.ts)},
      ${escapeIdentifier(VERSION_COLUMNS.lamport)} INTEGER,
      ${escapeIdentifier(VERSION_COLUMNS.instance)} TEXT,
      PRIMARY KEY ("tableName", "recordId")
    )
  `)
  const hadTombstone = tableExists(db, '_tombstone')
  if (hadTombstone) {
    for (const table of tables) {
      const pk = primaryKeyColumn(db, table.name)
      // 時刻列のある表では、削除の版の時刻は削除を実行した時刻（原則2）。
      // 無い表ではトリガーと同じく NULL（`src/rows/triggers.ts` の `deletedAtSql`）
      const ts =
        timestampSql(db, table) === 'NULL' ? 'NULL' : legacyDeletedAtTsSql()
      const version = `${ts}, 0, ${quoteLiteral(instanceId)}`
      // 綴りは畳んだものへ揃え、`recordId` は正規形（`CAST(… AS TEXT)`）で比べる。
      // アプリの表に同じ id がある墓標は写さない（§3.9 の3）
      const before = countOf(
        db,
        `SELECT COUNT(*) AS n FROM "_tombstone" WHERE "tableName" = ? COLLATE NOCASE`,
        table.name
      )
      db.prepare(
        `INSERT INTO "_sns_tombstone_new"
           ("tableName", "recordId", "deletedAt",
            ${escapeIdentifier(VERSION_COLUMNS.ts)},
            ${escapeIdentifier(VERSION_COLUMNS.lamport)},
            ${escapeIdentifier(VERSION_COLUMNS.instance)})
         SELECT ?, CAST("recordId" AS TEXT), "deletedAt", ${version}
           FROM "_tombstone"
          WHERE "tableName" = ? COLLATE NOCASE
            AND CAST("recordId" AS TEXT) NOT IN (
                  SELECT CAST(${escapeIdentifier(pk.name)} AS TEXT)
                    FROM ${escapeIdentifier(table.name)})
         ON CONFLICT ("tableName", "recordId") DO NOTHING`
      ).run(table.name, table.name)
      const kept = countOf(
        db,
        `SELECT COUNT(*) AS n FROM "_sns_tombstone_new" WHERE "tableName" = ?`,
        table.name
      )
      droppedByTable.set(table.name, before - kept)
    }
    // 同期しない表の墓標は、そのまま写す（綴りを畳む相手が無い）
    const known = tables.map((table) => foldIdentifier(table.name))
    const placeholders = known.map(() => '?').join(', ')
    db.prepare(
      `INSERT INTO "_sns_tombstone_new"
         ("tableName", "recordId", "deletedAt",
          ${escapeIdentifier(VERSION_COLUMNS.ts)},
          ${escapeIdentifier(VERSION_COLUMNS.lamport)},
          ${escapeIdentifier(VERSION_COLUMNS.instance)})
       SELECT "tableName", CAST("recordId" AS TEXT), "deletedAt",
              ${legacyDeletedAtTsSql()}, 0, ?
         FROM "_tombstone"
        ${known.length === 0 ? '' : `WHERE lower("tableName") NOT IN (${placeholders})`}
       ON CONFLICT ("tableName", "recordId") DO NOTHING`
    ).run(instanceId, ...known)
    db.exec(`DROP TABLE "_tombstone"`)
  }
  db.exec(`ALTER TABLE "_sns_tombstone_new" RENAME TO "_tombstone"`)

  /* ---- `_changelog` ---- */
  db.exec(`
    CREATE TABLE "_sns_changelog_new" (
      "id"        INTEGER PRIMARY KEY AUTOINCREMENT,
      "tableName" TEXT    NOT NULL,
      "recordId"  TEXT    NOT NULL,
      "operation" TEXT    NOT NULL,
      "changedAt" TEXT    NOT NULL DEFAULT (${NOW_SQL})
    )
  `)
  if (tableExists(db, '_changelog')) {
    // **刈らない**（§3.9 の G）。旧版の端末が残っている間に刈ると、
    // その端末へ渡すべき事実が消える。id も綴りもそのまま写す
    db.exec(`
      INSERT INTO "_sns_changelog_new"
        ("id", "tableName", "recordId", "operation", "changedAt")
      SELECT "id", "tableName", "recordId", "operation", "changedAt"
        FROM "_changelog"
    `)
    db.exec(`DROP TABLE "_changelog"`)
  }
  db.exec(`ALTER TABLE "_sns_changelog_new" RENAME TO "_changelog"`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_changelog_id ON _changelog(id)`)
  return droppedByTable
}

/* ------------------------------------------------------------------ *
 * `_sns_rows_<t>` の中身
 * ------------------------------------------------------------------ */

/**
 * `TRUE_ID`（§3.3）。
 *
 * 旧方式から移すときは `_sns_shown` が空なので主キーそのものになる。
 * 案A の DB で列の増減に追従するとき（{@link rewriteRowsWithNewVersions}）は、1:1 の表の表示している id を真の id へ戻す。
 */
function trueIdSql(spec: RowsTableSpec, pk: RowsColumn): string {
  const key = `${escapeIdentifier(spec.name)}.${escapeIdentifier(pk.name)}`
  return `COALESCE((SELECT "trueId" FROM "_sns_shown"
       WHERE "tableName" = ${quoteLiteral(spec.name)} AND "shownId" = CAST(${key} AS TEXT)), ${key})`
}

/**
 * 旧 `_tombstone` の墓標に与える `_sns_ts`。
 *
 * 旧 `deletedAt` はその削除を実行した時刻なので、原則2 のとおりそれで比べる。
 * ISO 8601 の文字列（群3）でなければ時刻として比べられないので NULL（群0＝最小）
 * にする。判定はトリガーと同じ式（{@link isIsoTimeSql}）を使う。
 */
function legacyDeletedAtTsSql(): string {
  return `(CASE WHEN ${isIsoTimeSql('"deletedAt"')} THEN "deletedAt" END)`
}

/** 時刻列の式（その表に無ければ `NULL`）。 */
function timestampSql(db: Database.Database, spec: RowsTableSpec): string {
  const wanted = spec.timestampColumn ?? DEFAULT_TIMESTAMP_COLUMN
  const all = db.pragma(
    `table_xinfo(${escapeIdentifier(spec.name)})`
  ) as RowsColumn[]
  const found = all.find(
    (column) => foldIdentifier(column.name) === foldIdentifier(wanted)
  )
  return found === undefined
    ? 'NULL'
    : `${escapeIdentifier(spec.name)}.${escapeIdentifier(found.name)}`
}

/**
 * 移行のとき、アプリの表の中身を `_sns_rows_<t>` へ写す（§3.9 の C）。
 *
 * 版は `_sns_ts` ＝ **時刻列の値**、`_sns_lamport = 0`、`_sns_instance` ＝ 自分。
 * `_sns_ts` を NULL にすると、移行した2端末の同じ行の勝敗が
 * `(群0, 0, instanceId)` の比較になり、**起動ごとに変わる乱数で決まる**。
 */
function seedRowsTable(
  db: Database.Database,
  spec: RowsTableSpec,
  instanceId: string
): number {
  const columns = syncedColumns(db, spec.name)
  const pk = primaryKeyColumn(db, spec.name)
  const trueId = trueIdSql(spec, pk)
  const names = columns
    .map((column) => escapeIdentifier(column.name))
    .concat([
      escapeIdentifier(VERSION_COLUMNS.ts),
      escapeIdentifier(VERSION_COLUMNS.lamport),
      escapeIdentifier(VERSION_COLUMNS.instance),
    ])
  const values = columns
    .map((column) =>
      foldIdentifier(column.name) === foldIdentifier(pk.name)
        ? trueId
        : `${escapeIdentifier(spec.name)}.${escapeIdentifier(column.name)}`
    )
    .concat([timestampSql(db, spec), '0', '?'])
  const statement = db.prepare(
    `INSERT INTO ${escapeIdentifier(rowsTableName(spec.name))} (${names.join(', ')})
     SELECT ${values.join(', ')} FROM ${escapeIdentifier(spec.name)}
     WHERE true
     ON CONFLICT (${escapeIdentifier(pk.name)}) DO NOTHING`
  )
  return statement.run(instanceId).changes
}

/**
 * 列の増減があった表を、**全行まるごと新しい版で書き直す**（§3.9 の E）。
 *
 * `_sns_ts` は §1.2.1 の3項の最大、`_sns_lamport` は進めた値、`_sns_instance` は自分。
 * **既定値を1回評価して埋める形は採らない** —— 評価のたびに変わる既定値では、
 * 端末ごとに違う値が同じ版の鍵で入り、永久に食い違う。
 */
function rewriteRowsWithNewVersions(
  db: Database.Database,
  spec: RowsTableSpec,
  instanceId: string
): number {
  const rows = rowsTableName(spec.name)
  const columns = syncedColumns(db, spec.name)
  const pk = primaryKeyColumn(db, spec.name)
  const trueId = trueIdSql(spec, pk)
  const keyText = `CAST(${trueId} AS TEXT)`
  // 表ごとに1つ進めれば足りる。版の鍵は `(t, k, iid, L, 種類)` なので、
  // 行が違えば同じ L でも重ならない
  const lamport = bumpLamport(db)
  const newTs = maxTsSql([
    timestampSql(db, spec),
    `(SELECT ${escapeIdentifier(VERSION_COLUMNS.ts)} FROM ${escapeIdentifier(rows)}
        WHERE ${escapeIdentifier(pk.name)} = ${trueId})`,
    `(SELECT ${escapeIdentifier(VERSION_COLUMNS.ts)} FROM "_tombstone"
        WHERE "tableName" = ${quoteLiteral(spec.name)} AND "recordId" = ${keyText})`,
  ])
  const names = columns
    .map((column) => escapeIdentifier(column.name))
    .concat([
      escapeIdentifier(VERSION_COLUMNS.ts),
      escapeIdentifier(VERSION_COLUMNS.lamport),
      escapeIdentifier(VERSION_COLUMNS.instance),
    ])
  const values = columns
    .map((column) =>
      foldIdentifier(column.name) === foldIdentifier(pk.name)
        ? trueId
        : `${escapeIdentifier(spec.name)}.${escapeIdentifier(column.name)}`
    )
    .concat([newTs, String(lamport), '?'])
  const assignments = columns
    .filter((column) => foldIdentifier(column.name) !== foldIdentifier(pk.name))
    .map(
      (column) =>
        `${escapeIdentifier(column.name)} = "excluded".${escapeIdentifier(column.name)}`
    )
    .concat([
      `${escapeIdentifier(VERSION_COLUMNS.ts)} = "excluded".${escapeIdentifier(VERSION_COLUMNS.ts)}`,
      `${escapeIdentifier(VERSION_COLUMNS.lamport)} = "excluded".${escapeIdentifier(VERSION_COLUMNS.lamport)}`,
      `${escapeIdentifier(VERSION_COLUMNS.instance)} = "excluded".${escapeIdentifier(VERSION_COLUMNS.instance)}`,
    ])
  db.prepare(
    `INSERT INTO ${escapeIdentifier(rows)} (${names.join(', ')})
     SELECT ${values.join(', ')} FROM ${escapeIdentifier(spec.name)}
     WHERE true
     ON CONFLICT (${escapeIdentifier(pk.name)}) DO UPDATE SET
       ${assignments.join(',\n       ')}`
  ).run(instanceId)
  return countOf(db, `SELECT COUNT(*) AS n FROM ${escapeIdentifier(rows)}`)
}

/** `_sns_clock.lamport` を1つ進めて、進めたあとの値を返す。 */
function bumpLamport(db: Database.Database): number {
  db.exec(`UPDATE "_sns_clock" SET "lamport" = "lamport" + 1`)
  return countOf(db, `SELECT "lamport" AS n FROM "_sns_clock"`)
}

/* ------------------------------------------------------------------ *
 * 列の増減（§3.9 の D・E）
 * ------------------------------------------------------------------ */

interface ShapeChange {
  added: string[]
  removed: string[]
}

/**
 * `_sns_rows_<t>` の列を、アプリの表の今の列へ合わせる。
 *
 * **主キーの列名が変わった・消えたら例外。** `_sns_rows_*` の主キーの列は
 * `DROP COLUMN` できず（`cannot drop PRIMARY KEY column`）、そもそも列名が
 * 変われば行の同定ができない。
 */
function reconcileColumns(
  db: Database.Database,
  spec: RowsTableSpec,
  result: RowsMigrationResult
): ShapeChange {
  const rows = rowsTableName(spec.name)
  const appColumns = syncedColumns(db, spec.name)
  const appPk = primaryKeyColumn(db, spec.name)
  const held = db.pragma(
    `table_info(${escapeIdentifier(rows)})`
  ) as RowsColumn[]
  const heldPk = held.find((column) => column.pk === 1)

  if (heldPk === undefined) {
    throw new Error(
      `${rows} に主キーの列が無い。同期のバージョンを行と対応づけられないので、取り付けを中止する`
    )
  }
  if (foldIdentifier(heldPk.name) !== foldIdentifier(appPk.name)) {
    throw new Error(
      `同期する表 ${spec.name} の主キーの列名が ${heldPk.name} から ${appPk.name} へ変わっている。` +
        ` 主キーの列名が変わると同期のバージョンを行と対応づけられないので、取り付けを中止する。` +
        `主キーの列名を元に戻すこと`
    )
  }

  const versionNames = new Set(
    Object.values(VERSION_COLUMNS).map((name) => foldIdentifier(name))
  )
  const heldNames = new Map(
    held
      .filter((column) => !versionNames.has(foldIdentifier(column.name)))
      .map((column) => [foldIdentifier(column.name), column])
  )
  const appNames = new Map(
    appColumns.map((column) => [foldIdentifier(column.name), column])
  )

  const added = appColumns.filter(
    (column) => !heldNames.has(foldIdentifier(column.name))
  )
  const removed = [...heldNames.values()].filter(
    (column) => !appNames.has(foldIdentifier(column.name))
  )
  if (added.length === 0 && removed.length === 0) {
    return { added: [], removed: [] }
  }

  const orphans = hasOrphanRows(db, spec, appPk)
  for (const column of added) {
    // 型名は書かない（`rowsColumnsSql`）
    db.exec(
      `ALTER TABLE ${escapeIdentifier(rows)} ADD COLUMN ${escapeIdentifier(
        column.name
      )}`
    )
    // アプリの表に居ない行（隠れた行・置かない行）は、アプリの表から
    // 埋め直せない。埋められるのは**定数の既定値だけ** —— 評価のたびに
    // 変わる既定値を1回評価して埋めると、端末ごとに違う値が同じ版の鍵で入る
    const constant = constantDefaultSql(column.dflt_value)
    if (constant !== null) {
      db.prepare(
        `UPDATE ${escapeIdentifier(rows)} SET ${escapeIdentifier(column.name)} = ?`
      ).run(storedValueOf(db, spec.name, column, constant))
    } else if (column.notnull === 1 && orphans) {
      throw new Error(
        `同期する表 ${spec.name} に増えた列 ${column.name} が NOT NULL で、既定値が定数でない。` +
          ` ユーザーテーブルに入っていないバージョンの行（UNIQUE の統合で隠れた行など）はこの列を埋められないので、取り付けを中止する。` +
          `この列に定数の既定値を付けること`
      )
    } else if (column.notnull === 1) {
      result.warnings.push(
        `同期する表 ${spec.name} に増えた列 ${column.name} は NOT NULL だが既定値が定数でない。` +
          ` いまはユーザーテーブルに入っていないバージョンが無いので続けた。` +
          `そのようなバージョンがあると列を足すときに取り付けが止まるので、定数の既定値を付けることを勧める`
      )
    }
  }
  for (const column of removed) {
    db.exec(
      `ALTER TABLE ${escapeIdentifier(rows)} DROP COLUMN ${escapeIdentifier(column.name)}`
    )
  }
  return {
    added: added.map((column) => column.name),
    removed: removed.map((column) => column.name),
  }
}

/**
 * 定数の字面を、アプリの表のその列に入れたときに持つ値にする。
 *
 * `_sns_rows_<t>` の列には型名が無い（`rowsColumnsSql`）ので、字面をそのまま
 * 入れると、アプリの列の親和性や STRICT の型による変換が起きない。
 * アプリの表に入る値と違うと、作り直しがその行を毎回「違う」と数える。
 * そこで、列の型名と STRICT かどうかを写した一時の表に入れて読み直す。
 */
function storedValueOf(
  db: Database.Database,
  table: string,
  column: RowsColumn,
  constant: string
): SqlValue {
  const strict = db
    .prepare(
      `SELECT "strict" AS "strict" FROM pragma_table_list
        WHERE "schema" = 'main' AND "name" = ?`
    )
    .get(table) as { strict: number } | undefined
  const type = column.type.trim()
  db.exec(
    `CREATE TEMP TABLE "_sns_default_probe" ("value"${type === '' ? '' : ` ${type}`})${
      strict?.strict === 1 ? ' STRICT' : ''
    }`
  )
  try {
    db.exec(`INSERT INTO temp."_sns_default_probe" VALUES (${constant})`)
    const read = db.prepare(`SELECT "value" FROM temp."_sns_default_probe"`)
    read.safeIntegers(true)
    return (read.get() as { value: SqlValue }).value
  } finally {
    db.exec(`DROP TABLE temp."_sns_default_probe"`)
  }
}

/**
 * 0.21.0 までに作った `_sns_rows_<t>` の、主キー以外のアプリの列から型名を外す。
 *
 * 0.21.0 までは、アプリの列の型名を写していた。STRICT の表の `ANY` 列では、
 * それが NUMERIC 親和性になって値を変える（`rowsColumnsSql`）。型名は
 * `ALTER TABLE` で変えられないので、型名の無い表を作って行をそのまま写し、
 * 元の表と置き換える。行も版も変えないので、他の端末から見て何も変わらない。
 * 既に変換された値は元に戻らない。
 *
 * その表のトリガーを落とす。作り直すのは呼び出し側（手順6）である。
 * 型名を外す列が無ければ何もしない。
 */
function dropRowsColumnTypes(db: Database.Database, spec: RowsTableSpec): void {
  const rows = rowsTableName(spec.name)
  const held = db.pragma(
    `table_info(${escapeIdentifier(rows)})`
  ) as RowsColumn[]
  const heldPk = held.find((column) => column.pk === 1)
  // 主キーの列が無い表は、続く `reconcileColumns` が例外にする
  if (heldPk === undefined) return
  const versionNames = new Set(
    Object.values(VERSION_COLUMNS).map((name) => foldIdentifier(name))
  )
  const appColumns = held
    .filter((column) => !versionNames.has(foldIdentifier(column.name)))
    .map((column) => column.name)
  const typed = held.some(
    (column) =>
      column.pk === 0 &&
      !versionNames.has(foldIdentifier(column.name)) &&
      column.type.trim() !== ''
  )
  if (!typed) return

  dropRowsTriggers(db, [spec])
  const replacement = `_sns_untyped_${spec.name}`
  const names = held.map((column) => escapeIdentifier(column.name)).join(', ')
  db.exec(
    `CREATE TABLE ${escapeIdentifier(replacement)} (
       ${rowsColumnsSql(appColumns, heldPk)}
     )`
  )
  db.exec(
    `INSERT INTO ${escapeIdentifier(replacement)} (${names})
     SELECT ${names} FROM ${escapeIdentifier(rows)}`
  )
  db.exec(`DROP TABLE ${escapeIdentifier(rows)}`)
  // `rebuildLedgers` と同じく `legacy_alter_table` を立てる。素の `RENAME TO` は
  // DB のすべてのトリガーとビューを読み直すので、アプリのスキーマ次第で落ちうる。
  // 付け替える名前を指しているものは無いので、書き換えは要らない
  const previousLegacy = db.pragma('legacy_alter_table', { simple: true })
  db.pragma('legacy_alter_table = ON')
  try {
    db.exec(
      `ALTER TABLE ${escapeIdentifier(replacement)} RENAME TO ${escapeIdentifier(rows)}`
    )
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacy === 1 ? 'ON' : 'OFF'}`)
  }
}

/** `_sns_rows_<t>` に、アプリの表に居ない行があるか。 */
function hasOrphanRows(
  db: Database.Database,
  spec: RowsTableSpec,
  pk: RowsColumn
): boolean {
  const rows = escapeIdentifier(rowsTableName(spec.name))
  const key = escapeIdentifier(pk.name)
  const found = db
    .prepare(
      `SELECT 1 AS found FROM ${rows} AS "r"
        WHERE NOT EXISTS (
          SELECT 1 FROM ${escapeIdentifier(spec.name)} AS "a"
           WHERE CAST("a".${key} AS TEXT) = CAST("r".${key} AS TEXT))
        LIMIT 1`
    )
    .get()
  return found !== undefined
}

/**
 * 既定値の字面が**定数**なら、その字面を返す。定数でなければ `null`。
 *
 * `CURRENT_TIMESTAMP` や `datetime('now')` は定数ではない —— 評価するたびに
 * 変わるので、端末ごとに違う値が同じ版の鍵で入る（§3.9 の E）。
 */
export function constantDefaultSql(text: unknown): string | null {
  if (typeof text !== 'string') return null
  let body = text.trim()
  // 括弧の入れ子を剥がす（`(0)` のような形で入っていることがある）
  while (body.startsWith('(') && body.endsWith(')')) {
    body = body.slice(1, -1).trim()
  }
  const literal =
    /^-?\s*\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(body) ||
    /^'(?:[^']|'')*'$/.test(body) ||
    /^[Xx]'[0-9a-fA-F]*'$/.test(body) ||
    /^(?:NULL|TRUE|FALSE)$/i.test(body)
  return literal ? body : null
}

/* ------------------------------------------------------------------ *
 * 小道具
 * ------------------------------------------------------------------ */

function droppedOf(
  result: RowsMigrationResult,
  table: string
): RowsMigrationTableReport {
  let found = result.tables.find((entry) => entry.table === table)
  if (found === undefined) {
    found = {
      table,
      rows: 0,
      droppedTombstones: 0,
      addedColumns: [],
      removedColumns: [],
      rewritten: false,
    }
    result.tables.push(found)
  }
  return found
}

function countOf(
  db: Database.Database,
  sql: string,
  ...parameters: unknown[]
): number {
  const row = db.prepare(sql).get(...parameters) as
    { n: number | bigint } | undefined
  return row === undefined ? 0 : Number(row.n)
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}
