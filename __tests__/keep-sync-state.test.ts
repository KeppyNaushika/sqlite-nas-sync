/**
 * 起動のたびに `_sync_state` を空にしない（`src/rows/migrate.ts` の手順7）。
 *
 * ここで見るのは3つ:
 *
 * - 立ち上げ直しただけでは、相手をフルマージで読まない
 * - 手元の読み位置か相手の読み位置で読めないものができる場合（同期する表が増えた・表を外してまた戻した・表名の大文字小文字を変えた・列の増減で書き直した・復元した）でも、立ち上げ直さない相手と同期2巡で一致する
 * - 相手にフルマージさせる `announceFullMerge` が、今の版と 0.20.0 の隙間の判定の両方に当たり、フルマージが1回で終わる
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { SyncConfig } from '../src/types'
import {
  announceFullMerge,
  cleanupChangelog,
  fullMergeCursor,
  getMaxChangelogId,
  hasChangelogGap,
  readChangelogPrunedThroughId,
  readChangelogSequence,
} from '../src/changelog'
import { SNS_META_KEYS, readSnsMeta } from '../src/rows/meta'
import { migrateToRows } from '../src/rows/migrate'
import { setupLegacyChangelog } from './helpers/legacy-changelog'
import { setupRowsDb } from './helpers/sync-fixtures'

const T = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'

describe('起動のたびに _sync_state を空にしない', () => {
  let work: string
  let nasPath: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-keep-state-'))
    nasPath = join(work, 'nas')
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function makeDb(file: string, tables: string[]): string {
    const dbPath = join(work, file)
    const db = new Database(dbPath)
    for (const table of tables) {
      db.exec(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
      )
    }
    db.close()
    return dbPath
  }

  function open(
    dbPath: string,
    clientId: string,
    extra: Partial<SyncConfig> = {}
  ) {
    const sync = setupSync({
      dbPath,
      nasPath,
      clientId,
      schemaVersion: '1',
      intervalMs: 3_600_000,
      ...extra,
    })
    const db = new Database(dbPath)
    return {
      sync,
      db,
      close: () => {
        sync.stop()
        db.close()
      },
    }
  }

  const rows = (db: Database.Database, table: string) =>
    db.prepare(`SELECT id, body FROM "${table}" ORDER BY id`).all()

  /** `sns.syncedTables` を書く前の版で作った DB にする。 */
  function forgetSyncedTables(dbPath: string): void {
    const db = new Database(dbPath)
    db.prepare(`DELETE FROM _sync_meta WHERE key = ?`).run(
      SNS_META_KEYS.syncedTables
    )
    db.close()
  }

  const syncStateCount = (db: Database.Database) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM _sync_state`).get() as { n: number })
      .n

  const versions = (db: Database.Database, table: string) =>
    db
      .prepare(
        `SELECT id, body, _sns_ts, _sns_lamport, _sns_instance FROM "_sns_rows_${table}" ORDER BY id`
      )
      .all()

  it('立ち上げ直しただけでは、相手をフルマージしない', async () => {
    const pathA = makeDb('a.sqlite', ['notes'])
    const pathB = makeDb('b.sqlite', ['notes'])
    let a = open(pathA, 'a')
    const b = open(pathB, 'b')
    a.db.prepare(`INSERT INTO notes VALUES ('k1', 'x', ?)`).run(T)
    b.db.prepare(`INSERT INTO notes VALUES ('k2', 'y', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    a.close()
    a = open(pathA, 'a')
    const first = await a.sync.syncNow()
    expect(first.hadChangelogGap).toBe(false)
    expect(rows(a.db, 'notes')).toEqual(rows(b.db, 'notes'))
    a.close()
    b.close()
  })

  it('同期する表が増えたとき、先に増やした端末にも後から増やした端末の行が届く', async () => {
    // `extra` は最初は同期しない（`excludeTables`）。両方の端末に別々の行がある
    const pathA = makeDb('a.sqlite', ['notes', 'extra'])
    const pathB = makeDb('b.sqlite', ['notes', 'extra'])
    for (const [p, id] of [
      [pathA, 'ea'],
      [pathB, 'eb'],
    ]) {
      const db = new Database(p)
      db.prepare(`INSERT INTO extra VALUES (?, 'v', ?)`).run(id, T)
      db.close()
    }
    let a = open(pathA, 'a', { excludeTables: ['extra'] })
    let b = open(pathB, 'b', { excludeTables: ['extra'] })
    a.db.prepare(`INSERT INTO notes VALUES ('k1', 'x', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    // a が先に extra を同期の対象にする
    a.close()
    a = open(pathA, 'a')
    await a.sync.syncNow()
    await b.sync.syncNow()
    // b があとから
    b.close()
    b = open(pathB, 'b')
    // 立ち上げ直さずに2周
    for (let i = 0; i < 2; i++) {
      await b.sync.syncNow()
      await a.sync.syncNow()
    }
    expect(rows(a.db, 'extra')).toEqual(rows(b.db, 'extra'))
    expect(rows(a.db, 'extra')).toHaveLength(2)
    a.close()
    b.close()
  })

  it.each([false, true])(
    '表名の大文字と小文字を変えた間の変更が、先に変えた端末にも届く（sns.syncedTables を消す: %s）',
    async (forgetKey) => {
      const pathA = makeDb('a.sqlite', ['Notes'])
      const pathB = makeDb('b.sqlite', ['Notes'])
      let a = open(pathA, 'a')
      let b = open(pathB, 'b')
      a.db.prepare(`INSERT INTO Notes VALUES ('k1', 'x', ?)`).run(T)
      for (let i = 0; i < 2; i++) {
        await a.sync.syncNow()
        await b.sync.syncNow()
      }
      const respell = (p: string) => {
        const db = new Database(p)
        db.exec(`CREATE TABLE c AS SELECT * FROM Notes`)
        db.exec(`DROP TABLE Notes`)
        db.exec(
          `CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
        )
        db.exec(`INSERT INTO notes SELECT * FROM c`)
        db.exec(`DROP TABLE c`)
        db.close()
      }
      a.close()
      respell(pathA)
      a = open(pathA, 'a')
      await a.sync.syncNow()
      // 綴りが違う間に b が書く
      b.db
        .prepare(
          `UPDATE Notes SET body = 'b-wrote', updatedAt = ? WHERE id = 'k1'`
        )
        .run(T2)
      b.db.prepare(`INSERT INTO Notes VALUES ('k2', 'b', ?)`).run(T2)
      a.db.prepare(`INSERT INTO notes VALUES ('k3', 'a', ?)`).run(T2)
      await a.sync.syncNow()
      await b.sync.syncNow()
      await a.sync.syncNow()
      // b も綴りを変える
      b.close()
      respell(pathB)
      if (forgetKey) forgetSyncedTables(pathB)
      b = open(pathB, 'b')
      for (let i = 0; i < 2; i++) {
        await b.sync.syncNow()
        await a.sync.syncNow()
      }
      expect(rows(a.db, 'notes')).toEqual(rows(b.db, 'notes'))
      expect(rows(a.db, 'notes')).toEqual([
        { id: 'k1', body: 'b-wrote' },
        { id: 'k2', body: 'b' },
        { id: 'k3', body: 'a' },
      ])
      a.close()
      b.close()
    }
  )

  // 戻したあとに書く行は、失った5行より少ない場合と同じ場合を見る。少なければ、手元の通知の id は相手の読み位置に届かない
  it.each([2, 5])(
    '復元した端末があとで書いた行が、立ち上げ直さない相手にも届く（戻したあとに書く行: %i）',
    async (written) => {
      const pathA = makeDb('a.sqlite', ['notes'])
      const pathB = makeDb('b.sqlite', ['notes'])
      let a = open(pathA, 'a')
      const b = open(pathB, 'b')
      a.db.prepare(`INSERT INTO notes VALUES ('k0', 'x', ?)`).run(T)
      for (let i = 0; i < 2; i++) {
        await a.sync.syncNow()
        await b.sync.syncNow()
      }
      // バックアップを取る
      a.close()
      const backup = join(work, 'a.backup')
      {
        const db = new Database(pathA)
        db.exec(`VACUUM INTO '${backup}'`)
        db.close()
      }
      a = open(pathA, 'a')
      for (let i = 1; i <= 5; i++) {
        a.db.prepare(`INSERT INTO notes VALUES (?, 'lost?', ?)`).run(`p${i}`, T)
      }
      await a.sync.syncNow()
      await b.sync.syncNow()
      // 戻す
      a.close()
      // 写しを読んだ相手の読み位置は、これを超えない
      const copy = new Database(join(nasPath, 'client-a.sqlite'), {
        readonly: true,
      })
      const limit = fullMergeCursor(copy)
      copy.close()
      // 古い接続はライブラリが閉じないので、戻した DB は別の場所に置く
      const restoredPath = join(work, 'a-restored.sqlite')
      copyFileSync(backup, restoredPath)
      a = open(restoredPath, 'a')
      for (let i = 1; i <= written; i++) {
        a.db
          .prepare(`INSERT INTO notes VALUES (?, 'after', ?)`)
          .run(`m${i}`, T2)
      }
      for (let i = 0; i < 2; i++) {
        await a.sync.syncNow()
        await b.sync.syncNow()
      }
      expect(readChangelogPrunedThroughId(a.db)).toBeGreaterThan(limit)
      expect(rows(b.db, 'notes')).toEqual(rows(a.db, 'notes'))
      const after = Array.from({ length: written }, (_, i) => `m${i + 1}`)
      const lost = ['p1', 'p2', 'p3', 'p4', 'p5']
      expect(
        (rows(b.db, 'notes') as { id: string }[]).map((r) => r.id)
      ).toEqual(['k0', ...after, ...lost])
      a.close()
      b.close()
    }
  )

  it('列を足して書き直した版が、立ち上げ直さない相手にも届く', async () => {
    const pathA = makeDb('a.sqlite', ['notes'])
    const pathB = makeDb('b.sqlite', ['notes'])
    let a = open(pathA, 'a')
    let b = open(pathB, 'b')
    a.db.prepare(`INSERT INTO notes VALUES ('k1', 'x', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    for (const which of ['a', 'b'] as const) {
      if (which === 'a') a.close()
      else b.close()
      const p = which === 'a' ? pathA : pathB
      const db = new Database(p)
      db.exec(`ALTER TABLE notes ADD COLUMN extra TEXT NOT NULL DEFAULT 'd'`)
      db.close()
      if (which === 'a') a = open(p, 'a')
      else b = open(p, 'b')
      for (let i = 0; i < 2; i++) {
        await a.sync.syncNow()
        await b.sync.syncNow()
      }
    }
    const versionsWithExtra = (db: Database.Database) =>
      db
        .prepare(
          `SELECT id, body, extra, _sns_ts, _sns_lamport, _sns_instance FROM _sns_rows_notes ORDER BY id`
        )
        .all()
    expect(versionsWithExtra(a.db)).toEqual(versionsWithExtra(b.db))
    a.close()
    b.close()
  })

  it('同期する表を外してまた戻すと、外していた間の変更が立ち上げ直さない相手にも届く', async () => {
    const pathA = makeDb('a.sqlite', ['notes', 'extra'])
    const pathB = makeDb('b.sqlite', ['notes', 'extra'])
    let a = open(pathA, 'a')
    const b = open(pathB, 'b')
    a.db.prepare(`INSERT INTO extra VALUES ('e1', 'v1', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    expect(rows(b.db, 'extra')).toEqual([{ id: 'e1', body: 'v1' }])

    // a だけが extra を外す。外している間に両方が extra を書く
    a.close()
    a = open(pathA, 'a', { excludeTables: ['extra'] })
    a.db
      .prepare(`UPDATE extra SET body = 'a2', updatedAt = ? WHERE id = 'e1'`)
      .run(T2)
    a.db.prepare(`INSERT INTO extra VALUES ('e2', 'a', ?)`).run(T2)
    b.db.prepare(`INSERT INTO extra VALUES ('e3', 'b', ?)`).run(T2)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    // 外している間も、a のトリガーは版を書いている。b にはまだ届いていない
    expect(
      a.db.prepare(`SELECT id, body FROM _sns_rows_extra ORDER BY id`).all()
    ).toEqual([
      { id: 'e1', body: 'a2' },
      { id: 'e2', body: 'a' },
    ])
    expect(rows(b.db, 'extra')).toEqual([
      { id: 'e1', body: 'v1' },
      { id: 'e3', body: 'b' },
    ])

    // a が extra を戻す。b は立ち上げ直さない
    a.close()
    a = open(pathA, 'a')
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    expect(rows(a.db, 'extra')).toEqual([
      { id: 'e1', body: 'a2' },
      { id: 'e2', body: 'a' },
      { id: 'e3', body: 'b' },
    ])
    expect(rows(b.db, 'extra')).toEqual(rows(a.db, 'extra'))
    // フルマージは1回で終わる
    expect((await a.sync.syncNow()).hadChangelogGap).toBe(false)
    expect((await b.sync.syncNow()).hadChangelogGap).toBe(false)
    a.close()
    b.close()
  })

  it('同期する表を外すだけなら、読み位置を残し、相手にもフルマージさせない', async () => {
    const pathA = makeDb('a.sqlite', ['notes', 'extra'])
    const pathB = makeDb('b.sqlite', ['notes', 'extra'])
    let a = open(pathA, 'a')
    const b = open(pathB, 'b')
    a.db.prepare(`INSERT INTO notes VALUES ('k1', 'x', ?)`).run(T)
    b.db.prepare(`INSERT INTO notes VALUES ('k2', 'y', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    a.close()
    a = open(pathA, 'a', { excludeTables: ['extra'] })
    expect(syncStateCount(a.db)).toBe(1)
    expect((await a.sync.syncNow()).hadChangelogGap).toBe(false)
    expect((await b.sync.syncNow()).hadChangelogGap).toBe(false)
    a.close()
    b.close()
  })

  it('sns.syncedTables の無い DB は、最初の起動で1回だけ読み位置を空にする', async () => {
    const pathA = makeDb('a.sqlite', ['notes'])
    const pathB = makeDb('b.sqlite', ['notes'])
    let a = open(pathA, 'a')
    const b = open(pathB, 'b')
    a.db.prepare(`INSERT INTO notes VALUES ('k1', 'x', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    a.close()
    forgetSyncedTables(pathA)
    a = open(pathA, 'a')
    expect(syncStateCount(a.db)).toBe(0)
    expect(readSnsMeta(a.db, SNS_META_KEYS.syncedTables)).toBe('["notes"]')
    await a.sync.syncNow()
    // 鍵が無いことは、相手にフルマージさせる理由にならない
    expect((await b.sync.syncNow()).hadChangelogGap).toBe(false)
    a.close()
    a = open(pathA, 'a')
    expect(syncStateCount(a.db)).toBe(1)
    a.close()
    b.close()
  })

  it('sns.syncedTables の無い DB で同期する表が増えても、相手にその表の行が届く', async () => {
    // b は初めから extra を同期する。a は extra を外していた間に行を書いた
    const pathA = makeDb('a.sqlite', ['notes', 'extra'])
    const pathB = makeDb('b.sqlite', ['notes', 'extra'])
    let a = open(pathA, 'a', { excludeTables: ['extra'] })
    const b = open(pathB, 'b')
    a.db.prepare(`INSERT INTO extra VALUES ('ea', 'a', ?)`).run(T)
    b.db.prepare(`INSERT INTO extra VALUES ('eb', 'b', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    a.close()
    forgetSyncedTables(pathA)
    a = open(pathA, 'a')
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    expect(rows(b.db, 'extra')).toEqual([
      { id: 'ea', body: 'a' },
      { id: 'eb', body: 'b' },
    ])
    expect(rows(a.db, 'extra')).toEqual(rows(b.db, 'extra'))
    a.close()
    b.close()
  })

  it('`_sns_rows_<表>` を写し直した端末は、相手から受け取っていた版を読み直す', async () => {
    const pathA = makeDb('a.sqlite', ['notes'])
    const pathB = makeDb('b.sqlite', ['notes'])
    let a = open(pathA, 'a')
    const b = open(pathB, 'b')
    b.db.prepare(`INSERT INTO notes VALUES ('k1', 'b', ?)`).run(T)
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    // a の版の表が失われる。次の起動はアプリの表から版を写し直す
    a.close()
    {
      const db = new Database(pathA)
      db.exec(`DROP TABLE _sns_rows_notes`)
      db.close()
    }
    a = open(pathA, 'a')
    for (let i = 0; i < 2; i++) {
      await a.sync.syncNow()
      await b.sync.syncNow()
    }
    expect(versions(a.db, 'notes')).toEqual(versions(b.db, 'notes'))
    a.close()
    b.close()
  })
})

describe('announceFullMerge', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, updatedAt TEXT NOT NULL)`
    )
    setupRowsDb(db, [{ name: 'users' }])
  })
  afterEach(() => db.close())

  const write = (id: string) =>
    db
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, 'n', ?)`)
      .run(id, T)

  const expireAll = () =>
    db.exec(`UPDATE _changelog SET changedAt = '2000-01-01T00:00:00.000Z'`)

  /** 0.20.0 の `hasChangelogGap` を写したもの。0.20.0 には規則2・3 が無い。 */
  function hasChangelogGapV020(lastSeenId: number): boolean {
    const prunedThroughId = readChangelogPrunedThroughId(db)
    if (prunedThroughId > lastSeenId) return true
    const row = db.prepare(`SELECT MIN(id) as minId FROM _changelog`).get() as {
      minId: number | null
    }
    if (row.minId === null) {
      if (prunedThroughId > 0) return false
      return lastSeenId > 0
    }
    return row.minId > lastSeenId + 1
  }

  /** 0.20.0 のフルマージのあとの読み位置。`sqlite_sequence` を見ない。 */
  const cursorV020 = () =>
    Math.max(getMaxChangelogId(db), readChangelogPrunedThroughId(db))

  it('それまでのどの読み位置にも隙間ありと答え、フルマージのあとの読み位置には答えない', () => {
    write('u1')
    write('u2')
    write('u3')
    const before = fullMergeCursor(db)
    const announced = announceFullMerge(db)
    expect(announced).toBe(before + 1)
    expect(readChangelogSequence(db)).toBe(announced)
    expect(getMaxChangelogId(db)).toBe(before)
    for (let seen = 0; seen <= before; seen++) {
      expect(hasChangelogGap(db, seen)).toBe(true)
      expect(hasChangelogGapV020(seen)).toBe(true)
    }
    expect(hasChangelogGap(db, fullMergeCursor(db))).toBe(false)
    expect(hasChangelogGapV020(cursorV020())).toBe(false)
  })

  it('次の通知はその次の id から途切れずに振られ、差分で読める', () => {
    write('u1')
    const announced = announceFullMerge(db)
    const cursor = fullMergeCursor(db)
    const cursor020 = cursorV020()
    write('u2')
    write('u3')
    const ids = db.prepare(`SELECT id FROM _changelog ORDER BY id`).all()
    expect(ids).toEqual([
      { id: 1 },
      { id: announced + 1 },
      { id: announced + 2 },
    ])
    expect(hasChangelogGap(db, cursor)).toBe(false)
    expect(hasChangelogGapV020(cursor020)).toBe(false)
  })

  it('掃除のあとも、フルマージのあとの読み位置に隙間ありと答えない', () => {
    write('u1')
    write('u2')
    announceFullMerge(db)
    const cursor = fullMergeCursor(db)
    const cursor020 = cursorV020()
    write('u3')
    // 全部を保持期間より古くして消す
    expireAll()
    expect(cleanupChangelog(db, 1)).toBe(3)
    expect(readChangelogPrunedThroughId(db)).toBe(cursor + 1)
    // 掃除で消えた通知を読んでいない相手は、フルマージする
    expect(hasChangelogGap(db, cursor)).toBe(true)
    expect(hasChangelogGap(db, fullMergeCursor(db))).toBe(false)
    expect(hasChangelogGapV020(cursor020)).toBe(true)
    expect(hasChangelogGapV020(cursorV020())).toBe(false)
  })

  it('掃除が消した位置が知らせた id より小さければ、掃除の記録は知らせた id のまま', () => {
    write('u1')
    write('u2')
    const announced = announceFullMerge(db)
    const cursor = fullMergeCursor(db)
    expireAll()
    expect(cleanupChangelog(db, 1)).toBe(2)
    expect(readChangelogPrunedThroughId(db)).toBe(announced)
    expect(hasChangelogGap(db, cursor)).toBe(false)
    expect(hasChangelogGapV020(cursorV020())).toBe(false)
  })

  it('通知を1件も振っていない DB でも、振る id を記録する', () => {
    expect(readChangelogSequence(db)).toBeNull()
    expect(announceFullMerge(db)).toBe(1)
    expect(readChangelogSequence(db)).toBe(1)
    expect(hasChangelogGap(db, 0)).toBe(true)
    expect(hasChangelogGapV020(0)).toBe(true)
    write('u1')
    expect(db.prepare(`SELECT id FROM _changelog`).all()).toEqual([{ id: 2 }])
  })

  it('振る id を floor より大きくする', () => {
    write('u1')
    expect(announceFullMerge(db, 10)).toBe(11)
    expect(hasChangelogGap(db, 10)).toBe(true)
    expect(hasChangelogGapV020(10)).toBe(true)
  })
})

describe('旧方式からの移行', () => {
  it('作り直す前の `_changelog` が振った id より大きい id を振る', () => {
    const db = new Database(':memory:')
    db.exec(
      `CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
    )
    setupLegacyChangelog(db, [{ name: 'notes' }], 'id')
    for (let i = 1; i <= 5; i++) {
      db.prepare(`INSERT INTO notes VALUES (?, 'x', ?)`).run(`k${i}`, T)
    }
    // 末尾の通知が消えている。相手の読み位置は 5 まで進んでいることがある
    expect(readChangelogSequence(db)).toBe(5)
    db.exec(`DELETE FROM _changelog WHERE id > 3`)
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })
    expect(readChangelogPrunedThroughId(db)).toBe(6)
    expect(hasChangelogGap(db, 5)).toBe(true)
    db.close()
  })
})
