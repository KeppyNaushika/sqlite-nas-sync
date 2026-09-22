/**
 * 段階3（取り込みと作り直し）を通した結果を、参照実装
 * `tools/explore/oracles/rows-d1.ts` の計算と突き合わせる。
 *
 * 突き合わせるのは**アプリの表の中身そのもの**である。参照実装は「版の集合と
 * スキーマ」だけから見え方を決めるので、`src/` 側が
 * 「相手から受け取る → 手元の版の集合になる → 作り直してアプリの表になる」の
 * どこかで事実を作ったり落としたりしていれば、ここで食い違う。
 *
 * あわせて**目標 (a)**（同じ事実を受け取った端末は同じ表示になる）も見る。
 */
import Database from 'better-sqlite3'
import { importFromPeer } from '../src/rows/import'
import { rebuildOnce } from '../src/rows/rebuild'
import { createRowsTables } from '../src/rows/schema'
import { createRowsTriggers } from '../src/rows/triggers'
import {
  OracleSchema,
  ValueOracle,
  Version,
  expectedView,
} from '../tools/explore/oracles/rows-d1'

const TAGS = `CREATE TABLE tags (
  id        TEXT PRIMARY KEY NOT NULL,
  name      TEXT NOT NULL UNIQUE,
  updatedAt TEXT NOT NULL
)`

const TAG_NOTES = `CREATE TABLE tag_notes (
  id        TEXT PRIMARY KEY NOT NULL,
  tagId     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  body      TEXT NOT NULL,
  updatedAt TEXT NOT NULL
)`

const SCHEMA: OracleSchema = {
  tables: [
    { name: 'tags', ddl: TAGS },
    { name: 'tag_notes', ddl: TAG_NOTES },
  ],
}

const TABLES = ['tags', 'tag_notes']

function openClient(instance: string): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(TAGS)
  db.exec(TAG_NOTES)
  const specs = TABLES.map((name) => ({ name }))
  createRowsTables(db, specs, instance)
  createRowsTriggers(db, specs)
  db.exec(`CREATE TABLE IF NOT EXISTS _sync_meta (
             key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.prepare(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('schemaVersion', ?)`
  ).run('app1;sns-format=rows1')
  return db
}

/** 端末が持っている版を全部集める（参照実装への入力）。 */
function versionsOf(db: Database.Database): Version[] {
  const versions: Version[] = []
  for (const table of TABLES) {
    for (const row of db
      .prepare(`SELECT * FROM "_sns_rows_${table}"`)
      .all() as Record<string, never>[]) {
      const content: Record<string, never> = {}
      for (const [column, value] of Object.entries(row)) {
        if (!column.startsWith('_sns_')) content[column] = value
      }
      versions.push({
        table,
        id: row['id'],
        kind: 'row',
        ts: row['_sns_ts'] ?? null,
        lamport: Number(row['_sns_lamport']),
        instance: String(row['_sns_instance']),
        content,
      })
    }
    for (const row of db
      .prepare(`SELECT * FROM _tombstone WHERE tableName = ?`)
      .all(table) as Record<string, never>[]) {
      versions.push({
        table,
        id: row['recordId'],
        kind: 'delete',
        ts: row['_sns_ts'] ?? null,
        lamport: Number(row['_sns_lamport']),
        instance: String(row['_sns_instance']),
      })
    }
  }
  return versions
}

/**
 * アプリの表の中身を、参照実装の `viewJson` と**同じ形**の JSON にする。
 *
 * 時刻列を `julianday` へ直すのも同じ（字面の違いで落ちないため）。
 */
function actualView(db: Database.Database): string {
  const values = new ValueOracle()
  const entries: [string, Record<string, unknown>][] = []
  for (const table of TABLES) {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all() as Record<
      string,
      never
    >[]) {
      const normalized: Record<string, unknown> = { ...row }
      if ('updatedAt' in normalized) {
        normalized['updatedAt'] =
          values.julian(row['updatedAt'] ?? null) ??
          String(row['updatedAt'] ?? null)
      }
      entries.push([`${table}:${String(row['id'])}`, normalized])
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries)
}

/** 両端末を互いに取り込み、両方で作り直す。 */
function syncBoth(a: Database.Database, b: Database.Database): void {
  importFromPeer(a, b, { tables: TABLES })
  importFromPeer(b, a, { tables: TABLES })
  rebuildOnce(a, { tables: TABLES })
  rebuildOnce(b, { tables: TABLES })
}

