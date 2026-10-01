/**
 * 同期は列の値の型を変えない（原則1）。
 *
 * 値はアプリの表から `_sns_rows_<表>`、NAS の写し、相手の `_sns_rows_<表>`、
 * 相手のアプリの表へと通る。どこかの表の列に型の親和性が効くと、アプリが書いた
 * 値が別の型に変わる。STRICT 表の `ANY` 列は値をそのまま持つので、
 * 非 STRICT の `_sns_rows_<表>` に `ANY` と宣言すると NUMERIC 親和性で
 * 文字列 `'123'` が整数 `123` に変わっていた。
 *
 * 非 STRICT 表では、アプリの表が親和性で変えた後の値が写る。同じ親和性を
 * 2回当てても値は変わらないので、宣言の違う列でも値と型は保たれるはずである。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { migrateToRows } from '../src/rows/migrate'
import { rowsTableName } from '../src/rows/schema'
import { createRowsTriggers, dropRowsTriggers } from '../src/rows/triggers'
import { SyncConfig, TableConfig } from '../src/types'
import { setupRowsDb } from './helpers/sync-fixtures'

const DDL = [
  `CREATE TABLE s (
     id TEXT PRIMARY KEY NOT NULL, v ANY, updatedAt TEXT NOT NULL
   ) STRICT`,
  `CREATE TABLE n (
     id TEXT PRIMARY KEY NOT NULL, t TEXT, num NUMERIC, untyped, a ANY,
     updatedAt TEXT NOT NULL
   )`,
]
const TABLES: TableConfig[] = [{ name: 's' }, { name: 'n' }]
/** 表 → 値を見る列 */
const VALUE_COLUMNS: Record<string, string[]> = {
  s: ['v'],
  n: ['t', 'num', 'untyped', 'a'],
}
const T = '2026-01-01T00:00:00.000Z'
/** 行の id → 書く値。JavaScript の数は REAL で結び付くので、整数は BigInt で書く */
const VALUES: [string, unknown][] = [
  ['text-123', '123'],
  ['text-1.0', '1.0'],
  ['integer', 42n],
  ['real', 1.5],
  ['blob', Buffer.from([0, 1, 2])],
  ['null', null],
]

type Snapshot = Record<string, unknown[]>

let workDir: string
const open: Database.Database[] = []

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sns-column-types-'))
  mkdirSync(join(workDir, 'nas'))
})

afterEach(() => {
  for (const db of open.splice(0)) db.close()
  rmSync(workDir, { recursive: true, force: true })
})

function client(clientId: string): {
  db: Database.Database
  config: SyncConfig
} {
  const dbPath = join(workDir, `${clientId}.sqlite`)
  const db = new Database(dbPath)
  open.push(db)
  for (const ddl of DDL) db.exec(ddl)
  setupRowsDb(db, TABLES)
  return {
    db,
    config: {
      dbPath,
      nasPath: join(workDir, 'nas'),
      clientId,
      primaryKey: 'id',
      changelogRetentionDays: 7,
    },
  }
}

