/**
 * 検査器が駆動する「世界」——NASに見立てたディレクトリと、その下の端末DBと、時計。
 *
 * **本物の `performSync` と本物の SQLite ファイルDBを使う。** 抽象モデルは書かない。
 * このライブラリで見つかった不具合の多くは、モデルに書き落とすと消える実装の癖
 * （読み取り専用で開くと `-wal` / `-shm` ができる、0行の `DELETE` ではトリガが
 * 発火しない、書式違いの時刻を字面で比べると逆転する、フルマージで id 順と時刻順が
 * ねじれる）にあった。DBは WAL を使うので**ファイルDB**でなければならない
 * （`:memory:` では WAL が使えない）。
 *
 * **駆動するライブラリは実行時に読み込む**（{@link loadLibrary}）。既知の不具合を
 * 戻した版（tools/explore/mutants.ts）へ差し替えて「検査器が反例を見逃さないこと」を
 * 確かめるためで、`src/` を直接 import するとそれができない。
 *
 * ## 時計
 *
 * トリガは `_changelog.changedAt` と `_tombstone.deletedAt` に**壁時計**を刻む。
 * そのまま使うと、別々の端末への操作 x, y を「x → y」と「y → x」の順に当てたとき、
 * 刻まれる時刻の前後が入れ替わり、**結果の状態が同じにならない**。すると
 * 「別々の端末への操作は入れ替えても結果が同じ」という順序の畳み込み
 * （partial order reduction）の前提が崩れ、畳むと反例を見逃す。しかも同じ列を
 * 再生しても同じミリ秒に収まるかどうかで結果が変わり、反例を再現できない。
 *
 * そこで世界に**時計 C** を1本持たせ、操作が刻んだ時刻は操作の直後に C へ書き換える。
 *
 * - 操作は C を名乗る（同期を挟まない操作は、端末が違っても**同じ瞬間**に起きた扱い）
 * - `tick` 遷移で C を進める（以後の操作は、それまでのどの時刻より後を名乗る）
 * - `performSync` の後も C を進める（同期のあとの操作が、同期の刻んだ時刻より
 *   前を名乗ることは無い）
 *
 * 「C を進める」は、**値を決めずに「まだ誰も名乗っていない瞬間」という印（null）にする**
 * ことで表す。実際の値は、その印のまま操作が来たときに「今 + 1ミリ秒」として決め、
 * 同期の直前に壁時計がその値を追い越すまで待つ。先に値を決めて待つ形にすると、
 * 検査の同期（操作を挟まずに何十回も回す）のたびに最大2ミリ秒の空回しが入り、
 * 実測で時間の4割を食った。状態の正規化では、どの刻みとも等しくない C は
 * 印と同じ「fresh」として扱う（どちらも「以後の操作は全ての刻みより後」で振る舞いが同じ）。
 *
 * これで操作は壁時計に依らない決定的な遷移になり、別々の端末への操作は本当に可換になる。
 * 表せる時刻の並びは「同着」「x が先」「y が先」の3通りとも残る
 * （`x, tick, y` と `y, tick, x` と `x, y`）。
 *
 * **同期そのものが刻む時刻（畳みの墓標、`_id_merge.mergedAt` など）は書き換えない。**
 * それはライブラリの振る舞いそのものなので、触ると本物を駆動したことにならない。
 * その代わり、同期の中の2つの刻みが同じミリ秒に収まるかどうかは実行ごとに揺れうる
 * （検査器の限界として docs/exhaustive-check.md に書いてある）。
 *
 * @module tools/explore/world
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import type { SyncConfig, SyncResult, TableConfig } from '../../src/types'
import { ExploreConfig, TABLE_SETS, idleSuppressionActive } from './config'
import { checkAfterRebuildCommit } from './judgments'
import type { OracleSchema } from './oracles/rows-d1'
import { Op, Transition, applyOp, clientName } from './ops'

/**
 * 案A の作り直しの差し込み口（設計書 §8.2 の `REQUIRED_HOOKS`）。
 *
 * `src/rows/rebuild.ts` の形をそのまま写したもの（`src/` を import すると
 * 「壊した版を駆動する」ができなくなるので、型だけ手で写す）。
 */
