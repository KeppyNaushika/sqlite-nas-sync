/**
 * 相手を取り込む合間に、イベントループへ戻す（`src/sync/rows-sync.ts` の `importAll`）。
 *
 * 取り込みは呼んだスレッドで行う。1人ぶんの中は区切って戻る（`importFromPeerInSteps`、`rows-import.test.ts` で確かめる）。
 * ここでは相手と相手の間を確かめる。
 *
 * 1. ある相手の取り込みの直後に積んだ `setImmediate` が、次の相手の取り込みより先に走る
 * 2. 何もしなかった相手の後では戻らない（戻るたびに、溜まった入出力の後ろへ回って遅れる）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

/** 取り込みのたびに、前の取り込みのあとで積んだ `setImmediate` が走っていたか */
const ranBetween: boolean[] = []
/** `importAll` が相手と相手の間で戻った回数 */
const yieldsBetweenPeers = { count: 0 }

vi.mock('../src/rows/import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rows/import')>()
  let ran = true
  return {
    ...actual,
    importFromPeerInSteps: (
      ...args: Parameters<typeof actual.importFromPeerInSteps>
    ) => {
      ranBetween.push(ran)
      ran = false
      setImmediate(() => {
        ran = true
      })
      return actual.importFromPeerInSteps(...args)
    },
  }
})

vi.mock('../src/event-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/event-loop')>()
  return {
    ...actual,
    yieldToEventLoop: () => {
      // 呼んだのが `importAll` のときだけ数える（1人ぶんの中の区切りや、写しを作る処理は数えない）
      const caller = new Error().stack?.split('\n')[2] ?? ''
      if (caller.includes('importAll')) yieldsBetweenPeers.count += 1
      return actual.yieldToEventLoop()
    },
  }
})

const { setupSync } = await import('../src/index')

const T = '2026-01-01T00:00:00.000Z'

describe('相手を取り込む合間', () => {
  let work: string
  let nasPath: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-import-yield-'))
    nasPath = join(work, 'nas')
    ranBetween.length = 0
    yieldsBetweenPeers.count = 0
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function open(clientId: string, suppressIdleSync = true) {
    const dbPath = join(work, `${clientId}.sqlite`)
    const db = new Database(dbPath)
    db.exec(
      `CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
    )
    db.close()
    const sync = setupSync({
      dbPath,
      nasPath,
      clientId,
      schemaVersion: '1',
      intervalMs: 3_600_000,
      suppressIdleSync,
    })
    return { sync, dbPath }
  }

  it('相手が3人なら、2人目と3人目の取り込みの前にイベントループへ戻っている', async () => {
    const clients = ['a', 'b', 'c', 'd'].map(open)
    try {
      for (const [index, client] of clients.entries()) {
        const db = new Database(client.dbPath)
        db.prepare(`INSERT INTO note VALUES (?, 'x', ?)`).run(`n${index}`, T)
        db.close()
        await client.sync.syncNow()
      }
      ranBetween.length = 0
      yieldsBetweenPeers.count = 0
      const result = await clients[0].sync.syncNow()
      expect(result.warnings).toEqual([])
      expect(ranBetween).toHaveLength(3)
      expect(ranBetween.slice(1)).toEqual([true, true])
      expect(yieldsBetweenPeers.count).toBe(2)
      const db = new Database(clients[0].dbPath, { readonly: true })
      try {
        expect(db.prepare(`SELECT count(*) FROM note`).pluck().get()).toBe(4)
      } finally {
        db.close()
      }
    } finally {
      for (const client of clients) await client.sync.close()
    }
  })

  it('何もしなかった相手の後では、イベントループへ戻らない', async () => {
    // 抑制を切って、変更の無い相手も毎回読む（差分が空なので取り込みまでは進まない）
    const clients = ['a', 'b', 'c', 'd'].map((id) => open(id, false))
    try {
      for (const [index, client] of clients.entries()) {
        const db = new Database(client.dbPath)
        db.prepare(`INSERT INTO note VALUES (?, 'x', ?)`).run(`n${index}`, T)
        db.close()
        await client.sync.syncNow()
      }
      for (let round = 0; round < 2; round += 1) {
        for (const client of clients) await client.sync.syncNow()
      }
      ranBetween.length = 0
      yieldsBetweenPeers.count = 0
      const result = await clients[0].sync.syncNow()
      expect(result.transfers?.peerReads).toBe(3)
      expect(ranBetween).toEqual([])
      expect(yieldsBetweenPeers.count).toBe(0)
    } finally {
      for (const client of clients) await client.sync.close()
    }
  })
})
