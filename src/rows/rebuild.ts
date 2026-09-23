/**
 * 作り直しの**適用**と、計算から適用までの段取り（設計書
 * `docs/rows-table-design.md` §3.7.2〜§3.7.5）。
 *
 * 計算（`src/rows/rebuild-plan.ts`）は読むだけ、適用（ここ）は主スレッドの
 * 書き込みだけ、と分けてある。適用で守っている決まりごと:
 *
 * 1. **`PRAGMA` の退避と復元はトランザクションの外**。`PRAGMA foreign_keys` は
 *    トランザクションが開いている間は黙って無視されるので、見送り・例外・
 *    外部キーの違反のどの経路でも `ROLLBACK` してから `finally` に入る。
 *    それでも `db.inTransaction` が真なら**例外にする**（`foreign_keys` を
 *    OFF のまま残すと、アプリの接続で以後 cascade も SET NULL も起きない）
 * 2. **`SQLITE_BUSY` は見送り**（§3.7.2 の (J)）。`busy_timeout = 0` の
 *    `BEGIN IMMEDIATE` は例外を投げる。投げ直すと見送りに数えられず、
 *    k 回目の合流経路に永久に入らない。token の不一致も見送りに数える
 * 3. **適用は表全体の入れ替え**（消す → 入れる）。UNIQUE の値を2行の間で
 *    入れ替える計画が通るのはこのためである
 * 4. **旗（`_sns_rebuilding`）が立っている間に `_sns_dirty` を消す**。
 *    先に旗を下ろすと、その間に走ったトリガーが立てた汚れまで消してしまう
 * 5. **`DROP TRIGGER` は schema 修飾**。main と temp に同名のトリガーがあると、
 *    素の `DROP TRIGGER` は temp 側を先に落とす
 * 6. **`PRAGMA foreign_key_check(<表>)` は、その表が子である違反しか返さない**。
 *    適用した表・後始末で触った表・それらを親として参照する表を1つずつ回す
 *
 * 公開 API ではない。
 *
 * @module rows/rebuild
 * @internal
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { escapeIdentifier, foldIdentifier } from '../setup/sql'
import { missingParentAction } from './on-delete'
import {
  RebuildPlan,
  RebuildPlanTable,
  computeRebuildPlan,
  dependencyOrder,
  foreignKeysOf,
  readRebuildToken,
  RebuildPlanDiscarded,
  reviveRebuildPlan,
  sameRebuildToken,
} from './rebuild-plan'
import { RowsColumn, primaryKeyColumn, rowsTableName } from './schema'
import { canonicalTableSpecs } from './table-name'
import { SqlValue, ValueOrdering } from './versions'

/** 合流経路に落ちるまでの見送りの回数（設計書 §3.7.4 の k）。 */
const DEFAULT_MERGE_AFTER_SKIPS = 3

/** 合流経路の `busy_timeout`（ミリ秒）。設計書の「数十 ms」。 */
const DEFAULT_MERGED_BUSY_TIMEOUT_MS = 50

/**
 * 検査と試験のための差し込み口（設計書 §8.2 の `REQUIRED_HOOKS`）。
 *
 * **公開 API ではない。** `SyncConfig` には出さない。
 */
export interface RowsRebuildHooks {
  /**
   * 計算が終わってから、適用が `BEGIN IMMEDIATE` を取るまでの窓で呼ばれる。
   *
   * ここで書き込むと token が進むので、その作り直しは見送りになる
   * （＝「計算中の書き込みを取りこぼさない」ことを試験から踏める口）
   */
  duringCompute?: (db: Database.Database) => void
  /** 作り直しが確定したことを知らせる（表と generation つき） */
  onRebuildCommitted?: (
    db: Database.Database,
    info: { tables: string[]; generation: number }
  ) => void
  /**
   * `BEGIN IMMEDIATE` を差し替える口。
   *
   * 検査は端末ごとに接続を1本しか開かないので、外から失敗させない限り
   * 「ロックを取れない」経路に入れない（設計書 §8.2）
   */
  beginImmediate?: (db: Database.Database) => void
  /** 警告（外部キーの検査に落ちた表など） */
  onWarning?: (message: string) => void
}

/** 作り直しの記憶（`SyncInstance` が全体で1つ持つ。設計書 §3.7.4）。 */
export interface RowsRebuildState {
  /** 見送りの回数。確定したときと `_sns_dirty` が空のときに 0 に戻す */
  skips: number
  /** 確定した回数 */
  generation: number
  /** 外部キーの検査に落ちて、対象から外した表 */
  excluded: Set<string>
  /** 利用者へ知らせる警告 */
  warnings: string[]
}

