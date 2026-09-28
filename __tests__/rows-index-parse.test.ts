/**
 * 索引の読み取り（`src/rows/index-parse.ts`）の試験。設計書 §1.5・前提 P8 と、
 * 段階1 の完了条件4・7。
 *
 * 見るのは3つ。
 *
 * 1. `CREATE INDEX` の字面から、列・式・照合順序・部分索引の述語を取り出せること
 * 2. **読めない形は例外**になること（黙って条件から落とすと、かぶっていない行を
 *    勝者に選ぶ）
 * 3. 一意にしている索引を集めるとき、**UNIQUE と主キーの両方**が挙がること
 *    （`INTEGER PRIMARY KEY` は `PRAGMA index_list` に出ないので、作り物を足す）
 */
import Database from 'better-sqlite3'
import { parseCreateIndex, readUniqueIndexes } from '../src/rows/index-parse'

describe('parseCreateIndex —— 読める形', () => {
  it('素の列の並び', () => {
    const parsed = parseCreateIndex('CREATE INDEX i ON t (a, b)')
    expect(parsed.expressions).toEqual(['a', 'b'])
    expect(parsed.predicate).toBeNull()
  })

  it('UNIQUE と IF NOT EXISTS と引用符つきの名前', () => {
    const parsed = parseCreateIndex(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx x" ON [my table] ("a b")'
    )
    expect(parsed.expressions).toEqual(['"a b"'])
  })

  it('COLLATE と DESC を項から剥がす', () => {
    const parsed = parseCreateIndex(
      'CREATE UNIQUE INDEX i ON t (name COLLATE NOCASE DESC, b ASC)'
    )
    expect(parsed.expressions).toEqual(['name', 'b'])
    expect(parsed.collations).toEqual(['NOCASE', null])
  })

  it('式索引（括弧とカンマを含む式を1つの項として読む）', () => {
    const parsed = parseCreateIndex(
      'CREATE UNIQUE INDEX i ON t (substr(name, 1, 3), lower(b))'
    )
    expect(parsed.expressions).toEqual(['substr(name, 1, 3)', 'lower(b)'])
  })

  it('部分索引の述語', () => {
    const parsed = parseCreateIndex(
      "CREATE UNIQUE INDEX i ON t (name) WHERE deleted = 0 AND kind = 'x';"
    )
    expect(parsed.expressions).toEqual(['name'])
    expect(parsed.predicate).toBe("deleted = 0 AND kind = 'x'")
  })

  it("文字列リテラルの中の 'DESC' や ',' を切れ目にしない", () => {
    const parsed = parseCreateIndex("CREATE INDEX i ON t (name || ', DESC', b)")
    expect(parsed.expressions).toEqual(["name || ', DESC'", 'b'])
  })
})

describe('parseCreateIndex —— 読めない形は例外（完了条件7）', () => {
  const broken: [string, string][] = [
    ['CREATE INDEX で始まっていない', 'CREATE TABLE t (a)'],
    ['列の並びが無い', 'CREATE INDEX i ON t'],
    ['括弧が閉じていない', 'CREATE INDEX i ON t (a, b'],
    ['引用符が閉じていない', "CREATE INDEX i ON t (a || 'x)"],
    ['空の項がある', 'CREATE INDEX i ON t (a, )'],
    ['WHERE 以外が続く', 'CREATE INDEX i ON t (a) NULLS LAST'],
  ]
  for (const [name, sql] of broken) {
    it(name, () => {
      expect(() => parseCreateIndex(sql)).toThrow(/索引の定義を読めない/)
    })
  }
})

