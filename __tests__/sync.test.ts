/**
 * `performSync` の基本動作 —— INSERT / UPDATE / DELETE の伝播、スキーマ版の突き合わせ、
 * リモートが開けないときの続行。
 *
 * 主キーの違う2行が `UNIQUE` で衝突したときの統合の勝者は `rows-derive.test.ts` にある。
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

    // B同期: Aのd-aを受信する。
    // d-a と d-b は cellKey で衝突し、時刻の新しい d-b が勝つので、d-a は隠れる。
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    // A同期: Bのd-bを受信し、同じく d-b が勝って d-a は隠れる。
    // 統合は削除ではないので、d-a の墓標は立たない。
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    // B再同期: 結果は変わらない
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

    // 構造化されたskippedRemotesにも記録される。
    // `_sync_meta.schemaVersion` は `<アプリの版>;sns-format=rows1` の形で持つが、
    // 利用者に見せるのはアプリの版だけ（`;sns-format=…` は内部の印）
    expect(result.skippedRemotes).toEqual([
      {
        clientId: 'client-a',
        remoteVersion: 'v1',
        localVersion: 'v2',
      },
    ])
    expect(result.warnings.some((w) => w.includes('sns-format'))).toBe(false)

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
    const { db: dbA } = createClientDb('client-a')
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
})