function writeValues(db: Database.Database): void {
  for (const [id, value] of VALUES) {
    db.prepare(`INSERT INTO s (id, v, updatedAt) VALUES (?, ?, ?)`).run(
      id,
      value,
      T
    )
    db.prepare(
      `INSERT INTO n (id, t, num, untyped, a, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, value, value, value, value, T)
  }
}

/** 表ごとに、値を見る列の値と `typeof` を id の順に読む。 */
function snapshot(
  db: Database.Database,
  name: (table: string) => string = (table) => table
): Snapshot {
  const result: Snapshot = {}
  for (const table of TABLES) {
    const selects = VALUE_COLUMNS[table.name].flatMap((column) => [
      `"${column}"`,
      `typeof("${column}") AS "${column}:type"`,
    ])
    result[table.name] = db
      .prepare(
        `SELECT id, ${selects.join(', ')} FROM "${name(table.name)}" ORDER BY id`
      )
      .all()
  }
  return result
}

const rowsSnapshot = (db: Database.Database): Snapshot =>
  snapshot(db, rowsTableName)

async function round(
  ...clients: { db: Database.Database; config: SyncConfig }[]
): Promise<void> {
  for (const { db, config } of clients) {
    const result = await performSync(db, config, TABLES)
    expect(result.warnings).toEqual([])
  }
}

describe('列の値の型', () => {
  it('書いた端末でも相手の端末でも、値と typeof が変わらない', async () => {
    const a = client('client-a')
    const b = client('client-b')
    writeValues(a.db)
    const written = snapshot(a.db)
    // 書いたままの値が残る列の確認。STRICT の ANY 列は文字列を文字列のまま持つ
    expect(
      written.s.map((row) => (row as { 'v:type': string })['v:type'])
    ).toEqual(['blob', 'integer', 'null', 'real', 'text', 'text'])

    await round(a, b, a)

    expect(snapshot(a.db)).toEqual(written)
    expect(snapshot(b.db)).toEqual(written)
    expect(rowsSnapshot(a.db)).toEqual(written)
    expect(rowsSnapshot(b.db)).toEqual(written)
  })

  it('相手の端末で書き換えた値も、型を保って戻ってくる', async () => {
    const a = client('client-a')
    const b = client('client-b')
    writeValues(a.db)
    await round(a, b)

    const later = '2026-02-01T00:00:00.000Z'
    b.db
      .prepare(`UPDATE s SET v = '007', updatedAt = ? WHERE id = 'integer'`)
      .run(later)
    b.db
      .prepare(
        `UPDATE n SET t = '007', num = '007', untyped = '007', a = '007',
           updatedAt = ? WHERE id = 'integer'`
      )
      .run(later)
    const written = snapshot(b.db)
    await round(b, a, b)

    expect(snapshot(a.db)).toEqual(written)
    expect(snapshot(b.db)).toEqual(written)
    expect(rowsSnapshot(a.db)).toEqual(written)
  })
})

describe('増えた列の定数の既定値', () => {
  it('アプリの表に居ない行には、アプリの列に入れたときと同じ型の値を入れる', () => {
    const a = client('client-a')
    // アプリの表に居ない行（隠れた行・置かない行に相当）を1つずつ置く
    a.db
      .prepare(
        `INSERT INTO "_sns_rows_s" ("id", "v", "updatedAt", "_sns_ts", "_sns_lamport", "_sns_instance")
         VALUES ('hidden', NULL, ?, ?, 0, 'iid-a')`
      )
      .run(T, T)
    a.db
      .prepare(
        `INSERT INTO "_sns_rows_n" ("id", "updatedAt", "_sns_ts", "_sns_lamport", "_sns_instance")
         VALUES ('hidden', ?, ?, 0, 'iid-a')`
      )
      .run(T, T)
    a.db.exec(`ALTER TABLE s ADD COLUMN i INTEGER NOT NULL DEFAULT '7'`)
    a.db.exec(`ALTER TABLE s ADD COLUMN w ANY NOT NULL DEFAULT '7'`)
    a.db.exec(`ALTER TABLE n ADD COLUMN i INTEGER NOT NULL DEFAULT '7'`)
    a.db.exec(`ALTER TABLE n ADD COLUMN w TEXT NOT NULL DEFAULT 7`)

    migrateToRows(a.db, { tables: TABLES, instanceId: 'iid-a2' })

    expect(
      a.db
        .prepare(
          `SELECT i, typeof(i) AS it, w, typeof(w) AS wt FROM "_sns_rows_s"`
        )
        .get()
    ).toEqual({ i: 7, it: 'integer', w: '7', wt: 'text' })
    expect(
      a.db
        .prepare(
          `SELECT i, typeof(i) AS it, w, typeof(w) AS wt FROM "_sns_rows_n"`
        )
        .get()
    ).toEqual({ i: 7, it: 'integer', w: '7', wt: 'text' })
  })
})

describe('0.21.0 までの `_sns_rows_<表>` からの移行', () => {
  /** 0.21.0 までと同じく、アプリの列の型名を写した `_sns_rows_s` に置き換える。 */
  function toTypedRowsTable(db: Database.Database): void {
    dropRowsTriggers(db, [{ name: 's' }])
    db.exec(`DROP TABLE "_sns_rows_s"`)
    db.exec(`CREATE TABLE "_sns_rows_s" (
       "id" TEXT PRIMARY KEY, "v" ANY, "updatedAt" TEXT,
       "_sns_ts", "_sns_lamport" INTEGER NOT NULL, "_sns_instance" TEXT NOT NULL)`)
    createRowsTriggers(db, [{ name: 's' }])
  }

  const declaredTypes = (db: Database.Database): Record<string, string> =>
    Object.fromEntries(
      (
        db.prepare(`PRAGMA table_info("_sns_rows_s")`).all() as {
          name: string
          type: string
        }[]
      ).map((column) => [column.name, column.type])
    )

  it('型名を写した列を型名の無い列に作り直し、行と版は残す', async () => {
    const a = client('client-a')
    toTypedRowsTable(a.db)
    a.db.prepare(`INSERT INTO s (id, v, updatedAt) VALUES ('k', 42, ?)`).run(T)
    const held = a.db.prepare(`SELECT * FROM "_sns_rows_s"`).all()

    migrateToRows(a.db, { tables: TABLES, instanceId: 'iid-a2' })

    expect(declaredTypes(a.db)).toEqual({
      id: 'TEXT',
      v: '',
      updatedAt: '',
      _sns_ts: '',
      _sns_lamport: 'INTEGER',
      _sns_instance: 'TEXT',
    })
    // 作り直しは行も版も変えない
    expect(a.db.prepare(`SELECT * FROM "_sns_rows_s"`).all()).toEqual(held)

    // 作り直したあとは、トリガーが書く値も型を保つ
    a.db
      .prepare(`INSERT INTO s (id, v, updatedAt) VALUES ('m', '123', ?)`)
      .run(T)
    await round(a)
    expect(
      a.db.prepare(`SELECT v, typeof(v) AS t FROM s WHERE id = 'm'`).get()
    ).toEqual({ v: '123', t: 'text' })
    expect(
      a.db.prepare(`SELECT v, typeof(v) AS t FROM s WHERE id = 'k'`).get()
    ).toEqual({ v: 42, t: 'integer' })
  })
})
