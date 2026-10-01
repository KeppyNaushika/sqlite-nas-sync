/**
 * 自己参照の外部キーを持つ表の同期。
 *
 * 0.21.0 までは、作り直しが同じ表の親を引けなかった。
 * 同じ端末で親行と子行を書いて1回同期すると子行がユーザーテーブルから消え、導入前からある木構造も最初の同期で根だけになった。
 * ここでは `setupSync` を通して、ユーザーテーブルに残る行を確かめる。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { SyncResult } from '../src/types'

const T = '2026-01-01T00:00:00.000Z'

describe('自己参照の外部キーを持つ表', () => {
  let work: string
  let nasPath: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-self-reference-'))
    nasPath = join(work, 'nas')
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  /** 木の表を持つ DB を作る。`seed` は `setupSync` の前に入れる行で、並びのとおりに入れる。 */
  function makeDb(name: string, seed: [string, string | null][] = []): string {
    const dbPath = join(work, name)
    const db = new Database(dbPath)
    db.exec(
      `CREATE TABLE tree (id TEXT PRIMARY KEY NOT NULL,
         up TEXT REFERENCES tree(id) ON DELETE CASCADE, updatedAt TEXT NOT NULL)`
    )
    // 子を親より先に入れられるように、入れる間だけ外部キーを検査しない
    db.pragma('foreign_keys = OFF')
    const insert = db.prepare(`INSERT INTO tree VALUES (?, ?, ?)`)
    for (const [id, up] of seed) insert.run(id, up, T)
    db.close()
    return dbPath
  }

  function open(dbPath: string, clientId: string) {
    const sync = setupSync({
      dbPath,
      nasPath,
      clientId,
      schemaVersion: '1',
      intervalMs: 3_600_000,
    })
    const db = new Database(dbPath)
    return { sync, db }
  }

  const ids = (db: Database.Database): string[] =>
    (
      db.prepare(`SELECT id FROM tree ORDER BY id`).all() as { id: string }[]
    ).map((row) => row.id)

  const unplaceable = (result: SyncResult): string[] =>
    result.warnings.filter((warning) => warning.includes('Unplaceable'))

  it('同じ端末で親と子を書いて同期しても、両方が残る', async () => {
    const a = open(makeDb('a.sqlite'), 'a')
    try {
      a.db.prepare(`INSERT INTO tree VALUES ('t1', NULL, ?)`).run(T)
      a.db.prepare(`INSERT INTO tree VALUES ('t2', 't1', ?)`).run(T)
      const result = await a.sync.syncNow()
      expect(unplaceable(result)).toEqual([])
      expect(ids(a.db)).toEqual(['t1', 't2'])
    } finally {
      a.sync.stop()
      a.db.close()
    }
  })

  it('導入前からある深さ4の木は、子が親より先に並んでいても最初の同期で全部残り、他の端末にも届く', async () => {
    // 行の並びは葉が先、根が最後。id の順も葉が小さい
    const seed: [string, string | null][] = [
      ['n1', 'n2'],
      ['n2', 'n3'],
      ['n3', 'n4'],
      ['n4', null],
      ['m1', 'n3'],
    ]
    const a = open(makeDb('a.sqlite', seed), 'a')
    const b = open(makeDb('b.sqlite'), 'b')
    try {
      expect(unplaceable(await a.sync.syncNow())).toEqual([])
      expect(ids(a.db)).toEqual(['m1', 'n1', 'n2', 'n3', 'n4'])
      expect(unplaceable(await b.sync.syncNow())).toEqual([])
      expect(ids(b.db)).toEqual(['m1', 'n1', 'n2', 'n3', 'n4'])
    } finally {
      a.sync.stop()
      a.db.close()
      b.sync.stop()
      b.db.close()
    }
  })

  it('親を消すと、子孫も全端末から消える（CASCADE）。入れ違いに足した子も入らない', async () => {
    const a = open(makeDb('a.sqlite'), 'a')
    const b = open(makeDb('b.sqlite'), 'b')
    try {
      a.db.prepare(`INSERT INTO tree VALUES ('r', NULL, ?)`).run(T)
      a.db.prepare(`INSERT INTO tree VALUES ('c', 'r', ?)`).run(T)
      a.db.prepare(`INSERT INTO tree VALUES ('g', 'c', ?)`).run(T)
      a.db.prepare(`INSERT INTO tree VALUES ('k', NULL, ?)`).run(T)
      await a.sync.syncNow()
      await b.sync.syncNow()
      expect(ids(b.db)).toEqual(['c', 'g', 'k', 'r'])

      // B が孫の下に子を足すのと入れ違いに、A が根を消す
      b.db
        .prepare(`INSERT INTO tree VALUES ('h', 'g', ?)`)
        .run('2026-02-01T00:00:00.000Z')
      a.db.prepare(`DELETE FROM tree WHERE id = 'r'`).run()
      expect(ids(a.db)).toEqual(['k'])

      for (let i = 0; i < 2; i += 1) {
        await a.sync.syncNow()
        await b.sync.syncNow()
      }
      expect(ids(a.db)).toEqual(['k'])
      expect(ids(b.db)).toEqual(['k'])
    } finally {
      a.sync.stop()
      a.db.close()
      b.sync.stop()
      b.db.close()
    }
  })
})
