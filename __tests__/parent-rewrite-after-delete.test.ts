/**
 * 原則4 で子のバージョンを捨てていたときに一致しなくなった形の回帰試験。
 *
 * 網羅検査（`--tables tags+tag_notes --ids 1 --keys 1 --times 0 --no-prune --no-tick
 * --sync-write before --depth 4`）が出した形を、同期の最中の書き込みを使わずに書き下した。
 *
 * 1. b が子 n1（親 g1）を書く。親の g1 も作る
 * 2. b が同期する
 * 3. a が g1 を書く
 * 4. a が g1 を消す
 * 5. a が同期する。a は b の g1 と n1 を取り込む。g1 の Max は a の削除
 * 6. a が g1 を同じ主キーで書き直す
 *
 * 5 で n1 のバージョンを捨てると、a は n1 を取り込み直す経路を失い、以後何度同期しても
 * a に n1 が無く b に n1 が残った。バージョンを捨てなければ、6 のあとは両方に n1 がある。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { SyncResult, TableConfig } from '../src/types'
import { createSyncFixture, setupRowsDb } from './helpers/sync-fixtures'

const { testDir, prepare, cleanup, makeConfig } = createSyncFixture(
  'test-data-parent-rewrite-after-delete'
)

const TABLES: TableConfig[] = [{ name: 'tags' }, { name: 'tag_notes' }]

const T0 = '2026-01-01T00:00:00.000Z'

interface Client {
  db: Database.Database
  sync: () => Promise<SyncResult>
}

function createClient(clientId: string): Client {
  const clientDir = path.join(testDir, clientId)
  fs.mkdirSync(clientDir, { recursive: true })
  const dbPath = path.join(clientDir, 'local.sqlite')
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE tags (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL UNIQUE,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE tag_notes (
      id        TEXT PRIMARY KEY,
      tagId     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `)
  setupRowsDb(db, TABLES)
  const config = makeConfig(dbPath, clientId)
  return { db, sync: () => performSync(db, config, TABLES) }
}

function writeTag(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO tags (id, name, updatedAt) VALUES (?, 't1', ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt`
  ).run(id, T0)
}

function writeNote(db: Database.Database, id: string, tagId: string): void {
  db.prepare(
    `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, 'b1', ?)`
  ).run(id, tagId, T0)
}

function rows(db: Database.Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
}

async function settle(clients: Client[]): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (const each of clients) await each.sync()
  }
}

describe('親を消して同期したあとに同じ主キーで書き直す（原則4）', () => {
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

  it('他のクライアントで書かれた子は、書き直したあと両方のクライアントに入る', async () => {
    const a = client('client-a')
    const b = client('client-b')

    writeTag(b.db, 'g1')
    writeNote(b.db, 'n1', 'g1')
    await b.sync()

    writeTag(a.db, 'g1')
    a.db.prepare(`DELETE FROM tags WHERE id = 'g1'`).run()
    const afterDelete = await a.sync()
    expect(rows(a.db, 'tag_notes')).toEqual([])
    expect(afterDelete.parentDeleted.map((entry) => entry.recordId)).toEqual([
      'n1',
    ])
    // 入らなくなっても、子のバージョンは捨てない
    expect(
      a.db.prepare(`SELECT id FROM _sns_rows_tag_notes`).pluck().all()
    ).toEqual(['n1'])

    writeTag(a.db, 'g1')
    await settle([a, b])

    const note = [{ id: 'n1', tagId: 'g1', body: 'b1', updatedAt: T0 }]
    expect(rows(a.db, 'tag_notes')).toEqual(note)
    expect(rows(b.db, 'tag_notes')).toEqual(note)
    expect(rows(a.db, 'tags')).toEqual(rows(b.db, 'tags'))
    expect(rows(a.db, 'tags')).toHaveLength(1)
  })

  it('親を消した時点で手元にあった子は、親を書き直しても戻らない', async () => {
    const a = client('client-a')
    const b = client('client-b')

    writeTag(b.db, 'g1')
    writeNote(b.db, 'n1', 'g1')
    await b.sync()
    await a.sync()
    expect(rows(a.db, 'tag_notes')).toHaveLength(1)

    // a の手元には n1 がある。親を消すと SQLite が n1 も消し、その削除も変更になる
    a.db.prepare(`DELETE FROM tags WHERE id = 'g1'`).run()
    expect(
      a.db
        .prepare(
          `SELECT recordId FROM _tombstone WHERE tableName = 'tag_notes'`
        )
        .pluck()
        .all()
    ).toEqual(['n1'])
    const afterDelete = await a.sync()
    // アプリケーションが自分で消した子は、親の削除による報告には出ない
    expect(afterDelete.parentDeleted).toEqual([])

    writeTag(a.db, 'g1')
    await settle([a, b])

    expect(rows(a.db, 'tags')).toHaveLength(1)
    expect(rows(b.db, 'tags')).toEqual(rows(a.db, 'tags'))
    expect(rows(a.db, 'tag_notes')).toEqual([])
    expect(rows(b.db, 'tag_notes')).toEqual([])
  })
})