describe('parseCreateIndex —— 決定的でない式は例外（完了条件6・前提 P8）', () => {
  it("索引の式の date(a, 'now')", () => {
    expect(() =>
      parseCreateIndex("CREATE INDEX i ON t (date(a, 'now'))")
    ).toThrow(/評価のたびに変わる日付の関数/)
  })

  it('索引の式の random()', () => {
    expect(() =>
      parseCreateIndex('CREATE INDEX i ON t (a + abs(random()))')
    ).toThrow(/決定的でない関数 random/)
  })

  it('引数の無い日付の関数', () => {
    expect(() => parseCreateIndex('CREATE INDEX i ON t (datetime())')).toThrow(
      /引数の無い日付の関数/
    )
  })

  it("部分索引の述語の 'localtime'", () => {
    expect(() =>
      parseCreateIndex(
        "CREATE INDEX i ON t (a) WHERE a > date('now','localtime')"
      )
    ).toThrow(/評価のたびに変わる日付の関数/)
  })

  it('決まった書式の日付の関数は通る', () => {
    const parsed = parseCreateIndex(
      "CREATE INDEX i ON t (strftime('%Y', updatedAt))"
    )
    expect(parsed.expressions).toEqual(["strftime('%Y', updatedAt)"])
  })

  it('date という名の列は関数呼び出しではないので通る', () => {
    const parsed = parseCreateIndex('CREATE INDEX i ON t (date, time, changes)')
    expect(parsed.expressions).toEqual(['date', 'time', 'changes'])
  })
})

describe('readUniqueIndexes —— UNIQUE と主キーの両方を拾う（完了条件4）', () => {
  function open(ddl: string, indexes: string[] = []): Database.Database {
    const db = new Database(':memory:')
    db.exec(ddl)
    for (const index of indexes) db.exec(index)
    return db
  }

  it('表の宣言の UNIQUE と、自動で作られた主キーの索引', () => {
    const db = open(
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, name TEXT UNIQUE)`
    )
    try {
      const found = readUniqueIndexes(db, 't')
      expect(found.map((index) => index.origin).sort()).toEqual(['pk', 'u'])
      const primaryKey = found.find((index) => index.origin === 'pk')
      expect(primaryKey?.terms.map((term) => term.expression)).toEqual(['"id"'])
    } finally {
      db.close()
    }
  })

  it('INTEGER PRIMARY KEY は PRAGMA に出ないので、作り物の索引を足す', () => {
    const db = open(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`)
    try {
      const found = readUniqueIndexes(db, 't')
      expect(found).toHaveLength(1)
      expect(found[0].origin).toBe('pk')
      expect(found[0].terms.map((term) => term.expression)).toEqual(['"id"'])
    } finally {
      db.close()
    }
  })

  it('列の宣言の COLLATE NOCASE が、索引の照合順序として読める', () => {
    const db = open(
      `CREATE TABLE t (id INTEGER PRIMARY KEY, handle TEXT COLLATE NOCASE)`,
      ['CREATE UNIQUE INDEX i ON t (handle)']
    )
    try {
      const found = readUniqueIndexes(db, 't')
      const index = found.find((entry) => entry.name === 'i')
      expect(index?.terms[0].collation.toUpperCase()).toBe('NOCASE')
    } finally {
      db.close()
    }
  })

  it('部分索引の述語が読める', () => {
    const db = open(
      `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, live INT)`,
      ['CREATE UNIQUE INDEX i ON t (name) WHERE live = 1']
    )
    try {
      const index = readUniqueIndexes(db, 't').find(
        (entry) => entry.name === 'i'
      )
      expect(index?.predicate).toBe('live = 1')
    } finally {
      db.close()
    }
  })

  it('式索引の式が読める', () => {
    const db = open(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`, [
      'CREATE UNIQUE INDEX i ON t (lower(name))',
    ])
    try {
      const index = readUniqueIndexes(db, 't').find(
        (entry) => entry.name === 'i'
      )
      expect(index?.terms.map((term) => term.expression)).toEqual([
        'lower(name)',
      ])
    } finally {
      db.close()
    }
  })

  it('WITHOUT ROWID の主キーも拾う', () => {
    const db = open(
      `CREATE TABLE t (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID`
    )
    try {
      const index = readUniqueIndexes(db, 't').find(
        (entry) => entry.origin === 'pk'
      )
      expect(index?.terms.map((term) => term.expression)).toEqual([
        '"a"',
        '"b"',
      ])
    } finally {
      db.close()
    }
  })
})
