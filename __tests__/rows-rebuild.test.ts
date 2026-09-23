/**
 * 案A の作り直し（`src/rows/rebuild-plan.ts`・`src/rows/rebuild.ts`）の試験。
 * 設計書 `docs/rows-table-design.md` §3.7 と、§11 の段階3 の完了条件。
 *
 * ここで見るのは:
 *
 * - **計算と適用が分かれていること**（計算は1バイトも書かない）
 * - **token の不一致と `SQLITE_BUSY` を見送り、3回続いたら合流経路へ落ちること**
 * - **計算中の書き込みを取りこぼさないこと**
 * - **同期しない表からの外部キーを、宣言どおりに手で始末すること**
 * - **外部キーの違反が残る表は、例外ではなく警告で対象から外すこと**
 * - **適用の前後で事実が増えないこと**、`PRAGMA` が戻ること、
 *   一時トリガーが一時のまま戻ること、冪等であること
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { importFromPeer } from '../src/rows/import'
import {
  computeRebuildPlan,
  readRebuildToken,
  sameRebuildToken,
} from '../src/rows/rebuild-plan'
import {
  computeRebuildPlanInWorker,
  createRebuildState,
  rebuildDiffCount,
  rebuildOnce,
} from '../src/rows/rebuild'
import { RowsTableSpec, createRowsTables } from '../src/rows/schema'
import { createRowsTriggers } from '../src/rows/triggers'

const NOTES = `CREATE TABLE notes (
  id        TEXT PRIMARY KEY NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT,
  updatedAt TEXT
)`

type Row = Record<string, unknown>

const scratch: string[] = []

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sns-rows-rebuild-'))
  scratch.push(dir)
  return dir
}

/** ワーカーを組み上げる先（`node_modules/.cache/` の下）。 */
const WORKER_BUILD = 'rows-worker-test'

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  rmSync(join(process.cwd(), 'node_modules', '.cache', WORKER_BUILD), {
    recursive: true,
    force: true,
  })
})

/** 案A の仕掛けを載せた端末を1つ開く。 */
function openClient(
  instance: string,
  options: {
    statements?: string[]
    tables?: (RowsTableSpec | string)[]
    path?: string
  } = {}
): Database.Database {
  const db = new Database(options.path ?? ':memory:')
  if (options.path !== undefined) db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const statement of options.statements ?? [NOTES]) db.exec(statement)
  const specs = (options.tables ?? ['notes']).map((table) =>
    typeof table === 'string' ? { name: table } : table
  )
  createRowsTables(db, specs, instance)
  createRowsTriggers(db, specs)
  db.exec(`CREATE TABLE IF NOT EXISTS _sync_meta (
             key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.prepare(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('schemaVersion', ?)`
  ).run('app1;sns-format=rows1')
  return db
}

function notesOf(db: Database.Database): Row[] {
  return db.prepare(`SELECT * FROM notes ORDER BY id`).all() as Row[]
}

