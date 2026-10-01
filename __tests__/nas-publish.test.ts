/**
 * NAS の写しの作り方（`copyToNas`）。
 *
 * 見るのは次のとおり。
 *
 * 1. 写しの文字コードは元の DB と同じ。UTF-16 の DB でも同期が止まらない
 * 2. 手元の一時領域は写しの大きさ程度で、DB 全体を写さない
 * 3. 区切って作り、区切りの間にイベントループへ戻る。それでも写しは呼んだ時点の一貫したもの
 * 4. WAL でない DB では、区切りの間にイベントループへ戻らない
 * 5. 載せるのは他の端末が読む表だけで、`_sns_rows_<表>` はいま同期している表の分だけ
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { copyToNas } from '../src/nas'
import { SyncConfig, SyncInstance } from '../src/types'

const testDir = path.join(__dirname, 'test-data-nas-publish')
const nasDir = path.join(testDir, 'nas')
const tmpRoot = path.join(testDir, 'tmp')
/** `copyToNas` が一時ファイルを置くディレクトリ（`os.tmpdir()/sqlite-nas-sync`） */
const copyDir = path.join(tmpRoot, 'sqlite-nas-sync')
const AT = '2026-09-01T00:00:00.000Z'

let savedTmpDir: string | undefined
const instances: SyncInstance[] = []

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(nasDir, { recursive: true })
  fs.mkdirSync(tmpRoot, { recursive: true })
  savedTmpDir = process.env.TMPDIR
  process.env.TMPDIR = tmpRoot
})

afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop()
  if (savedTmpDir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = savedTmpDir
  fs.rmSync(testDir, { recursive: true, force: true })
})

