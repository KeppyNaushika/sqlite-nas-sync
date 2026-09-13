/**
 * 消えた親を指す子が届いたとき。
 *
 * 片方が親を消すのと入れ違いに、もう片方がその親へ子を足す —— どちらの操作も
 * その端末では正当（`better-sqlite3` は `PRAGMA foreign_keys` を既定で有効にするので、
 * 親が居ない状態では子を作れない）。壊れた組み合わせを作るのは**同期**である。
 *
 * 取り込む側は親を tombstone に負けて入れないのに、子だけ素通しで入れると
 * **COMMIT 時に外部キー違反になり、その相手ぶんの取り込みが丸ごと巻き戻る**
 * （`src/sync/pull.ts` の `defer_foreign_keys` は検査を終端へ遅らせるだけで、
 * 終端で矛盾が残れば通常どおり失敗する）。作り直された親が tombstone より古い形では
 * 毎回同じ違反を繰り返し、その相手からの同期が**恒久的に止まる**。
 *
 * 正しい答えは「親が消えたのだから、その外部キーの `ON DELETE` に従う」。
 * 畳みで読み替えた先が消えていた場合の扱い（`conflict/remap.ts` の規則5）と同じ規則を、
 * 畳みが絡まない普通の削除にも当てる。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { applyInsert } from '../src/conflict'
import { setupChangelog } from '../src/setup'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

describe('同期経路（tag_notes は ON DELETE CASCADE）', () => {
  const fixture = createSyncFixture('test-data-fk-missing-parent')
  beforeEach(fixture.prepare)
  afterEach(fixture.cleanup)

  const syncFailures = (warnings: string[]): string[] =>
    warnings.filter((warning) => warning.includes('Sync failed'))

  it('親を消すのと入れ違いに子が足されても、取り込みは巻き戻らない', async () => {
    const a = fixture.createClientDb('client-a')
    const b = fixture.createClientDb('client-b')
    const warnings: string[] = []
    const round = async (): Promise<void> => {
      warnings.push(
        ...(
          await performSync(
            a.db,
            fixture.makeConfig(a.dbPath, 'client-a'),
            TABLES
          )
        ).warnings,
        ...(
          await performSync(
            b.db,
            fixture.makeConfig(b.dbPath, 'client-b'),
            TABLES
          )
        ).warnings
      )
    }

    try {
      // 1. A が親を作り、B へ渡す
      a.db
        .prepare(`INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('g2', 't1', '2026-01-01T00:00:00.000Z')
      await round()
      await round()
      expect(b.db.prepare(`SELECT COUNT(*) AS n FROM tags`).get()).toEqual({
        n: 1,
      })

      // 2. B が子を足す（親が居るので正当）
      b.db
        .prepare(
          `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
        )
        .run('n1', 'g2', 'memo', '2026-02-01T00:00:00.000Z')
      // 3. A が親を消す（A には子が無い）
      a.db.prepare(`DELETE FROM tags WHERE id = 'g2'`).run()

      for (let i = 0; i < 4; i += 1) await round()

      expect(syncFailures(warnings)).toEqual([])
      // 親が消えたのだから子も残らない（CASCADE）
      for (const [label, db] of [
        ['A', a.db],
        ['B', b.db],
      ] as const) {
        expect(
          db.prepare(`SELECT COUNT(*) AS n FROM tags`).get(),
          `client-${label} tags`
        ).toEqual({ n: 0 })
        expect(
          db.prepare(`SELECT COUNT(*) AS n FROM tag_notes`).get(),
          `client-${label} tag_notes`
        ).toEqual({ n: 0 })
      }
    } finally {
      a.db.close()
      b.db.close()
    }
  }, 60000)

  it('tombstone より古い時刻で作り直された親でも、同期が止まらない', async () => {
    // 恒久的に止まる形。作り直された親は tombstone に負けて**永久に入らない**のに、
    // それを指す子は届き続けるので、取り込みが毎周巻き戻る。
    const a = fixture.createClientDb('client-a')
    const c = fixture.createClientDb('client-c')
    const warnings: string[] = []
    const round = async (): Promise<void> => {
      warnings.push(
        ...(
          await performSync(
            a.db,
            fixture.makeConfig(a.dbPath, 'client-a'),
            TABLES
          )
        ).warnings,
        ...(
          await performSync(
            c.db,
            fixture.makeConfig(c.dbPath, 'client-c'),
            TABLES
          )
        ).warnings
      )
    }

    try {
      // C が親を作ってすぐ消す（A はその行を一度も持たない）
      c.db
        .prepare(`INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('g1', 't1', '2026-01-01T00:00:00.000Z')
      c.db.prepare(`DELETE FROM tags WHERE id = 'g1'`).run()
      await round()
      await round()

      // C が親を「削除より古い時刻」で作り直し、子を足す
      c.db
        .prepare(`INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('g1', 't1', '2026-01-01T00:00:01.000Z')
      c.db
        .prepare(
          `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
        )
        .run('n1', 'g1', 'memo', '2026-01-01T00:00:01.000Z')

      for (let i = 0; i < 5; i += 1) await round()

      expect(syncFailures(warnings)).toEqual([])
    } finally {
      a.db.close()
      c.db.close()
    }
  }, 60000)

  it('親がこのあと同じ取り込みで届くだけの子は、捨てない', async () => {
    // 順番が違うだけの行を殺してはいけない。親と子を同時に作って渡す。
    const a = fixture.createClientDb('client-a')
    const b = fixture.createClientDb('client-b')
    try {
      a.db
        .prepare(`INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('g3', 't3', '2026-01-01T00:00:00.000Z')
      a.db
        .prepare(
          `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
        )
        .run('n3', 'g3', 'memo', '2026-01-01T00:00:00.000Z')
      await performSync(a.db, fixture.makeConfig(a.dbPath, 'client-a'), TABLES)
      const result = await performSync(
        b.db,
        fixture.makeConfig(b.dbPath, 'client-b'),
        TABLES
      )

      expect(syncFailures(result.warnings)).toEqual([])
      expect(b.db.prepare(`SELECT COUNT(*) AS n FROM tag_notes`).get()).toEqual(
        { n: 1 }
      )
    } finally {
      a.db.close()
      b.db.close()
    }
  }, 60000)
})

describe('ON DELETE の種類ごと', () => {
  let db: Database.Database

  /** 親1つと、`ON DELETE` の書き方が違う子を3つ持つDBを作る。 */
  function createDb(): Database.Database {
    const fresh = new Database(':memory:')
    fresh.exec(`
      CREATE TABLE parents (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    fresh.exec(`
      CREATE TABLE cascade_children (
        id TEXT PRIMARY KEY,
        parentId TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      )
    `)
    fresh.exec(`
      CREATE TABLE setnull_children (
        id TEXT PRIMARY KEY,
        parentId TEXT REFERENCES parents(id) ON DELETE SET NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    fresh.exec(`
      CREATE TABLE noaction_children (
        id TEXT PRIMARY KEY,
        parentId TEXT NOT NULL REFERENCES parents(id),
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(
      fresh,
      [
        { name: 'parents' },
        { name: 'cascade_children' },
        { name: 'setnull_children' },
        { name: 'noaction_children' },
      ],
      'id'
    )
    // 親が消されたことを記録しておく（同期で届いた削除に相当）
    fresh
      .prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt) VALUES (?, ?, ?)`
      )
      .run('parents', 'p1', '2026-06-01T00:00:00.000Z')
    return fresh
  }

  beforeEach(() => {
    db = createDb()
  })
  afterEach(() => {
    db.close()
  })

  const insertChild = (
    table: string,
    columns: string[]
  ): ReturnType<typeof applyInsert> =>
    applyInsert(
      db,
      table,
      'id',
      {
        id: 'c1',
        parentId: 'p1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      columns
    )

  it('CASCADE: 子を採らず、採らなかったことを知らせる', () => {
    const result = insertChild('cascade_children', [
      'id',
      'parentId',
      'updatedAt',
    ])
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM cascade_children`).get()
    ).toEqual({ n: 0 })
    expect(result.warnings.join(' ')).toContain('parents:p1 is gone')
    expect(result.warnings.join(' ')).toContain('ON DELETE CASCADE')
  })

  it('SET NULL: 参照を外して採る', () => {
    const result = insertChild('setnull_children', [
      'id',
      'parentId',
      'updatedAt',
    ])
    const row = db
      .prepare(`SELECT parentId FROM setnull_children WHERE id = 'c1'`)
      .get() as { parentId: string | null } | undefined
    expect(row).toBeDefined()
    expect(row!.parentId).toBeNull()
    expect(result.warnings.join(' ')).toContain('set to NULL')
  })

  it('NO ACTION: 子を採らない', () => {
    const result = insertChild('noaction_children', [
      'id',
      'parentId',
      'updatedAt',
    ])
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM noaction_children`).get()
    ).toEqual({ n: 0 })
    expect(result.warnings.join(' ')).toContain('parents:p1 is gone')
  })

  it('親が生きているなら、何も起きない', () => {
    db.prepare(`INSERT INTO parents (id, updatedAt) VALUES (?, ?)`).run(
      'p1',
      '2026-07-01T00:00:00.000Z'
    )
    const result = insertChild('cascade_children', [
      'id',
      'parentId',
      'updatedAt',
    ])
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM cascade_children`).get()
    ).toEqual({ n: 1 })
    expect(result.warnings).toEqual([])
  })

  it('参照が NULL なら、外部キーは検査されないので触らない', () => {
    const result = applyInsert(
      db,
      'setnull_children',
      'id',
      { id: 'c2', parentId: null, updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'parentId', 'updatedAt']
    )
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM setnull_children`).get()
    ).toEqual({ n: 1 })
    expect(result.warnings).toEqual([])
  })

  it('tombstone が無い（ローカルにまだ無いだけ）なら、子を捨てない', () => {
    // 同じ取り込みであとから親が届く形。証拠が無いのに捨てると、
    // 順番が違うだけの行を殺す。
    db.prepare(`DELETE FROM _tombstone`).run()
    db.pragma('foreign_keys = OFF')
    const result = insertChild('cascade_children', [
      'id',
      'parentId',
      'updatedAt',
    ])
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM cascade_children`).get()
    ).toEqual({ n: 1 })
    expect(result.warnings).toEqual([])
  })
})