describe('段階3 —— 参照実装との突き合わせ', () => {
  it('素直な行き違い（別々の行を足す）', () => {
    const a = openClient('aaaa')
    const b = openClient('bbbb')
    try {
      a.prepare(`INSERT INTO tags VALUES ('t1', 'あか', '2026-01-01')`).run()
      b.prepare(`INSERT INTO tags VALUES ('t2', 'あお', '2026-01-02')`).run()
      syncBoth(a, b)

      expect(actualView(a)).toBe(expectedView(versionsOf(a), SCHEMA))
      expect(actualView(b)).toBe(expectedView(versionsOf(b), SCHEMA))
      expect(actualView(a)).toBe(actualView(b))
    } finally {
      a.close()
      b.close()
    }
  })

  it('UNIQUE のかぶり（片方が隠れる）', () => {
    const a = openClient('aaaa')
    const b = openClient('bbbb')
    try {
      a.prepare(`INSERT INTO tags VALUES ('t1', 'おなじ', '2026-01-01')`).run()
      b.prepare(`INSERT INTO tags VALUES ('t2', 'おなじ', '2026-02-01')`).run()
      syncBoth(a, b)

      expect(actualView(a)).toBe(expectedView(versionsOf(a), SCHEMA))
      expect(actualView(b)).toBe(expectedView(versionsOf(b), SCHEMA))
      expect(actualView(a)).toBe(actualView(b))
      // 版は2つ残り、表に出るのは1つ
      expect(
        (
          a.prepare(`SELECT COUNT(*) AS n FROM _sns_rows_tags`).get() as {
            n: number
          }
        ).n
      ).toBe(2)
      expect(
        (a.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n
      ).toBe(1)
      // 隠れた行と勝者が残っている
      expect(a.prepare(`SELECT COUNT(*) AS n FROM _sns_hidden`).get()).toEqual({
        n: 1,
      })
    } finally {
      a.close()
      b.close()
    }
  })

  it('削除と、親を失った子（CASCADE の宣言）', () => {
    const a = openClient('aaaa')
    const b = openClient('bbbb')
    try {
      a.prepare(`INSERT INTO tags VALUES ('t1', 'あか', '2026-01-01')`).run()
      a.prepare(
        `INSERT INTO tag_notes VALUES ('n1', 't1', 'ほん', '2026-01-01')`
      ).run()
      syncBoth(a, b)
      expect(actualView(a)).toBe(actualView(b))

      // b が親を消す。a は子を書き換える
      b.prepare(`DELETE FROM tags WHERE id = 't1'`).run()
      a.prepare(
        `UPDATE tag_notes SET body = 'かえた', updatedAt = '2026-03-01' WHERE id = 'n1'`
      ).run()
      syncBoth(a, b)

      expect(actualView(a)).toBe(expectedView(versionsOf(a), SCHEMA))
      expect(actualView(b)).toBe(expectedView(versionsOf(b), SCHEMA))
      expect(actualView(a)).toBe(actualView(b))
      // 親が置かれないので、子も置かれない（§1.4 の CASCADE）
      expect(
        (
          a.prepare(`SELECT COUNT(*) AS n FROM tag_notes`).get() as {
            n: number
          }
        ).n
      ).toBe(0)
    } finally {
      a.close()
      b.close()
    }
  })

  it('消してから同じ id で作り直す（§2 の場面4）', () => {
    const a = openClient('aaaa')
    const b = openClient('bbbb')
    try {
      a.prepare(`INSERT INTO tags VALUES ('t1', 'あか', '2026-01-01')`).run()
      syncBoth(a, b)
      b.prepare(`DELETE FROM tags WHERE id = 't1'`).run()
      syncBoth(a, b)
      expect(
        (a.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n
      ).toBe(0)

      a.prepare(`INSERT INTO tags VALUES ('t1', 'あか2', '2026-05-01')`).run()
      syncBoth(a, b)

      expect(actualView(a)).toBe(expectedView(versionsOf(a), SCHEMA))
      expect(actualView(b)).toBe(expectedView(versionsOf(b), SCHEMA))
      expect(actualView(a)).toBe(actualView(b))
      expect(
        (
          a.prepare(`SELECT name FROM tags WHERE id = 't1'`).get() as {
            name: string
          }
        ).name
      ).toBe('あか2')
    } finally {
      a.close()
      b.close()
    }
  })
})