function countOf(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

function dirtyOf(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT tableName FROM _sns_dirty ORDER BY tableName`).all() as {
      tableName: string
    }[]
  ).map((row) => row.tableName)
}

/** 相手から1件受け取って、作り直しの対象がある状態を作る。 */
function seedFromPeer(
  mine: Database.Database,
  peer: Database.Database,
  tables: string[] = ['notes']
): void {
  importFromPeer(mine, peer, { tables })
}

/* ================================================================== *
 * 計算と適用の分離
 * ================================================================== */

describe('作り直し —— 計算と適用の分離（§3.7.1）', () => {
  it('計算は1バイトも書かない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)

      const plan = computeRebuildPlan(mine, { tables: ['notes'] })
      expect(plan.apply.map((table) => table.name)).toEqual(['notes'])
      expect(plan.apply[0].rows.map((row) => row.id)).toEqual(['k1'])
      // 書いていない
      expect(notesOf(mine)).toEqual([])
      expect(dirtyOf(mine)).toEqual(['notes'])
      expect(mine.inTransaction).toBe(false)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('適用すると、計算した行がアプリの表に入る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', 'x', '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)

      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.status).toBe('applied')
      expect(outcome.tables).toEqual(['notes'])
      expect(notesOf(mine).map((row) => [row.id, row.title])).toEqual([
        ['k1', '相手'],
      ])
      expect(dirtyOf(mine)).toEqual([])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('するものが無ければ何もしない', () => {
    const mine = openClient('aaaa')
    try {
      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.status).toBe('noop')
    } finally {
      mine.close()
    }
  })
})

/* ================================================================== *
 * token と見送り
 * ================================================================== */

describe('作り直し —— token の不一致で見送る（§3.7.2）', () => {
  it('計算中の書き込みがあれば見送り、取りこぼさない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)
      const state = createRebuildState()

      const outcome = rebuildOnce(mine, {
        tables: ['notes'],
        state,
        hooks: {
          // 計算のあと・ロックを取る前にアプリが書く
          duringCompute: (db) => {
            db.prepare(
              `INSERT INTO notes VALUES ('k2', '窓の中', NULL, '2026-03-01')`
            ).run()
          },
        },
      })
      expect(outcome.status).toBe('deferred')
      expect(outcome.reason).toBe('token が違う')
      expect(state.skips).toBe(1)
      // 差し込んだ書き込みは事実になっている（取りこぼしていない）
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_notes`)).toBe(2)

      // もう一度やれば、両方が入る
      const again = rebuildOnce(mine, { tables: ['notes'], state })
      expect(again.status).toBe('applied')
      expect(state.skips).toBe(0)
      expect(notesOf(mine).map((row) => row.id)).toEqual(['k1', 'k2'])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('token は表ごとの tick と importTick で作る', () => {
    const mine = openClient('aaaa')
    try {
      const before = readRebuildToken(mine, ['notes'])
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      const after = readRebuildToken(mine, ['notes'])
      expect(sameRebuildToken(before, after)).toBe(false)
      expect(sameRebuildToken(after, readRebuildToken(mine, ['notes']))).toBe(
        true
      )
    } finally {
      mine.close()
    }
  })
})

