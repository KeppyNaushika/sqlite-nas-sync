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
 * | 残す `_tombstone` の版 | `_sns_ts` は NULL（群0＝最小） | 移行時の削除に大きな時刻を与えない |
 * | アプリの表に居る id の墓標 | **消す** | 残すと版の鍵が完全に一致し、種類の規則で削除が勝って、最初の作り直しでその行が消える |
 * | `_changelog` | **刈らない** | 旧版の端末が残っている間に刈ると、その端末へ渡すべき事実が消える |
 * | `_sns_rebuilding` の残り | 知らせて、トリガーを作る前に消す | 残っているとアプリの書き込みが1つも事実にならない |
 *
 * **段階4 ではまだ `setupSync` から呼ばれない**（切り替えるのは段階5）。
 *
 * @module rows/migrate
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier, foldIdentifier, NOW_SQL } from '../setup/sql'
import { ROWS_FORMAT, readSnsFormat } from './import'
import {
  SNS_META_KEYS,
  ensureSyncMetaTable,
  newInstanceId,
  readSnsMeta,
  writeSnsMeta,
} from './meta'
import {
  RowsColumn,
  RowsTableSpec,
  VERSION_COLUMNS,
  createRowsTables,
  primaryKeyColumn,
  quoteLiteral,
  rowsTableName,
  syncedColumns,
} from './schema'
import { canonicalTableSpecs } from './table-name'
import { createRowsTriggers, dropRowsTriggers, maxTsSql } from './triggers'

/** {@link migrateToRows} の設定。 */
interface RowsMigrationOptions {
  /** 同期する表（綴りは入り口で `sqlite_master` へ畳む。§1.11・段階3 の申し送り） */
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

/** {@link migrateToRows} の結果。 */
interface RowsMigrationResult {
  /** `legacy` なら旧方式から移した。`refresh` なら既に案A だった（列の増減だけ見た） */
  from: 'legacy' | 'refresh'
  /** この移行で使った端末の id */
  instanceId: string
  /** 表ごとの内訳 */
  tables: RowsMigrationTableReport[]
  /** 残した墓標の数 */
  keptTombstones: number
  /** 写した `_changelog` の行数（刈っていないので旧方式の全件） */
  changelogEntries: number
  /** `_sns_rebuilding` の残りを消したか（§3.10 の I） */
  clearedRebuilding: boolean
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
    from: fromLegacy ? 'legacy' : 'refresh',
    instanceId,
    tables: [],
    keptTombstones: 0,
    changelogEntries: 0,
    clearedRebuilding: false,
    warnings: [],
  }

  // `PRAGMA recursive_triggers` は接続の設定であってスキーマではないので、
  // トランザクションの外で立てておく（`createRowsTriggers` も立てるが、
  // 途中で落ちたときに中途半端な設定を残さないため先に済ませる）
  db.pragma('recursive_triggers = ON')