/** {@link rebuildOnce} の設定。 */
interface RowsRebuildOptions {
  /** 同期する表 */
  tables: string[]
  /** 適用する表（省略すると `_sns_dirty` の表とその子孫） */
  targets?: string[]
  state?: RowsRebuildState
  hooks?: RowsRebuildHooks
  /** 合流経路に落ちるまでの見送りの回数 @defaultValue 3 */
  mergeAfterSkips?: number
  /** 合流経路の `busy_timeout`（ミリ秒） @defaultValue 50 */
  mergedBusyTimeoutMs?: number
}

/** {@link rebuildOnce} の結果。 */
interface RowsRebuildOutcome {
  /**
   * - `applied` 確定した
   * - `deferred` 見送った（`SQLITE_BUSY` か token の不一致）
   * - `noop` するものが無かった
   * - `excluded` 外部キーの違反が残る表を対象から外した（巻き戻してある）
   */
  status: 'applied' | 'deferred' | 'noop' | 'excluded'
  mode: 'normal' | 'merged'
  /** 適用した表 */
  tables: string[]
  /** そのときの見送りの回数 */
  skips: number
  generation: number
  warnings: string[]
  reason?: string
  /**
   * アプリの表に当てた差の内訳（設計書 §4.4 の `inserted` / `updated` / `deleted`）。
   *
   * 適用は表全体の入れ替えなので、**入れ替える前のアプリの表と計画の行を
   * 突き合わせて**数える。`status` が `applied` でなければ全部 0。
   */
  counts: RowsRebuildCounts
  /**
   * 版ごと捨てた行（原則4）。親が削除されているので `_sns_rows_<表>` から落とした。
   *
   * **中身を載せる**のは、落としたあとには誰も読めなくなるからである。
   * ライブラリは退避しない。必要ならアプリケーションが受け取って退避する。
   */
  discarded: RebuildPlanDiscarded[]
}

/** アプリの表に当てた差の内訳。 */
interface RowsRebuildCounts {
  /** 計画にあって、アプリの表に無かった行 */
  inserted: number
  /** 主キーは同じだが中身が違っていた行 */
  updated: number
  /** アプリの表にあって、計画に無かった行 */
  deleted: number
}

/** まっさらな記憶。 */
export function createRebuildState(): RowsRebuildState {
  return { skips: 0, generation: 0, excluded: new Set(), warnings: [] }
}

/**
 * 主スレッドで計算して、そのまま適用する（`REQUIRED_HOOKS` の (1)）。
 *
 * 本物のワーカーは1回あたり約17ミリ秒かかるので、検査器は必ずこちらを使う。
 * 外部キーの検査に落ちた表を外しての作り直しも、ここで1回だけやり直す。
 */
export function rebuildOnce(
  db: Database.Database,
  options: RowsRebuildOptions
): RowsRebuildOutcome {
  const state = options.state ?? createRebuildState()
  const tables = canonicalTables(db, options.tables)
  if (db.inTransaction) {
    return outcome(state, 'noop', 'normal', [], 'すでにトランザクションの中')
  }
  if (!hasWork(db, options)) {
    state.skips = 0
    return outcome(state, 'noop', 'normal', [], '_sns_dirty が空')
  }
  const merged =
    state.skips >= (options.mergeAfterSkips ?? DEFAULT_MERGE_AFTER_SKIPS)
  const mode: 'normal' | 'merged' = merged ? 'merged' : 'normal'
  // 対象から外す表が増えるたびに計算し直す。表の数を超えて回ることはない
  for (let attempt = 0; attempt <= tables.length; attempt += 1) {
    const compute = (): RebuildPlan =>
      computeRebuildPlan(db, {
        tables,
        targets: options.targets,
        excluded: [...state.excluded],
        insideTransaction: mode === 'merged',
      })
    const result =
      mode === 'merged'
        ? applyRebuild(db, tables, options, state, 'merged', null, compute)
        : applyRebuild(db, tables, options, state, 'normal', compute(), null)
    if (result.status !== 'excluded') return result
  }
  return outcome(state, 'noop', mode, [], '外せる表が尽きた')
}

/**
 * もう1回だけ作り直して、いまのアプリの表との差の件数を返す（適用はしない）。
 *
 * `REQUIRED_HOOKS` の (4)。判定8（作り直しの冪等性）に使う。
 */
export function rebuildDiffCount(
  db: Database.Database,
  options: RowsRebuildOptions
): number {
  const tables = canonicalTables(db, options.tables)
  const state = options.state ?? createRebuildState()
  const plan = computeRebuildPlan(db, {
    tables,
    // 汚れが消えていても差は測れるように、対象は明示する
    targets: options.targets ?? tables,
    excluded: [...state.excluded],
  })
  const values = new ValueOrdering()
  try {
    let diff = 0
    for (const table of plan.apply) {
      diff += countDifferences(db, table, values)
    }
    return diff
  } finally {
    values.close()
  }
}

/* ------------------------------------------------------------------ *
 * ワーカーで計算する（設計書 §3.7.1）
 * ------------------------------------------------------------------ */