describe('作り直し —— SQLITE_BUSY で見送り、3回で合流経路（§3.7.4）', () => {
  it('BEGIN IMMEDIATE が取れないあいだは見送り、4回目は合流経路になる', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)
      const state = createRebuildState()
      let attempts = 0
      const busy = (db: Database.Database): void => {
        attempts += 1
        if (attempts <= 3) {
          const error = new Error('database is locked') as Error & {
            code: string
          }
          error.code = 'SQLITE_BUSY'
          throw error
        }
        db.exec('BEGIN IMMEDIATE')
      }

      const modes: string[] = []
      for (let at = 0; at < 4; at += 1) {
        const outcome = rebuildOnce(mine, {
          tables: ['notes'],
          state,
          hooks: { beginImmediate: busy },
        })
        modes.push(`${outcome.mode}:${outcome.status}`)
      }
      expect(modes).toEqual([
        'normal:deferred',
        'normal:deferred',
        'normal:deferred',
        // 3回見送ったので、計算も適用も1つのトランザクションで行う
        'merged:applied',
      ])
      expect(state.skips).toBe(0)
      expect(notesOf(mine).map((row) => row.id)).toEqual(['k1'])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('見送りのあいだ、アプリの表も PRAGMA も変わらない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)
      const outcome = rebuildOnce(mine, {
        tables: ['notes'],
        hooks: {
          beginImmediate: () => {
            const error = new Error('database is locked') as Error & {
              code: string
            }
            error.code = 'SQLITE_BUSY'
            throw error
          },
        },
      })
      expect(outcome.status).toBe('deferred')
      expect(notesOf(mine)).toEqual([])
      expect(dirtyOf(mine)).toEqual(['notes'])
      expect(Number(mine.pragma('foreign_keys', { simple: true }))).toBe(1)
      expect(mine.inTransaction).toBe(false)
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 同期しない表からの外部キー（§3.7.5）
 * ================================================================== */

const ATTACHMENTS_CASCADE = `CREATE TABLE attachments (
  id     TEXT PRIMARY KEY NOT NULL,
  noteId TEXT REFERENCES notes(id) ON DELETE CASCADE
)`

const ATTACHMENTS_SET_NULL = `CREATE TABLE attachments (
  id     TEXT PRIMARY KEY NOT NULL,
  noteId TEXT REFERENCES notes(id) ON DELETE SET NULL
)`

const ATTACHMENTS_RESTRICT = `CREATE TABLE attachments (
  id     TEXT PRIMARY KEY NOT NULL,
  noteId TEXT NOT NULL REFERENCES notes(id) ON DELETE RESTRICT
)`

/** 同期する `notes` と、同期しない `attachments` を持つ端末。 */
function openWithChild(child: string): {
  mine: Database.Database
  peer: Database.Database
} {
  const mine = openClient('aaaa', { statements: [NOTES, child] })
  const peer = openClient('bbbb')
  return { mine, peer }
}

describe('作り直し —— 同期しない表からの外部キーの後始末（§3.7.5）', () => {
  it('CASCADE の子は消える', () => {
    const { mine, peer } = openWithChild(ATTACHMENTS_CASCADE)
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      mine.prepare(`INSERT INTO attachments VALUES ('a1', 'k1')`).run()
      // 相手が強い版で消す
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k1'`).run()
      seedFromPeer(mine, peer)

      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.status).toBe('applied')
      expect(notesOf(mine)).toEqual([])
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM attachments`)).toBe(0)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('SET NULL の子は残り、外部キーの列が NULL になる', () => {
    const { mine, peer } = openWithChild(ATTACHMENTS_SET_NULL)
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      mine.prepare(`INSERT INTO attachments VALUES ('a1', 'k1')`).run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k1'`).run()
      seedFromPeer(mine, peer)

      rebuildOnce(mine, { tables: ['notes'] })
      expect(mine.prepare(`SELECT * FROM attachments`).all()).toEqual([
        { id: 'a1', noteId: null },
      ])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('RESTRICT の子は消す（残すと、その表が永久に作り直せなくなる）', () => {
    const { mine, peer } = openWithChild(ATTACHMENTS_RESTRICT)
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      mine.prepare(`INSERT INTO attachments VALUES ('a1', 'k1')`).run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k1'`).run()
      seedFromPeer(mine, peer)

      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.status).toBe('applied')
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM attachments`)).toBe(0)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('残る子は消さない（親が入れ直されるなら手を触れない）', () => {
    const { mine, peer } = openWithChild(ATTACHMENTS_CASCADE)
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      mine.prepare(`INSERT INTO attachments VALUES ('a1', 'k1')`).run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)

      rebuildOnce(mine, { tables: ['notes'] })
      expect(notesOf(mine).map((row) => row.title)).toEqual(['相手'])
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM attachments`)).toBe(1)
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 外部キーの検査に落ちた表を外す（§6.2）
 * ================================================================== */

describe('作り直し —— 違反が残る表を外して警告する', () => {
  it('同期しない親を指す行が残る表は、例外にせず対象から外す', () => {
    const authors = `CREATE TABLE authors (id TEXT PRIMARY KEY NOT NULL)`
    const notesWithAuthor = `CREATE TABLE notes (
      id        TEXT PRIMARY KEY NOT NULL,
      authorId  TEXT REFERENCES authors(id),
      title     TEXT NOT NULL,
      updatedAt TEXT
    )`
    const mine = openClient('aaaa', { statements: [authors, notesWithAuthor] })
    const peer = openClient('bbbb', { statements: [authors, notesWithAuthor] })
    try {
      // 相手には居る著者。こちらには居ない（`authors` は同期しない表）
      peer.prepare(`INSERT INTO authors VALUES ('w1')`).run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', 'w1', '相手', '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)

      const warnings: string[] = []
      const state = createRebuildState()
      const outcome = rebuildOnce(mine, {
        tables: ['notes'],
        state,
        hooks: { onWarning: (message) => warnings.push(message) },
      })
      // 例外にはしない
      expect(outcome.status).toBe('applied')
      expect(outcome.tables).toEqual([])
      expect(state.excluded.has('notes')).toBe(true)
      expect(warnings.join('\n')).toContain('notes')
      // 巻き戻っているので、違反した行は入っていない
      expect(notesOf(mine)).toEqual([])
      expect(mine.inTransaction).toBe(false)
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 適用のまわりで壊さないもの
 * ================================================================== */

describe('作り直し —— 適用の前後で壊さないもの', () => {
  it('事実（版・墓標・通知・lamport）が増えない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k2'`).run()
      seedFromPeer(mine, peer)

      const before = {
        rows: countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_notes`),
        tombstones: countOf(mine, `SELECT COUNT(*) AS n FROM _tombstone`),
        changelog: countOf(mine, `SELECT COUNT(*) AS n FROM _changelog`),
        lamport: countOf(mine, `SELECT lamport AS n FROM _sns_clock`),
      }
      rebuildOnce(mine, { tables: ['notes'] })
      expect({
        rows: countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_notes`),
        tombstones: countOf(mine, `SELECT COUNT(*) AS n FROM _tombstone`),
        changelog: countOf(mine, `SELECT COUNT(*) AS n FROM _changelog`),
        lamport: countOf(mine, `SELECT lamport AS n FROM _sns_clock`),
      }).toEqual(before)
      // 旗は下りている
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rebuilding`)).toBe(0)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('PRAGMA foreign_keys が元に戻る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)
      expect(Number(mine.pragma('foreign_keys', { simple: true }))).toBe(1)
      rebuildOnce(mine, { tables: ['notes'] })
      expect(Number(mine.pragma('foreign_keys', { simple: true }))).toBe(1)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('アプリのトリガーは戻り、一時トリガーは一時のまま戻る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      mine.exec(`CREATE TABLE audit (id TEXT, note TEXT)`)
      mine.exec(`CREATE TRIGGER app_audit AFTER INSERT ON notes
                   BEGIN INSERT INTO audit VALUES (NEW.id, 'main'); END`)
      mine.exec(`CREATE TEMP TRIGGER app_audit_temp AFTER INSERT ON notes
                   BEGIN INSERT INTO audit VALUES (NEW.id, 'temp'); END`)
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)

      rebuildOnce(mine, { tables: ['notes'] })
      // 作り直しの書き込みでは、アプリのトリガーは走らない
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM audit`)).toBe(0)
      // 戻っている。temp のものは temp のまま
      expect(
        mine
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='trigger' AND name='app_audit'`
          )
          .get()
      ).toBeDefined()
      expect(
        mine
          .prepare(
            `SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name='app_audit_temp'`
          )
          .get()
      ).toBeDefined()
      expect(
        mine
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='trigger' AND name='app_audit_temp'`
          )
          .get()
      ).toBeUndefined()
      // 戻ったあとのアプリの書き込みでは、ちゃんと走る
      mine
        .prepare(`INSERT INTO notes VALUES ('k2', '手元', NULL, '2026-03-01')`)
        .run()
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM audit`)).toBe(2)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('続けてもう1回作り直しても差が出ない（冪等）', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', 'x', '2026-02-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-02')`)
        .run()
      seedFromPeer(mine, peer)

      rebuildOnce(mine, { tables: ['notes'] })
      expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(0)
      // 汚れが無いので2回目は何もしない
      expect(rebuildOnce(mine, { tables: ['notes'] }).status).toBe('noop')
      expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(0)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('UNIQUE の値を2行の間で入れ替える計画も通る（表全体の入れ替え）', () => {
    const seats = `CREATE TABLE seats (
      id        TEXT PRIMARY KEY NOT NULL,
      slot      TEXT NOT NULL UNIQUE,
      updatedAt TEXT
    )`
    const mine = openClient('aaaa', {
      statements: [seats],
      tables: ['seats'],
    })
    const peer = openClient('bbbb', {
      statements: [seats],
      tables: ['seats'],
    })
    try {
      mine.prepare(`INSERT INTO seats VALUES ('a', 's1', '2026-01-01')`).run()
      mine.prepare(`INSERT INTO seats VALUES ('b', 's2', '2026-01-01')`).run()
      peer.prepare(`INSERT INTO seats VALUES ('a', 's2', '2026-02-01')`).run()
      peer.prepare(`INSERT INTO seats VALUES ('b', 's1', '2026-02-01')`).run()
      importFromPeer(mine, peer, { tables: ['seats'] })

      const outcome = rebuildOnce(mine, { tables: ['seats'] })
      expect(outcome.status).toBe('applied')
      expect(
        mine.prepare(`SELECT id, slot FROM seats ORDER BY id`).all()
      ).toEqual([
        { id: 'a', slot: 's2' },
        { id: 'b', slot: 's1' },
      ])
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 確定の知らせ（差し込み口 (2)）
 * ================================================================== */

describe('作り直し —— 確定したことを知らせる', () => {
  it('確定するたびに、表と generation つきで呼ばれる', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      const seen: { tables: string[]; generation: number }[] = []
      const state = createRebuildState()
      const hooks = {
        onRebuildCommitted: (
          _db: Database.Database,
          info: { tables: string[]; generation: number }
        ): void => {
          seen.push(info)
        },
      }
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)
      rebuildOnce(mine, { tables: ['notes'], state, hooks })

      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-02')`)
        .run()
      seedFromPeer(mine, peer)
      rebuildOnce(mine, { tables: ['notes'], state, hooks })

      expect(seen).toEqual([
        { tables: ['notes'], generation: 1 },
        { tables: ['notes'], generation: 2 },
      ])
      // 知らせるのは `PRAGMA` を戻したあと
      expect(Number(mine.pragma('foreign_keys', { simple: true }))).toBe(1)
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * ワーカーで計算する（§3.7.1）
 * ================================================================== */

describe('作り直し —— worker_threads で計算する', () => {
  it('ワーカーの計算は、主スレッドの計算と同じ計画になる', async () => {
    const dir = scratchDir()
    // ワーカーは Node がそのまま読める JS でなければならない（`vitest` の
    // 変換は別スレッドには効かない）。段階3 の試験では、その場で組み上げる。
    // **組み上げ先は `node_modules/.cache/` の下**である —— `better-sqlite3` を
    // `require` するので、`node_modules` をたどれる場所に置く必要がある
    const build = join(process.cwd(), 'node_modules', '.cache', WORKER_BUILD)
    execFileSync(
      'npx',
      [
        'tsc',
        '--ignoreConfig',
        'src/rows/rebuild-worker.ts',
        '--outDir',
        build,
        '--module',
        'node16',
        '--moduleResolution',
        'node16',
        '--target',
        'ES2020',
        '--esModuleInterop',
        '--skipLibCheck',
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    )
    const workerPath = join(build, 'rows', 'rebuild-worker.js')
    expect(existsSync(workerPath)).toBe(true)

    const path = join(dir, 'mine.sqlite')
    const mine = openClient('aaaa', { path })
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', 'x', '2026-02-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-02')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k2'`).run()
      seedFromPeer(mine, peer)

      const fromWorker = await computeRebuildPlanInWorker({
        dbPath: path,
        tables: ['notes'],
        workerPath,
      })
      const fromMain = computeRebuildPlan(mine, { tables: ['notes'] })
      expect(fromWorker.token).toEqual(fromMain.token)
      expect(fromWorker.apply).toEqual(fromMain.apply)
      expect(fromWorker.hidden).toEqual(fromMain.hidden)
      expect(fromWorker.unplaceable).toEqual(fromMain.unplaceable)
      // アプリの表は空のまま（ワーカーは読むだけ）
      expect(notesOf(mine)).toEqual([])
    } finally {
      mine.close()
      peer.close()
    }
  }, 60000)
})

/* ================================================================== *
 * 原則4 —— 親の削除にあわせて子の版を捨てる
 * ================================================================== */

describe('作り直し —— 親の削除にあわせて子の版を捨てる（原則4）', () => {
  const FAMILY = [
    `CREATE TABLE tags (
       id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updatedAt TEXT)`,
    `CREATE TABLE tag_notes (
       id TEXT PRIMARY KEY NOT NULL,
       tagId TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
       body TEXT NOT NULL, updatedAt TEXT)`,
  ]

  /** 親を消した端末と、その親の子を作った端末を用意して、片方へ取り込む。 */
  function openPair(): { mine: Database.Database; peer: Database.Database } {
    const mine = openClient('aaaa', {
      statements: FAMILY,
      tables: ['tags', 'tag_notes'],
    })
    const peer = openClient('bbbb', {
      statements: FAMILY,
      tables: ['tags', 'tag_notes'],
    })
    for (const db of [mine, peer]) {
      db.prepare(`INSERT INTO tags VALUES ('g1','t1','2026-01-01')`).run()
    }
    // 相手だけが子を作る。しかも親の削除より新しい時刻で
    peer
      .prepare(
        `INSERT INTO tag_notes VALUES ('n1','g1','b1','2099-01-01T00:00:00.000Z')`
      )
      .run()
    // 手元は親を消す
    mine.prepare(`DELETE FROM tags WHERE id='g1'`).run()
    return { mine, peer }
  }

  it('あとから届いた子の版は、時刻によらず _sns_rows_* から落ちる', () => {
    const { mine, peer } = openPair()
    try {
      seedFromPeer(mine, peer, ['tags', 'tag_notes'])
      expect(
        countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_tag_notes`)
      ).toBe(1)

      const outcome = rebuildOnce(mine, {
        tables: ['tags', 'tag_notes'],
        state: createRebuildState(),
      })
      expect(outcome.status).toBe('applied')
      // アプリの表にも、版の表にも残らない
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM tag_notes`)).toBe(0)
      expect(
        countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_tag_notes`)
      ).toBe(0)
      // 置かない行としては数えない（永遠に警告が出続けることになる）
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM _sns_unplaceable`)).toBe(
        0
      )
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('捨てた行の中身と、原因になった親を知らせる', () => {
    const { mine, peer } = openPair()
    try {
      seedFromPeer(mine, peer, ['tags', 'tag_notes'])
      const outcome = rebuildOnce(mine, {
        tables: ['tags', 'tag_notes'],
        state: createRebuildState(),
      })
      expect(outcome.discarded).toHaveLength(1)
      expect(outcome.discarded[0]).toMatchObject({
        table: 'tag_notes',
        trueId: 'n1',
        causeTable: 'tags',
        causeId: 'g1',
      })
      // 中身は落とす前の値。これが無いとアプリケーションは退避できない
      expect(outcome.discarded[0].content).toMatchObject({
        id: 'n1',
        tagId: 'g1',
        body: 'b1',
      })
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('二度目の作り直しでは、もう捨てるものが無い', () => {
    const { mine, peer } = openPair()
    try {
      seedFromPeer(mine, peer, ['tags', 'tag_notes'])
      const state = createRebuildState()
      rebuildOnce(mine, { tables: ['tags', 'tag_notes'], state })
      mine.prepare(`INSERT INTO _sns_dirty VALUES ('tag_notes')`).run()
      const again = rebuildOnce(mine, { tables: ['tags', 'tag_notes'], state })
      expect(again.discarded).toEqual([])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('親がまだ届いていないだけの子は、版を落とさない', () => {
    const mine = openClient('aaaa', {
      statements: FAMILY,
      tables: ['tags', 'tag_notes'],
    })
    const peer = openClient('bbbb', {
      statements: FAMILY,
      tables: ['tags', 'tag_notes'],
    })
    try {
      peer.prepare(`INSERT INTO tags VALUES ('g1','t1','2026-01-01')`).run()
      peer
        .prepare(`INSERT INTO tag_notes VALUES ('n1','g1','b1','2026-01-01')`)
        .run()
      // 子だけを取り込む（親はまだ届いていない）
      seedFromPeer(mine, peer, ['tag_notes'])
      const outcome = rebuildOnce(mine, {
        tables: ['tags', 'tag_notes'],
        state: createRebuildState(),
      })
      expect(outcome.discarded).toEqual([])
      expect(
        countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_tag_notes`)
      ).toBe(1)
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM _sns_unplaceable`)).toBe(
        1
      )
    } finally {
      mine.close()
      peer.close()
    }
  })
})
