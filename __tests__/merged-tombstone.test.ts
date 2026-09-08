/**
 * 「畳んだ結果」を受け取る側の回帰テスト。
 *
 * 畳みを起こした端末は自分で子を付け替えられるが、**畳みを経験しなかった端末**には
 * 「敗者行が消えた」という事実（tombstone）だけが届く。畳み先が一緒に届かないと、
 * その端末は敗者行をただ削除し、**自分が持っている子をカスケードで失う**。
 * さらにその削除がtombstoneとして伝播し、**他の端末で正しく付け替え済みの子まで殺す**。
 *
 * ここでは tombstone に畳み先（mergedInto）が載って伝わること、そして受け取った側が
 * 「消す前に子を畳み先へ付け替える」ことを、2端末では作れない4端末の並びで確かめる。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupChangelog } from '../src/setup'
import { performSync } from '../src/sync'
import { SyncConfig, TableConfig } from '../src/types'

describe('畳み先つきtombstoneの伝播', () => {
  const testDir = path.join(__dirname, 'test-data-merged-tombstone')
  const nasDir = path.join(testDir, 'nas')

  const TABLES: TableConfig[] = [
    { name: 'parents' },
    { name: 'children' },
    { name: 'memos' },
  ]

  function createClientDb(clientId: string): {
    db: Database.Database
    dbPath: string
  } {
    const clientDir = path.join(testDir, clientId)
    fs.mkdirSync(clientDir, { recursive: true })
    const dbPath = path.join(clientDir, 'local.sqlite')

    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        ukey      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE children (
        id        TEXT PRIMARY KEY,
        parentId  TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        label     TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    // 競合とは何の関係も無いテーブル（同期が詰まっていないことの検査に使う）
    db.exec(`
      CREATE TABLE memos (
        id        TEXT PRIMARY KEY,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')
    return { db, dbPath }
  }

  function makeConfig(dbPath: string, clientId: string): SyncConfig {
    return {
      dbPath,
      nasPath: nasDir,
      clientId,
      primaryKey: 'id',
      changelogRetentionDays: 7,
    }
  }

  function childrenOf(db: Database.Database): string[] {
    return (
      db.prepare(`SELECT id, parentId FROM children ORDER BY id`).all() as {
        id: string
        parentId: string
      }[]
    ).map((child) => `${child.id}->${child.parentId}`)
  }

  function parentIdsOf(db: Database.Database): string[] {
    return (
      db.prepare(`SELECT id FROM parents ORDER BY id`).all() as { id: string }[]
    ).map((parent) => parent.id)
  }

  /**
   * 「畳んだ結果を、畳みを経験していない端末が受け取る」並びを作る。
   *
   * - client-b: 敗者 bbb の持ち主。勝者を受け取って自分で畳む（tombstone を作る側）
   * - client-z: 勝者 aaa の持ち主
   * - client-c: 畳みを経験しない端末。bbb を持ち、**自分のローカルで** bbb の子を作る
   * - client-d: ずっと遅れている端末。bbb を持ったまま、あとで bbb の子を作る
   */
  async function seedFoldedWorld(): Promise<{
    dbB: Database.Database
    pathB: string
    dbC: Database.Database
    pathC: string
    dbD: Database.Database
    pathD: string
    dbZ: Database.Database
    pathZ: string
  }> {
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    dbB
      .prepare(`INSERT INTO parents (id, ukey, updatedAt) VALUES (?, ?, ?)`)
      .run('bbb', 'k1', '2024-01-01T00:00:00Z')
    dbB
      .prepare(
        `INSERT INTO children (id, parentId, label, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('ch-b', 'bbb', 'Bの子', '2024-01-01T00:00:00Z')
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    const { db: dbC, dbPath: pathC } = createClientDb('client-c')
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES)
    const { db: dbD, dbPath: pathD } = createClientDb('client-d')
    await performSync(dbD, makeConfig(pathD, 'client-d'), TABLES)

    // C は自分のローカルで bbb の子を作る（この行は C にしか無い）
    dbC
      .prepare(
        `INSERT INTO children (id, parentId, label, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('ch-c', 'bbb', 'Cの子', '2024-02-01T00:00:00Z')

    const { db: dbZ, dbPath: pathZ } = createClientDb('client-z')
    dbZ
      .prepare(`INSERT INTO parents (id, ukey, updatedAt) VALUES (?, ?, ?)`)
      .run('aaa', 'k1', '2024-06-01T00:00:00Z')
    dbZ
      .prepare(
        `INSERT INTO children (id, parentId, label, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('ch-z', 'aaa', 'Zの子', '2024-06-01T00:00:00Z')
    await performSync(dbZ, makeConfig(pathZ, 'client-z'), TABLES)

    // B が畳む（bbb → aaa）。NASへのアップロードはpullより前に起きるので、
    // 畳んだ結果がNASに載るのは次の同期。tombstoneがCへ先に届く状況はここで作られる。
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    return { dbB, pathB, dbC, pathC, dbD, pathD, dbZ, pathZ }
  }

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
    fs.mkdirSync(nasDir, { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  it('畳みを経験しなかった端末でも、自分の子が消えず畳み先へ引き取られる', async () => {
    const { dbB, dbC, pathC, dbD, dbZ } = await seedFoldedWorld()

    const resultC = await performSync(
      dbC,
      makeConfig(pathC, 'client-c'),
      TABLES
    )
    expect(
      resultC.warnings.filter((warning) => warning.includes('FOREIGN KEY'))
    ).toEqual([])

    expect(parentIdsOf(dbC)).toEqual(['aaa'])
    // C にしか無かった ch-c が生き残り、勝者 aaa にぶら下がる
    expect(childrenOf(dbC)).toEqual(['ch-b->aaa', 'ch-c->aaa', 'ch-z->aaa'])

    ;[dbB, dbC, dbD, dbZ].forEach((db) => db.close())
  })

  it('その端末の削除が、他端末で付け替え済みの子を殺さない', async () => {
    const { dbB, pathB, dbC, pathC, dbD, dbZ, pathZ } = await seedFoldedWorld()

    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES)
    // C が取り込んだ結果（削除が起きていればその tombstone も）をNASへ載せる
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES)

    // C の削除（もしあれば）が tombstone として B・Z へ伝播する
    for (let i = 0; i < 2; i++) {
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
      await performSync(dbZ, makeConfig(pathZ, 'client-z'), TABLES)
    }

    for (const [label, db] of [
      ['B', dbB],
      ['Z', dbZ],
    ] as const) {
      expect(parentIdsOf(db), `client-${label}`).toEqual(['aaa'])
      // 付け替え済みの ch-b が生きており、C から来た削除で殺されていない
      expect(childrenOf(db), `client-${label}`).toEqual([
        'ch-b->aaa',
        'ch-c->aaa',
        'ch-z->aaa',
      ])
    }

    ;[dbB, dbC, dbD, dbZ].forEach((db) => db.close())
  })

  it('畳んだ側のDBが共有フォルダに無くても、勝った側の記録から畳み先が通常経路で届く', async () => {
    // B: 敗者になる bbb（古い）とその子。このあと二度と現れない
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    dbB
      .prepare(`INSERT INTO parents (id, ukey, updatedAt) VALUES (?, ?, ?)`)
      .run('bbb', 'k1', '2024-01-01T00:00:00Z')
    dbB
      .prepare(
        `INSERT INTO children (id, parentId, label, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('ch-b', 'bbb', 'Bの子', '2024-01-01T00:00:00Z')
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // D: bbb を持ったまま遅れる端末
    const { db: dbD, dbPath: pathD } = createClientDb('client-d')
    await performSync(dbD, makeConfig(pathD, 'client-d'), TABLES)

    // A: 勝者 aaa（新しい）。B の bbb を受け取って local_wins で畳む。
    // A は敗者行を一度も持たないので、A では DELETE が起きない
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO parents (id, ukey, updatedAt) VALUES (?, ?, ?)`)
      .run('aaa', 'k1', '2024-06-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    // アップロードはpullより前に起きるので、畳んだ記録がNASに載るのは次の同期
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // B の共有ファイルを取り除く（DELETEトリガーによる記録はどこにも存在しない）
    fs.rmSync(path.join(nasDir, 'client-client-b.sqlite'))
    dbB.close()

    // D は離脱中に bbb の子と無関係なメモを作る。
    // bbb の作成記録は保持期間を過ぎて消えている（誰も bbb の存在を語らない）
    dbD
      .prepare(
        `INSERT INTO children (id, parentId, label, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('ch-d', 'bbb', 'Dの子', '2024-03-01T00:00:00Z')
    dbD
      .prepare(`INSERT INTO memos (id, body, updatedAt) VALUES (?, ?, ?)`)
      .run('memo-d', '競合とは無関係な変更', '2024-03-01T00:00:00Z')
    dbD.prepare(`DELETE FROM _changelog WHERE recordId = ?`).run('bbb')
    await performSync(dbD, makeConfig(pathD, 'client-d'), TABLES)

    // C: あとから参加する端末。読める相手は A と D だけ
    const { db: dbC, dbPath: pathC } = createClientDb('client-c')
    const result = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES)

    expect(
      result.warnings.filter((warning) => warning.includes('FOREIGN KEY'))
    ).toEqual([])
    expect(result.clientsSynced).toBe(2)
    expect(parentIdsOf(dbC)).toEqual(['aaa'])
    expect(childrenOf(dbC)).toEqual(['ch-b->aaa', 'ch-d->aaa'])
    expect(
      (dbC.prepare(`SELECT id FROM memos`).all() as { id: string }[]).map(
        (memo) => memo.id
      )
    ).toEqual(['memo-d'])

    dbA.close()
    dbC.close()
    dbD.close()
  })

  it('mergedInto列を持たない旧クライアントのtombstoneも従来どおり適用できる', async () => {
    const { db: dbOld, dbPath: pathOld } = createClientDb('client-old')
    dbOld
      .prepare(`INSERT INTO parents (id, ukey, updatedAt) VALUES (?, ?, ?)`)
      .run('p1', 'k1', '2024-01-01T00:00:00Z')
    await performSync(dbOld, makeConfig(pathOld, 'client-old'), TABLES)

    const { db: dbNew, dbPath: pathNew } = createClientDb('client-new')
    await performSync(dbNew, makeConfig(pathNew, 'client-new'), TABLES)
    expect(parentIdsOf(dbNew)).toEqual(['p1'])

    // 旧バージョンのクライアントを模して、_tombstone を mergedInto 列の無い形に戻す
    dbOld.prepare(`DELETE FROM parents WHERE id = ?`).run('p1')
    const tombstones = dbOld
      .prepare(`SELECT tableName, recordId, deletedAt FROM _tombstone`)
      .all() as { tableName: string; recordId: string; deletedAt: string }[]
    dbOld.exec(`DROP TABLE _tombstone`)
    dbOld.exec(`
      CREATE TABLE _tombstone (
        tableName TEXT NOT NULL,
        recordId  TEXT NOT NULL,
        deletedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tableName, recordId)
      )
    `)
    for (const tombstone of tombstones) {
      dbOld
        .prepare(
          `INSERT INTO _tombstone (tableName, recordId, deletedAt) VALUES (?, ?, ?)`
        )
        .run(tombstone.tableName, tombstone.recordId, tombstone.deletedAt)
    }
    await performSync(dbOld, makeConfig(pathOld, 'client-old'), TABLES)

    const result = await performSync(
      dbNew,
      makeConfig(pathNew, 'client-new'),
      TABLES
    )
    expect(
      result.warnings.filter((warning) => warning.includes('Sync failed'))
    ).toEqual([])
    expect(parentIdsOf(dbNew)).toEqual([])

    dbOld.close()
    dbNew.close()
  })

  it('畳みを受け取ったあとに届く敗者の子も、畳み先へ向け直される', async () => {
    const { dbB, dbC, pathC, dbD, pathD, dbZ } = await seedFoldedWorld()

    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES)

    // ずっと遅れている D が、まだ生きていると思っている bbb の子を作る
    dbD
      .prepare(
        `INSERT INTO children (id, parentId, label, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('ch-d', 'bbb', 'Dの子', '2024-03-01T00:00:00Z')
    dbD
      .prepare(`INSERT INTO memos (id, body, updatedAt) VALUES (?, ?, ?)`)
      .run('memo-d', '競合とは無関係な変更', '2024-03-01T00:00:00Z')
    await performSync(dbD, makeConfig(pathD, 'client-d'), TABLES)

    for (let i = 0; i < 3; i++) {
      const result = await performSync(
        dbC,
        makeConfig(pathC, 'client-c'),
        TABLES
      )
      expect(
        result.warnings.filter((warning) => warning.includes('FOREIGN KEY'))
      ).toEqual([])
      expect(result.clientsSynced).toBe(3)
    }

    expect(childrenOf(dbC)).toContain('ch-d->aaa')
    // 詰まっていれば、その相手の無関係な変更も永久に届かない
    expect(
      (dbC.prepare(`SELECT id FROM memos`).all() as { id: string }[]).map(
        (memo) => memo.id
      )
    ).toEqual(['memo-d'])

    ;[dbB, dbC, dbD, dbZ].forEach((db) => db.close())
  })
})