  const run = db.transaction(() => {
    // 1. 旗の残り（§3.10 の I）。**トリガーを作る前に**消す
    result.clearedRebuilding = clearRebuildingRows(db)
    if (result.clearedRebuilding) {
      result.warnings.push(
        `_sns_rebuilding に行が残っていたので消した。` +
          `前回の作り直しが途中で落ちた可能性がある（残っている間、アプリの書き込みは1つも事実にならない）`
      )
    }

    // 2. 旧方式のトリガーを落とす。残すと、旧 DELETE トリガーの
    //    `INSERT OR REPLACE INTO _tombstone` が版の3列を NULL で塗り潰す
    if (fromLegacy) {
      dropLegacyTriggers(db, specs)
    }

    // 3. `_tombstone` と `_changelog` を作り直す（§3.9 の F）
    if (fromLegacy) {
      const counts = rebuildLedgers(db, specs, instanceId)
      result.keptTombstones = counts.keptTombstones
      result.changelogEntries = counts.changelogEntries
      for (const [table, dropped] of counts.droppedByTable) {
        droppedOf(result, table).droppedTombstones = dropped
      }
      // 旧「畳み」の帳簿は捨てる（§3.9 の2）。案A では重複はそのまま両方残る
      db.exec(`DROP TABLE IF EXISTS _id_merge`)
    } else {
      result.keptTombstones = countOf(
        db,
        `SELECT COUNT(*) AS n FROM _tombstone`
      )
      result.changelogEntries = countOf(
        db,
        `SELECT COUNT(*) AS n FROM _changelog`
      )
    }

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
 * 旗・旧トリガー
 * ------------------------------------------------------------------ */

/** `_sns_rebuilding` に行が残っていれば消す。消したら `true`（§3.10 の I）。 */
function clearRebuildingRows(db: Database.Database): boolean {
  if (!tableExists(db, '_sns_rebuilding')) return false
  return db.prepare(`DELETE FROM _sns_rebuilding`).run().changes > 0
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

/* ------------------------------------------------------------------ *
 * `_tombstone` と `_changelog` の作り直し（§3.9 の F）
 * ------------------------------------------------------------------ */

interface LedgerCounts {
  keptTombstones: number
  changelogEntries: number
  droppedByTable: Map<string, number>
}

/**
 * `_tombstone` と `_changelog` を、案A の形で作り直す。
 *
 * `_changelog` は **id をそのまま写す**。振り直すと、相手の `_sync_state` が
 * 指している位置と食い違い、旧版の端末が隙間ありに落ちる（§3.9 の G）。
 */
function rebuildLedgers(
  db: Database.Database,
  tables: RowsTableSpec[],
  instanceId: string
): LedgerCounts {
  // **`legacy_alter_table` を立てる。** 素の `ALTER TABLE … RENAME TO` は、
  // その DB の**すべてのトリガーを読み直して**参照を書き換える。旧方式の
  // `_heartbeat` のトリガーは `_changelog` を指しているので、作り直しの途中
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
): LedgerCounts {
  const counts: LedgerCounts = {
    keptTombstones: 0,
    changelogEntries: 0,
    droppedByTable: new Map(),
  }

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
    const version = `NULL, 0, ${quoteLiteral(instanceId)}`
    for (const table of tables) {
      const pk = primaryKeyColumn(db, table.name)
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
      counts.droppedByTable.set(table.name, before - kept)
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
              NULL, 0, ?
         FROM "_tombstone"
        ${known.length === 0 ? '' : `WHERE lower("tableName") NOT IN (${placeholders})`}
       ON CONFLICT ("tableName", "recordId") DO NOTHING`
    ).run(instanceId, ...known)
    db.exec(`DROP TABLE "_tombstone"`)
  }
  db.exec(`ALTER TABLE "_sns_tombstone_new" RENAME TO "_tombstone"`)
  counts.keptTombstones = countOf(db, `SELECT COUNT(*) AS n FROM "_tombstone"`)

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
  counts.changelogEntries = countOf(
    db,
    `SELECT COUNT(*) AS n FROM "_changelog"`
  )
  return counts
}

/* ------------------------------------------------------------------ *
 * `_sns_rows_<t>` の中身
 * ------------------------------------------------------------------ */

/** `TRUE_ID`（§3.3）。移行の時点では `_sns_shown` は空なので主キーそのもの。 */
function trueIdSql(spec: RowsTableSpec, pk: RowsColumn): string {
  const key = `${escapeIdentifier(spec.name)}.${escapeIdentifier(pk.name)}`
  return `COALESCE((SELECT "trueId" FROM "_sns_shown"
       WHERE "tableName" = ${quoteLiteral(spec.name)} AND "shownId" = CAST(${key} AS TEXT)), ${key})`
}

/** 時刻列の式（その表に無ければ `NULL`）。 */
function timestampSql(db: Database.Database, spec: RowsTableSpec): string {
  const wanted = spec.timestampColumn ?? 'updatedAt'
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
      `${rows} に主キーの列が無い。作り直せないので移行を中止する`
    )
  }
  if (foldIdentifier(heldPk.name) !== foldIdentifier(appPk.name)) {
    throw new Error(
      `同期する表 ${spec.name} の主キーの列名が ${heldPk.name} から ${appPk.name} へ変わっている。` +
        ` ${rows} の主キーの列は落とせず、行の同定もできないので移行を中止する（§3.9）`
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
    const type = column.type.trim()
    db.exec(
      `ALTER TABLE ${escapeIdentifier(rows)} ADD COLUMN ${escapeIdentifier(
        column.name
      )}${type === '' ? '' : ` ${type}`}`
    )
    // アプリの表に居ない行（隠れた行・置かない行）は、アプリの表から
    // 埋め直せない。埋められるのは**定数の既定値だけ** —— 評価のたびに
    // 変わる既定値を1回評価して埋めると、端末ごとに違う値が同じ版の鍵で入る
    const constant = constantDefaultSql(column.dflt_value)
    if (constant !== null) {
      db.exec(
        `UPDATE ${escapeIdentifier(rows)} SET ${escapeIdentifier(column.name)} = ${constant}`
      )
    } else if (column.notnull === 1 && orphans) {
      throw new Error(
        `同期する表 ${spec.name} に増えた列 ${column.name} が NOT NULL で、既定値が定数でない。` +
          ` ${rows} にはアプリの表から埋め直せない行があるので移行を中止する（§3.9 の E）`
      )
    } else if (column.notnull === 1) {
      result.warnings.push(
        `同期する表 ${spec.name} に増えた列 ${column.name} は NOT NULL だが既定値が定数でない。` +
          ` いまは全行をアプリの表から書き直せるので通すが、隠れた行があると移行できなくなる`
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
