/**
 * まだ踏んでいなかった入力の端。
 *
 * ここまでのテストは「起きた不具合を再現する」形で積み上がってきたので、
 * 誰も投げ込んだことのない値——桁の大きい件数、同時に走る2本の同期、
 * 使えない設定の値——が空白のまま残っていた。
 * 同値分割の端をここでまとめて固定する。
 *
 * 「こうあるべき」が自明でないものは、**今どう振る舞うか**を書き留める形にしてある。
 * 黙って変わったら気づけるようにするのが目的で、正しさの主張とは別である。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { Worker } from 'worker_threads'
import Database from 'better-sqlite3'
import { cleanupChangelog } from '../src/changelog'
import { performSync } from '../src/sync'
import { createSyncFixture, setupRowsDb, TABLES } from './helpers/sync-fixtures'

describe('件数の桁', () => {
  const fixture = createSyncFixture('test-data-volume')

  beforeEach(fixture.prepare)
  afterEach(fixture.cleanup)

  it('1000件の変更が1回の同期で渡り、掃除で消える', async () => {
    const { db: dbA, dbPath: pathA } = fixture.createClientDb('client-a')
    const insert = dbA.prepare(
      `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
    )
    const insertMany = dbA.transaction(() => {
      for (let i = 0; i < 1000; i += 1) {
        insert.run(
          `u${String(i).padStart(4, '0')}`,
          `名前${i}`,
          '2026-01-01T00:00:00Z'
        )
      }
    })
    insertMany()

    await performSync(dbA, fixture.makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = fixture.createClientDb('client-b')
    const result = await performSync(
      dbB,
      fixture.makeConfig(pathB, 'client-b'),
      TABLES
    )

    expect(result.inserted).toBe(1000)
    const count = dbB.prepare(`SELECT COUNT(*) AS n FROM users`).get() as {
      n: number
    }
    expect(count.n).toBe(1000)

    // 取り込んだぶんは自分の changelog にも載る。掃除が桁の大きい削除でも通ること。
    dbB
      .prepare(`UPDATE _changelog SET changedAt = '2020-01-01T00:00:00.000Z'`)
      .run()
    expect(cleanupChangelog(dbB, 7)).toBeGreaterThanOrEqual(1000)

    dbB.close()
  }, 60000)
})

describe('同時に走らせる', () => {
  const testDir = path.join(__dirname, 'test-data-concurrency')

  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('別スレッドが書き込み中の DB へ書く接続は、待ち時間があれば解放まで待って通り、待ち時間が 0 なら SQLITE_BUSY で失敗する', async () => {
    // NAS越しの同期では、同じローカルDBを別の接続が触っている最中に取り込みが走りうる。
    // better-sqlite3 は同期的に動くので、同じスレッドの中でロックを持ったまま別の接続で待たせることはできない。
    // そこで、ロックを持つ側を別スレッドに置き、決めた時間だけ持ってから COMMIT させる。
    const dbPath = path.join(testDir, 'shared.sqlite')
    const setup = new Database(dbPath)
    setup.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    setupRowsDb(setup, [{ name: 'users' }])
    setup.close()

    const HOLD_MS = 300
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const holder = new Worker(
      `
      const { workerData } = require('worker_threads')
      const Database = require('better-sqlite3')
      const flag = new Int32Array(workerData.buffer)
      const db = new Database(workerData.dbPath)
      db.exec('BEGIN IMMEDIATE')
      db.prepare("INSERT INTO users (id, name, updatedAt) VALUES ('u1', 'Alice', '2026-01-01T00:00:00Z')").run()
      Atomics.store(flag, 0, 1)
      Atomics.notify(flag, 0)
      Atomics.wait(flag, 0, 1, workerData.holdMs)
      db.exec('COMMIT')
      db.close()
      `,
      {
        eval: true,
        workerData: { dbPath, buffer: flag.buffer, holdMs: HOLD_MS },
      }
    )
    const exited = new Promise<number>((resolve, reject) => {
      holder.once('exit', resolve)
      holder.once('error', reject)
    })

    try {
      // 別スレッドがロックを取るまで待つ
      expect(Atomics.wait(flag, 0, 0, 5000)).not.toBe('timed-out')

      // 待ち時間を 0 にした接続は、ロック中はすぐ SQLITE_BUSY で失敗する
      const impatient = new Database(dbPath, { timeout: 0 })
      try {
        expect(() =>
          impatient
            .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
            .run('u2', 'Bob', '2026-01-01T00:00:00Z')
        ).toThrow(/SQLITE_BUSY|locked/i)
      } finally {
        impatient.close()
      }

      // 待ち時間を持つ接続は、別スレッドが COMMIT するまで待ってから通る
      const patient = new Database(dbPath, { timeout: 5000 })
      try {
        const started = Date.now()
        patient
          .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
          .run('u2', 'Bob', '2026-01-01T00:00:00Z')
        const waited = Date.now() - started
        expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2)

        const count = patient
          .prepare(`SELECT COUNT(*) AS n FROM users`)
          .get() as { n: number }
        expect(count.n).toBe(2)
      } finally {
        patient.close()
      }
    } finally {
      Atomics.store(flag, 0, 2)
      Atomics.notify(flag, 0)
      expect(await exited).toBe(0)
    }
  })

  it('2端末の同期を同時に走らせても、どちらも壊れずに終わる', async () => {
    const fixture = createSyncFixture('test-data-concurrent-sync')
    fixture.prepare()
    try {
      const { db: dbA, dbPath: pathA } = fixture.createClientDb('client-a')
      const { db: dbB, dbPath: pathB } = fixture.createClientDb('client-b')
      dbA
        .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('u1', 'Alice', '2026-01-01T00:00:00Z')
      dbB
        .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('u2', 'Bob', '2026-01-01T00:00:00Z')

      // 同じNASディレクトリへ同時に押し出し、同時に読む。
      // 押し出しは .tmp への書き込み → rename なので、
      // 相手が読んでいる最中でも中途半端なファイルを掴ませない。
      await Promise.all([
        performSync(dbA, fixture.makeConfig(pathA, 'client-a'), TABLES),
        performSync(dbB, fixture.makeConfig(pathB, 'client-b'), TABLES),
      ])

      // 往復させれば双方に行き渡る
      await performSync(dbA, fixture.makeConfig(pathA, 'client-a'), TABLES)
      await performSync(dbB, fixture.makeConfig(pathB, 'client-b'), TABLES)

      for (const db of [dbA, dbB]) {
        const ids = (
          db.prepare(`SELECT id FROM users ORDER BY id`).all() as {
            id: string
          }[]
        ).map((row) => row.id)
        expect(ids).toEqual(['u1', 'u2'])
      }

      dbA.close()
      dbB.close()
    } finally {
      fixture.cleanup()
    }
  }, 30000)
})

describe('設定の値が使えないとき', () => {
  const fixture = createSyncFixture('test-data-bad-config')

  beforeEach(fixture.prepare)
  afterEach(fixture.cleanup)

  it('保持期間が使えない値なら、均したことを警告として返す', async () => {
    // 保持期間はSQLの綴りへ埋め込まれる（`'-' || ? || ' days'`）ので、
    // 負値や NaN は解析できない綴りになり、**掃除もフルマージも例外なしで止まる**。
    // 黙って直すのではなく、直したことを持ち主へ返すこと。
    const { db, dbPath } = fixture.createClientDb('client-a')
    db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1',
      'Alice',
      '2026-01-01T00:00:00Z'
    )

    const config = {
      ...fixture.makeConfig(dbPath, 'client-a'),
      changelogRetentionDays: -1,
    }
    const result = await performSync(db, config, TABLES)

    expect(
      result.warnings.filter((warning) =>
        warning.includes('changelogRetentionDays')
      )
    ).toHaveLength(1)

    // 均した値で掃除が動くので、古いエントリは実際に消える
    db.prepare(
      `UPDATE _changelog SET changedAt = '2020-01-01T00:00:00.000Z'`
    ).run()
    const after = await performSync(db, config, TABLES)
    expect(
      after.warnings.some((w) => w.includes('changelogRetentionDays'))
    ).toBe(true)
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM _changelog WHERE changedAt < '2021'`)
      .get() as { n: number }
    expect(remaining.n).toBe(0)

    db.close()
  }, 30000)

  it('まともな設定なら、余計な警告は出さない', async () => {
    const { db, dbPath } = fixture.createClientDb('client-b')
    const result = await performSync(
      db,
      fixture.makeConfig(dbPath, 'client-b'),
      TABLES
    )
    expect(
      result.warnings.filter((warning) =>
        warning.includes('changelogRetentionDays')
      )
    ).toEqual([])
    db.close()
  })
})
