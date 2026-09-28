/**
 * 前提の検査（`src/setup/rows-preflight.ts`）の試験。設計書 §1.8 と、段階1 の
 * 完了条件6・7。
 *
 * 断るべきものを断ることと、**まともなスキーマを断らないこと**の両方を見る。
 * 後者は同じくらい大事で、`date`・`time`・`changes` という名の列や、
 * `'now'` という語を含む文字列リテラルは普通に現れる。名前の部分一致で
 * 実装すると、そういう表が起動しなくなる。
 */
import Database from 'better-sqlite3'
import { checkRowsPreconditions } from '../src/setup/rows-preflight'

function open(statements: string[]): Database.Database {
  const db = new Database(':memory:')
  for (const statement of statements) db.exec(statement)
  return db
}

describe('checkRowsPreconditions —— P1（主キーが TEXT で、NULL を取らない）', () => {
  it('素の TEXT PRIMARY KEY は NULL を許すので例外', () => {
    const db = open([`CREATE TABLE t (id TEXT PRIMARY KEY, updatedAt TEXT)`])
    try {
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /主キー id が NULL を取れる/
      )
    } finally {
      db.close()
    }
  })

  it('TEXT NOT NULL と TEXT の WITHOUT ROWID は通る', () => {
    for (const ddl of [
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, updatedAt TEXT)`,
      `CREATE TABLE t (id TEXT PRIMARY KEY, updatedAt TEXT) WITHOUT ROWID`,
    ]) {
      const db = open([ddl])
      try {
        expect(checkRowsPreconditions(db, [{ name: 't' }]).warnings).toEqual([])
      } finally {
        db.close()
      }
    }
  })

  // 自動採番は NULL にこそならないが、別々の端末が**同じ値を別の行に**割り当てる。
  // その2行は同期で1つの行として扱われ、片方の中身が失われるので、型の宣言で断る
  it('INTEGER PRIMARY KEY（自動採番）は例外', () => {
    const db = open([`CREATE TABLE t (id INTEGER PRIMARY KEY, updatedAt TEXT)`])
    try {
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /主キー id が TEXT で宣言されていない/
      )
    } finally {
      db.close()
    }
  })

  it('TEXT 以外の宣言（BLOB など）も例外', () => {
    const db = open([
      `CREATE TABLE t (id BLOB PRIMARY KEY NOT NULL, updatedAt TEXT)`,
    ])
    try {
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /主キー id が TEXT で宣言されていない/
      )
    } finally {
      db.close()
    }
  })

  it('主キーが無ければ例外', () => {
    const db = open([`CREATE TABLE t (a TEXT, updatedAt TEXT)`])
    try {
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /主キーが無い/
      )
    } finally {
      db.close()
    }
  })

  it('宣言は正しくても、既存の行に NULL の主キーがあれば例外', () => {
    const db = open([`CREATE TABLE t (id TEXT PRIMARY KEY, updatedAt TEXT)`])
    try {
      db.prepare(`INSERT INTO t VALUES (NULL, '2026-01-01')`).run()
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /NULL を取れる|主キーが NULL の行/
      )
    } finally {
      db.close()
    }
  })
})

describe('checkRowsPreconditions —— P8（決定的でないもの）（完了条件6・7）', () => {
  it('CHECK の random() で例外', () => {
    const db = open([
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a INTEGER CHECK (a <> abs(random())))`,
    ])
    try {
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /決定的でない関数 random/
      )
    } finally {
      db.close()
    }
  })

  it("索引の式の date(a,'now') で例外", () => {
    const db = open([
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a TEXT)`,
      `CREATE INDEX i ON t (date(a, 'now'))`,
    ])
    try {
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /評価のたびに変わる日付の関数/
      )
    } finally {
      db.close()
    }
  })

  it('独自に登録された関数を CHECK で使っていれば例外', () => {
    const db = new Database(':memory:')
    try {
      db.function('myrank', () => 1)
      db.exec(
        `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a INTEGER CHECK (a > myrank()))`
      )
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /独自に登録された関数 myrank/
      )
    } finally {
      db.close()
    }
  })

  it('組み込みでない照合順序が宣言に現れれば例外', () => {
    // SQLite は `COLLATE MYCOLL` を `CREATE TABLE` の時点で断る（`no such
    // collation sequence`）ので、この形は**独自に登録した端末で作った DB を
    // 登録していない端末で開いた**ときにしか現れない。それを `sqlite_master` の
    // 書き換えで作る
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a TEXT)`)
      db.unsafeMode(true)
      db.pragma('writable_schema = ON')
      db.prepare(
        `UPDATE sqlite_master
            SET sql = 'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a TEXT COLLATE MYCOLL)'
          WHERE name = 't'`
      ).run()
      db.pragma('writable_schema = OFF')
      db.unsafeMode(false)
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /組み込みでない照合順序 mycoll/
      )
    } finally {
      db.close()
    }
  })

  it('組み込みの照合順序（BINARY / NOCASE / RTRIM）は通る', () => {
    const db = open([
      `CREATE TABLE t (
         id TEXT PRIMARY KEY NOT NULL,
         a  TEXT COLLATE NOCASE,
         b  TEXT COLLATE RTRIM,
         c  TEXT COLLATE BINARY
       )`,
      'CREATE UNIQUE INDEX i ON t (a COLLATE NOCASE)',
    ])
    try {
      expect(checkRowsPreconditions(db, [{ name: 't' }]).warnings).toEqual([])
    } finally {
      db.close()
    }
  })

  it('読めない索引で例外', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a TEXT)`)
      db.exec(`CREATE INDEX i ON t (a)`)
      // `sqlite_master` を直に書き換えて、読めない定義を作る
      db.unsafeMode(true)
      db.pragma('writable_schema = ON')
      db.prepare(
        `UPDATE sqlite_master SET sql = 'CREATE INDEX i ON t (a' WHERE name = 'i'`
      ).run()
      db.pragma('writable_schema = OFF')
      db.unsafeMode(false)
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /索引の定義を読めない/
      )
    } finally {
      db.close()
    }
  })

  it('まともなスキーマは断らない（date・time・changes という名の列、now を含む文字列）', () => {
    const db = open([
      `CREATE TABLE t (
         id        TEXT PRIMARY KEY NOT NULL,
         date      TEXT,
         time      TEXT,
         changes   INTEGER,
         note      TEXT DEFAULT 'now is the time',
         updatedAt TEXT,
         -- random なコメント。datetime('now') と書いてあっても読み飛ばす
         CHECK (length(note) >= 0)
       )`,
      `CREATE INDEX i_date ON t (date, time)`,
      `CREATE UNIQUE INDEX i_note ON t (note) WHERE changes > 0`,
      `CREATE INDEX i_year ON t (strftime('%Y', updatedAt))`,
    ])
    try {
      expect(checkRowsPreconditions(db, [{ name: 't' }]).warnings).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('checkRowsPreconditions —— 時刻列（P15・穴7）', () => {
  /** 時刻列に1つずつ値を入れた表を作り、前提の検査の例外を返す。 */
  function rejectionOf(values: unknown[], declaration = 'updatedAt'): string {
    const db = open([
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, ${declaration})`,
    ])
    try {
      const insert = db.prepare(`INSERT INTO t VALUES (?, ?)`)
      values.forEach((value, at) => insert.run(`r${at}`, value))
      try {
        checkRowsPreconditions(db, [{ name: 't' }], {
          now: () => Date.parse('2026-01-01T00:00:00.000Z'),
        })
      } catch (error) {
        return (error as Error).message
      }
      throw new Error('例外にならなかった')
    } finally {
      db.close()
    }
  }

  it.each([
    ['整数', 1767225600000, '1767225600000'],
    ['実数', 2460676.5, '2460676.5'],
    ['ISO でない文字列', 'yesterday', "'yesterday'"],
    ['NULL', null, 'NULL'],
    ['BLOB', Buffer.from('x', 'utf8'), 'BLOB（1 バイト）'],
  ])('時刻列に %s があれば例外', (_label, value, shown) => {
    const message = rejectionOf(['2026-01-01T00:00:00.000Z', value])
    expect(message).toContain(
      '同期する表 t の時刻列 updatedAt に、ISO-8601 の文字列でない値が 1 件ある'
    )
    expect(message).toContain(`（例: ${shown}）`)
    expect(message).toContain(
      '時刻列は ISO-8601 の文字列（例: 2026-01-01T00:00:00.000Z）で書くこと'
    )
  })

  it('例外の文面には件数と、代表の値がいくつか入る', () => {
    const message = rejectionOf([
      1,
      2,
      3,
      4,
      null,
      'x',
      '2026-01-01T00:00:00.000Z',
    ])
    expect(message).toContain('ISO-8601 の文字列でない値が 6 件ある')
    // 代表は値の種類ごとに1つ（種類の名前の順。JS の数値は REAL で入る）
    expect(message).toContain("（例: NULL, 1, 'x'）")
  })

  it('ISO 8601 の文字列ならどの書き方でも通る（Z・+00:00・スペース区切り・日付だけ）', () => {
    const db = open([
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, updatedAt TEXT)`,
    ])
    try {
      const insert = db.prepare(`INSERT INTO t VALUES (?, ?)`)
      insert.run('a', '2026-01-01T00:00:00.000Z')
      insert.run('b', '2025-12-30T23:56:25.448+00:00')
      insert.run('c', '2026-01-01 00:00:01')
      insert.run('d', '2026-06-01')
      const result = checkRowsPreconditions(db, [{ name: 't' }], {
        now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      })
      expect(result.warnings).toEqual([])
    } finally {
      db.close()
    }
  })

  it('時刻列の名前の大文字小文字が設定と違っても検査する', () => {
    const db = open([
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, UpdatedAt INTEGER)`,
    ])
    try {
      db.prepare(`INSERT INTO t VALUES ('a', 1767225600000)`).run()
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /同期する表 t の時刻列 UpdatedAt に、ISO-8601 の文字列でない値が 1 件ある/
      )
      expect(() =>
        checkRowsPreconditions(db, [
          { name: 't', timestampColumn: 'UPDATEDAT' },
        ])
      ).toThrow(/時刻列 UpdatedAt/)
    } finally {
      db.close()
    }
  })

  it('WITHOUT ROWID の表でも検査できる', () => {
    const db = open([
      `CREATE TABLE t (id TEXT PRIMARY KEY, updatedAt) WITHOUT ROWID`,
    ])
    try {
      db.prepare(`INSERT INTO t VALUES ('a', 5)`).run()
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /ISO-8601 の文字列でない値が 1 件ある（例: 5）/
      )
    } finally {
      db.close()
    }
  })

  it('大きく未来の値は警告', () => {
    const db = open([
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, updatedAt TEXT)`,
    ])
    try {
      db.prepare(`INSERT INTO t VALUES ('a', '2200-01-01T00:00:00.000Z')`).run()
      const result = checkRowsPreconditions(db, [{ name: 't' }], {
        now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      })
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toMatch(/大きく未来の値/)
    } finally {
      db.close()
    }
  })

  it('時刻列が無い表では、時刻にまつわる検査を飛ばす', () => {
    const db = open([`CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a TEXT)`])
    try {
      db.prepare(`INSERT INTO t VALUES ('a', 'x')`).run()
      expect(checkRowsPreconditions(db, [{ name: 't' }]).warnings).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('checkRowsPreconditions —— P14（同期する表を親とする外部キーは親の主キーを参照する）', () => {
  const PARENT = `CREATE TABLE parent (
    id   TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE
  )`

  it('親の主キーを参照する外部キーは通る', () => {
    const db = open([
      PARENT,
      `CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL,
         parentId TEXT REFERENCES parent(id) ON DELETE CASCADE)`,
    ])
    try {
      expect(() =>
        checkRowsPreconditions(db, [{ name: 'parent' }, { name: 'child' }])
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('列を書かない参照（REFERENCES parent）は主キーを指すので通る', () => {
    const db = open([
      PARENT,
      `CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL,
         parentId TEXT REFERENCES parent)`,
    ])
    try {
      expect(() =>
        checkRowsPreconditions(db, [{ name: 'parent' }, { name: 'child' }])
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('大文字小文字の違う列名で主キーを参照するのは通る', () => {
    const db = open([
      PARENT,
      `CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL,
         parentId TEXT REFERENCES Parent(ID))`,
    ])
    try {
      expect(() =>
        checkRowsPreconditions(db, [{ name: 'parent' }, { name: 'child' }])
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('UNIQUE 列を参照する外部キーは例外（子が同期する表）', () => {
    const db = open([
      PARENT,
      `CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL,
         parentCode TEXT REFERENCES parent(code))`,
    ])
    try {
      expect(() =>
        checkRowsPreconditions(db, [{ name: 'parent' }, { name: 'child' }])
      ).toThrow(
        '表 child の外部キー（parentCode）が、同期する表 parent の主キーでない列（code）を参照している。' +
          '同期する表を親とする外部キーは、親の主キー（id）を参照すること。'
      )
    } finally {
      db.close()
    }
  })

  it('UNIQUE 列を参照する外部キーは例外（子が同期しない表）', () => {
    const db = open([
      PARENT,
      `CREATE TABLE local_only (id INTEGER PRIMARY KEY,
         parentCode TEXT REFERENCES parent(code))`,
    ])
    try {
      expect(() => checkRowsPreconditions(db, [{ name: 'parent' }])).toThrow(
        /表 local_only の外部キー（parentCode）が、同期する表 parent の主キーでない列（code）を参照している/
      )
    } finally {
      db.close()
    }
  })

  it('同期しない表を親とする外部キーは見ない', () => {
    const db = open([
      PARENT,
      `CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL,
         parentCode TEXT REFERENCES parent(code))`,
    ])
    try {
      expect(() =>
        checkRowsPreconditions(db, [{ name: 'child' }])
      ).not.toThrow()
    } finally {
      db.close()
    }
  })
})

describe('checkRowsPreconditions —— P5（親のいない子）', () => {
  /**
   * 親の表と子の表を作り、**外部キーの強制を切ってから**親のいない子を入れる。
   * better-sqlite3 は既定で `foreign_keys = ON` なので、切らないと壊れた形を
   * 作れない。導入前から壊れている DB は、これと同じ姿をしている。
   */
  function openBroken(
    childRows: number,
    extra: string[] = []
  ): Database.Database {
    const db = open([
      `CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL)`,
      `CREATE TABLE notes (
         id    TEXT PRIMARY KEY NOT NULL,
         tagId TEXT REFERENCES tags(id)
       )`,
      ...extra,
    ])
    db.pragma('foreign_keys = OFF')
    const insert = db.prepare(`INSERT INTO notes VALUES (?, 'missing')`)
    for (let index = 0; index < childRows; index += 1) insert.run(`n${index}`)
    return db
  }

  it('違反が無ければ警告が出ない', () => {
    const db = openBroken(0)
    try {
      db.prepare(`INSERT INTO tags VALUES ('t1')`).run()
      db.prepare(`INSERT INTO notes VALUES ('n1', 't1')`).run()
      expect(
        checkRowsPreconditions(db, [{ name: 'notes' }, { name: 'tags' }])
          .warnings
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  it('子の行だけある DB では、表名・親の表名・件数が文面に入る', () => {
    const db = openBroken(9)
    try {
      const warnings = checkRowsPreconditions(db, [
        { name: 'notes' },
        { name: 'tags' },
      ]).warnings
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('notes')
      expect(warnings[0]).toContain('tags')
      expect(warnings[0]).toContain('9 件')
      expect(warnings[0]).toContain('親のいない行')
    } finally {
      db.close()
    }
  })

  // `foreign_key_check(<表>)` は「その表が子である違反」しか返さない。同期する表
  // だけを回すと、この形（子が対象外・親が対象）を取りこぼす
  it('同期しない表から同期する表への違反も見つかる', () => {
    const db = openBroken(2)
    try {
      const warnings = checkRowsPreconditions(db, [{ name: 'tags' }]).warnings
      expect(warnings.join('\n')).toMatch(/同期する表 notes/)
    } finally {
      db.close()
    }
  })

  it('同期に関わらない表の違反は、文面で区別が付く', () => {
    const db = openBroken(0, [
      `CREATE TABLE books (id TEXT PRIMARY KEY NOT NULL)`,
      `CREATE TABLE pages (
         id     TEXT PRIMARY KEY NOT NULL,
         bookId TEXT REFERENCES books(id)
       )`,
    ])
    try {
      db.prepare(`INSERT INTO pages VALUES ('p1', 'missing')`).run()
      const warnings = checkRowsPreconditions(db, [{ name: 'notes' }]).warnings
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/^同期しない表 pages/)
    } finally {
      db.close()
    }
  })

  it('違反が多数あっても文面が暴れない（表の数と件数の上限が効く）', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL)`)
      const names: string[] = []
      for (let index = 0; index < 14; index += 1) {
        const table = `child${String(index).padStart(2, '0')}`
        names.push(table)
        db.exec(
          `CREATE TABLE ${table} (
             id    TEXT PRIMARY KEY NOT NULL,
             tagId TEXT REFERENCES tags(id)
           )`
        )
      }
      db.pragma('foreign_keys = OFF')
      for (const table of names) {
        const insert = db.prepare(`INSERT INTO ${table} VALUES (?, 'missing')`)
        for (let row = 0; row < 200; row += 1) insert.run(`r${row}`)
      }
      const warnings = checkRowsPreconditions(db, [{ name: 'tags' }]).warnings
      // 個別に並ぶのは10表まで、残りの4表は1行にまとまる
      expect(warnings).toHaveLength(11)
      expect(warnings[10]).toContain('ほか 4 表')
      expect(warnings[10]).toContain('800 件')
      // 2800 件の違反があっても、文字数は素直な長さに収まる
      expect(warnings.join('\n').length).toBeLessThan(2000)
    } finally {
      db.close()
    }
  })

  it('1つの表に親が多いとき、親の表の名前も上限までに収まる', () => {
    const db = new Database(':memory:')
    try {
      const parents = ['p1', 'p2', 'p3', 'p4', 'p5']
      for (const parent of parents) {
        db.exec(`CREATE TABLE ${parent} (id TEXT PRIMARY KEY NOT NULL)`)
      }
      db.exec(
        `CREATE TABLE child (
           id TEXT PRIMARY KEY NOT NULL,
           ${parents.map((parent) => `${parent}Id TEXT REFERENCES ${parent}(id)`).join(', ')}
         )`
      )
      db.pragma('foreign_keys = OFF')
      db.prepare(
        `INSERT INTO child VALUES ('c1', 'x', 'x', 'x', 'x', 'x')`
      ).run()
      const warnings = checkRowsPreconditions(db, [{ name: 'child' }]).warnings
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ほか 2 表')
    } finally {
      db.close()
    }
  })

  // `_` で始まる表はこのライブラリが自分で作って自分で直すもので、利用者が
  // 手を打てない。挙げてもアプリの表の破れを埋もれさせるだけなので数えない
  it('このライブラリの表（_ で始まる）の違反は挙げない', () => {
    const db = open([
      `CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL)`,
      `CREATE TABLE _sns_shown (
         id    TEXT PRIMARY KEY NOT NULL,
         tagId TEXT REFERENCES tags(id)
       )`,
    ])
    try {
      db.pragma('foreign_keys = OFF')
      db.prepare(`INSERT INTO _sns_shown VALUES ('a', 'missing')`).run()
      expect(checkRowsPreconditions(db, [{ name: 'tags' }]).warnings).toEqual(
        []
      )
    } finally {
      db.close()
    }
  })
})
