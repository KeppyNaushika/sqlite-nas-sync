/**
 * 真の id で行を引く条件（`src/rows/key-lookup.ts`）。
 *
 * 突き合わせの意味は `CAST(<主キー> AS TEXT) = <キー>` のまま変えずに、主キーの索引を
 * 使わせる。これが崩れると、フルマージの取り込みは「行数 × 行数」に戻り、9,000 行で
 * 9〜20 秒呼んだスレッドが止まる。アプリが行を1つ消すたびに動くトリガーも、表を
 * 全部なめるようになる（索引の検査）。逆に、答えが1行でも変われば、取り込みが相手の
 * 行を「無い」と読み違えて版を失う（同じ答えの検査）。
 *
 * 同じ答えになるかは、主キーの列の**照合順序**（NOCASE・RTRIM）と DB の**文字コード**
 * （UTF-16）にも左右される。BLOB の主キーを `CAST(<キー> AS BLOB)` との一致で拾う形は、
 * そのどれでも答えが変わっていた。
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  hasTextAffinity,
  keyInSql,
  keyLookup,
  keyMatchSql,
} from '../src/rows/key-lookup'

/** 主キーの宣言 `type` の表に `values` を入れる。 */
function tableWith(type: string, values: unknown[]): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE t (id ${type} PRIMARY KEY, body TEXT)`)
  // 親和性の変換で同じ値になるもの（REAL の '5' と '5.0' など）は1つだけ入る
  const insert = db.prepare(`INSERT OR IGNORE INTO t (id, body) VALUES (?, ?)`)
  values.forEach((value, i) => insert.run(value, `row-${i}`))
  return db
}

/** 元の条件（索引を使わない）で引いた行。 */
function byCast(db: Database.Database, key: string): unknown[] {
  return db
    .prepare(
      `SELECT rowid, body FROM t WHERE CAST(id AS TEXT) = ? ORDER BY rowid`
    )
    .all(key)
}

/** 新しい条件で引いた行。 */
function byLookup(db: Database.Database, key: string): unknown[] {
  const lookup = keyLookup(db, 't', 'id')
  return db
    .prepare(`SELECT rowid, body FROM t WHERE ${lookup.sql} ORDER BY rowid`)
    .all(...lookup.bind(key))
}

/** 主キーに入りうる、紛らわしい値。 */
const TRICKY_VALUES: unknown[] = [
  'a1b2c3d4-0000-4000-8000-000000000001',
  '5',
  '05',
  '5.0',
  ' 5',
  '',
  '学校',
  'ＡＢＣ',
  'abc',
  'ABC',
  Buffer.from('blob-id', 'utf8'),
  Buffer.from('学校の行', 'utf8'),
  7,
  1.5,
  null,
]

/** 引いてみるキー（入っている値の正規形と、入っていないもの）。 */
const KEYS = [
  'a1b2c3d4-0000-4000-8000-000000000001',
  '5',
  '05',
  '5.0',
  ' 5',
  '',
  '学校',
  'ＡＢＣ',
  'abc',
  'ABC',
  'blob-id',
  '学校の行',
  '7',
  '7.0',
  '1.5',
  'missing',
]

describe('keyLookup —— 答えは CAST(主キー AS TEXT) = ? と同じ', () => {
  for (const type of [
    'TEXT',
    'VARCHAR(36)',
    'CLOB',
    'INTEGER',
    'REAL',
    'NUMERIC',
    '',
  ]) {
    it(`主キーの型名が ${type === '' ? '（なし）' : type} の表`, () => {
      // INTEGER PRIMARY KEY は rowid の別名で、整数以外を入れられない
      const values =
        type === 'INTEGER'
          ? TRICKY_VALUES.filter(
              (value) => typeof value === 'number' && Number.isInteger(value)
            )
          : TRICKY_VALUES
      const db = tableWith(type, values)
      try {
        for (const key of KEYS) {
          expect(byLookup(db, key), `キー ${JSON.stringify(key)}`).toEqual(
            byCast(db, key)
          )
        }
        // 自己検査: 何かは見つかっている（全部「無し」で一致していたら検査にならない）
        const found = KEYS.filter((key) => byCast(db, key).length > 0)
        expect(found.length).toBeGreaterThanOrEqual(type === 'INTEGER' ? 1 : 10)
      } finally {
        db.close()
      }
    })
  }

  it('STRICT 表の TEXT 主キー', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT) STRICT`)
    const insert = db.prepare(`INSERT INTO t VALUES (?, ?)`)
    for (const value of ['5', '05', '', '学校', 'abc']) insert.run(value, value)
    try {
      for (const key of KEYS) {
        expect(byLookup(db, key), `キー ${JSON.stringify(key)}`).toEqual(
          byCast(db, key)
        )
      }
    } finally {
      db.close()
    }
  })
})