/** {@link computeRebuildPlanInWorker} の設定。 */
interface RebuildWorkerOptions {
  /** 読み取り専用で開く DB の位置（WAL が前提） */
  dbPath: string
  tables: string[]
  targets?: string[]
  excluded?: readonly string[]
  /**
   * ワーカーの入口の位置。既定は同じ場所の `rebuild-worker.js`
   * （`dist/` では隣にある。試験からは、組み上げた JS を指す）
   */
  workerPath?: string
}

/**
 * `worker_threads` の中で計算する（設計書 §3.7.1）。
 *
 * 計算のあいだ主スレッドは空くので、アプリの書き込みは待たされない。その代わり
 * 計算中の書き込みは token で捕まえて見送る。
 */
export function computeRebuildPlanInWorker(
  options: RebuildWorkerOptions
): Promise<RebuildPlan> {
  const workerPath = options.workerPath ?? join(__dirname, 'rebuild-worker.js')
  const input = {
    dbPath: options.dbPath,
    options: {
      tables: options.tables,
      targets: options.targets,
      excluded:
        options.excluded === undefined ? undefined : [...options.excluded],
    },
  }
  return new Promise<RebuildPlan>((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: input })
    let settled = false
    worker.on('message', (message: unknown) => {
      settled = true
      const output = message as
        { ok: true; plan: RebuildPlan } | { ok: false; message: string }
      void worker.terminate()
      if (output.ok) {
        // BLOB は構造化複製で `Uint8Array` になる。`Buffer` へ戻さないと
        // better-sqlite3 の束縛が BLOB として受け取らない
        resolve(reviveRebuildPlan(output.plan))
        return
      }
      reject(new Error(`作り直しの計算がワーカーで失敗した: ${output.message}`))
    })
    worker.on('error', (error) => {
      settled = true
      reject(error)
    })
    worker.on('exit', (code) => {
      if (settled) return
      reject(new Error(`作り直しのワーカーが ${String(code)} で終わった`))
    })
  })
}

/**
 * ワーカーで計算して、主スレッドで適用する（本番の経路）。
 *
 * 見送りが続いたときは、**計算も適用も主スレッドの1つのトランザクション**で
 * 行う経路（合流経路）へ落ちる（設計書 §3.7.4）。
 */
export async function rebuildOnceInWorker(
  db: Database.Database,
  options: RowsRebuildOptions & RebuildWorkerOptions
): Promise<RowsRebuildOutcome> {
  const state = options.state ?? createRebuildState()
  if (db.inTransaction) {
    return outcome(state, 'noop', 'normal', [], 'すでにトランザクションの中')
  }
  if (!hasWork(db, options)) {
    state.skips = 0
    return outcome(state, 'noop', 'normal', [], '_sns_dirty が空')
  }
  if (state.skips >= (options.mergeAfterSkips ?? DEFAULT_MERGE_AFTER_SKIPS)) {
    // 合流経路。ワーカーは使わない
    return rebuildOnce(db, { ...options, state })
  }
  const tables = canonicalTables(db, options.tables)
  const plan = await computeRebuildPlanInWorker({
    ...options,
    tables,
    excluded: [...state.excluded],
  })
  return applyRebuild(
    db,
    tables,
    { ...options, state },
    state,
    'normal',
    plan,
    null
  )
}

/* ------------------------------------------------------------------ *
 * 適用（設計書 §3.7.2）
 * ------------------------------------------------------------------ */

