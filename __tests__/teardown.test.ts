import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { removeSync, setupSync } from '../src/index'

/**
 * `removeSync` の検査。
 *
 * 取り除いたあとに「アプリの表の名前と行だけが残る」ことを、sqlite_master の全件で見る。
 * 取り除く対象の一覧（`teardown.ts`）からライブラリの新しい表やトリガーが漏れれば、
 * 本物の `setupSync` と `syncNow` が作ったものが残るのでここで落ちる。
 */
describe('removeSync', () => {
  let testDir: string
  let dbPath: string
  let nasDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-teardown-'))
    dbPath = path.join(testDir, 'local.sqlite')
    nasDir = path.join(testDir, 'nas')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE posts (
        id TEXT PRIMARY KEY NOT NULL,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX posts_userId ON posts(userId);
    `)
    db.close()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  const schemaObjects = (): string[] => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return db
        .prepare<[], { type: string; name: string }>(
          `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
        )
        .all()
        .map((row) => `${row.type}:${row.name}`)
    } finally {
      db.close()
    }
  }

  const appObjects = ['index:posts_userId', 'table:posts', 'table:users']

  async function setUpAndSync(): Promise<void> {
    const sync = setupSync({ dbPath, nasPath: nasDir, clientId: 'client-a' })
    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO users VALUES ('u1', 'Alice', '2026-10-05T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO posts VALUES ('p1', 'u1', 'Hello', '2026-10-05T00:00:00.000Z')`
    ).run()
    db.prepare(
      `UPDATE users SET name = 'Alicia', updatedAt = '2026-10-05T00:00:01.000Z' WHERE id = 'u1'`
    ).run()
    db.close()
    await sync.syncNow()
    await sync.close()
  }

  it('setupSync と同期が作ったものを全部取り除き、アプリの表と行は残す', async () => {
    await setUpAndSync()
    expect(schemaObjects().length).toBeGreaterThan(appObjects.length)

    const removed = removeSync(dbPath)

    expect(removed.length).toBeGreaterThan(0)
    expect(schemaObjects()).toEqual(appObjects)
    const db = new Database(dbPath)
    try {
      expect(db.pragma('quick_check', { simple: true })).toBe('ok')
      expect(db.prepare(`SELECT name FROM users`).all()).toEqual([
        { name: 'Alicia' },
      ])
      expect(db.prepare(`SELECT title FROM posts`).all()).toEqual([
        { title: 'Hello' },
      ])
      // `_changelog` の AUTOINCREMENT の値も残らない
      expect(
        db
          .prepare(`SELECT name FROM sqlite_sequence WHERE name = '_changelog'`)
          .all()
      ).toEqual([])
      // 取り除いたあとは、時刻列の検査も効かない（ISO 8601 でない値も書ける）
      db.prepare(
        `INSERT INTO users VALUES ('u2', 'Bob', '1759622400000')`
      ).run()
    } finally {
      db.close()
    }
    expect(schemaObjects()).toEqual(appObjects)
  })

  it('取り除いたあとに setupSync し直せば、同期は元どおり動く', async () => {
    await setUpAndSync()
    removeSync(dbPath)

    // 同じ NAS へ同じ clientId で戻ると、手元の記録が消えているので復元と判定される
    // （removeSync の説明を参照）。ここでは新しい NAS で張り直す
    const sync = setupSync({
      dbPath,
      nasPath: path.join(testDir, 'nas-2'),
      clientId: 'client-a',
    })
    const result = await sync.syncNow()
    await sync.close()

    expect(result.warnings).toEqual([])
    expect(schemaObjects().length).toBeGreaterThan(appObjects.length)
  })

  it('2回目は何も取り除かない', async () => {
    await setUpAndSync()
    removeSync(dbPath)

    expect(removeSync(dbPath)).toEqual([])
  })

  it('このライブラリが使ったことのない DB では、同じ名前の表があっても触らない', () => {
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE _changelog (id INTEGER PRIMARY KEY, note TEXT)`)
    db.close()

    expect(removeSync(dbPath)).toEqual([])
    expect(schemaObjects()).toContain('table:_changelog')
  })

  it('旧方式の表とトリガーも取り除く', () => {
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE _sync_state (clientId TEXT PRIMARY KEY, lastSeenId INTEGER);
      CREATE TABLE _changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tableName TEXT);
      CREATE TABLE _id_merge (id TEXT PRIMARY KEY);
      CREATE TABLE _heartbeat (id TEXT PRIMARY KEY, updatedAt TEXT);
      CREATE TRIGGER _changelog_after_insert_users AFTER INSERT ON users
        BEGIN INSERT INTO _changelog (tableName) VALUES ('users'); END;
      CREATE TRIGGER _changelog_after_update__heartbeat AFTER UPDATE ON _heartbeat
        BEGIN INSERT INTO _changelog (tableName) VALUES ('_heartbeat'); END;
    `)
    db.close()

    expect(removeSync(dbPath)).toEqual([
      '_changelog_after_insert_users',
      '_changelog_after_update__heartbeat',
      '_changelog',
      '_heartbeat',
      '_id_merge',
      '_sync_state',
    ])
    expect(schemaObjects()).toEqual(appObjects)
  })
})
