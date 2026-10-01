/**
 * トリガーの SQL を小さくした変更の試験（`src/rows/triggers.ts`・`src/rows/versions.ts`）。
 *
 * 0.21.0 のトリガーは、値の種類の群の式を `STRONGER` 1つにつき10回、`NEWTS` 1つにつき2回書き写していた。
 * いまは群を1つの値について1回だけ計算し、字形の判定も短い形で書く。ここでは次の2つを確かめる。
 *
 * 1. 新しい式が、0.21.0 の式と同じ答えを返すこと。0.21.0 の式はこの試験の中に固定の SQL として持つ。
 *    群の判定は全端末で同じ答えを返さなければならない（設計書 §1.2.3）ので、0.21.0 の端末と混在しても順序が食い違わないことをここで確かめる
 * 2. 0.21.0 で作った DB を `setupSync` で開くと、トリガーが新しいものに置き換わること
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { createRowsTables } from '../src/rows/schema'
import {
  createRowsTriggers,
  maxTsSql,
  rowsTriggerNames,
  strongerSql,
} from '../src/rows/triggers'
import { timeGroupSql } from '../src/rows/versions'

/* ------------------------------------------------------------------ *
 * 0.21.0 の式（固定の SQL）
 * ------------------------------------------------------------------ */

const OLD_ISO_SHAPE_GLOBS = [
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9].*',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]*Z',
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]*[+-][0-9][0-9]:[0-9][0-9]',
]

function oldGroup(value: string): string {
  const shape = OLD_ISO_SHAPE_GLOBS.map(
    (glob) => `${value} GLOB '${glob}'`
  ).join(' OR ')
  return `(CASE typeof(${value})
      WHEN 'null' THEN 0
      WHEN 'integer' THEN 1
      WHEN 'real' THEN 1
      WHEN 'blob' THEN 4
      ELSE (CASE WHEN julianday(${value}) IS NOT NULL AND (${shape}) THEN 3 ELSE 2 END)
    END)`
}

function oldTsGreater(a: string, b: string): string {
  const groupA = oldGroup(a)
  const groupB = oldGroup(b)
  return `(${groupA} > ${groupB} OR (${groupA} = ${groupB} AND (CASE
      WHEN ${groupA} = 0 THEN 0
      WHEN ${groupA} = 3 THEN julianday(${a}) > julianday(${b})
      ELSE ${a} > ${b} COLLATE BINARY
    END)))`
}

function oldTsEqual(a: string, b: string): string {
  const groupA = oldGroup(a)
  const groupB = oldGroup(b)
  return `(${groupA} = ${groupB} AND (CASE
      WHEN ${groupA} = 0 THEN 1
      WHEN ${groupA} = 3 THEN julianday(${a}) = julianday(${b})
      ELSE ${a} = ${b} COLLATE BINARY
    END))`
}

interface Refs {
  ts: string
  lamport: string
  instance: string
}

function oldStronger(a: Refs, b: Refs): string {
  return `(${oldTsGreater(a.ts, b.ts)} OR (${oldTsEqual(a.ts, b.ts)} AND (
      ${a.lamport} > ${b.lamport}
      OR (${a.lamport} = ${b.lamport} AND ${a.instance} > ${b.instance} COLLATE BINARY)
    )))`
}

function oldMaxTs(terms: string[]): string {
  const branches = terms
    .map((term, at) => (at === 0 ? `SELECT ${term} AS "v"` : `SELECT ${term}`))
    .join(' UNION ALL ')
  const group = oldGroup('"v"')
  return `(SELECT "v" FROM (${branches})
     ORDER BY ${group} DESC,
              (CASE WHEN ${group} = 3 THEN julianday("v") END) DESC,
              "v" COLLATE BINARY DESC
     LIMIT 1)`
}

/* ------------------------------------------------------------------ *
 * 値
 * ------------------------------------------------------------------ */

/**
 * 時刻として比べる値（SQL のリテラル）。
 * 整数と実数を区別するため、束縛せずにリテラルで書く。
 */