function applyRebuild(
  db: Database.Database,
  tables: string[],
  options: RowsRebuildOptions,
  state: RowsRebuildState,
  mode: 'normal' | 'merged',
  computed: RebuildPlan | null,
  compute: (() => RebuildPlan) | null
): RowsRebuildOutcome {
  const hooks = options.hooks ?? {}
  // トランザクションの外で読む（開いていると `PRAGMA` は黙って無視される）
  const previousForeignKeys = Number(
    db.pragma('foreign_keys', { simple: true })
  )
  const previousBusyTimeout = Number(
    db.pragma('busy_timeout', { simple: true })
  )
  db.pragma(
    `busy_timeout = ${
      mode === 'merged'
        ? (options.mergedBusyTimeoutMs ?? DEFAULT_MERGED_BUSY_TIMEOUT_MS)
        : 0
    }`
  )
  db.pragma('foreign_keys = OFF')
  // `finally` では書かない。`finally` の中の `throw` は、本体が投げた例外を
  // 黙って捨てる（ESLint の `no-unsafe-finally`）。**戻す処理を2つの出口で
  // 明示的に呼ぶ**ほうが、何が起きたかが残る
  const restore = (): void => {
    if (db.inTransaction) {
      // ここへ来てはならない。`PRAGMA` を戻せないまま進むと、アプリの接続の
      // `foreign_keys` が OFF のまま残り、以後 cascade も SET NULL も起きない
      throw new Error(
        '作り直しの適用がトランザクションを開いたまま抜けた（PRAGMA を戻せない）'
      )
    }
    db.pragma(`foreign_keys = ${previousForeignKeys === 1 ? 'ON' : 'OFF'}`)
    db.pragma(`busy_timeout = ${previousBusyTimeout}`)
  }
  const body = (): RowsRebuildOutcome => {
    if (mode === 'normal') hooks.duringCompute?.(db)
    try {
      ;(hooks.beginImmediate ?? beginImmediate)(db)
    } catch (error) {
      if (!isBusy(error)) throw error
      state.skips += 1
      return outcome(state, 'deferred', mode, [], 'BEGIN IMMEDIATE が取れない')
    }
    const plan = computed ?? (compute as () => RebuildPlan)()
    if (mode === 'normal') {
      // token を読み直す。計算のあいだにアプリや取り込みが書いていれば見送る
      if (!sameRebuildToken(plan.token, readRebuildToken(db, tables))) {
        db.exec('ROLLBACK')
        state.skips += 1
        return outcome(state, 'deferred', mode, [], 'token が違う')
      }
    }
    const report = applyPlan(db, plan, tables, options)
    if (report.violations.length > 0) {
      db.exec('ROLLBACK')
      for (const table of report.violations) state.excluded.add(table)
      const message =
        `外部キーの違反が残るので、作り直しの対象から外した: ` +
        report.violations.join(', ')
      state.warnings.push(message)
      hooks.onWarning?.(message)
      return outcome(state, 'excluded', mode, report.applied, message)
    }
    db.exec('COMMIT')
    state.skips = 0
    state.generation += 1
    return outcome(
      state,
      'applied',
      mode,
      report.applied,
      undefined,
      report.counts,
      report.discarded
    )
  }

  let result: RowsRebuildOutcome
  try {
    result = body()
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    restore()
    if (isBusy(error)) {
      state.skips += 1
      return outcome(state, 'deferred', mode, [], '適用の途中で待たされた')
    }
    throw error
  }
  restore()
  // 知らせるのは `PRAGMA` を戻したあと。利用者の処理が長引いても、
  // アプリの接続の `foreign_keys` が OFF のまま残らない
  if (result.status === 'applied') {
    hooks.onRebuildCommitted?.(db, {
      tables: result.tables,
      generation: state.generation,
    })
  }
  return result
}

/** 適用の中で分かったこと。 */
interface ApplyReport {
  applied: string[]
  /** 後始末で触った同期しない表 */
  touched: string[]
  /** 外部キーの検査に落ちて、対象から外すべき表 */
  violations: string[]
  /** アプリの表に当てた差の内訳（入れ替える**前**に数える） */
  counts: RowsRebuildCounts
  /** 版ごと落とした行（原則4） */
  discarded: RebuildPlanDiscarded[]
}

/** トランザクションの中身（設計書 §3.7.2 の箱の中）。 */
function applyPlan(
  db: Database.Database,
  plan: RebuildPlan,
  tables: string[],
  options: RowsRebuildOptions
): ApplyReport {
  const applied = plan.apply.map((table) => table.name)
  // 差は**入れ替える前に**数える。入れ替えたあとでは、消した行も入れた行も
  // 区別が付かない（表全体が計画どおりになっているだけ）
  const counts = countApplied(db, plan)
  raiseFlag(db)
  const dropped = dropApplicationTriggers(db, applied)
  // 消す → 入れる（表全体の入れ替え）。消すのは子から、入れるのは親から
  for (const table of [...plan.apply].reverse()) {
    db.exec(`DELETE FROM ${escapeIdentifier(table.name)}`)
  }
  for (const table of plan.apply) insertRows(db, table)
  // 同期しない表からの外部キーの後始末（設計書 §3.7.5）
  const touched = cleanupUnsyncedChildren(db, applied, tables)
  rewriteOutputs(db, plan, applied)
  restoreApplicationTriggers(db, dropped)
  const violations = checkForeignKeys(db, applied, touched)
  if (violations.length > 0) {
    return { applied, touched, violations, counts, discarded: [] }
  }
  // 親が削除されている子の版を落とす（原則4）。**外部キーの検査を通ってから**
  // 落とすのは、巻き戻す回で版を失わないためである
  const discarded = dropDiscardedVersions(db, plan, applied)
  // 旗が立っている間に消す（下ろしてから消すと、その間の汚れまで消える）
  if (applied.length > 0) {
    db.prepare(
      `DELETE FROM "_sns_dirty" WHERE "tableName" IN (${applied
        .map(() => '?')
        .join(', ')})`
    ).run(...applied)
  }
  lowerFlag(db)
  void options
  return { applied, touched, violations, counts, discarded }
}

