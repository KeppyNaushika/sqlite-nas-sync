/**
 * `applyUpdate`（LWWによる上書き）と `applyDelete` の基本。
 *
 * `applyInsert` は `conflict.test.ts` にある。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyDelete, applyUpdate } from '../src/conflict'

let db: Database.Database
const columns = ['id', 'name', 'email', 'updatedAt']

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      updatedAt TEXT NOT NULL
    )
  `)
})

afterEach(() => {
  db.close()
})

describe('applyUpdate', () => {
  it('ローカルにPKが無くセカンダリUNIQUE違反になる場合も競合解決される', () => {
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z')

    // リモートのUPDATEエントリだが、ローカルにu2は無く、emailがu1と衝突する
    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u2',
        name: 'Alice Remote',
        email: 'alice@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      columns
    )

    // 例外にならず、LWWで解決される（リモートが新しい → 置換）
    expect(result.action).toBe('updated')
    const u1 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1')
    const u2 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u2') as any
    expect(u1).toBeUndefined()
    expect(u2.name).toBe('Alice Remote')
  })

  it('ローカルにPKが在り、書き込みが別の行のセカンダリUNIQUEに当たる場合も畳まれる', () => {
    // 更新対象の u1 と、更新後の email を既に持っている別の行 u2
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z')
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u2', 'Alice Dup', 'alice.new@example.com', '2024-02-01T00:00:00Z')

    // 届いた更新(2024-06-01)が u2(2024-02-01)より新しい → 届いた更新が勝つ
    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u1',
        name: 'Alice Renamed',
        email: 'alice.new@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      columns
    )

    expect(result.action).toBe('updated')
    expect(result.conflict?.resolution).toBe('remote_wins')

    expect(db.prepare(`SELECT id FROM users ORDER BY id`).all()).toEqual([
      { id: 'u1' },
    ])
    const u1 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any
    expect(u1.email).toBe('alice.new@example.com')
    // 畳んだ相手の id は勝者へ読み替えられるよう記録される
    expect(
      db.prepare(`SELECT losingId, winningId FROM _id_merge`).all()
    ).toEqual([{ losingId: 'u2', winningId: 'u1' }])
  })

  it('セカンダリUNIQUEでローカル行が勝つ場合、更新対象の行の方が畳まれる', () => {
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z')
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u2', 'Alice Dup', 'alice.new@example.com', '2024-12-01T00:00:00Z')

    // 届いた更新(2024-06-01)より u2(2024-12-01)の方が新しい → ローカル行が勝つ
    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u1',
        name: 'Alice Renamed',
        email: 'alice.new@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      columns
    )

    expect(result.action).toBe('skipped')
    expect(result.conflict?.resolution).toBe('local_wins')

    // 届いた更新を黙って捨てるのではなく、u1 の方を u2 へ畳む
    expect(db.prepare(`SELECT id FROM users ORDER BY id`).all()).toEqual([
      { id: 'u2' },
    ])
    const u2 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u2') as any
    expect(u2.name).toBe('Alice Dup')
    expect(
      db.prepare(`SELECT losingId, winningId FROM _id_merge`).all()
    ).toEqual([{ losingId: 'u1', winningId: 'u2' }])
  })

  it('2本目のユニークで更新が拒まれる場合、1本目で畳んだ行は巻き戻る', () => {
    // ユニークが2本ある表（`User(username UNIQUE, email UNIQUE)` の形）。
    // 1回の書き込みが、索引ごとに別々の相手へぶつかることがある。
    db.exec(`
      CREATE TABLE accounts (
        id        TEXT PRIMARY KEY,
        username  TEXT NOT NULL UNIQUE,
        email     TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    const accountColumns = ['id', 'username', 'email', 'updatedAt']
    const insertAccount = db.prepare(
      `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)`
    )
    // 更新対象
    insertAccount.run('r0', 'name0', 'mail0', '2024-05-01T00:00:00Z')
    // email でぶつかる古い相手（届いた更新が勝つ側）
    insertAccount.run('r1', 'name1', 'mailX', '2024-01-01T00:00:00Z')
    // username でぶつかる新しい相手（届いた更新が負ける側）
    insertAccount.run('r2', 'nameX', 'mail2', '2024-12-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'accounts',
      'id',
      {
        id: 'r0',
        username: 'nameX',
        email: 'mailX',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      accountColumns
    )

    expect(result.action).toBe('skipped')
    expect(result.conflict?.resolution).toBe('local_wins')

    // 更新は採用しないと決まったのだから、その前に畳んだ r1 も残っていること。
    // 収束のため、更新対象の r0 だけが勝った相手 r2 へ畳まれる。
    expect(db.prepare(`SELECT id FROM accounts ORDER BY id`).all()).toEqual([
      { id: 'r1' },
      { id: 'r2' },
    ])
    expect(
      db.prepare(`SELECT email FROM accounts WHERE id = ?`).get('r1')
    ).toEqual({ email: 'mailX' })
    expect(
      db
        .prepare(`SELECT losingId, winningId FROM _id_merge ORDER BY losingId`)
        .all()
    ).toEqual([{ losingId: 'r0', winningId: 'r2' }])
  })

  it('リモートが新しい場合は更新する', () => {
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u1',
        name: 'Alice Updated',
        email: 'alice.new@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      columns
    )

    expect(result.action).toBe('updated')
    expect(result.conflict?.resolution).toBe('remote_wins')

    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any
    expect(row.name).toBe('Alice Updated')
  })

  it('ローカルが新しい場合はスキップする', () => {
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2024-06-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u1',
        name: 'Alice Old',
        email: 'alice.old@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      columns
    )

    expect(result.action).toBe('skipped')
    expect(result.conflict?.resolution).toBe('local_wins')

    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any
    expect(row.name).toBe('Alice')
  })

  it('タイムゾーンオフセット混在でも時刻として比較する（字句比較だと更新喪失する回帰ケース）', () => {
    // ローカルは 10:00 UTC。リモートは +09:00 表記の 18:30（=09:30 UTC）で実際は古い。
    // 字句比較では "T18:30" > "T10:00" となりリモートが新しく見えてしまうが、
    // julianday 正規化により本当の時刻順（ローカルが新しい）で local_wins になるべき。
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2026-05-13T10:00:00.000+00:00')

    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u1',
        name: 'Alice Stale',
        email: 'alice.stale@example.com',
        updatedAt: '2026-05-13T18:30:00.000+09:00',
      },
      columns
    )

    expect(result.action).toBe('skipped')
    expect(result.conflict?.resolution).toBe('local_wins')

    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any
    expect(row.name).toBe('Alice')
  })

  it('同じタイムスタンプならスキップする', () => {
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u1',
        name: 'Alice Same',
        email: 'alice.same@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      columns
    )

    expect(result.action).toBe('skipped')
    expect(result.conflict).toBeUndefined()
  })

  it('ローカルに存在しない場合はINSERTする', () => {
    const result = applyUpdate(
      db,
      'users',
      'id',
      {
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      columns
    )

    expect(result.action).toBe('inserted')

    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any
    expect(row.name).toBe('Alice')
  })
})

describe('applyDelete', () => {
  it('存在するレコードを削除する', () => {
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z')

    const result = applyDelete(db, 'users', 'id', 'u1')
    expect(result.action).toBe('deleted')

    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1')
    expect(row).toBeUndefined()
  })

  it('存在しないレコードの削除はスキップする', () => {
    const result = applyDelete(db, 'users', 'id', 'nonexistent')
    expect(result.action).toBe('skipped')
  })
})

/**
 * 衝突相手を「エラー文から1本ずつ」ではなく
 * 「`PRAGMA index_list` / `index_xinfo` から先に全部」引くようにしたぶんの検査。
 */