const TS_VALUES = [
  'NULL',
  '0',
  '1',
  '1.0',
  '-1',
  '1.5',
  "'2026-01-01'",
  "'2026-01-01T00:00:00.000Z'",
  "'2026-01-01T00:00:00Z'",
  "'2026-01-01 00:00:00'",
  "'2026-01-01T09:00:00+09:00'",
  "'2026-01-01T00:00'",
  "'2025-12-31T23:59:59.999Z'",
  "'2026-02-30'",
  "'abc'",
  "'ABC'",
  "'2026-01-01 '",
  "'now'",
  "'2460000.5'",
  "''",
  "x'61'",
  "x'41'",
]

const LAMPORTS = ['NULL', '1', '2']
/** 大文字と小文字だけ違う2つを含める。`COLLATE BINARY` で比べていれば前後が付く */
const INSTANCES = ['NULL', "'a'", "'A'"]

/** 値の組を総当たりで突き合わせる試験は、負荷の高い機械では既定の5秒を超えることがある。 */
const SLOW = 60_000

/** 値の組を表に入れる（500行ずつの複数行の `INSERT`）。 */
function fill(db: Database.Database, table: string, rows: string[]): void {
  db.transaction(() => {
    for (let at = 0; at < rows.length; at += 500) {
      db.exec(
        `INSERT INTO ${table} VALUES ${rows.slice(at, at + 500).join(', ')}`
      )
    }
  })()
}

/** 再現できる擬似乱数（xorshift32）。 */
function random(seed: number): (n: number) => number {
  let state = seed
  return (n) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
}

/** ISO 8601 の字形の境目を突く文字列。字形の6つの形を元に、1〜4文字を足す・消す・置き換える。 */
function shapeProbes(): string[] {
  const seeds = [
    '2026-01-01',
    '2026-01-01T00:00',
    '2026-01-01 00:00',
    '2026-01-01T00:00:00',
    '2026-01-01T00:00:00.123',
    '2026-01-01T00:00:00.123Z',
    '2026-01-01T00:00Z',
    '2026-01-01T00:00:00+09:00',
    '2026-01-01 00:00:00.5-05:30',
    '2026-02-30',
    '0000-01-01',
    '9999-12-31T23:59:59.999Z',
  ]
  const alphabet = [
    '0',
    '1',
    '9',
    '-',
    ':',
    'T',
    't',
    ' ',
    '.',
    'Z',
    'z',
    '+',
    '\u0000',
    'あ',
    '\n',
    '*',
    '[',
    'x',
  ]
  const found = new Set(seeds)
  for (const seed of seeds) {
    for (let at = 0; at <= seed.length; at += 1) {
      found.add(seed.slice(0, at))
      for (const char of alphabet) {
        found.add(seed.slice(0, at) + char + seed.slice(at))
        found.add(seed.slice(0, at) + char + seed.slice(at + 1))
      }
    }
  }
  const next = random(20261002)
  for (let count = 0; count < 30000; count += 1) {
    const chars = [...seeds[next(seeds.length)]]
    const edits = 1 + next(4)
    for (let edit = 0; edit < edits; edit += 1) {
      const at = next(chars.length + 1)
      const kind = next(3)
      const char = alphabet[next(alphabet.length)]
      if (kind === 0) chars.splice(at, 0, char)
      else if (kind === 1) chars.splice(at, 1)
      else chars[at] = char
    }
    found.add(chars.join(''))
  }
  return [...found]
}