/**
 * 親が削除されている子の版を `_sns_rows_<表>` から落とす（原則4）。
 *
 * 落とすのは**適用した表のぶんだけ**。祖先について計算しただけの表には触らない。
 *
 * 墓標は書かない。親の削除の版がすでに他のクライアントへ渡っており、
 * 同じ計算をすれば同じ子が落ちる。子ごとに墓標を書くと、
 * `ON DELETE CASCADE` の連鎖1回で `_tombstone` が子孫の数だけ膨らむ。
 *
 * @returns 実際に落ちた行（落ちなかったぶんは載せない）
 */
function dropDiscardedVersions(
  db: Database.Database,
  plan: RebuildPlan,
  applied: readonly string[]
): RebuildPlanDiscarded[] {
  if (plan.discarded.length === 0) return []
  const appliedSet = new Set(applied.map(foldIdentifier))
  const dropped: RebuildPlanDiscarded[] = []
  const statements = new Map<string, Database.Statement>()
  for (const entry of plan.discarded) {
    if (!appliedSet.has(foldIdentifier(entry.table))) continue
    let statement = statements.get(entry.table)
    if (statement === undefined) {
      const primaryKey = primaryKeyColumn(db, entry.table).name
      statement = db.prepare(
        `DELETE FROM ${escapeIdentifier(rowsTableName(entry.table))}
          WHERE CAST(${escapeIdentifier(primaryKey)} AS TEXT) = ?`
      )
      statements.set(entry.table, statement)
    }
    if (statement.run(entry.trueId).changes > 0) dropped.push(entry)
  }
  return dropped
}

/**
 * 計画とアプリの表の差を数える（設計書 §4.4）。**入れ替える前に**呼ぶこと。
 */
function countApplied(
  db: Database.Database,
  plan: RebuildPlan
): RowsRebuildCounts {
  const counts: RowsRebuildCounts = { inserted: 0, updated: 0, deleted: 0 }
  const values = new ValueOrdering()
  try {
    for (const table of plan.apply) {
      const statement = db.prepare(
        `SELECT ${table.columns.map(escapeIdentifier).join(', ')}
           FROM ${escapeIdentifier(table.name)}`
      )
      statement.safeIntegers(true)
      const actual = new Map<string, Record<string, SqlValue>>()
      for (const row of statement.all() as Record<string, SqlValue>[]) {
        actual.set(values.idKey(row[table.primaryKey] ?? null), row)
      }
      const seen = new Set<string>()
      for (const row of table.rows) {
        const key = values.idKey(row[table.primaryKey] ?? null)
        seen.add(key)
        const other = actual.get(key)
        if (other === undefined) {
          counts.inserted += 1
        } else if (!sameRow(table.columns, row, other)) {
          counts.updated += 1
        }
      }
      for (const key of actual.keys()) {
        if (!seen.has(key)) counts.deleted += 1
      }
    }
    return counts
  } finally {
    values.close()
  }
}

function raiseFlag(db: Database.Database): void {
  db.exec(
    `INSERT INTO "_sns_rebuilding" ("onlyRow") VALUES (0)
     ON CONFLICT ("onlyRow") DO NOTHING`
  )
}

function lowerFlag(db: Database.Database): void {
  db.exec(`DELETE FROM "_sns_rebuilding"`)
}

/** 計画の行を入れる。**生成列は書かない**（計画の `columns` に入っていない）。 */
function insertRows(db: Database.Database, table: RebuildPlanTable): void {
  if (table.rows.length === 0) return
  const statement = db.prepare(
    `INSERT INTO ${escapeIdentifier(table.name)} (${table.columns
      .map(escapeIdentifier)
      .join(', ')})
     VALUES (${table.columns.map(() => '?').join(', ')})`
  )
  // `BigInt` のまま束縛する（`Number` へ戻すと 2^53 を超える id が壊れる）
  statement.safeIntegers(true)
  for (const row of table.rows) {
    statement.run(
      ...(table.columns.map((column) => row[column] ?? null) as never[])
    )
  }
}

/* ------------------------------------------------------------------ *
 * アプリのトリガーの外し戻し（設計書 §3.7.3）
 * ------------------------------------------------------------------ */

/** 外したトリガー1本。 */
interface SavedTrigger {
  schema: 'main' | 'temp'
  name: string
  sql: string
}

/**
 * 同期する表に付いた**ライブラリ以外の**トリガーを落とす。
 *
 * `DROP TRIGGER` に schema を書くのは、main と temp に同名のトリガーがあると
 * 素の `DROP TRIGGER` が **temp 側を先に落とす**からである。
 */
function dropApplicationTriggers(
  db: Database.Database,
  tables: readonly string[]
): SavedTrigger[] {
  if (tables.length === 0) return []
  const folded = new Set(tables.map(foldIdentifier))
  const saved: SavedTrigger[] = []
  for (const schema of ['main', 'temp'] as const) {
    const source = schema === 'main' ? 'sqlite_master' : 'sqlite_temp_master'
    const rows = db
      .prepare(
        `SELECT name, tbl_name, sql FROM ${source}
          WHERE type = 'trigger' AND sql IS NOT NULL`
      )
      .all() as { name: string; tbl_name: string; sql: string }[]
    for (const row of rows) {
      if (!folded.has(foldIdentifier(row.tbl_name))) continue
      if (isLibraryTrigger(row.name)) continue
      saved.push({ schema, name: row.name, sql: row.sql })
    }
  }
  for (const trigger of saved) {
    db.exec(
      `DROP TRIGGER ${escapeIdentifier(trigger.schema)}.${escapeIdentifier(
        trigger.name
      )}`
    )
  }
  return saved
}

