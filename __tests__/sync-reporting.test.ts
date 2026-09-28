/**
 * 同期結果の報告（`SyncResult.restores` / `SyncResult.parentDeleted` / `SyncResult.parentReturned`）を、
 * `performSync` を通して確かめる。
 *
 * 単体の作り直し（`rows-rebuild`・`rows-derive`）では、`_sns_hidden` の前後の差分や、
 * 取り込みを挟んだときの `parentDeleted` の出方までは押さえられない。ここでは
 * 複数のクライアントで実際に同期を回して、利用者が受け取る結果を見る。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { SyncResult, TableConfig } from '../src/types'
import { createSyncFixture, setupRowsDb } from './helpers/sync-fixtures'

const { testDir, prepare, cleanup, makeConfig } = createSyncFixture(
  'test-data-sync-reporting'
)

/** この試験だけで使う表。`ON DELETE` の種類ごとに子の表を分ける。 */
const TABLES: TableConfig[] = [
  { name: 'tags' },
  { name: 'notes' },
  { name: 'links' },
]

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:01.000Z'
const T2 = '2026-01-01T00:00:02.000Z'
const T3 = '2026-01-01T00:00:03.000Z'

interface Client {
  id: string
  db: Database.Database
  sync: () => Promise<SyncResult>
}