export type RebuildHooksIn = {
  duringCompute?: (db: Database.Database) => void
  onRebuildCommitted?: (
    db: Database.Database,
    info: { tables: string[]; generation: number }
  ) => void
  beginImmediate?: (db: Database.Database) => void
  onWarning?: (message: string) => void
}

/** `performSync` へ渡す記憶（`src/sync/rows-sync.ts` の `RowsSyncRuntime`）。 */
export type RuntimeIn = {
  rebuild: unknown
  instanceId?: string
  forceMainThread?: boolean
  hooks?: RebuildHooksIn
  /** 無駄な転送の抑制の覚え（`src/sync/idle.ts` の `IdleMemory`） */
  idle?: unknown
}

/** 作り直しを外から回す口（`REQUIRED_HOOKS` の (1)・(4)）。 */
export type RebuildApi = {
  /** 主スレッドで計算して適用する（ワーカーは1回17ミリ秒かかるので使わない） */
  rebuildOnce: (
    db: Database.Database,
    options: {
      tables: string[]
      targets?: string[]
      state?: unknown
      hooks?: RebuildHooksIn
      mergeAfterSkips?: number
    }
  ) => {
    status: string
    mode: string
    tables: string[]
    skips: number
    generation: number
  }
  /** もう1回だけ作り直して差の件数を返す（適用はしない）。判定8 */
  rebuildDiffCount: (
    db: Database.Database,
    options: { tables: string[]; targets?: string[]; state?: unknown }
  ) => number
  /** まっさらな記憶 */
  createRebuildState: () => unknown
  /** `instanceId` を外から与える口（`REQUIRED_HOOKS` の (6)） */
  createRowsTables: (
    db: Database.Database,
    tables: { name: string }[],
    instanceId: string
  ) => void
  /** 案A の仕掛けを丸ごと取り付ける（差し込み口の筋書きで、素の DB を仕立てる） */
  migrateToRows: (
    db: Database.Database,
    options: { tables: { name: string }[]; instanceId?: string }
  ) => unknown
}

/** 検査器が駆動するライブラリの入口。 */
export type Library = {
  performSync: (
    db: Database.Database,
    config: SyncConfig,
    tables: TableConfig[],
    runtime?: RuntimeIn
  ) => Promise<SyncResult>
  /**
   * 表に触らない帳簿（`_sync_state` / `_changelog_prune` / `_heartbeat` / `_sync_meta`）を作る。
   *
   * 旧方式の `setupChangelog` は**段階6 で消えた**ので、雛形の DB は
   * `setupSync`（`src/index.ts`）と同じ順で仕立てる —— `migrateToRows` で案A の仕掛けを
   * 取り付けてから、この帳簿を作る
   */
  setupRowsLedgers: (db: Database.Database) => void
  /** 案A の作り直しの口。旧方式の版を駆動しているときは `null` */
  rebuild: RebuildApi | null
  /**
   * 無駄な転送の抑制の覚えを作る口（`src/sync/idle.js`）。
   * 抑制を持たない版を駆動しているときは `null`
   */
  createIdleMemory: ((enabled?: boolean) => unknown) | null
}

/**
 * 端末の `instanceId`（設計書 §3.2 の `iid`）。
 *
 * **乱数のままにしない。** `iid` は同着の最後の鍵なので、乱数だと1回の実行で
 * どちらの向きを調べたのかが分からず、再生もできない。端末の番号の順に並ぶ字面を
 * 与えると、端末の入れ替え（reduction.ts の対称性）が `iid` の順位も一緒に
 * 入れ替えることになり、畳み込みがそのまま効く。
 *
 * **限界は残る**: この形では「端末 a の iid が端末 b より小さい」側しか調べられない
 * （tools/explore/normalize.ts の instanceLabels の「限界」）。逆向きを調べるには
 * ここを逆順にして走らせ直すこと。
 */
export function instanceIdFor(index: number): string {
  return `iid-${clientName(index)}`
}

