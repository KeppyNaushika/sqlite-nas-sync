/**
 * changelog の「id順」と「起きた順」がねじれる形。
 *
 * `_changelog.id` は `AUTOINCREMENT` なので「そのDBが後から書いた順」ではあるが、
 * 「出来事が後に起きた順」ではない。フルマージ（`mergeChangelog`）が取り込んだ
 * 相手のエントリを**元の `changedAt` のまま、新しく採番したid**で書き足すため、
 * 古い出来事が大きいidに並ぶ。
 *
 * この前提を置き忘れると、取り込み側が**新しい削除を古い挿入で覆い隠す**。
 * しかも例外も警告も出ないまま `lastSeenId` だけが進むので、取りこぼしは
 * 二度と埋まらない。3端末ではじめて出る形なので、ここに置く。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { deduplicateEntries } from '../src/sync/state'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'
import { ChangelogEntry } from '../src/types'

describe('deduplicateEntries', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  const entry = (
    id: number,
    operation: 'INSERT' | 'UPDATE' | 'DELETE',
    changedAt: string
  ): ChangelogEntry => ({
    id,
    tableName: 'users',
    recordId: 'u1',
    operation,
    changedAt,
  })

  it('同じ行なら、いちばん後に起きたエントリだけを残す', () => {
    const kept = deduplicateEntries(
      db,
      [
        entry(1, 'INSERT', '2026-01-01T00:00:00.000Z'),
        entry(2, 'UPDATE', '2026-01-02T00:00:00.000Z'),
      ],
      'id'
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].operation).toBe('UPDATE')
  })

  it('idが大きくても、時刻が古ければ採らない', () => {
    // フルマージが取り込んだ「古い INSERT」が、自分の DELETE より後ろに並ぶ形。
    // ここで INSERT を採ると、その行は相手のDBに既に無いので取り込み側が
    // 丸ごと捨て、削除が永久に届かなくなる。
    const kept = deduplicateEntries(
      db,
      [
        entry(5, 'DELETE', '2026-06-01T00:00:00.000Z'),
        entry(9, 'INSERT', '2026-01-01T00:00:00.000Z'),
      ],
      'id'
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].operation).toBe('DELETE')
    expect(kept[0].id).toBe(5)
  })

  it('書式が違っても時刻として比べる', () => {
    // 0.19.0 以前は秒精度のスペース形式で書かれていた。字面で比べると
    // ' '(0x20) < 'T'(0x54) なので、同じ日でも古い書式の方が常に小さく出る。
    const kept = deduplicateEntries(
      db,
      [
        entry(1, 'INSERT', '2026-06-01 00:00:00'),
        entry(2, 'UPDATE', '2026-01-01T00:00:00.000Z'),
      ],
      'id'
    )
    expect(kept[0].operation).toBe('INSERT')
    expect(kept[0].id).toBe(1)
  })

  it('同時刻なら、idの大きい方を後とみなす', () => {
    // 同じ瞬間に起きた出来事の順は、そのDBが書いた順しか手掛かりが無い。
    const kept = deduplicateEntries(
      db,
      [
        entry(1, 'INSERT', '2026-01-01T00:00:00.000Z'),
        entry(2, 'DELETE', '2026-01-01T00:00:00.000Z'),
      ],
      'id'
    )
    expect(kept[0].operation).toBe('DELETE')
  })

  it('時刻として読めない値どうしでも、idで決着する（捨てない）', () => {
    const kept = deduplicateEntries(
      db,
      [
        entry(1, 'INSERT', 'not-a-timestamp'),
        entry(2, 'UPDATE', 'also-not-a-timestamp'),
      ],
      'id'
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe(2)
  })

  it('別の行は別に残す（表名の大小だけが違うものは同じ行）', () => {
    const kept = deduplicateEntries(
      db,
      [
        { ...entry(1, 'INSERT', '2026-01-01T00:00:00.000Z'), recordId: 'u1' },
        { ...entry(2, 'INSERT', '2026-01-01T00:00:00.000Z'), recordId: 'u2' },
        {
          ...entry(3, 'UPDATE', '2026-02-01T00:00:00.000Z'),
          tableName: 'Users',
          recordId: 'u1',
        },
      ],
      'id'
    )
    expect(kept).toHaveLength(2)
    const u1 = kept.find((e) => e.recordId === 'u1')
    expect(u1?.operation).toBe('UPDATE')
  })
})

describe('3端末でのねじれ', () => {
  const fixture = createSyncFixture('test-data-changelog-order')
  beforeEach(fixture.prepare)
  afterEach(fixture.cleanup)

  it('フルマージが持ち込む古いINSERTが、新しい削除を覆い隠さない', async () => {
    const a = fixture.createClientDb('client-a')
    const b = fixture.createClientDb('client-b')
    const c = fixture.createClientDb('client-c')
    const syncAll = async (): Promise<void> => {
      await performSync(a.db, fixture.makeConfig(a.dbPath, 'client-a'), TABLES)
      await performSync(b.db, fixture.makeConfig(b.dbPath, 'client-b'), TABLES)
      await performSync(c.db, fixture.makeConfig(c.dbPath, 'client-c'), TABLES)
    }
    const countUsers = (db: Database.Database): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n

    try {
      // 1. A が行を作り、3台に行き渡らせる
      a.db
        .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('u1', 'Alice', '2026-01-01T00:00:00.000Z')
      await syncAll()
      await syncAll()
      await syncAll()
      for (const db of [a.db, b.db, c.db]) expect(countUsers(db)).toBe(1)

      // 2. A の changelog を、相手がまだ読んでいない位置まで削る
      //    （＝次に読む端末はフルマージに落ちる）
      const lags = [b.db, c.db].map((peer) => {
        const row = peer
          .prepare(
            `SELECT lastSeenId FROM _sync_state WHERE remoteClientId = 'client-a'`
          )
          .get() as { lastSeenId: number } | undefined
        return row?.lastSeenId ?? 0
      })
      a.db
        .prepare(`DELETE FROM _changelog WHERE id <= ?`)
        .run(Math.min(...lags) + 1)

      // 3. C が削除する。C はこのあとフルマージで
      //    「u1 の古い INSERT」を取り込み、それが自分の DELETE より後ろに並ぶ
      c.db.prepare(`DELETE FROM users WHERE id = 'u1'`).run()

      // 4. 何周回しても削除が行き渡ること
      for (let round = 0; round < 5; round += 1) await syncAll()

      for (const [label, db] of [
        ['A', a.db],
        ['B', b.db],
        ['C', c.db],
      ] as const) {
        expect(countUsers(db), `client-${label}`).toBe(0)
      }
    } finally {
      a.db.close()
      b.db.close()
      c.db.close()
    }
  }, 60000)
})