function createClient(clientId: string): Client {
  const clientDir = path.join(testDir, clientId)
  fs.mkdirSync(clientDir, { recursive: true })
  const dbPath = path.join(clientDir, 'local.sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE tags (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL UNIQUE,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE notes (
      id        TEXT PRIMARY KEY,
      tagId     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE links (
      id        TEXT PRIMARY KEY,
      tagId     TEXT REFERENCES tags(id) ON DELETE SET NULL,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `)
  setupRowsDb(db, TABLES)
  const config = makeConfig(dbPath, clientId)
  return {
    id: clientId,
    db,
    sync: () => performSync(db, config, TABLES),
  }
}

function insertTag(
  db: Database.Database,
  id: string,
  name: string,
  at: string
) {
  db.prepare(`INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`).run(
    id,
    name,
    at
  )
}

function rows(db: Database.Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
}

describe('同期結果の報告', () => {
  const opened: Database.Database[] = []
  const client = (id: string): Client => {
    const made = createClient(id)
    opened.push(made.db)
    return made
  }

  beforeEach(prepare)
  afterEach(() => {
    for (const db of opened.splice(0)) db.close()
    cleanup()
  })

  describe('restores', () => {
    /**
     * 2端末が同じ `name` を別々の主キーで書いて統合させ、勝った行を消す。
     * 原則3 により負けていた主キーも削除されるので、`restores` に載せてはいけない。
     */
    async function foldThenSync(): Promise<{ a: Client; b: Client }> {
      const a = client('client-a')
      const b = client('client-b')
      insertTag(a.db, 'x', 'same', T0)
      insertTag(b.db, 'y', 'same', T1)
      await a.sync()
      await b.sync()
      await a.sync()
      await b.sync()
      // 統合: 時刻の新しい y が勝ち、x が隠れる
      expect(rows(a.db, 'tags')).toEqual([
        { id: 'y', name: 'same', updatedAt: T1 },
      ])
      expect(rows(b.db, 'tags')).toEqual(rows(a.db, 'tags'))
      return { a, b }
    }

    it('統合した行を DELETE しても、負けていた主キーは restores に出ない', async () => {
      const { a, b } = await foldThenSync()

      a.db.prepare(`DELETE FROM tags WHERE id = 'y'`).run()
      const resultA = await a.sync()
      const resultB = await b.sync()
      const resultA2 = await a.sync()

      expect(rows(a.db, 'tags')).toEqual([])
      expect(rows(b.db, 'tags')).toEqual([])
      expect(resultA.restores).toEqual([])
      expect(resultB.restores).toEqual([])
      expect(resultA2.restores).toEqual([])
    })

    it('統合が本当に解けたとき（UNIQUE 列を別の値へ変えた）は restores に出る', async () => {
      const { a, b } = await foldThenSync()

      a.db
        .prepare(`UPDATE tags SET name = 'other', updatedAt = ? WHERE id = 'y'`)
        .run(T2)
      const resultA = await a.sync()
      const resultB = await b.sync()

      const expected = [
        { id: 'x', name: 'same', updatedAt: T0 },
        { id: 'y', name: 'other', updatedAt: T2 },
      ]
      expect(rows(a.db, 'tags')).toEqual(expected)
      expect(rows(b.db, 'tags')).toEqual(expected)
      const restored = [{ tableName: 'tags', losingId: 'x', winningId: 'y' }]
      expect(resultA.restores).toEqual(restored)
      expect(resultB.restores).toEqual(restored)
    })
  })

  describe('parentDeleted / parentReturned', () => {
    it('親の削除のあとに届いた CASCADE の子は、内容と原因の親つきで parentDeleted に出る', async () => {
      const a = client('client-a')
      const b = client('client-b')
      insertTag(a.db, 't1', 'tag', T0)
      await a.sync()
      await b.sync()

      // b が子を作って上げる。a はまだ取り込んでいない
      b.db
        .prepare(
          `INSERT INTO notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
        )
        .run('n1', 't1', 'memo', T3)
      await b.sync()

      // a が親を消してから同期する。子は親の削除より新しい時刻でも入らない
      a.db.prepare(`DELETE FROM tags WHERE id = 't1'`).run()
      const resultA = await a.sync()

      const expected = [
        {
          tableName: 'notes',
          recordId: 'n1',
          content: { id: 'n1', tagId: 't1', body: 'memo', updatedAt: T3 },
          causeTable: 'tags',
          causeId: 't1',
        },
      ]
      expect(resultA.parentDeleted).toEqual(expected)
      expect(resultA.parentReturned).toEqual([])
      expect(
        resultA.warnings.filter((w) => w.startsWith('Unplaceable'))
      ).toEqual([])
      expect(rows(a.db, 'notes')).toEqual([])

      // b では入っていた子が入らなくなる。ここでも同じ行が知らされる
      const resultB = await b.sync()
      expect(resultB.parentDeleted).toEqual(expected)
      expect(rows(b.db, 'tags')).toEqual([])
      expect(rows(b.db, 'notes')).toEqual([])

      // 状態が変わらなければ、もう出ない
      expect((await a.sync()).parentDeleted).toEqual([])
      expect((await b.sync()).parentDeleted).toEqual([])
    })

    it('ON DELETE SET NULL の子は parentDeleted に出ず、参照を NULL にして入る', async () => {
      const a = client('client-a')
      const b = client('client-b')
      insertTag(a.db, 't1', 'tag', T0)
      await a.sync()
      await b.sync()

      b.db
        .prepare(
          `INSERT INTO links (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
        )
        .run('l1', 't1', 'link', T3)
      await b.sync()

      a.db.prepare(`DELETE FROM tags WHERE id = 't1'`).run()
      const resultA = await a.sync()
      const resultB = await b.sync()

      expect(resultA.parentDeleted).toEqual([])
      expect(resultB.parentDeleted).toEqual([])
      const expected = [{ id: 'l1', tagId: null, body: 'link', updatedAt: T3 }]
      expect(rows(a.db, 'links')).toEqual(expected)
      expect(rows(b.db, 'links')).toEqual(expected)
    })

    /**
     * 同じ子が別のクライアントから再び届いても、入らないままなら二度は出ない。
     * 子のバージョンは捨てずに残っているので、再び届いたバージョンは手元のものと同じで、
     * `_sns_unplaceable` の状態も変わらない。
     */
    it('同じ子が別のクライアントから再び届いても、parentDeleted に二度は出ない', async () => {
      const a = client('client-a')
      const b = client('client-b')
      const c = client('client-c')
      insertTag(a.db, 't1', 'tag', T0)
      await a.sync()
      await b.sync()
      await c.sync()
      await a.sync()

      b.db
        .prepare(
          `INSERT INTO notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
        )
        .run('n1', 't1', 'memo', T3)
      await b.sync()
      await c.sync()
      expect(rows(c.db, 'notes')).toHaveLength(1)

      a.db.prepare(`DELETE FROM tags WHERE id = 't1'`).run()
      const first = await a.sync()
      expect(first.parentDeleted.map((entry) => entry.recordId)).toEqual(['n1'])

      const atC = await c.sync()
      expect(atC.parentDeleted.map((entry) => entry.recordId)).toEqual(['n1'])

      // c の写しから n1 がもう一度届くが、a の状態は変わらないので出ない
      const second = await a.sync()
      expect(second.parentDeleted).toEqual([])
      expect(rows(a.db, 'notes')).toEqual([])

      await b.sync()
      await c.sync()
      const third = await a.sync()
      expect(third.parentDeleted).toEqual([])
      for (const each of [a, b, c]) {
        expect(rows(each.db, 'tags')).toEqual([])
        expect(rows(each.db, 'notes')).toEqual([])
      }
    })

    it('親が同じ主キーで書き直されると、子が元の形で入り parentReturned に出る', async () => {
      const a = client('client-a')
      const b = client('client-b')
      insertTag(a.db, 't1', 'tag', T0)
      await a.sync()
      await b.sync()
      b.db
        .prepare(
          `INSERT INTO notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
        )
        .run('n1', 't1', 'memo', T3)
      await b.sync()
      a.db.prepare(`DELETE FROM tags WHERE id = 't1'`).run()
      expect((await a.sync()).parentDeleted).toHaveLength(1)
      expect((await b.sync()).parentDeleted).toHaveLength(1)

      // a が同じ主キーで親を書き直す。書き直しは削除より後なので勝つ
      insertTag(a.db, 't1', 'tag', T0)
      const resultA = await a.sync()
      const resultB = await b.sync()

      const expected = [
        {
          tableName: 'notes',
          recordId: 'n1',
          content: { id: 'n1', tagId: 't1', body: 'memo', updatedAt: T3 },
          causeTable: 'tags',
          causeId: 't1',
        },
      ]
      expect(resultA.parentReturned).toEqual(expected)
      expect(resultB.parentReturned).toEqual(expected)
      const note = [{ id: 'n1', tagId: 't1', body: 'memo', updatedAt: T3 }]
      expect(rows(a.db, 'notes')).toEqual(note)
      expect(rows(b.db, 'notes')).toEqual(note)
      expect((await a.sync()).parentReturned).toEqual([])
    })
  })
})
