/**
 * 自分が書いた行にも、同じ LWW を当てる。
 *
 * 取り込み経路は「削除より古い挿入・更新は採らない」を守っているが、**アプリが
 * ローカルへ直接書いた行はその検査を通らない**。既にある削除より古い時刻で行が
 * 書かれると、書いた端末はそれを持ち続け、受け取る端末は規則どおり採らないので、
 * **警告も例外も出ないまま永久に食い違う**。
 *
 * アプリが `updatedAt` に現在時刻を入れているかぎり起きないが、過去の時刻を
 * 入れる余地がある以上、ライブラリ側の規則として閉じておく。
 * （この形は3端末の性質テストが見つけた。手で書いた筋書きでは踏めていなかった。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { readSelfCheckCursor } from '../src/sync/self-check'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

describe('削除に負けたローカルの書き込み', () => {
  const fixture = createSyncFixture('test-data-self-check')
  beforeEach(fixture.prepare)
  afterEach(fixture.cleanup)

  const insertUser = (
    db: Database.Database,
    id: string,
    name: string,
    at: string
  ): void => {
    db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      id,
      name,
      at
    )
  }
  const userIds = (db: Database.Database): string[] =>
    (
      db.prepare(`SELECT id FROM users ORDER BY id`).all() as { id: string }[]
    ).map((row) => row.id)

  it('同じ端末が、自分の削除より古い時刻で作り直した行は残らない', async () => {
    const a = fixture.createClientDb('client-a')
    try {
      const config = fixture.makeConfig(a.dbPath, 'client-a')
      insertUser(a.db, 'u1', 'Alice', '2026-01-01T00:00:00.000Z')
      a.db.prepare(`DELETE FROM users WHERE id = 'u1'`).run()
      await performSync(a.db, config, TABLES)

      // 削除より古い時刻で作り直す（アプリが過去の時刻を書いた形）
      insertUser(a.db, 'u1', 'Alice again', '2026-01-01T00:00:00.000Z')
      const result = await performSync(a.db, config, TABLES)

      expect(userIds(a.db)).toEqual([])
      expect(
        result.warnings.filter((warning) =>
          warning.startsWith('Dropped local users:u1')
        )
      ).toHaveLength(1)
    } finally {
      a.db.close()
    }
  }, 60000)

  it('他端末の削除より古い時刻で書いた行も残らない（食い違いが閉じる）', async () => {
    const a = fixture.createClientDb('client-a')
    const b = fixture.createClientDb('client-b')
    try {
      const configA = fixture.makeConfig(a.dbPath, 'client-a')
      const configB = fixture.makeConfig(b.dbPath, 'client-b')

      // B が行を作って消し、A へ渡す（A は削除の記録だけを受け取る）
      insertUser(b.db, 'u1', 'Alice', '2026-01-01T00:00:00.000Z')
      b.db.prepare(`DELETE FROM users WHERE id = 'u1'`).run()
      await performSync(b.db, configB, TABLES)
      await performSync(a.db, configA, TABLES)

      // A が同じ id を、その削除より古い時刻で作る
      insertUser(a.db, 'u1', 'Alice on A', '2026-01-01T00:00:00.000Z')
      for (let round = 0; round < 3; round += 1) {
        await performSync(a.db, configA, TABLES)
        await performSync(b.db, configB, TABLES)
      }

      expect(userIds(a.db)).toEqual([])
      expect(userIds(b.db)).toEqual([])
    } finally {
      a.db.close()
      b.db.close()
    }
  }, 60000)

  it('削除より新しい時刻で作り直した行は残る（作り直しを殺さない）', async () => {
    const a = fixture.createClientDb('client-a')
    try {
      const config = fixture.makeConfig(a.dbPath, 'client-a')
      insertUser(a.db, 'u1', 'Alice', '2026-01-01T00:00:00.000Z')
      a.db.prepare(`DELETE FROM users WHERE id = 'u1'`).run()
      await performSync(a.db, config, TABLES)

      // 削除（＝同期を回した現在時刻）より後の時刻で作り直す
      insertUser(a.db, 'u1', 'Alice again', '2099-01-01T00:00:00.000Z')
      const result = await performSync(a.db, config, TABLES)

      expect(userIds(a.db)).toEqual(['u1'])
      expect(
        result.warnings.filter((warning) => warning.startsWith('Dropped local'))
      ).toEqual([])
    } finally {
      a.db.close()
    }
  }, 60000)

  it('普通に書いた行には何もしない', async () => {
    const a = fixture.createClientDb('client-a')
    try {
      const config = fixture.makeConfig(a.dbPath, 'client-a')
      insertUser(a.db, 'u1', 'Alice', '2026-01-01T00:00:00.000Z')
      insertUser(a.db, 'u2', 'Bob', '2026-01-02T00:00:00.000Z')
      const result = await performSync(a.db, config, TABLES)

      expect(userIds(a.db)).toEqual(['u1', 'u2'])
      expect(
        result.warnings.filter((warning) => warning.startsWith('Dropped local'))
      ).toEqual([])
    } finally {
      a.db.close()
    }
  }, 60000)

  it('見直した位置は前へ進み、保持期間ぶんを毎回なめ直さない', async () => {
    const a = fixture.createClientDb('client-a')
    try {
      const config = fixture.makeConfig(a.dbPath, 'client-a')
      insertUser(a.db, 'u1', 'Alice', '2026-01-01T00:00:00.000Z')
      await performSync(a.db, config, TABLES)
      const first = readSelfCheckCursor(a.db)
      expect(first).toBeGreaterThan(0)

      insertUser(a.db, 'u2', 'Bob', '2026-01-02T00:00:00.000Z')
      await performSync(a.db, config, TABLES)
      expect(readSelfCheckCursor(a.db)).toBeGreaterThan(first)
    } finally {
      a.db.close()
    }
  }, 60000)

  it('位置は巻き戻らない', () => {
    const a = fixture.createClientDb('client-a')
    try {
      a.db
        .prepare(`INSERT INTO _sync_meta (key, value) VALUES (?, ?)`)
        .run('selfCheckedChangelogId', '100')
      // 小さい値を書いても下がらない（下がると、見直した書き込みをまた読み直す
      // ——害は無いが、位置が意味を失う）
      a.db
        .prepare(
          `INSERT INTO _sync_meta (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value = CAST(MAX(CAST(_sync_meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`
        )
        .run('selfCheckedChangelogId', '5')
      expect(readSelfCheckCursor(a.db)).toBe(100)
    } finally {
      a.db.close()
    }
  })

  it('`_sync_meta` が無いDBでも例外にならない', () => {
    const bare = new Database(':memory:')
    expect(readSelfCheckCursor(bare)).toBe(0)
    bare.close()
  })
})