/**
 * コンパイル済みのライブラリを読み込む。
 *
 * @param libDir - `sync.js` と `setup/index.js` を持つディレクトリ
 */
export function loadLibrary(libDir: string): Library {
  const syncPath = path.join(libDir, 'sync.js')
  const setupPath = path.join(libDir, 'setup', 'index.js')
  for (const file of [syncPath, setupPath]) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `駆動するライブラリが見つからない: ${file}（npm run explore で tools と一緒にコンパイルされる）`
      )
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sync = require(syncPath) as Pick<Library, 'performSync'>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const setup = require(setupPath) as Pick<Library, 'setupRowsLedgers'>
  if (typeof setup.setupRowsLedgers !== 'function') {
    throw new Error(
      `${setupPath} に setupRowsLedgers が無い（案A の版を駆動していない）`
    )
  }
  return {
    performSync: sync.performSync,
    setupRowsLedgers: setup.setupRowsLedgers,
    rebuild: loadRebuildApi(libDir),
    createIdleMemory: loadIdleApi(libDir),
  }
}

/**
 * 無駄な転送の抑制の口を読み込む。**無ければ `null`**（抑制を持たない版を
 * 駆動しているあいだは、毎回上げ・毎回読む昔の振る舞いになる）。
 */
function loadIdleApi(libDir: string): ((enabled?: boolean) => unknown) | null {
  const idlePath = path.join(libDir, 'sync', 'idle.js')
  if (!fs.existsSync(idlePath)) return null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const idle = require(idlePath) as {
    createIdleMemory?: (enabled?: boolean) => unknown
  }
  return typeof idle.createIdleMemory === 'function'
    ? idle.createIdleMemory
    : null
}

/**
 * 案A の作り直しの口を読み込む。**無ければ `null`**（旧方式の版を駆動している
 * あいだ、判定8・10・13・20・21 は黙る。偽の反例を出さないため）。
 */
