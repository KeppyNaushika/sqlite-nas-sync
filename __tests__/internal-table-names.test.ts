/**
 * 内部テーブルと同じ名前のアプリの表。
 *
 * `_` で始まる表は同期の対象にならないが、ライブラリが作る内部テーブルと名前が同じだと、ライブラリはその表を自分の表として読み書きする。
 * 0.21.0 までは、列が無いという SQLite の例外で `setupSync` が止まるか、`_id_merge` などはアプリの表が黙って消えた。
 * ここでは、`setupSync` が DB に触る前に、どの表が何と重なっているかを示す例外にすることを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'

const T = '2026-01-01T00:00:00.000Z'

/** ライブラリが作る、または以前の版が作った内部テーブルの名前。 */
const INTERNAL_NAMES = [
  '_sync_meta',
  '_sync_state',
  '_changelog',
  '_changelog_prune',
  '_tombstone',
  '_id_merge',
  '_heartbeat',
  '_sns_clock',
  '_sns_tick',
  '_sns_dirty',
  '_sns_shown',
  '_sns_hidden',
  '_sns_unplaceable',
  '_sns_rebuilding',
  '_sns_rows_notes',
  '_sns_rows_other',
  '_SYNC_META',
]

describe('内部テーブルと同じ名前のアプリの表', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-internal-names-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function makeDb(statement: string): string {
    const dbPath = join(work, `${Math.random().toString(36).slice(2)}.sqlite`)
    const db = new Database(dbPath)
    db.exec(
      `CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
    )
    db.exec(statement)
    db.close()
    return dbPath
  }

  function open(dbPath: string): () => void {
    const sync = setupSync({
      dbPath,
      nasPath: join(work, 'nas'),
      clientId: 'a',
      schemaVersion: '1',
      intervalMs: 3_600_000,
    })
    return () => sync.stop()
  }

  it.each(INTERNAL_NAMES)(
    '%s という名前の表があると、名前と欠けている列を示す例外になり、表は残る',
    (name) => {
      const dbPath = makeDb(
        `CREATE TABLE "${name}" (id TEXT PRIMARY KEY NOT NULL, body TEXT)`
      )
      const app = new Database(dbPath)
      app.prepare(`INSERT INTO "${name}" VALUES ('x', 'アプリの行')`).run()
      app.close()

      expect(() => open(dbPath)).toThrow(
        new RegExp(`${name}.*内部テーブル.*列 .* が無い`)
      )

      const after = new Database(dbPath)
      try {
        expect(after.prepare(`SELECT * FROM "${name}"`).all()).toEqual([
          { id: 'x', body: 'アプリの行' },
        ])
      } finally {
        after.close()
      }
    }
  )

  it('内部テーブルと同じ名前のビューも例外になる', () => {
    const dbPath = makeDb(`CREATE VIEW _sync_state AS SELECT id FROM notes`)
    expect(() => open(dbPath)).toThrow(/_sync_state.*内部テーブル.*ビュー/)
  })

  it('ライブラリが作った内部テーブルは通る', () => {
    const dbPath = makeDb(`SELECT 1`)
    open(dbPath)()
    const app = new Database(dbPath)
    app.prepare(`INSERT INTO notes VALUES ('k1', 'x', ?)`).run(T)
    app.close()
    open(dbPath)()
  })

  it('`_` で始まっても内部テーブルの名前でなければ通る', () => {
    const dbPath = makeDb(
      `CREATE TABLE _cache (id TEXT PRIMARY KEY NOT NULL, body TEXT)`
    )
    open(dbPath)()
  })
})