/**
 * 外したトリガーを戻す。
 *
 * `sqlite_temp_master` の `sql` には `TEMP` の語が入らないので、
 * **`CREATE` の直後に挿し直してから**実行する。
 */
function restoreApplicationTriggers(
  db: Database.Database,
  saved: readonly SavedTrigger[]
): void {
  for (const trigger of saved) {
    const sql =
      trigger.schema === 'temp'
        ? trigger.sql.replace(/^(\s*CREATE\s+)/i, '$1TEMP ')
        : trigger.sql
    db.exec(sql)
  }
}

/** ライブラリが作ったトリガーか（外してはいけない）。 */
function isLibraryTrigger(name: string): boolean {
  return name.startsWith('_sns_') || name.startsWith('_sync_')
}

/* ------------------------------------------------------------------ *
 * 同期しない表からの外部キーの後始末（設計書 §3.7.5）
 * ------------------------------------------------------------------ */

/**
 * 消える親を指す**同期しない**子を、宣言された `ON DELETE` に従って始末する。
 *
 * `foreign_keys = OFF` の下では cascade も SET NULL も自動では起きないので、
 * ライブラリが手で当てる。子を消すと、その子を親とする孫が孤児になるので、
 * **変化が無くなるまで繰り返す**。
 *
 * @returns 触った表
 */
function cleanupUnsyncedChildren(
  db: Database.Database,
  applied: readonly string[],
  synced: readonly string[]
): string[] {
  const syncedSet = new Set(synced.map(foldIdentifier))
  const unsynced = allUserTables(db).filter(
    (table) => !syncedSet.has(foldIdentifier(table))
  )
  const touched = new Set<string>()
  const queue = [...applied]
  const seen = new Set<string>()
  let rounds = 0
  while (queue.length > 0) {
    rounds += 1
    if (rounds > unsynced.length + applied.length + 1) break
    const parent = queue.shift() as string
    if (seen.has(foldIdentifier(parent))) continue
    seen.add(foldIdentifier(parent))
    for (const child of unsynced) {
      for (const key of foreignKeysOf(db, child)) {
        if (foldIdentifier(key.parentTable) !== foldIdentifier(parent)) continue
        const changes = applyMissingParentAction(db, child, parent, key)
        if (changes === 0) continue
        touched.add(child)
        queue.push(child)
        seen.delete(foldIdentifier(child))
      }
    }
  }
  return [...touched]
}

/** 外部キー1本ぶんの後始末。@returns 変えた行数 */
function applyMissingParentAction(
  db: Database.Database,
  child: string,
  parent: string,
  key: {
    columns: string[]
    parentColumns: string[]
    onDelete: string
  }
): number {
  const parentColumns =
    key.parentColumns.length > 0
      ? key.parentColumns
      : primaryKeyNames(db, parent)
  if (parentColumns.length !== key.columns.length) return 0
  const quotedChild = escapeIdentifier(child)
  // 外部キーの列に NULL があると SQLite は検査しないので、孤児ではない
  const notNull = key.columns
    .map((column) => `${escapeIdentifier(column)} IS NOT NULL`)
    .join(' AND ')
  const match = parentColumns
    .map(
      (column, at) =>
        `"p".${escapeIdentifier(column)} IS ${quotedChild}.${escapeIdentifier(
          key.columns[at]
        )}`
    )
    .join(' AND ')
  const orphan = `${notNull} AND NOT EXISTS (
       SELECT 1 FROM ${escapeIdentifier(parent)} AS "p" WHERE ${match})`

  const columns = tableColumns(db, child)
  switch (missingParentAction(key.onDelete)) {
    case 'setNull': {
      const notNullColumn = key.columns.some((column) =>
        columns.some(
          (info) =>
            foldIdentifier(info.name) === foldIdentifier(column) &&
            info.notnull === 1
        )
      )
      if (notNullColumn) {
        return db.prepare(`DELETE FROM ${quotedChild} WHERE ${orphan}`).run()
          .changes
      }
      return db
        .prepare(
          `UPDATE ${quotedChild} SET ${key.columns
            .map((column) => `${escapeIdentifier(column)} = NULL`)
            .join(', ')} WHERE ${orphan}`
        )
        .run().changes
    }
    case 'setDefault': {
      const defaults = key.columns.map((column) => {
        const info = columns.find(
          (entry) => foldIdentifier(entry.name) === foldIdentifier(column)
        )
        const text = info?.dflt_value
        return typeof text === 'string' ? `(${text})` : 'NULL'
      })
      const updated = db
        .prepare(
          `UPDATE ${quotedChild} SET ${key.columns
            .map(
              (column, at) => `${escapeIdentifier(column)} = ${defaults[at]}`
            )
            .join(', ')} WHERE ${orphan}`
        )
        .run().changes
      // 既定値の指す親も居なければ、その子は残せない
      const removed = db
        .prepare(`DELETE FROM ${quotedChild} WHERE ${orphan}`)
        .run().changes
      return updated + removed
    }
    default:
      // 'drop'（CASCADE / RESTRICT / NO ACTION）。RESTRICT と NO ACTION でも
      // 消すのは、残すと外部キーの検査に引っかかり、その表が永久に
      // 作り直せなくなるからである（設計書 §3.7.5）
      return db.prepare(`DELETE FROM ${quotedChild} WHERE ${orphan}`).run()
        .changes
  }
}