function loadRebuildApi(libDir: string): RebuildApi | null {
  const rebuildPath = path.join(libDir, 'rows', 'rebuild.js')
  const schemaPath = path.join(libDir, 'rows', 'schema.js')
  const migratePath = path.join(libDir, 'rows', 'migrate.js')
  for (const file of [rebuildPath, schemaPath, migratePath]) {
    if (!fs.existsSync(file)) return null
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rebuild = require(rebuildPath) as Pick<
    RebuildApi,
    'rebuildOnce' | 'rebuildDiffCount' | 'createRebuildState'
  >
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const schema = require(schemaPath) as Pick<RebuildApi, 'createRowsTables'>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const migrate = require(migratePath) as Pick<RebuildApi, 'migrateToRows'>
  return {
    rebuildOnce: rebuild.rebuildOnce,
    rebuildDiffCount: rebuild.rebuildDiffCount,
    createRebuildState: rebuild.createRebuildState,
    createRowsTables: schema.createRowsTables,
    migrateToRows: migrate.migrateToRows,
  }
}

/**
 * 表ごとの DDL。`__tests__/helpers/sync-fixtures.ts` と同じ形。
 *
 * **写しを持つ理由**: あちらは vitest の寿命に合わせた足場で、`__tests__/` は
 * 変更も import もしない約束（テスト側の都合で形が変わると、検査器が黙って別の
 * スキーマを調べることになる）。形が同じであることは docs に書いてある。
 */
export const DDL: Record<string, string> = {
  users: `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     updatedAt TEXT NOT NULL
   )`,
  decisions: `CREATE TABLE decisions (
     id TEXT PRIMARY KEY,
     cellKey TEXT NOT NULL UNIQUE,
     value TEXT NOT NULL,
     updatedAt TEXT NOT NULL
   )`,
  tags: `CREATE TABLE tags (
     id        TEXT PRIMARY KEY,
     name      TEXT NOT NULL UNIQUE,
     updatedAt TEXT NOT NULL
   )`,
  tag_notes: `CREATE TABLE tag_notes (
     id        TEXT PRIMARY KEY,
     tagId     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
     body      TEXT NOT NULL,
     updatedAt TEXT NOT NULL
   )`,
  tag_profiles: `CREATE TABLE tag_profiles (
     id        TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
     memo      TEXT NOT NULL,
     updatedAt TEXT NOT NULL
   )`,
  accounts: `CREATE TABLE accounts (
     id        TEXT PRIMARY KEY,
     username  TEXT NOT NULL UNIQUE,
     email     TEXT NOT NULL UNIQUE,
     updatedAt TEXT NOT NULL
   )`,
  /**
   * 時刻列が **INTEGER**（設計書 §1.2.3 の群1）。行の時刻はエポックのミリ秒
   * （tools/explore/ops.ts の `timeValuesFor`）。
   *
   * ここだけ `__tests__/helpers/sync-fixtures.ts` に写しが無い（検査器のための表）。
   */
  epoch_notes: `CREATE TABLE epoch_notes (
     id        TEXT PRIMARY KEY,
     name      TEXT NOT NULL UNIQUE,
     updatedAt INTEGER NOT NULL
   )`,
  /**
   * 時刻列が **`COLLATE NOCASE` で宣言された TEXT**（設計書 §1.2.3 の群2）。行の時刻は
   * `julianday` で読めない文字列で、**大文字小文字だけが違う**組を含む。
   *
   * 素の比較（＝列の宣言の照合順序）に任せると `TS-A` と `ts-a` が同着になり、
   * 値が違うのに前後が付かない。`COLLATE BINARY` を明示してある実装ではバイト列で前後が付く。
   */
  nocase_notes: `CREATE TABLE nocase_notes (
     id        TEXT PRIMARY KEY,
     name      TEXT NOT NULL UNIQUE,
     updatedAt TEXT COLLATE NOCASE NOT NULL
   )`,
}

/** 選んだ組の表だけを同期対象にする（空の表を足しても同期が遅くなるだけで何も踏めない）。 */
export function tableConfigs(config: ExploreConfig): TableConfig[] {
  return TABLE_SETS[config.tableSet].map((name) => ({ name }))
}

export type Client = {
  id: string
  db: Database.Database
  config: SyncConfig
}

export type World = {
  dir: string
  nasDir: string
  clients: Client[]
  tables: TableConfig[]
  /**
   * 時計 C（ISO-T、ミリ秒まで）。null は「まだ誰も名乗っていない瞬間」の印。
   * モジュール冒頭の「時計」を参照
   */
  clock: string | null
  /**
   * これまでに名乗った C の最大値（ミリ秒）。次に名乗る C は必ずこれより後にする
   * （{@link concreteClock}）
   */
  clockFloor: number
  /**
   * 読んだ中身の覚え（tools/explore/state.ts の readWorld が使う）。**世界を開くたびに空から
   * 始める**（複製から戻したファイルは、inode や更新時刻が偶然前と揃いうるので信用しない）
   */
  readCache: Map<string, { stamp: string; value: unknown }>
  /**
   * 端末ごとの「無駄な転送の抑制」の覚え（`src/sync/idle.ts` の `IdleMemory`）。
   *
   * **世界を開くたびに空から始める。** 空の覚えは「立ち上げ直した直後」と同じで、
   * その回は必ず上げ・必ず読む —— つまり**何も落とさない側**へ倒れる。
   * 状態から世界を復元して続きを探るこの検査器では、これが安全な始め方である
   * （{@link idleMemoryFor} の「状態を分けない根拠」を参照）
   */
  idle: Map<number, unknown>
  /** この探索の設定（抑制を入れるかの判断に使う） */
  config: ExploreConfig
}

/**
 * 操作が名乗る時刻を決める。印（null）なら「今 + 1ミリ秒」と「前に名乗った C + 1ミリ秒」の
 * 遅い方。
 *
 * - 同期が刻んだ時刻（≦ 今）よりも厳密に後になる
 * - **前に名乗った C よりも厳密に後になる。** C は「今 + 1ミリ秒」なので未来を指しうる。
 *   `tick` の直後に同じミリ秒で操作すると、今 + 1 が前の C と等しくなり、進めたはずの時計が
 *   進まない（同着になるかどうかが実行ごとに揺れる）
 *
 * このあと SQLite が刻む現在時刻より厳密に前であることは、同期の直前に
 * {@link waitPastClock} で待って保証する。
 */
function concreteClock(world: World): string {
  if (world.clock === null) {
    const ms = Math.max(Date.now() + 1, world.clockFloor + 1)
    world.clockFloor = ms
    setClock(world, new Date(ms).toISOString())
  }
  return world.clock as string
}

/**
 * 壁時計が C を厳密に追い越すまで待つ。待たずに同期すると、同期が同じミリ秒に刻んで
 * **操作と同期が同着**になり、「同期は操作より後に起きた」が確率的に崩れる
 * （再生するたびに状態が変わり、反例を再現できなくなる）。
 */
function waitPastClock(world: World): void {
  if (world.clock === null) return
  const limit = Date.parse(world.clock)
  while (Date.now() <= limit) {
    // 高々2ミリ秒。setTimeout は最小でも1ミリ秒以上ぶれるので回して待つ
  }
}

function clockFile(dir: string): string {
  return path.join(dir, 'clock.txt')
}

function openClients(dir: string, config: ExploreConfig): Client[] {
  const nasDir = path.join(dir, 'nas')
  return Array.from({ length: config.clients }, (_, index) => {
    const id = clientName(index)
    const dbPath = path.join(dir, id, 'local.sqlite')
    // WAL はファイルに残る設定なので開き直すたびに指定しなくてよい（雛形で指定済み）
    const db = new Database(dbPath)
    return {
      id,
      db,
      config: {
        dbPath,
        nasPath: nasDir,
        clientId: id,
        primaryKey: 'id',
        changelogRetentionDays: 7,
      },
    }
  })
}

/**
 * 空の世界の雛形を作る（ワーカーの起動時に1回）。以後の世界はこの複製から作る。
 *
 * DDL と `setupChangelog` を世界ごとに流すと、それだけで端末あたり数ミリ秒かかる。
 */
export function buildTemplate(
  lib: Library,
  templateDir: string,
  config: ExploreConfig
): void {
  fs.rmSync(templateDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(templateDir, 'nas'), { recursive: true })
  const tables = tableConfigs(config)
  for (let index = 0; index < config.clients; index += 1) {
    const clientDir = path.join(templateDir, clientName(index))
    fs.mkdirSync(clientDir, { recursive: true })
    const db = new Database(path.join(clientDir, 'local.sqlite'))
    db.pragma('journal_mode = WAL')
    for (const table of TABLE_SETS[config.tableSet]) db.exec(DDL[table])
    // `setupSync`（src/index.ts）と同じ順。移行が `_sync_state` を空にするので、
    // 帳簿はそのあとで作る
    if (lib.rebuild === null) {
      throw new Error(
        '案A の作り直しの口（rows/rebuild.js・rows/schema.js・rows/migrate.js）が見つからない'
      )
    }
    lib.rebuild.migrateToRows(db, {
      tables: tables.map((table) => ({ name: table.name })),
      instanceId: instanceIdFor(index),
    })
    lib.setupRowsLedgers(db)
    db.close()
  }
  fs.writeFileSync(clockFile(templateDir), '')
}

/** ディレクトリにある世界を開く。 */
function openWorld(dir: string, config: ExploreConfig): World {
  return {
    dir,
    nasDir: path.join(dir, 'nas'),
    clients: openClients(dir, config),
    tables: tableConfigs(config),
    clock: readClock(dir).clock,
    clockFloor: readClock(dir).floor,
    readCache: new Map(),
    idle: new Map(),
    config,
  }
}

function readClock(dir: string): { clock: string | null; floor: number } {
  const text = fs.readFileSync(clockFile(dir), 'utf8')
  if (text === '') return { clock: null, floor: 0 }
  return JSON.parse(text) as { clock: string | null; floor: number }
}

/** 雛形から空の世界を作る。時計は印（まだ誰も名乗っていない瞬間）から始める。 */
export function createWorld(
  templateDir: string,
  dir: string,
  config: ExploreConfig
): World {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(templateDir, dir, { recursive: true })
  const world = openWorld(dir, config)
  setClock(world, null)
  return world
}

function setClock(world: World, clock: string | null): void {
  world.clock = clock
  // 複製から戻した世界でも同じ時計の続きになるよう、ファイルにも残す
  fs.writeFileSync(
    clockFile(world.dir),
    JSON.stringify({ clock, floor: world.clockFloor })
  )
}

/** 世界の接続を全部閉じる（閉じると WAL が本体へ書き戻され、`-wal` が消える）。 */
export function closeWorld(world: World): void {
  for (const client of world.clients) {
    try {
      client.db.close()
    } catch {
      // 既に閉じている
    }
  }
}

/**
 * 世界を丸ごと複製する。**閉じてから写す**（WAL が残ったまま写すと、写した先の
 * 本体は古い中身のままで、`-wal` を伴わない限り同じ状態とは言えない）。
 */
export function snapshotWorld(world: World, snapshotDir: string): void {
  closeWorld(world)
  fs.rmSync(snapshotDir, { recursive: true, force: true })
  fs.cpSync(world.dir, snapshotDir, { recursive: true })
}

/** 複製から世界を作り直す。 */
export function restoreWorld(
  snapshotDir: string,
  dir: string,
  config: ExploreConfig
): World {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(snapshotDir, dir, { recursive: true })
  return openWorld(dir, config)
}

/**
 * 1つの操作を当て、操作が刻んだ時刻を時計 C へ書き換える。
 *
 * 書き換えるのは**この操作で増えた** `_changelog` の行（id が操作前の採番値より大きい）と、
 * **この操作で書かれた** `_tombstone` の行（操作前に同じ (表, id, 削除時刻) が無かった）
 * だけ。`ON DELETE CASCADE` で消えた子の分もトリガが刻むので、ここで一緒に揃う。
 * `_changelog` / `_tombstone` にはトリガが無いので、この書き換えは記録を増やさない。
 */
function applyOpWithClock(world: World, clientIndex: number, op: Op): string {
  const client = world.clients[clientIndex]
  const db = client.db
  const clock = concreteClock(world)
  const seqRow = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = '_changelog'`)
    .get() as { seq: number } | undefined
  const seqBefore = seqRow?.seq ?? 0
  const tombKey = (row: {
    tableName: string
    recordId: string
    deletedAt: string
  }): string => JSON.stringify([row.tableName, row.recordId, row.deletedAt])
  const readTombs = (): {
    tableName: string
    recordId: string
    deletedAt: string
  }[] =>
    db
      .prepare(`SELECT tableName, recordId, deletedAt FROM _tombstone`)
      .all() as { tableName: string; recordId: string; deletedAt: string }[]
  const before = new Set(readTombs().map(tombKey))

  const peers = world.clients
    .filter((_, index) => index !== clientIndex)
    .map((peer) => ({ id: peer.id, db: peer.db }))
  const status = applyOp(db, client.id, peers, op)

  db.prepare(`UPDATE _changelog SET changedAt = ? WHERE id > ?`).run(
    clock,
    seqBefore
  )
  const rewrite = db.prepare(
    `UPDATE _tombstone SET deletedAt = ? WHERE tableName = ? AND recordId = ?`
  )
  for (const row of readTombs()) {
    if (!before.has(tombKey(row))) {
      rewrite.run(clock, row.tableName, row.recordId)
    }
  }
  return status
}

/**
 * 遷移の結果。`warnings` は同期の警告、`status` はアプリの書き込みが SQLite から受け取った結果
 * （ops.ts の runStatement。書き込みを含まない遷移では null）。
 */
export type TransitionOutcome = { warnings: string[]; status: string | null }

/**
 * 1つの遷移を当てる。
 *
 * **`performSync` の例外はここで飲まない。** 投げること自体が探している壊れ方なので、
 * 呼び手へ上げる。
 */
export async function applyTransition(
  lib: Library,
  world: World,
  transition: Transition
): Promise<TransitionOutcome> {
  switch (transition.kind) {
    case 'op':
      return {
        warnings: [],
        status: applyOpWithClock(world, transition.client, transition.op),
      }
    case 'tick':
      setClock(world, null)
      return { warnings: [], status: null }
    case 'sync': {
      waitPastClock(world)
      const client = world.clients[transition.client]
      const result = await lib.performSync(
        client.db,
        client.config,
        world.tables,
        runtimeFor(lib, world, transition.client)
      )
      setClock(world, null)
      return { warnings: result.warnings, status: null }
    }
    case 'syncWrite':
      return syncWithWrite(lib, world, transition)
  }
}

/**
 * 同期の最中（`copyToNas` の `localDb.backup()` の待ちの間）にアプリが書く（ops.ts の syncWrite）。
 *
 * **`src/` を変えずに窓へ差し込む**ため、同期のあいだだけ、その端末の接続の `backup` を
 * 差し替える（インスタンスに同名の関数を置き、終わったら消して元のメソッドに戻す）。
 * `copyToNas` は `localDb.backup(tempPath)` を1回だけ呼ぶので、差し込みも1回になる。
 *
 * 書き込みの時刻は、同期の中のそれまでの刻みより後で、同期のそれ以降の刻みより前になるように
 * 取る（時計を印に戻してから名乗り、壁時計が追い越すまで待つ）。こうしないと、書き込みと同期の
 * 刻みが同じミリ秒に収まるかどうかで結果が揺れる。
 *
 * @throws `performSync` が `backup` を呼ばずに戻った場合（書き込みが起きていないのに起きた
 *   ことにすると、履歴が嘘になる）
 */
async function syncWithWrite(
  lib: Library,
  world: World,
  transition: Extract<Transition, { kind: 'syncWrite' }>
): Promise<TransitionOutcome> {
  waitPastClock(world)
  const client = world.clients[transition.client]
  const db = client.db as Database.Database & {
    backup: Database.Database['backup']
  }
  const original = Database.prototype.backup
  let status: string | null = null
  const write = (): void => {
    setClock(world, null)
    status = applyOpWithClock(world, transition.client, transition.op)
    waitPastClock(world)
  }
  db.backup = async function (
    this: Database.Database,
    ...args: Parameters<Database.Database['backup']>
  ): ReturnType<Database.Database['backup']> {
    if (transition.point === 'before-copy') {
      write()
      return original.apply(this, args)
    }
    const progress = await original.apply(this, args)
    write()
    return progress
  }
  let warnings: string[]
  try {
    warnings = (
      await lib.performSync(
        db,
        client.config,
        world.tables,
        runtimeFor(lib, world, transition.client)
      )
    ).warnings
  } finally {
    delete (db as Partial<typeof db>).backup
  }
  setClock(world, null)
  if (status === null) {
    throw new Error(
      '同期の最中の書き込みを差し込めなかった（performSync が copyToNas の backup を呼ばなかった）'
    )
  }
  return { warnings, status }
}

/**
 * 同期1回ぶんの記憶（`RowsSyncRuntime`）。
 *
 * - `instanceId` は端末の番号で決める（{@link instanceIdFor}）。`migrateToRows` から
 *   `createRowsTables(db, tables, instanceId)` へそのまま渡り、`_sns_clock` と
 *   `_sync_meta` の両方が同じ字面になる
 * - `forceMainThread` は必ず立てる。本物のワーカーは1回あたり約17ミリ秒かかり、
 *   1つの列で何百回も作り直す検査器では現実的な時間にならない（`REQUIRED_HOOKS` の (1)）
 * - `rebuild` は**毎回まっさら**。同期をまたいで見送りの回数を持ち回ると、
 *   同じ状態でも前の履歴で振る舞いが変わり、状態の突き合わせが成り立たない
 */
function runtimeFor(
  lib: Library,
  world: World,
  index: number
): RuntimeIn | undefined {
  const api = lib.rebuild
  if (api === null) return undefined
  const names = world.tables.map((table) => table.name)
  const client = world.clients[index]
  return {
    rebuild: api.createRebuildState(),
    idle: idleMemoryFor(lib, world, index),
    instanceId: instanceIdFor(index),
    forceMainThread: true,
    hooks: {
      // 判定8・10・13 を**確定のたびに**当てる（設計書 §8.1）。
      //
      // 違反は例外にして上げる。検査器は `performSync` の例外を反例として
      // 経路つきで書き出す道を既に持っているので、ここを飲み込まずに投げるのが
      // いちばん確かである（飲み込むと、どの遷移で裂けたかが消える）
      onRebuildCommitted: (db, info): void => {
        const failures = checkAfterRebuildCommit(
          db,
          client.id,
          names,
          oracleSchemaOf(world),
          info.tables,
          () =>
            api.rebuildDiffCount(db, { tables: names, targets: info.tables })
        )
        if (failures.length > 0) throw new Error(failures.join(' / '))
      },
    },
  }
}

/**
 * 端末 `index` の「無駄な転送の抑制」の覚え（`src/sync/idle.ts`）。同じ世界の
 * あいだは持ち回る。
 *
 * ## 状態を分けない根拠
 *
 * 覚えは**状態に入れない**（`_sync_meta` にも `_sync_state` にも書かれないので、
 * tools/explore/state.ts が読む対象にそもそも現れない）。それでよいのは、
 * 抑制が落とすのが**状態を変えない回**だけだからである:
 *
 * - **相手を読まない回**: 落とすのは「同じファイル・同じ読み位置で、もう一度
 *   読んでも事実が1つも動かない」と**その場で確かめた**相手だけ
 *   （`src/sync/idle.ts` の `readWouldBeNoOp` と、取り込みが何も動かさなかった
 *   ことの確認）。読んでも読まなくても、どの表の中身も `_sync_state` も変わらない
 * - **上げない回**: 落とすのは手元の印（lamport・`_sns_tick`・`_changelog` の
 *   最大 id・掃除の位置・版・`deleteProtected`）が前に上げたときと同じ回だけ。
 *   上げ直しても、NAS の写しは `sns.generation` が1つ進む以外に違いが無い ——
 *   そして `generation` は「手元と NAS の新旧関係」へ畳んであり、上げても上げなくても
 *   `local=nas` のままである（tools/explore/normalize.ts）。
 *   **だから `--raw-generation` のときは抑制を切る**（`idleSuppressionActive`）
 * - **自分の写しを読まない回**: 復元の判定を省くのは、その写しが自分の書いたもの
 *   だと `stat` で分かるときだけ。判定は必ず「異常なし」になる
 *
 * つまり抑制の有無は、同じ節から**同じ正準の後継**を生む。覚えを状態に足すと、
 * 振る舞いの同じ状態が別物に見えて探索が無駄に広がるだけになる。
 */
function idleMemoryFor(
  lib: Library,
  world: World,
  index: number
): unknown | undefined {
  if (lib.createIdleMemory === null) return undefined
  const kept = world.idle.get(index)
  if (kept !== undefined) return kept
  const memory = lib.createIdleMemory(idleSuppressionActive(world.config))
  world.idle.set(index, memory)
  return memory
}

/** 参照実装へ渡すスキーマ（同期する表の `CREATE TABLE` をそのまま）。 */
function oracleSchemaOf(world: World): OracleSchema {
  return {
    tables: world.tables.map((table) => ({
      name: table.name,
      ddl: DDL[table.name],
      timeColumn: 'updatedAt',
    })),
  }
}

/**
 * 取り込みの一時コピーの残骸を掃く。
 *
 * ワーカーは `TMPDIR` を自分専用にしてある（親が `fork` で渡す）ので、消すのは
 * **自分の残骸だけ**。同時に走っている別の測定の一時ファイルには触らない。
 */
export function purgeRemoteTmp(): void {
  fs.rmSync(path.join(os.tmpdir(), 'sqlite-nas-sync'), {
    recursive: true,
    force: true,
  })
}