describe('keyLookup —— TEXT 親和性の主キーでは索引を使う', () => {
  it('実行計画が SCAN ではなく索引の SEARCH になる', () => {
    const db = tableWith('TEXT', ['x'])
    try {
      const lookup = keyLookup(db, 't', 'id')
      const plan = (
        db
          .prepare(`EXPLAIN QUERY PLAN SELECT * FROM t WHERE ${lookup.sql}`)
          .all(...lookup.bind('x')) as { detail: string }[]
      ).map((row) => row.detail)
      expect(plan.some((detail) => /SEARCH t USING .*INDEX/.test(detail))).toBe(
        true
      )
      expect(plan.some((detail) => /^SCAN t\b/.test(detail))).toBe(false)

      // 自己検査: 元の条件だけなら SCAN になる（判定が逆向きに壊れていないこと）
      const castPlan = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT * FROM t WHERE CAST(id AS TEXT) = ?`
          )
          .all('x') as { detail: string }[]
      ).map((row) => row.detail)
      expect(castPlan.some((detail) => /^SCAN t\b/.test(detail))).toBe(true)
    } finally {
      db.close()
    }
  })

  it('TEXT 親和性でない主キーでは元の条件のまま', () => {
    for (const type of ['INTEGER', 'REAL', 'NUMERIC', '', 'BLOB']) {
      const db = tableWith(type, [])
      try {
        expect(keyLookup(db, 't', 'id').sql).toBe(`CAST("id" AS TEXT) = ?`)
      } finally {
        db.close()
      }
    }
  })

  it('主キーの列名の大文字・小文字が違っても見つける', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (Id TEXT PRIMARY KEY)`)
    try {
      expect(keyLookup(db, 't', 'id').sql).toContain(`"id" >= X''`)
    } finally {
      db.close()
    }
  })
})

/** 照合順序・主キーの宣言の組み合わせ（`CREATE TABLE t (…)` の括弧の中）。 */
const DECLARATIONS = [
  'id TEXT PRIMARY KEY, body TEXT',
  'id TEXT COLLATE NOCASE PRIMARY KEY, body TEXT',
  'id TEXT COLLATE RTRIM PRIMARY KEY, body TEXT',
  // 主キーの索引の照合順序が列と違う（索引は使えないが、答えは同じでなければならない）
  'id TEXT, body TEXT, PRIMARY KEY (id COLLATE NOCASE)',
]

/** BLOB の主キー。奇数長のものは、UTF-16 の DB で `CAST(… AS TEXT)` が端を落とす。 */
const BLOB_VALUES: Buffer[] = [
  Buffer.from('abc', 'utf8'),
  Buffer.from('ABC', 'utf8'),
  Buffer.from('abc ', 'utf8'),
  Buffer.from('学校', 'utf8'),
  Buffer.from([0x61, 0x00, 0x62]),
  Buffer.from([0x61, 0x00]),
  Buffer.from([0xff, 0xfe, 0x00]),
  Buffer.alloc(0),
]

/** 文字コード `encoding`、宣言 `declaration` の表に、紛らわしい値を入れる。 */
function trickyTable(
  encoding: string,
  declaration: string,
  withoutRowid: boolean
): Database.Database {
  const db = new Database(':memory:')
  db.pragma(`encoding = '${encoding}'`)
  db.exec(
    `CREATE TABLE t (${declaration})${withoutRowid ? ' WITHOUT ROWID' : ''}`
  )
  const insert = db.prepare(`INSERT OR IGNORE INTO t (id, body) VALUES (?, ?)`)
  const values = [
    ...TRICKY_VALUES.filter((value) => value !== null),
    'Abc',
    'abc ',
    ...BLOB_VALUES,
  ]
  values.forEach((value, i) => insert.run(value, `row-${i}`))
  return db
}

/** 引いてみるキー: 決めたものと、入っている値の正規形すべて。 */
function keysOf(db: Database.Database): string[] {
  const held = db
    .prepare(`SELECT CAST(id AS TEXT) FROM t WHERE id IS NOT NULL`)
    .pluck()
    .all() as string[]
  return [...new Set([...KEYS, 'aBC', 'abc  ', ...held])]
}

