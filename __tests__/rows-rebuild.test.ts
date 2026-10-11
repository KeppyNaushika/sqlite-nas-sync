/**
 * 案A の作り直し（`src/rows/rebuild-plan.ts`・`src/rows/rebuild.ts`）の試験。
 * 設計書 `docs/rows-table-design.md` §3.7。
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
  rebuildOnceInWorker,
} from '../src/rows/rebuild'
import { RowsTableSpec, createRowsTables } from '../src/rows/schema'
import { createRowsTriggers } from '../src/rows/triggers'
import { createSyncWorker } from '../src/worker-host'
import { buildWorker } from './helpers/build-worker'

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

/** ワーカーを組み上げる先の名前（`node_modules/.cache/` の下）。 */
const WORKER_BUILD = 'rows-worker-test'
/** ワーカーを組み上げた先（`buildWorker` が返す）。組み上げていなければ `null` */
let workerBuild: string | null = null

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  if (workerBuild !== null) {
    rmSync(workerBuild, { recursive: true, force: true })
  }
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
      expect(plan.apply[0].inserts.map((row) => row.id)).toEqual(['k1'])
      expect(plan.apply[0].deletes).toEqual([])
      expect(plan.apply[0].counts).toEqual({
        inserted: 1,
        updated: 0,
        deleted: 0,
      })
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

  it('UNIQUE の値を2行の間で入れ替える計画も通る（消す行を先に全部消す）', () => {
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
 * 差だけを当てる（§3.7.2）
 * ================================================================== */

describe('作り直し —— 差だけを当てる（§3.7.2）', () => {
  /** トリガーを素通りさせて、アプリの表だけを書き換える（版は変わらない） */
  function behindTriggers(db: Database.Database, sql: string): void {
    db.exec(`INSERT INTO _sns_rebuilding (onlyRow) VALUES (0)`)
    try {
      db.exec(sql)
    } finally {
      db.exec(`DELETE FROM _sns_rebuilding`)
    }
  }

  function rowids(db: Database.Database): Row[] {
    return db.prepare(`SELECT rowid, id FROM notes ORDER BY id`).all() as Row[]
  }

  it.each(['UTF-8', 'UTF-16le'])(
    'UTF-8 として正しくないバイト列の主キーの行も消せる（%s の DB）',
    (encoding) => {
      const mine = openClient('aaaa', {
        statements: [`PRAGMA encoding = '${encoding}'`, NOTES],
      })
      try {
        mine
          .prepare(
            `INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`
          )
          .run()
        rebuildOnce(mine, { tables: ['notes'] })
        // JS の文字列にすると U+FFFD に置き換わる主キー。版は無いので、作り直しで消える行
        behindTriggers(
          mine,
          `INSERT INTO notes VALUES (CAST(X'6BFF00' AS TEXT), '外から', NULL, '2026-01-01')`
        )
        mine.exec(`INSERT INTO _sns_dirty (tableName) VALUES ('notes')`)

        const outcome = rebuildOnce(mine, { tables: ['notes'] })
        expect(outcome.status).toBe('applied')
        expect(outcome.counts).toEqual({ inserted: 0, updated: 0, deleted: 1 })
        expect(
          mine.prepare(`SELECT id FROM notes ORDER BY id`).pluck().all()
        ).toEqual(['k1'])
      } finally {
        mine.close()
      }
    }
  )

  it('UTF-8 として正しくないバイト列の値は入れ直し、正しい U+FFFD は入れ直し続けない', () => {
    const mine = openClient('aaaa')
    try {
      // 版の中身は正しい U+FFFD（EF BF BD）
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', ?, NULL, '2026-01-01')`)
        .run('a\uFFFD')
      rebuildOnce(mine, { tables: ['notes'] })
      expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(0)

      // アプリの表だけ、JS では同じ 'a\uFFFD' に見える正しくないバイト列（61 FF）にする
      behindTriggers(
        mine,
        `UPDATE notes SET title = CAST(X'61FF' AS TEXT) WHERE id = 'k1'`
      )
      expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(1)
      mine.exec(`INSERT INTO _sns_dirty (tableName) VALUES ('notes')`)
      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 })
      expect(mine.prepare(`SELECT hex(title) FROM notes`).pluck().get()).toBe(
        '61EFBFBD'
      )
      expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(0)
    } finally {
      mine.close()
    }
  })

  it('同じ DB を開いた別の接続が先に作り直したら、見送る（差を二重に当てない）', () => {
    const path = join(scratchDir(), 'shared.sqlite')
    const mine = openClient('aaaa', { path })
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)
      const other = new Database(path)
      try {
        const outcome = rebuildOnce(mine, {
          tables: ['notes'],
          hooks: {
            // 計算を終えて適用する前に、別の接続が同じ計画を当てる
            duringCompute: () => {
              const first = rebuildOnce(other, { tables: ['notes'] })
              expect(first.status).toBe('applied')
            },
          },
        })
        expect(outcome.status).toBe('deferred')
        expect(notesOf(mine).map((row) => row.id)).toEqual(['k1'])
        expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(0)
      } finally {
        other.close()
      }
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('計算のあとに token が捕まえない書き込みで行が消えていたら、見送って次の回に揃える', () => {
    const mine = openClient('aaaa')
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      rebuildOnce(mine, { tables: ['notes'] })
      // 版の無い行。作り直しで消える
      behindTriggers(
        mine,
        `INSERT INTO notes VALUES ('x', '外から', NULL, '2026-01-01')`
      )
      mine.exec(`INSERT INTO _sns_dirty (tableName) VALUES ('notes')`)

      const state = createRebuildState()
      const first = rebuildOnce(mine, {
        tables: ['notes'],
        state,
        hooks: {
          // 旗を立てて書く別の書き手（token に表れない）が、先に消してしまう
          duringCompute: (db) =>
            behindTriggers(db, `DELETE FROM notes WHERE id = 'x'`),
        },
      })
      expect(first.status).toBe('deferred')
      expect(state.skips).toBe(1)

      const second = rebuildOnce(mine, { tables: ['notes'], state })
      expect(second.status).toBe('applied')
      expect(notesOf(mine).map((row) => row.id)).toEqual(['k1'])
      expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(0)
    } finally {
      mine.close()
    }
  })

  it('計算のあとに token が捕まえない書き込みで入れる行が先にあったら、見送って次の回に揃える', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)

      const state = createRebuildState()
      const first = rebuildOnce(mine, {
        tables: ['notes'],
        state,
        hooks: {
          duringCompute: (db) =>
            behindTriggers(
              db,
              `INSERT INTO notes VALUES ('k1', '別の書き手', NULL, '2026-01-01')`
            ),
        },
      })
      expect(first.status).toBe('deferred')

      const second = rebuildOnce(mine, { tables: ['notes'], state })
      expect(second.status).toBe('applied')
      expect(second.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 })
      expect(notesOf(mine).map((row) => row.title)).toEqual(['相手'])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('差の無い表では、アプリのトリガーを外さず、importTick も進めない', () => {
    const mine = openClient('aaaa', {
      statements: [
        NOTES,
        `CREATE TABLE audit (id TEXT)`,
        `CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN
           INSERT INTO audit VALUES (NEW.id);
         END`,
      ],
    })
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      rebuildOnce(mine, { tables: ['notes'] })
      mine.exec(`INSERT INTO _sns_dirty (tableName) VALUES ('notes')`)
      const schemaVersion = (): unknown =>
        mine.pragma('schema_version', { simple: true })
      const importTick = (): unknown =>
        mine.prepare(`SELECT importTick FROM _sns_clock`).pluck().get()
      const before = { schema: schemaVersion(), tick: importTick() }

      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.status).toBe('applied')
      expect(outcome.counts).toEqual({ inserted: 0, updated: 0, deleted: 0 })
      // `DROP TRIGGER` はスキーマを変える。差が無ければ触らない
      expect({ schema: schemaVersion(), tick: importTick() }).toEqual(before)
      expect(dirtyOf(mine)).toEqual([])
    } finally {
      mine.close()
    }
  })

  it('変わらない行には触らない（rowid が変わらない）', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      for (const id of ['k1', 'k2', 'k3']) {
        mine
          .prepare(`INSERT INTO notes VALUES (?, '手元', NULL, '2026-01-01')`)
          .run(id)
      }
      rebuildOnce(mine, { tables: ['notes'] })
      const before = rowids(mine)
      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-01')`)
        .run()
      importFromPeer(mine, peer, { tables: ['notes'] })

      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.status).toBe('applied')
      expect(outcome.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 })
      const after = rowids(mine)
      expect(after.filter((row) => row.id !== 'k2')).toEqual(
        before.filter((row) => row.id !== 'k2')
      )
      expect(
        mine.prepare(`SELECT title FROM notes WHERE id = 'k2'`).pluck().get()
      ).toBe('相手')
      expect(rebuildDiffCount(mine, { tables: ['notes'] })).toBe(0)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('値が等しくても型が違う行は入れ直す（整数の 1 と実数の 1.0）', () => {
    const items = `CREATE TABLE items (
      id        TEXT PRIMARY KEY NOT NULL,
      n,
      updatedAt TEXT
    )`
    const mine = openClient('aaaa', { statements: [items], tables: ['items'] })
    try {
      mine.prepare(`INSERT INTO items VALUES ('k1', 1, '2026-01-01')`).run()
      rebuildOnce(mine, { tables: ['items'] })
      behindTriggers(mine, `UPDATE items SET n = 1.0 WHERE id = 'k1'`)
      expect(mine.prepare(`SELECT typeof(n) FROM items`).pluck().get()).toBe(
        'real'
      )

      expect(
        rebuildDiffCount(mine, { tables: ['items'], targets: ['items'] })
      ).toBe(1)
      mine.exec(`INSERT INTO _sns_dirty (tableName) VALUES ('items')`)
      const outcome = rebuildOnce(mine, { tables: ['items'] })
      expect(outcome.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 })
      expect(mine.prepare(`SELECT typeof(n) FROM items`).pluck().get()).toBe(
        'integer'
      )
    } finally {
      mine.close()
    }
  })

  it('同じ正規形の主キーを持つ行が2つあれば、中身の同じ1つを残して残りを消す', () => {
    const mine = openClient('aaaa')
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      rebuildOnce(mine, { tables: ['notes'] })
      // 'k1' と X'6B31' は別の値なので主キーは衝突しないが、真の id はどちらも 'k1'
      behindTriggers(
        mine,
        `INSERT INTO notes VALUES (X'6B31', '外から', NULL, '2026-01-01')`
      )
      mine.exec(`INSERT INTO _sns_dirty (tableName) VALUES ('notes')`)

      const outcome = rebuildOnce(mine, { tables: ['notes'] })
      expect(outcome.counts).toEqual({ inserted: 0, updated: 0, deleted: 1 })
      expect(
        mine.prepare(`SELECT typeof(id) AS t, title FROM notes`).all()
      ).toEqual([{ t: 'text', title: '手元' }])
    } finally {
      mine.close()
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
    workerBuild = buildWorker(WORKER_BUILD)
    const workerPath = join(workerBuild, 'worker.js')
    expect(existsSync(workerPath)).toBe(true)
    const worker = createSyncWorker({ workerPath })

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

      const computed = await computeRebuildPlanInWorker({
        dbPath: path,
        tables: ['notes'],
        worker,
      })
      // ワーカーが答えている（主スレッドへ落ちていない）
      expect(computed).not.toBeNull()
      const fromWorker = computed!
      const fromMain = computeRebuildPlan(mine, { tables: ['notes'] })
      expect(fromWorker.token).toEqual(fromMain.token)
      expect(fromWorker.apply).toEqual(fromMain.apply)
      expect(fromWorker.hidden).toEqual(fromMain.hidden)
      expect(fromWorker.unplaceable).toEqual(fromMain.unplaceable)
      // アプリの表は空のまま（ワーカーは読むだけ）
      expect(notesOf(mine)).toEqual([])
    } finally {
      await worker.close()
      mine.close()
      peer.close()
    }
  }, 60000)

  it('ワーカーが答えを返さなければ、主スレッドで計算して作り直す', async () => {
    const dir = scratchDir()
    const path = join(dir, 'mine.sqlite')
    const mine = openClient('aaaa', { path })
    const peer = openClient('bbbb')
    const worker = createSyncWorker({ workerPath: join(dir, 'no-such.js') })
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', 'x', '2026-02-01')`)
        .run()
      seedFromPeer(mine, peer)
      const outcome = await rebuildOnceInWorker(mine, {
        tables: ['notes'],
        dbPath: path,
        worker,
      })
      expect(outcome.status).toBe('applied')
      expect(notesOf(mine).map((row) => row.id)).toEqual(['k1'])
    } finally {
      await worker.close()
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 原則4 —— 親が削除されている間、子はアプリの表に入らない（版は残る）
 * ================================================================== */

describe('作り直し —— 親が削除されている間、子はアプリの表に入らない（原則4）', () => {
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

  const cause = (db: Database.Database): unknown[] =>
    db
      .prepare(
        `SELECT tableName, trueId, causeTable, causeId FROM _sns_unplaceable`
      )
      .all()

  it('あとから届いた子の版は、時刻によらずアプリの表に入らず、_sns_rows_* には残る', () => {
    const { mine, peer } = openPair()
    try {
      seedFromPeer(mine, peer, ['tags', 'tag_notes'])
      const outcome = rebuildOnce(mine, {
        tables: ['tags', 'tag_notes'],
        state: createRebuildState(),
      })
      expect(outcome.status).toBe('applied')
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM tag_notes`)).toBe(0)
      // 版は捨てない
      expect(
        countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_tag_notes`)
      ).toBe(1)
      // 置かない行として、原因の親つきで載る（報告の差分の元になる）
      expect(cause(mine)).toEqual([
        {
          tableName: 'tag_notes',
          trueId: 'n1',
          causeTable: 'tags',
          causeId: 'g1',
        },
      ])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('親を同じ主キーで書き直すと、次の作り直しで子が元の形で入る', () => {
    const { mine, peer } = openPair()
    try {
      seedFromPeer(mine, peer, ['tags', 'tag_notes'])
      const state = createRebuildState()
      rebuildOnce(mine, { tables: ['tags', 'tag_notes'], state })
      mine.prepare(`INSERT INTO tags VALUES ('g1','t1','2026-01-01')`).run()
      const again = rebuildOnce(mine, { tables: ['tags', 'tag_notes'], state })
      expect(again.status).toBe('applied')
      expect(
        mine.prepare(`SELECT id, tagId, body FROM tag_notes`).all()
      ).toEqual([{ id: 'n1', tagId: 'g1', body: 'b1' }])
      expect(cause(mine)).toEqual([])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('親がまだ届いていないだけの子は、原因の親の無い置かない行になる', () => {
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
      expect(outcome.status).toBe('applied')
      expect(
        countOf(mine, `SELECT COUNT(*) AS n FROM _sns_rows_tag_notes`)
      ).toBe(1)
      expect(cause(mine)).toEqual([
        {
          tableName: 'tag_notes',
          trueId: 'n1',
          causeTable: null,
          causeId: null,
        },
      ])
    } finally {
      mine.close()
      peer.close()
    }
  })
})