describe('版の順序の式は 0.21.0 の式と同じ答えを返す', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => db.close())

  it(
    '値の種類の群',
    () => {
      db.exec(`CREATE TABLE t (v)`)
      const insert = db.prepare(`INSERT INTO t VALUES (?)`)
      db.transaction(() => {
        for (const text of shapeProbes()) insert.run(text)
      })()
      // UTF-8 として正しくないバイト列を含む文字列
      db.exec(`INSERT INTO t SELECT CAST(CAST(v AS BLOB) || x'80' AS TEXT) FROM t
             WHERE length(v) BETWEEN 9 AND 20`)
      db.exec(`INSERT INTO t SELECT CAST(x'c3' || CAST(v AS BLOB) AS TEXT) FROM t
             WHERE length(v) BETWEEN 9 AND 20 AND typeof(v) = 'text'`)
      fill(
        db,
        't',
        TS_VALUES.map((value) => `(${value})`)
      )
      const result = db
        .prepare(
          `SELECT count(*) AS n,
                sum(${oldGroup('"v"')} IS NOT ${timeGroupSql('"v"')}) AS differ,
                sum(${oldGroup('"v"')} = 3) AS iso
           FROM t`
        )
        .get() as { n: number; differ: number; iso: number }
      expect(result.n).toBeGreaterThan(50000)
      // 群3 に入るものも十分にあること（どれも群2 なら突き合わせにならない）
      expect(result.iso).toBeGreaterThan(500)
      expect(result.differ).toBe(0)
    },
    SLOW
  )

  it(
    'STRONGER（NULL を返す組も同じ）',
    () => {
      // 片方の時刻の列を COLLATE NOCASE で宣言しておく。大文字と小文字だけ違う文字列に前後が付くこと
      db.exec(`CREATE TABLE t (ts1 COLLATE NOCASE, l1, i1, ts2, l2, i2)`)
      const rows: string[] = []
      for (const ts1 of TS_VALUES)
        for (const ts2 of TS_VALUES)
          for (const l1 of LAMPORTS)
            for (const l2 of LAMPORTS)
              for (const i1 of INSTANCES)
                for (const i2 of INSTANCES)
                  rows.push(`(${ts1}, ${l1}, ${i1}, ${ts2}, ${l2}, ${i2})`)
      fill(db, 't', rows)
      const a = { ts: '"ts1"', lamport: '"l1"', instance: '"i1"' }
      const b = { ts: '"ts2"', lamport: '"l2"', instance: '"i2"' }
      for (const [left, right] of [
        [a, b],
        [b, a],
      ]) {
        const result = db
          .prepare(
            `SELECT count(*) AS n,
                  sum(${oldStronger(left, right)} IS NOT ${strongerSql(left, right)}) AS differ,
                  sum(${oldStronger(left, right)} IS NULL) AS unknown,
                  sum(${oldStronger(left, right)} = 1) AS stronger
             FROM t`
          )
          .get() as {
          n: number
          differ: number
          unknown: number
          stronger: number
        }
        expect(result.n).toBe(rows.length)
        expect(result.unknown).toBeGreaterThan(0)
        expect(result.stronger).toBeGreaterThan(0)
        expect(result.differ).toBe(0)
      }
    },
    SLOW
  )

  it(
    'NEWTS（3項の最大。値も種類も同じ）',
    () => {
      // 1項めを COLLATE NOCASE で宣言しておく。アプリの時刻列がそう宣言されていても、群の中は COLLATE BINARY で比べる
      db.exec(`CREATE TABLE t (a COLLATE NOCASE, b, c)`)
      const rows: string[] = []
      for (const a of TS_VALUES)
        for (const b of TS_VALUES)
          for (const c of TS_VALUES) rows.push(`(${a}, ${b}, ${c})`)
      fill(db, 't', rows)
      const terms = ['"a"', '"b"', '"c"']
      const before = oldMaxTs(terms)
      const after = maxTsSql(terms)
      const result = db
        .prepare(
          `SELECT count(*) AS n,
                sum(${before} IS NOT ${after} OR typeof(${before}) <> typeof(${after})) AS differ
           FROM t`
        )
        .get() as { n: number; differ: number }
      expect(result.n).toBe(rows.length)
      expect(result.differ).toBe(0)
    },
    SLOW
  )

  it('新しい式は 0.21.0 の式より短い', () => {
    const version = (table: string) => ({
      ts: `"${table}"."_sns_ts"`,
      lamport: `"${table}"."_sns_lamport"`,
      instance: `"${table}"."_sns_instance"`,
    })
    const stronger = [version('excluded'), version('_tombstone')] as const
    expect(strongerSql(...stronger).length * 3).toBeLessThan(
      oldStronger(...stronger).length
    )
    expect(maxTsSql(['"a"', '"b"', '"c"']).length).toBeLessThan(
      oldMaxTs(['"a"', '"b"', '"c"']).length * 0.6
    )
  })
})

