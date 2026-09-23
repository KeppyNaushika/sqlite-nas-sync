/**
 * 削除 vs 更新の決定論的LWW回帰テスト。
 *
 * 修正前のバグを固定する:
 *  1. 順序依存: pullNormal の changelog DELETE が無条件適用で、クライアント処理順により
 *     「削除 vs より新しい更新」の勝敗が変わっていた。
 *  2. 時刻の精度: `datetime('now')` の秒切り捨てで、同じ秒の中の削除と更新の
 *     前後が失われていた。
 *
 * 書式の違う時刻どうしの比較（ISO-T vs スペース形式）は、案A では
 * `src/rows/versions.ts` の版の順序（群の判定）が受け持つ。そちらの性質は
 * `__tests__/rows-versions.test.ts` で確かめてある。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { setupRowsDb } from './helpers/sync-fixtures'

describe('pullNormal consolidation: 削除 vs 更新がクライアント処理順に依存しない', () => {
  let work: string
  let syncDir: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-lww-'))
    syncDir = join(work, 'sync')
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function makeDbFile(name: string): string {
    const p = join(work, name)
    const db = new Database(p)
    db.exec(
      `CREATE TABLE Item (id TEXT PRIMARY KEY NOT NULL, value TEXT, updatedAt TEXT NOT NULL)`
    )
    db.close()
    return p
  }

  async function withSync(
    dbPath: string,
    clientId: string,
    fn: (
      db: Database.Database,
      sync: { syncNow: () => Promise<unknown> }
    ) => Promise<void>
  ): Promise<void> {
    const sync = setupSync({
      dbPath,
      nasPath: syncDir,
      clientId,
      intervalMs: 3_600_000,
    })
    const db = new Database(dbPath)
    try {
      await fn(db, sync)
    } finally {
      db.close()
      sync.stop()
    }
  }

  /** delId が X を削除、updId が X をより新しい updatedAt で保持。consolidator が両方を pull。 */
  async function consolidate(delId: string, updId: string): Promise<string> {
    const delPath = makeDbFile(`${delId}.db`)
    const updPath = makeDbFile(`${updId}.db`)
    const mainPath = makeDbFile('school-planner.db')

    await withSync(delPath, delId, async (db, sync) => {
      db.prepare(`INSERT INTO Item (id, value, updatedAt) VALUES (?,?,?)`).run(
        'X',
        'created',
        '2026-01-01T00:00:00.000+00:00'
      )
      await sync.syncNow()
      db.prepare(`DELETE FROM Item WHERE id = ?`).run('X')
      await sync.syncNow()
    })
    await withSync(updPath, updId, async (db, sync) => {
      db.prepare(`INSERT INTO Item (id, value, updatedAt) VALUES (?,?,?)`).run(
        'X',
        'updated',
        '2099-12-31T00:00:00.000+00:00'
      )
      await sync.syncNow()
    })

    let result = 'ERR'
    await withSync(mainPath, 'zzconsolidator', async (db, sync) => {
      await sync.syncNow()
      const row = db.prepare(`SELECT value FROM Item WHERE id = ?`).get('X') as
        { value: string } | undefined
      result = row ? `SURVIVED:${row.value}` : 'DELETED'
    })
    return result
  }

  it('削除が先・更新が後 → 更新(2099)が新しいので X は残る', async () => {
    expect(await consolidate('aaaa', 'bbbb')).toBe('SURVIVED:updated')
  })

  it('更新が先・削除が後 → 同じ結果（順序非依存）', async () => {
    // readdir順で削除が後に処理されても、無条件削除ではなくLWWなので結果は不変
    expect(await consolidate('zzzz', 'aaaa')).toBe('SURVIVED:updated')
  })
})

/**
 * 記録する時刻の精度の回帰テスト。
 *
 * `datetime('now')` は**秒に切り捨てた**値を返すため、同じ秒の中で起きた
 * 削除と更新の前後が失われていた。アプリが書く `updatedAt` はミリ秒まで持つので、
 * 削除側だけが粗いと「削除より前の更新」が新しいと判定され、行が復活する。
 */
describe('記録する時刻の精度', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `)
    setupRowsDb(db, [{ name: 'users' }])
  })
  afterEach(() => db.close())

  it('_tombstone.deletedAt と _changelog.changedAt がミリ秒まで持つ', () => {
    db.prepare('INSERT INTO users (id,name,updatedAt) VALUES (?,?,?)').run(
      'u1',
      'a',
      '2026-01-01T00:00:00.000Z'
    )
    db.prepare('DELETE FROM users WHERE id = ?').run('u1')

    const { deletedAt } = db
      .prepare('SELECT deletedAt FROM _tombstone WHERE recordId = ?')
      .get('u1') as { deletedAt: string }
    const { changedAt } = db
      .prepare(`SELECT changedAt FROM _changelog WHERE operation = 'DELETE'`)
      .get() as { changedAt: string }

    // updatedAt と同じ書式・同じ精度（例: 2026-05-02T02:19:56.111Z）
    const isoMillis = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    expect(deletedAt).toMatch(isoMillis)
    expect(changedAt).toMatch(isoMillis)
  })
})