/* ------------------------------------------------------------------ *
 * 外部キーの検査（設計書 §3.7.2 の必須4）
 * ------------------------------------------------------------------ */

/**
 * `PRAGMA foreign_key_check(<表>)` を1つずつ回す。
 *
 * **引数は1つだけ**で、その表が**子である**違反しか返さない。だから
 * 「適用した表・後始末で触った表」だけでなく、**それらを親として参照している
 * すべての表**も対象に含める。
 *
 * @returns 対象から外すべき表（違反の子が適用した表ならその表、そうでなければ親）
 */
function checkForeignKeys(
  db: Database.Database,
  applied: readonly string[],
  touched: readonly string[]
): string[] {
  const appliedSet = new Set(applied.map(foldIdentifier))
  const written = new Set([...applied, ...touched])
  const writtenFolded = new Set([...written].map(foldIdentifier))
  const subjects = new Set(written)
  for (const table of allUserTables(db)) {
    for (const key of foreignKeysOf(db, table)) {
      if (writtenFolded.has(foldIdentifier(key.parentTable))) {
        subjects.add(table)
      }
    }
  }
  const excluded = new Set<string>()
  for (const table of subjects) {
    const violations = db.pragma(
      `foreign_key_check(${escapeIdentifier(table)})`
    ) as { table: string; parent: string }[]
    for (const violation of violations) {
      if (appliedSet.has(foldIdentifier(table))) {
        excluded.add(table)
        continue
      }
      if (appliedSet.has(foldIdentifier(violation.parent))) {
        excluded.add(violation.parent)
        continue
      }
      // どちらも適用した表でない（もともと壊れていた）。外す表が決まらないと
      // 同じ計画で何度も落ちるので、適用した表をまとめて外す
      for (const name of applied) excluded.add(name)
    }
  }
  return [...excluded]
}

/* ------------------------------------------------------------------ *
 * 作り直しの出力（`_sns_shown` / `_sns_hidden` / `_sns_unplaceable`）
 * ------------------------------------------------------------------ */

/** 適用した表の分だけ書き直す（祖先について計算した分は書かない）。 */
function rewriteOutputs(
  db: Database.Database,
  plan: RebuildPlan,
  applied: readonly string[]
): void {
  if (applied.length === 0) return
  const holes = applied.map(() => '?').join(', ')
  const appliedSet = new Set(applied.map(foldIdentifier))
  for (const table of ['_sns_shown', '_sns_hidden'] as const) {
    db.prepare(
      `DELETE FROM ${escapeIdentifier(table)} WHERE "tableName" IN (${holes})`
    ).run(...applied)
  }
  const shown = db.prepare(
    `INSERT INTO "_sns_shown" ("tableName", "trueId", "shownId") VALUES (?, ?, ?)`
  )
  for (const entry of plan.shown) {
    if (!appliedSet.has(foldIdentifier(entry.table))) continue
    shown.run(entry.table, entry.trueId, entry.shownId)
  }
  const hidden = db.prepare(
    `INSERT INTO "_sns_hidden" ("tableName", "trueId", "winnerId") VALUES (?, ?, ?)`
  )
  for (const entry of plan.hidden) {
    if (!appliedSet.has(foldIdentifier(entry.table))) continue
    hidden.run(entry.table, entry.trueId, entry.winnerId)
  }
  // `_sns_unplaceable` は**警告の重複を避けるため**の表なので、すでに知らせた
  // 行は消さずに残し（行があれば同じ警告を繰り返さない）、いま置けるようになった
  // 行だけを落とす
  const keep = new Set(
    plan.unplaceable
      .filter((entry) => appliedSet.has(foldIdentifier(entry.table)))
      .map((entry) => `${entry.table} ${entry.trueId}`)
  )
  const existing = db
    .prepare(
      `SELECT "tableName", "trueId" FROM "_sns_unplaceable"
        WHERE "tableName" IN (${holes})`
    )
    .all(...applied) as { tableName: string; trueId: string }[]
  const remove = db.prepare(
    `DELETE FROM "_sns_unplaceable" WHERE "tableName" = ? AND "trueId" = ?`
  )
  for (const row of existing) {
    if (keep.has(`${row.tableName} ${row.trueId}`)) continue
    remove.run(row.tableName, row.trueId)
  }
  const upsert = db.prepare(
    `INSERT INTO "_sns_unplaceable" ("tableName", "trueId", "reason")
     VALUES (?, ?, ?)
     ON CONFLICT ("tableName", "trueId") DO UPDATE SET
       "reason" = "excluded"."reason"`
  )
  for (const entry of plan.unplaceable) {
    if (!appliedSet.has(foldIdentifier(entry.table))) continue
    upsert.run(entry.table, entry.trueId, entry.reason)
  }
}