describe('0.21.0 で作った DB を setupSync で開くと、トリガーが置き換わる', () => {
  /**
   * `__tests__/fixtures/db-0.21.0.sqlite.gz` は、0.21.0 の `setupSync` で次の表を同期の対象にし、
   * そのあとアプリの接続で1行を INSERT した DB である。
   */
  const NOTES = `CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL, updatedAt TEXT NOT NULL)`
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-trigger-sql-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function triggerSql(db: Database.Database): Map<string, string> {
    return new Map(
      (
        db
          .prepare(
            `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`
          )
          .all() as { name: string; sql: string }[]
      ).map((row) => [row.name, row.sql])
    )
  }

  /** いまのライブラリが同じ表に作るトリガー。 */
  function currentTriggerSql(): Map<string, string> {
    const db = new Database(':memory:')
    try {
      db.exec(NOTES)
      createRowsTables(db, [{ name: 'notes' }], 'b'.repeat(32))
      createRowsTriggers(db, [{ name: 'notes' }])
      return triggerSql(db)
    } finally {
      db.close()
    }
  }

  it(
    '4本とも新しい SQL になり、行の版と削除の版がこれまでどおり書かれる',
    () => {
      const dbPath = join(work, 'app.sqlite')
      writeFileSync(
        dbPath,
        gunzipSync(
          readFileSync(join(__dirname, 'fixtures', 'db-0.21.0.sqlite.gz'))
        )
      )
      const expected = currentTriggerSql()
      expect([...expected.keys()].sort()).toEqual(
        [...rowsTriggerNames('notes')].sort()
      )

      const old = new Database(dbPath, { readonly: true })
      const before = triggerSql(old)
      old.close()
      expect([...before.keys()].sort()).toEqual([...expected.keys()].sort())
      for (const [name, sql] of before) expect(sql).not.toBe(expected.get(name))

      const sync = setupSync({
        dbPath,
        nasPath: join(work, 'nas'),
        clientId: 'a',
        schemaVersion: '1',
        intervalMs: 3_600_000,
      })
      sync.stop()

      const db = new Database(dbPath)
      try {
        const after = triggerSql(db)
        expect(after).toEqual(expected)
        const size = (sqls: Map<string, string>) =>
          [...sqls.values()].reduce((sum, sql) => sum + sql.length, 0)
        expect(size(after) * 2).toBeLessThan(size(before))

        // 0.21.0 のトリガーが書いた行の版が残っている
        const held = db
          .prepare(`SELECT * FROM "_sns_rows_notes"`)
          .all() as Record<string, unknown>[]
        expect(held.map((row) => [row.id, row.body])).toEqual([
          ['n1', '0.21.0 で書いた行'],
        ])

        // 新しいトリガーが版を書く。書かなかった列は `_sns_rows_notes` から引き継ぐ
        db.pragma('recursive_triggers = ON')
        db.prepare(
          `UPDATE notes SET updatedAt = '2026-01-02T00:00:00.000Z' WHERE id = 'n1'`
        ).run()
        const updated = db
          .prepare(`SELECT * FROM "_sns_rows_notes" WHERE id = 'n1'`)
          .get() as Record<string, unknown>
        expect(updated.body).toBe('0.21.0 で書いた行')
        expect(updated._sns_ts).toBe('2026-01-02T00:00:00.000Z')
        expect(Number(updated._sns_lamport)).toBeGreaterThan(
          Number(held[0]._sns_lamport)
        )

        db.prepare(`DELETE FROM notes WHERE id = 'n1'`).run()
        expect(
          db.prepare(`SELECT count(*) AS n FROM "_sns_rows_notes"`).get()
        ).toEqual({ n: 0 })
        expect(
          db
            .prepare(
              `SELECT recordId FROM _tombstone WHERE tableName = 'notes'`
            )
            .all()
        ).toEqual([{ recordId: 'n1' }])
      } finally {
        db.close()
      }
    },
    SLOW
  )
})
