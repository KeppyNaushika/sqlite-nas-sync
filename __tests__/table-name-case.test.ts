/**
 * 表名の大文字と小文字。
 *
 * SQLite の表名は大文字と小文字を区別しないが、`_tombstone.tableName` などの帳簿は表名を文字列として持つ。
 * ライブラリは `sqlite_master` の綴りにそろえて帳簿を書くので、綴りが端末ごとに違うと版の鍵が割れる（`src/rows/table-name.ts`）。
 * ここでは次の3つを `setupSync` を通して確かめる。
 *
 * - アプリが表名の大文字と小文字だけを変えて表を作り直したら、次の `setupSync` が内部テーブルの綴りを新しい綴りにそろえ、フルマージで行と削除が届く
 * - 端末ごとに `sqlite_master` の綴りが違えば、`schemaVersion` を明示していても、その表を取り込まずに警告する
 * - `setupSync` に渡す綴りではなく `sqlite_master` の綴りで帳簿を書くので、利用者の綴りが違っても同期する
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { SyncConfig } from '../src/types'

const T = '2026-01-01T00:00:00.000Z'

describe('表名の大文字と小文字', () => {
  let work: string
  let nasPath: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-table-name-case-'))
    nasPath = join(work, 'nas')
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function makeDb(file: string, table: string): string {
    const dbPath = join(work, file)
    const db = new Database(dbPath)
    db.exec(
      `CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
    )
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

  /** アプリが表を作り直し、表名の大文字と小文字だけを変える。 */
  function recreateWithSpelling(dbPath: string, from: string, to: string) {
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE notes_copy AS SELECT * FROM "${from}"`)
    db.exec(`DROP TABLE "${from}"`)
    db.exec(
      `CREATE TABLE "${to}" (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
    )
    db.exec(`INSERT INTO "${to}" SELECT * FROM notes_copy`)
    db.exec(`DROP TABLE notes_copy`)
    db.close()
  }

  const ids = (db: Database.Database, table: string): string[] =>
    (
      db.prepare(`SELECT id FROM "${table}" ORDER BY id`).all() as {
        id: string
      }[]
    ).map((row) => row.id)

  const tableNamesOf = (db: Database.Database, ledger: string): string[] =>
    (
      db
        .prepare(`SELECT DISTINCT tableName FROM "${ledger}" ORDER BY 1`)
        .all() as { tableName: string }[]
    ).map((row) => row.tableName)

  it('表名の大文字と小文字だけを変えて作り直すと、内部テーブルの綴りがそろい、フルマージで行と削除が届く', async () => {
    const pathA = makeDb('a.sqlite', 'Notes')
    let a = open(pathA, 'a')
    a.db
      .prepare(
        `INSERT INTO Notes VALUES ('k1', 'x', ?), ('k2', 'y', ?), ('k3', 'z', ?)`
      )
      .run(T, T, T)
    a.db.prepare(`DELETE FROM Notes WHERE id = 'k1'`).run()
    await a.sync.syncNow()
    a.close()

    recreateWithSpelling(pathA, 'Notes', 'notes')
    a = open(pathA, 'a')
    a.db.prepare(`DELETE FROM notes WHERE id = 'k2'`).run()
    const second = await a.sync.syncNow()
    // そろえたことだけを知らせ、仕掛けの欠けや表の見送りにはならない
    expect(second.warnings).toHaveLength(1)
    expect(second.warnings[0]).toMatch(/^表名が Notes から notes に変わった/)
    const internal = (
      a.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name LIKE '\\_sns\\_rows\\_%' ESCAPE '\\'`
        )
        .all() as { name: string }[]
    ).map((row) => row.name)
    expect(internal).toEqual(['_sns_rows_notes'])
    expect(tableNamesOf(a.db, '_tombstone')).toEqual(['notes'])
    expect(tableNamesOf(a.db, '_changelog')).toEqual(['notes'])
    expect(tableNamesOf(a.db, '_sns_tick')).toEqual(['notes'])
    a.close()

    // 初めて参加する端末はフルマージで読む
    const b = open(makeDb('b.sqlite', 'notes'), 'b')
    try {
      const result = await b.sync.syncNow()
      expect(result.hadChangelogGap).toBe(true)
      expect(result.warnings).toEqual([])
      expect(ids(b.db, 'notes')).toEqual(['k3'])
      expect(
        b.db
          .prepare(
            `SELECT tableName, recordId FROM _tombstone ORDER BY recordId`
          )
          .all()
      ).toEqual([
        { tableName: 'notes', recordId: 'k1' },
        { tableName: 'notes', recordId: 'k2' },
      ])
    } finally {
      b.close()
    }
  })

  it.each([
    ['新しい綴りの版が強い', '_sns_lamport + 100'],
    ['古い綴りの版が強い', '0'],
  ])(
    '同じ id の削除の版が両方の綴りで残っていたら、強い方を残す（%s）',
    async (_label, lamport) => {
      const pathA = makeDb('a.sqlite', 'Notes')
      let a = open(pathA, 'a')
      a.db.prepare(`INSERT INTO Notes VALUES ('k1', 'x', ?)`).run(T)
      a.db.prepare(`DELETE FROM Notes WHERE id = 'k1'`).run()
      await a.sync.syncNow()
      a.close()

      // 前の版のライブラリが作り直しのあとに書いた形を作る。
      // 新しい綴りで同じ id の削除の版を足し、内部テーブルは古い綴りのまま残す
      recreateWithSpelling(pathA, 'Notes', 'notes')
      const raw = new Database(pathA)
      raw
        .prepare(
          `INSERT INTO _tombstone (tableName, recordId, deletedAt, _sns_ts, _sns_lamport, _sns_instance)
           SELECT 'notes', recordId, deletedAt, _sns_ts, ${lamport}, _sns_instance
             FROM _tombstone WHERE tableName = 'Notes'`
        )
        .run()
      const lamports = raw
        .prepare(`SELECT _sns_lamport AS l FROM _tombstone`)
        .all() as { l: number }[]
      const strongest = Math.max(...lamports.map((row) => row.l))
      expect(new Set(lamports.map((row) => row.l)).size).toBe(2)
      raw.close()

      a = open(pathA, 'a')
      try {
        await a.sync.syncNow()
        expect(
          a.db
            .prepare(
              `SELECT tableName, recordId, _sns_lamport AS l FROM _tombstone`
            )
            .all()
        ).toEqual([{ tableName: 'notes', recordId: 'k1', l: strongest }])
      } finally {
        a.close()
      }
    }
  )

  it('端末ごとに表名の大文字と小文字が違うと、schemaVersion を明示していても、その表を取り込まずに警告する', async () => {
    const a = open(makeDb('a.sqlite', 'Notes'), 'a')
    const b = open(makeDb('b.sqlite', 'notes'), 'b')
    try {
      a.db.prepare(`INSERT INTO Notes VALUES ('k1', 'x', ?)`).run(T)
      await a.sync.syncNow()
      const resultB = await b.sync.syncNow()
      expect(ids(b.db, 'notes')).toEqual([])
      expect(
        resultB.warnings.filter((w) => w.startsWith('Skipped table notes:'))
      ).toHaveLength(1)
      expect(resultB.warnings.join('\n')).toContain('_sns_rows_Notes')

      b.db.prepare(`INSERT INTO notes VALUES ('k9', 'y', ?)`).run(T)
      await b.sync.syncNow()
      const resultA = await a.sync.syncNow()
      expect(ids(a.db, 'Notes')).toEqual(['k1'])
      expect(
        resultA.warnings.filter((w) => w.startsWith('Skipped table Notes:'))
      ).toHaveLength(1)
    } finally {
      a.close()
      b.close()
    }
  })

  it('setupSync に渡す綴りが端末ごとに違っても、sqlite_master の綴りが同じなら削除がフルマージで届く', async () => {
    const options = (spelling: string): Partial<SyncConfig> => ({
      tableOptions: { [spelling]: { timestampColumn: 'UPDATEDAT' } },
    })
    const a = open(makeDb('a.sqlite', 'Notes'), 'a', options('NOTES'))
    try {
      a.db
        .prepare(`INSERT INTO Notes VALUES ('k1', 'x', ?), ('k2', 'y', ?)`)
        .run(T, T)
      a.db.prepare(`DELETE FROM Notes WHERE id = 'k1'`).run()
      await a.sync.syncNow()
    } finally {
      a.close()
    }
    const b = open(makeDb('b.sqlite', 'Notes'), 'b', options('notes'))
    try {
      const result = await b.sync.syncNow()
      expect(result.hadChangelogGap).toBe(true)
      expect(result.warnings).toEqual([])
      expect(ids(b.db, 'Notes')).toEqual(['k2'])
      expect(tableNamesOf(b.db, '_tombstone')).toEqual(['Notes'])
    } finally {
      b.close()
    }
  })
})