/* ------------------------------------------------------------------ *
 * 小道具
 * ------------------------------------------------------------------ */

function beginImmediate(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE')
}

function isBusy(error: unknown): boolean {
  return (error as { code?: string }).code === 'SQLITE_BUSY'
}

function outcome(
  state: RowsRebuildState,
  status: RowsRebuildOutcome['status'],
  mode: 'normal' | 'merged',
  tables: string[],
  reason?: string,
  counts?: RowsRebuildCounts,
  discarded?: RebuildPlanDiscarded[]
): RowsRebuildOutcome {
  return {
    status,
    mode,
    tables,
    skips: state.skips,
    generation: state.generation,
    warnings: [...state.warnings],
    reason,
    counts: counts ?? { inserted: 0, updated: 0, deleted: 0 },
    discarded: discarded ?? [],
  }
}

function canonicalTables(
  db: Database.Database,
  tables: readonly string[]
): string[] {
  const specs = canonicalTableSpecs(db, [...tables])
  // 適用の順（親が先）に並べておく。消すときはこれを逆に回る
  return dependencyOrder(
    db,
    specs.map((spec) => spec.name)
  )
}

/** `_sns_dirty` に何か載っているか（載っていなければ作り直すものが無い）。 */
function hasWork(db: Database.Database, options: RowsRebuildOptions): boolean {
  if (options.targets !== undefined) return options.targets.length > 0
  return db.prepare(`SELECT 1 FROM "_sns_dirty" LIMIT 1`).get() !== undefined
}

/**
 * ライブラリの表を除いた、この DB のふつうの表。
 *
 * `_heartbeat` と `_id_merge` は**もう作らない**が、除外の名前は残す。旧版で
 * 作られた DB にはこれらの表がまだ在りうるので、外すと「アプリの表」として
 * 拾われてしまう。
 */
function allUserTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
            AND name NOT LIKE '\\_sns\\_%' ESCAPE '\\'
            AND name NOT IN ('_tombstone', '_changelog', '_changelog_prune',
                             '_heartbeat', '_sync_meta', '_sync_state', '_id_merge')`
      )
      .all() as { name: string }[]
  ).map((row) => row.name)
}

function tableColumns(db: Database.Database, table: string): RowsColumn[] {
  return db.pragma(`table_xinfo(${escapeIdentifier(table)})`) as RowsColumn[]
}

function primaryKeyNames(db: Database.Database, table: string): string[] {
  return tableColumns(db, table)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
}

/** 計画の行と、いまのアプリの表の行の差の件数。 */
function countDifferences(
  db: Database.Database,
  table: RebuildPlanTable,
  values: ValueOrdering
): number {
  const statement = db.prepare(
    `SELECT ${table.columns.map(escapeIdentifier).join(', ')}
       FROM ${escapeIdentifier(table.name)}`
  )
  statement.safeIntegers(true)
  const actual = new Map<string, Record<string, SqlValue>>()
  for (const row of statement.all() as Record<string, SqlValue>[]) {
    actual.set(values.idKey(row[table.primaryKey] ?? null), row)
  }
  let diff = 0
  const seen = new Set<string>()
  for (const row of table.rows) {
    const key = values.idKey(row[table.primaryKey] ?? null)
    seen.add(key)
    const other = actual.get(key)
    if (other === undefined) {
      diff += 1
      continue
    }
    if (!sameRow(table.columns, row, other)) diff += 1
  }
  for (const key of actual.keys()) {
    if (!seen.has(key)) diff += 1
  }
  return diff
}

function sameRow(
  columns: readonly string[],
  a: Record<string, SqlValue>,
  b: Record<string, SqlValue>
): boolean {
  return columns.every((column) =>
    sameValue(a[column] ?? null, b[column] ?? null)
  )
}

function sameValue(a: SqlValue, b: SqlValue): boolean {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false
    return a.equals(b)
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if (a === null || b === null) return a === b
    if (typeof a === 'string' || typeof b === 'string') return false
    return BigInt(a as bigint | number) === BigInt(b as bigint | number)
  }
  return a === b
}
