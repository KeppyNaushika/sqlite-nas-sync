/**
 * `performSync` の基本動作 —— INSERT / UPDATE / DELETE の伝播、スキーマ版の突き合わせ、
 * heartbeat、リモートが開けないときの続行。
 *
 * 別id・同一ユニークキーの畳みは `sync-unique-fold.test.ts`、
 * changelog に隙間があるときのフルマージは `sync-full-merge.test.ts` にある。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

describe('performSync', () => {
  const { nasDir, prepare, cleanup, createClientDb, makeConfig } =
    createSyncFixture('test-data-sync')

  beforeEach(prepare)
  afterEach(cleanup)

  it('INSERTエントリがリモートからローカルに同期される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    expect(result.inserted).toBe(1)
    const user = dbB
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get('u1') as any
    expect(user.name).toBe('Alice')

    dbB.close()
  })

  it('UPDATEエントリがLWWで同期される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    dbB
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice Old', '2023-01-01T00:00:00Z')

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    const user = dbB
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get('u1') as any
    expect(user.name).toBe('Alice')
    expect(result.conflictsResolved).toBeGreaterThanOrEqual(1)

    dbB.close()
  })

  it('DELETEエントリが伝播される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    let user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1')
    expect(user).toBeTruthy()

    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    expect(result.deleted).toBe(1)

    user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1')
    expect(user).toBeUndefined()

    dbB.close()
  })

  it('複数テーブルが同時にsyncされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    dbA
      .prepare(
        `INSERT INTO posts (id, title, userId, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('p1', 'Hello', 'u1', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    expect(result.inserted).toBe(2)
    dbB.close()
  })

  it('新しいエントリがない場合はスキップされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    expect(result.inserted).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.clientsSynced).toBe(1)

    dbB.close()
  })

  it('別ID・同一ユニークキーの行が両クライアントで作成された場合、LWWで1行に収束する', async () => {
    // A・Bが独立に同じ論理エンティティ（cellKey=c1）の行を作成
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(
        `INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('d-a', 'c1', 'score:5', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    dbB
      .prepare(
        `INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('d-b', 'c1', 'score:8', '2024-06-01T00:00:00Z')

    // B同期: Aのd-aを受信 → ローカルd-bの方が新しい → d-bを保持
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    // A同期: Bのd-bを受信 → リモートd-bの方が新しい → d-aを削除しd-bに置換
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    // B再同期: Aのd-a削除（tombstone/changelog）を受信しても結果は変わらない
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      const rows = db
        .prepare(`SELECT * FROM decisions WHERE cellKey = ?`)
        .all('c1') as any[]
      expect(rows, `client-${label}`).toHaveLength(1)
      expect(rows[0].id, `client-${label}`).toBe('d-b')
      expect(rows[0].value, `client-${label}`).toBe('score:8')
    }

    dbA.close()
    dbB.close()
  })

  it('schemaVersionが一致するリモートは正常に同期される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v2' }
    await performSync(dbA, configA, TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' }
    const result = await performSync(dbB, configB, TABLES)

    expect(result.inserted).toBe(1)
    dbB.close()
  })

  it('schemaVersionが不一致のリモートはスキップされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v1' }
    await performSync(dbA, configA, TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' }
    const result = await performSync(dbB, configB, TABLES)

    expect(result.inserted).toBe(0)
    expect(
      result.warnings.some((w) => w.includes('schema version mismatch'))
    ).toBe(true)

    // 構造化されたskippedRemotesにも記録される
    expect(result.skippedRemotes).toEqual([
      { clientId: 'client-a', remoteVersion: 'v1', localVersion: 'v2' },
    ])

    dbB.close()
  })

  it('schemaVersionが一致するsyncではskippedRemotesは空', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v2' }
    await performSync(dbA, configA, TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' }
    const result = await performSync(dbB, configB, TABLES)

    expect(result.skippedRemotes).toEqual([])
    dbB.close()
  })

  it('リモートDBオープン失敗時は警告を出して続行する', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    fs.writeFileSync(
      path.join(nasDir, 'client-corrupt.sqlite'),
      'not a database'
    )

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    expect(result.warnings.some((w) => w.includes('corrupt'))).toBe(true)

    dbB.close()
  })

  it('DELETEが_tombstoneに記録される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1')

    const tombstone = dbA
      .prepare(
        `SELECT * FROM _tombstone WHERE tableName = 'users' AND recordId = 'u1'`
      )
      .get() as any
    expect(tombstone).toBeTruthy()

    dbA.close()
  })

  it('heartbeatがsync時に自動更新される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    const heartbeat = dbA
      .prepare(
        `SELECT * FROM _heartbeat WHERE id = '00000000-0000-0000-0000-000000000000'`
      )
      .get() as any
    expect(heartbeat).toBeTruthy()

    const today = new Date().toISOString().slice(0, 10)
    expect(heartbeat.updatedAt).toBe(`${today}T12:00:00Z`)

    dbA.close()
  })

  it('heartbeatがchangelogに記録される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    const entry = dbA
      .prepare(`SELECT * FROM _changelog WHERE tableName = '_heartbeat'`)
      .get() as any
    expect(entry).toBeTruthy()
    expect(entry.operation).toBe('INSERT')

    dbA.close()
  })

  it('heartbeatが他クライアントに伝播する', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    const heartbeat = dbB
      .prepare(
        `SELECT * FROM _heartbeat WHERE id = '00000000-0000-0000-0000-000000000000'`
      )
      .get() as any
    expect(heartbeat).toBeTruthy()

    dbB.close()
  })
})
