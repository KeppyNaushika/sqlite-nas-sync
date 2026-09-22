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
import { performSync } from '../src/sync'
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