/** アプリの DB を作る。`encoding` を渡すと、その文字コードの DB にする。 */
function createDb(name: string, encoding?: string): string {
  const dbPath = path.join(testDir, `${name}.sqlite`)
  const db = new Database(dbPath)
  if (encoding !== undefined) db.pragma(`encoding = '${encoding}'`)
  db.exec(
    `CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
  )
  db.close()
  return dbPath
}

function setup(dbPath: string, clientId: string, extra?: Partial<SyncConfig>) {
  const instance = setupSync({
    dbPath,
    nasPath: nasDir,
    clientId,
    schemaVersion: 'publish-1',
    ...extra,
  })
  instances.push(instance)
  return instance
}

function write(dbPath: string, id: string, body: string): void {
  const db = new Database(dbPath)
  db.prepare(
    `INSERT INTO notes (id, body, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET body = excluded.body`
  ).run(id, body, AT)
  db.close()
}

function notes(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare(`SELECT id, body FROM notes ORDER BY id`).all()
  } finally {
    db.close()
  }
}

/** NAS の写しを読み取り専用で開いて `read` に渡す。 */
function readCopy<T>(clientId: string, read: (copy: Database.Database) => T) {
  const copy = new Database(path.join(nasDir, `client-${clientId}.sqlite`), {
    readonly: true,
  })
  try {
    return read(copy)
  } finally {
    copy.close()
  }
}

function tablesOf(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .all() as { name: string }[]
  ).map((row) => row.name)
}

function directoryBytes(dir: string): number {
  let total = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    try {
      total += fs.statSync(path.join(dir, name)).size
    } catch {
      /* 数える間に消えた */
    }
  }
  return total
}

describe('写しの文字コード', () => {
  it.each(['UTF-16le', 'UTF-16be'])(
    '%s の DB でも同期が止まらず、UTF-8 の DB と行が行き来する',
    async (encoding) => {
      const pathA = createDb('a', encoding)
      const pathB = createDb('b')
      const syncA = setup(pathA, 'a')
      const syncB = setup(pathB, 'b')

      write(pathA, 'x', 'こんにちは')
      await syncA.syncNow()
      await syncB.syncNow()
      expect(notes(pathB)).toEqual([{ id: 'x', body: 'こんにちは' }])

      write(pathB, 'y', 'さようなら')
      await syncB.syncNow()
      await syncA.syncNow()
      expect(notes(pathA)).toEqual([
        { id: 'x', body: 'こんにちは' },
        { id: 'y', body: 'さようなら' },
      ])

      expect(
        readCopy('a', (copy) => copy.pragma('encoding', { simple: true }))
      ).toBe(encoding)
      expect(
        readCopy('b', (copy) => copy.pragma('encoding', { simple: true }))
      ).toBe('UTF-8')
    }
  )
})

describe('手元の一時領域', () => {
  it('写しの大きさ程度で、DB 全体を写さない', async () => {
    const dbPath = path.join(testDir, 'big.sqlite')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    // 他の端末が読まない表を大きく、読む表を小さくする
    db.exec(`
      CREATE TABLE big (id INTEGER PRIMARY KEY, body BLOB);
      CREATE TABLE _sns_rows_notes (id TEXT PRIMARY KEY, body, _sns_ts);
    `)
    const insert = db.prepare(`INSERT INTO big (body) VALUES (zeroblob(4096))`)
    db.transaction(() => {
      for (let row = 0; row < 2000; row += 1) insert.run()
    })()
    db.prepare(
      `INSERT INTO _sns_rows_notes (id, body, _sns_ts) VALUES ('n1', 'hello', 1)`
    ).run()
    db.pragma('wal_checkpoint(TRUNCATE)')
    const dbBytes = fs.statSync(dbPath).size

    // 一時領域の大きさを、SQL を1つ実行するたびと、イベントループへ戻るたびに見る。
    // 写しを作る処理はどちらかを必ず挟むので、一時ファイルが最も大きい時点を見逃さない
    let peak = 0
    const sample = (): void => {
      peak = Math.max(peak, directoryBytes(copyDir))
    }
    const statement = Object.getPrototypeOf(db.prepare(`SELECT 1`)) as {
      run: (...args: unknown[]) => unknown
    }
    const database = Database.prototype as unknown as {
      exec: (sql: string) => unknown
    }
    const realRun = statement.run
    const realExec = database.exec
    statement.run = function (this: unknown, ...args: unknown[]) {
      const out = realRun.apply(this, args)
      sample()
      return out
    }
    database.exec = function (this: unknown, sql: string) {
      const out = realExec.call(this, sql)
      sample()
      return out
    }
    let running = true
    const tick = (): void => {
      sample()
      if (running) setImmediate(tick)
    }
    setImmediate(tick)
    try {
      await copyToNas(db, nasDir, 'me', ['notes'])
    } finally {
      running = false
      statement.run = realRun
      database.exec = realExec
      db.close()
    }

    const copyBytes = fs.statSync(path.join(nasDir, 'client-me.sqlite')).size
    expect(copyBytes).toBeLessThan(dbBytes / 10)
    expect(peak).toBeLessThanOrEqual(copyBytes * 2)
    expect(directoryBytes(copyDir)).toBe(0)
  })
})

describe('区切って作る写し', () => {
  /** 同期する表 `notes` に `count` 行を入れた DB を作り、`setupSync` の仕掛けを付ける。 */
  function seededDb(count: number): string {
    const dbPath = createDb('seeded')
    setup(dbPath, 'seeded').stop()
    const app = new Database(dbPath)
    const insert = app.prepare(
      `INSERT INTO notes (id, body, updatedAt) VALUES (?, ?, ?)`
    )
    app.transaction(() => {
      for (let row = 0; row < count; row += 1) {
        insert.run(`n${String(row)}`, 'x'.repeat(200), AT)
      }
    })()
    app.close()
    return dbPath
  }

  interface Snapshot {
    rows: number
    changelog: number
    maxId: number
    sequence: number
  }

  function snapshotOf(db: Database.Database): Snapshot {
    const value = (sql: string): number =>
      (db.prepare(sql).get() as { n: number }).n
    return {
      rows: value(`SELECT COUNT(*) AS n FROM _sns_rows_notes`),
      changelog: value(`SELECT COUNT(*) AS n FROM _changelog`),
      maxId: value(`SELECT MAX(id) AS n FROM _changelog`),
      sequence: value(
        `SELECT seq AS n FROM sqlite_sequence WHERE name = '_changelog'`
      ),
    }
  }

  it(
    '区切りの間にアプリが書けて、写しは呼んだ時点のまま一貫している',
    { timeout: 60_000 },
    async () => {
      const dbPath = seededDb(30_000)
      const lib = new Database(dbPath)
      const app = new Database(dbPath)
      app.pragma('recursive_triggers = ON')
      const before = snapshotOf(lib)

      // 区切りの間に、別の接続からアプリが書く。書くたびに `_sns_rows_notes` と
      // `_changelog` が1行ずつ増える
      const insert = app.prepare(
        `INSERT INTO notes (id, body, updatedAt) VALUES (?, 'during', ?)`
      )
      let writes = 0
      let running = true
      const writer = (): void => {
        if (!running || writes >= 200) return
        insert.run(`w${String(writes)}`, AT)
        writes += 1
        setImmediate(writer)
      }
      setImmediate(writer)
      try {
        await copyToNas(lib, nasDir, 'me', ['notes'])
      } finally {
        running = false
      }
      const after = snapshotOf(lib)
      lib.close()
      app.close()

      // 写しを作る間に、アプリの書き込みが何度も通った
      expect(writes).toBeGreaterThan(1)
      expect(after.rows).toBe(before.rows + writes)
      // 写しは呼んだ時点のもの。行の版・通知・`sqlite_sequence` が同じ時点で揃う
      readCopy('me', (copy) => {
        expect(snapshotOf(copy)).toEqual(before)
        const orphan = copy
          .prepare(
            `SELECT COUNT(*) AS n FROM _changelog
            WHERE recordId NOT IN (SELECT id FROM _sns_rows_notes)`
          )
          .get() as { n: number }
        expect(orphan.n).toBe(0)
      })
    }
  )

  it('WAL でない DB では、区切りの間にイベントループへ戻らない', async () => {
    const dbPath = path.join(testDir, 'rollback.sqlite')
    const lib = new Database(dbPath)
    lib.pragma('journal_mode = DELETE')
    lib.exec(
      `CREATE TABLE _sns_rows_notes (id TEXT PRIMARY KEY, body, _sns_ts)`
    )
    const seed = lib.prepare(
      `INSERT INTO _sns_rows_notes (id, body, _sns_ts) VALUES (?, ?, 1)`
    )
    lib.transaction(() => {
      for (let row = 0; row < 40_000; row += 1) {
        seed.run(`n${String(row)}`, 'x'.repeat(1000))
      }
    })()
    const app = new Database(dbPath)
    // 待たずに失敗させる。区切りの間に共有ロックを持ったまま戻ると、ここで SQLITE_BUSY になる
    app.pragma('busy_timeout = 0')
    const insert = app.prepare(
      `INSERT INTO _sns_rows_notes (id, body, _sns_ts) VALUES (?, 'during', 2)`
    )
    let failure: unknown = null
    let wrote = false
    setImmediate(() => {
      try {
        insert.run('w')
        wrote = true
      } catch (error) {
        failure = error
      }
    })
    await copyToNas(lib, nasDir, 'me', ['notes'])
    await new Promise((resolve) => setImmediate(resolve))
    lib.close()
    app.close()

    expect(failure).toBeNull()
    expect(wrote).toBe(true)
  })
})

describe('写しに載せる表', () => {
  it('他の端末が読む表だけを載せ、掃除した位置（`_changelog_prune`）も載せる', async () => {
    const dbPath = createDb('a')
    const sync = setup(dbPath, 'a', { changelogRetentionDays: 1 })
    write(dbPath, 'x', 'hello')
    write(dbPath, 'y', 'world')
    await sync.syncNow()
    // 通知を古くして、次の同期の掃除で刈らせる
    const local = new Database(dbPath)
    local.exec(`UPDATE _changelog SET changedAt = '2000-01-01T00:00:00.000Z'`)
    local.close()
    await sync.syncNow()
    // 掃除は写しのあとなので、刈った位置が載るのはその次の写しである
    await sync.syncNow()

    const pruned = (db: Database.Database): unknown =>
      db.prepare(`SELECT prunedThroughId FROM _changelog_prune`).all()
    const reader = new Database(dbPath, { readonly: true })
    const expected = pruned(reader)
    reader.close()
    expect(expected).toEqual([{ prunedThroughId: 2 }])
    readCopy('a', (copy) => {
      expect(tablesOf(copy)).toEqual([
        '_changelog',
        '_changelog_prune',
        '_sns_rows_notes',
        '_sync_meta',
        '_tombstone',
        'sqlite_sequence',
      ])
      expect(pruned(copy)).toEqual(expected)
    })
  })

  it('`_sns_rows_<表>` は、いま同期している表の分だけを載せる', async () => {
    const dbPath = createDb('a')
    const db = new Database(dbPath)
    db.exec(
      `CREATE TABLE old (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
    )
    db.close()
    // はじめは `notes` と `old` を同期する
    setup(dbPath, 'a').stop()
    const local = new Database(dbPath)
    expect(tablesOf(local)).toContain('_sns_rows_old')
    // 同期するどの表にも対応しない `_sns_rows_` の表。版の列があるので `setupSync` は断らない
    local.exec(
      `CREATE TABLE "_sns_rows_stray" (id TEXT PRIMARY KEY, "_sns_ts", "_sns_lamport", "_sns_instance")`
    )
    local.close()

    // `old` の同期をやめる。`_sns_rows_old` は手元に残る
    const sync = setup(dbPath, 'a', { excludeTables: ['old'] })
    write(dbPath, 'x', 'hello')
    await sync.syncNow()

    readCopy('a', (copy) => {
      const tables = tablesOf(copy)
      expect(tables).toContain('_sns_rows_notes')
      expect(tables).not.toContain('_sns_rows_old')
      expect(tables).not.toContain('_sns_rows_stray')
    })
  })
})