describe('keyLookup・keyMatchSql・keyInSql —— 照合順序と文字コードが違っても答えは同じ', () => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
    for (const declaration of DECLARATIONS) {
      for (const withoutRowid of [false, true]) {
        it(`${encoding}・${declaration}${withoutRowid ? '・WITHOUT ROWID' : ''}`, () => {
          const db = trickyTable(encoding, declaration, withoutRowid)
          try {
            const keys = keysOf(db)
            const lookup = keyLookup(db, 't', 'id')
            const byLookupSql = db.prepare(
              `SELECT body FROM t WHERE ${lookup.sql} ORDER BY body`
            )
            const byCastSql = db.prepare(
              `SELECT body FROM t WHERE CAST(id AS TEXT) = ? ORDER BY body`
            )
            for (const key of keys) {
              expect(
                byLookupSql.all(...lookup.bind(key)),
                `キー ${JSON.stringify(key)}`
              ).toEqual(byCastSql.all(key))
            }

            // 列を参照する形（トリガーの相関副問い合わせ）と、`IN` の副問い合わせの形
            db.exec(`CREATE TEMP TABLE k (key TEXT)`)
            const insertKey = db.prepare(`INSERT INTO temp.k VALUES (?)`)
            for (const key of keys) insertKey.run(key)
            const correlated = (match: string): unknown[] =>
              db
                .prepare(
                  `SELECT k.key,
                          (SELECT group_concat(body, ',') FROM
                             (SELECT body FROM t WHERE ${match} ORDER BY body)) AS bodies
                     FROM temp.k AS k ORDER BY k.key`
                )
                .all()
            expect(correlated(keyMatchSql('t.id', 'k.key', true))).toEqual(
              correlated(`CAST(t.id AS TEXT) = k.key`)
            )
            const inSubquery = (match: string): unknown[] =>
              db
                .prepare(`SELECT body FROM t WHERE ${match} ORDER BY body`)
                .all()
            for (const pattern of ['a%', '学%', '%', '']) {
              const subquery = `SELECT key FROM temp.k WHERE key LIKE '${pattern}'`
              expect(
                inSubquery(keyInSql('id', subquery, true)),
                `LIKE ${pattern}`
              ).toEqual(inSubquery(`CAST(id AS TEXT) IN (${subquery})`))
            }

            // 自己検査: BLOB の主キーと、大文字・小文字だけ違うキーで見つかる行がある
            const found = keys.filter((key) => byCastSql.all(key).length > 0)
            expect(found.length).toBeGreaterThanOrEqual(10)
            expect(
              db
                .prepare(`SELECT count(*) FROM t WHERE typeof(id) = 'blob'`)
                .pluck()
                .get()
            ).toBeGreaterThanOrEqual(5)
          } finally {
            db.close()
          }
        })
      }
    }
  }
})

describe('keyMatchSql・keyInSql —— 列を参照する形でも索引を使う', () => {
  /** 9,000 行ではなく、索引の有無が実行計画に出るだけの行を入れる。 */
  function planOf(db: Database.Database, sql: string): string[] {
    return (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
    ).map((row) => row.detail)
  }

  it('相関副問い合わせ（統合された側の削除の版）', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE r (id TEXT PRIMARY KEY, ts)`)
    db.exec(`CREATE TABLE h (trueId TEXT PRIMARY KEY)`)
    try {
      const plan = planOf(
        db,
        `SELECT (SELECT ts FROM r WHERE ${keyMatchSql('"id"', 'h.trueId', true)}) FROM h`
      )
      expect(plan.some((detail) => /SEARCH r USING .*INDEX/.test(detail))).toBe(
        true
      )
      expect(plan.some((detail) => /SCAN r\b/.test(detail))).toBe(false)
      // 自己検査: 元の条件だけなら表をなめる
      expect(
        planOf(
          db,
          `SELECT (SELECT ts FROM r WHERE CAST(id AS TEXT) = h.trueId) FROM h`
        ).some((detail) => /SCAN r\b/.test(detail))
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('IN の副問い合わせ（アプリが行を消すたびに動く後始末）', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE r (id TEXT PRIMARY KEY, ts)`)
    db.exec(`CREATE TABLE h (trueId TEXT PRIMARY KEY, winnerId TEXT)`)
    try {
      const subquery = `SELECT trueId FROM h WHERE winnerId = 'w'`
      const plan = planOf(
        db,
        `DELETE FROM r WHERE ${keyInSql('"id"', subquery, true)}`
      )
      expect(plan.some((detail) => /SEARCH r USING .*INDEX/.test(detail))).toBe(
        true
      )
      expect(plan.some((detail) => /SCAN r\b/.test(detail))).toBe(false)
      expect(
        planOf(
          db,
          `DELETE FROM r WHERE CAST(id AS TEXT) IN (${subquery})`
        ).some((detail) => /SCAN r\b/.test(detail))
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('TEXT 親和性でなければ元の条件のまま', () => {
    expect(keyMatchSql('"id"', '?', false)).toBe(`CAST("id" AS TEXT) = ?`)
    expect(keyInSql('"id"', 'SELECT 1', false)).toBe(
      `CAST("id" AS TEXT) IN (SELECT 1)`
    )
  })
})

describe('hasTextAffinity —— SQLite の型名の規則', () => {
  it.each([
    ['TEXT', true],
    ['text', true],
    ['VARCHAR(36)', true],
    ['NCHAR', true],
    ['CLOB', true],
    ['CHARINT', false], // INT が先に勝つ
    ['INTEGER', false],
    ['BLOB', false],
    ['', false],
    ['REAL', false],
    ['NUMERIC', false],
  ])('%s → %s', (type, expected) => {
    expect(hasTextAffinity(type)).toBe(expected)
  })
})
