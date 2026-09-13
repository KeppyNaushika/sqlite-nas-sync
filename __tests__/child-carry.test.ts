/**
 * **黙って消えるのがいちばん悪い** —— 敗者行の DELETE を越えて子を引き渡す手当て。
 *
 * `PRAGMA defer_foreign_keys` が遅らせるのは外部キーの**検査**であって `ON DELETE` の
 * **動作**ではない。だから畳みで敗者行を消す前に手当てが要るのだが、手当てできる形と
 * できない形があり、できない形では**実際に何行失われたか**を数えて利用者へ渡す約束に
 * なっている。憶測で「及ばないはず」と決めた瞬間に、子が黙って消える。
 *
 * ここで扱うのは**主キー以外のユニーク列を指す外部キー**という限られた形である
 * （主キーを指す外部キーでは、敗者と勝者で参照先の値が必ず違うのでこの経路へ来ない）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import {
  carryChildrenThroughDelete,
  countChildrenLostToDelete,
  countChildrenReferencing,
  detachChildren,
  emptyChildCarry,
} from '../src/conflict/child-carry'
import { findReferencingForeignKeys } from '../src/conflict/schema'

const testDir = path.join(__dirname, 'test-data-child-carry')

/** ファイルDBを作る（`:memory:` では他のテストと形を揃えづらいため、実ファイルで揃える） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true })
  return new Database(path.join(testDir, `${name}.sqlite`))
}

/**
 * 「親のユニーク列を子が指している」形を作る。
 *
 * @param childDefinition - 子テーブルの定義。外す（NULL にする）ことができる形と
 *   できない形を差し替えて確かめるため、呼び出し側が渡す
 */
function createSchema(db: Database.Database, childDefinition: string): void {
  db.exec(`
    CREATE TABLE parents (
      id        TEXT PRIMARY KEY,
      code      TEXT UNIQUE,
      updatedAt TEXT NOT NULL
    );
    ${childDefinition}
  `)
  db.prepare(
    `INSERT INTO parents VALUES ('loser', 'X', '2026-01-01T00:00:00.000Z')`
  ).run()
  db.prepare(
    `INSERT INTO parents VALUES ('winner', NULL, '2026-02-01T00:00:00.000Z')`
  ).run()
}

/** `parents.code` を指している外部キー1本を引く */
function codeForeignKey(
  db: Database.Database
): ReturnType<typeof findReferencingForeignKeys>[number] {
  const foreignKeys = findReferencingForeignKeys(db, 'parents', 'id').filter(
    (foreignKey) => foreignKey.columns[0].parentColumn === 'code'
  )
  expect(foreignKeys).toHaveLength(1)
  return foreignKeys[0]
}

let db: Database.Database

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

afterEach(() => {
  if (db && db.open) db.close()
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('削除が子に及ばないなら、子には触らない', () => {
  it('`ON DELETE NO ACTION` の子はそのまま勝者の子になる', () => {
    db = createDb('no-action')
    db.pragma('foreign_keys = ON')
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT REFERENCES parents(code),
         body TEXT NOT NULL
       );`
    )
    db.exec(`
      INSERT INTO notes VALUES ('n1', 'X', 'a');
      INSERT INTO notes VALUES ('n2', 'X', 'b');
    `)

    const carry = emptyChildCarry()
    carryChildrenThroughDelete(db, codeForeignKey(db), ['X'], carry)

    // 検査は終端まで遅れており、そのときには勝者がこの値を持っている。
    // ここで余計に NULL 化すると、戻し損ねた子が宙ぶらりんで残る
    expect(carry).toEqual({
      movedChildren: 2,
      lostChildren: 0,
      afterDelete: [],
    })
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE code = 'X'`).get()
    ).toEqual({ n: 2 })

    // 実際に「畳みの手順」を通しても外部キーが壊れないこと。
    // 敗者を消し、勝者がその値を引き取る順で、検査は COMMIT まで遅れる
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON')
      db.prepare(`DELETE FROM parents WHERE id = 'loser'`).run()
      db.prepare(`UPDATE parents SET code = 'X' WHERE id = 'winner'`).run()
    })()

    const rows = db
      .prepare(`SELECT id FROM notes WHERE code = 'X' ORDER BY id`)
      .all()
    expect(rows).toEqual([{ id: 'n1' }, { id: 'n2' }])
  })

  it('外部キーが効いていない接続では、`CASCADE` でも子は消えない', () => {
    db = createDb('fk-off')
    // better-sqlite3 の既定は `foreign_keys = OFF`。利用者がONにしていない接続では
    // `ON DELETE CASCADE` の宣言があっても動作しないので、手当ては要らない
    db.pragma('foreign_keys = OFF')
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT REFERENCES parents(code) ON DELETE CASCADE,
         body TEXT NOT NULL
       );`
    )
    db.exec(`INSERT INTO notes VALUES ('n1', 'X', 'a');`)

    const carry = emptyChildCarry()
    carryChildrenThroughDelete(db, codeForeignKey(db), ['X'], carry)

    expect(carry.movedChildren).toBe(1)
    expect(carry.lostChildren).toBe(0)
    expect(carry.afterDelete).toHaveLength(0)

    db.prepare(`DELETE FROM parents WHERE id = 'loser'`).run()
    expect(countChildrenReferencing(db, codeForeignKey(db), ['X'])).toBe(1)
  })

  it('そもそも子が居なければ何も積まない', () => {
    db = createDb('no-children')
    db.pragma('foreign_keys = ON')
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT REFERENCES parents(code) ON DELETE CASCADE,
         body TEXT NOT NULL
       );`
    )

    const carry = emptyChildCarry()
    carryChildrenThroughDelete(db, codeForeignKey(db), ['X'], carry)

    expect(carry).toEqual({
      movedChildren: 0,
      lostChildren: 0,
      afterDelete: [],
    })
  })
})

describe('削除が子に及ぶなら、一旦外して削除後に戻す', () => {
  it('`CASCADE` の子は NULL へ外され、削除のあと元の値へ戻る', () => {
    db = createDb('cascade-detach')
    db.pragma('foreign_keys = ON')
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT REFERENCES parents(code) ON DELETE CASCADE,
         body TEXT NOT NULL
       );`
    )
    db.exec(`
      INSERT INTO notes VALUES ('n1', 'X', 'a');
      INSERT INTO notes VALUES ('n2', 'X', 'b');
    `)

    const carry = emptyChildCarry()
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON')
      carryChildrenThroughDelete(db, codeForeignKey(db), ['X'], carry)

      // この時点では外れている（`ON DELETE` の動作を空振りさせるため）。
      // 数え上げは削除のあとで確定するので、まだ 0
      expect(carry.movedChildren).toBe(0)
      expect(carry.afterDelete).toHaveLength(1)
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE code IS NULL`).get()
      ).toEqual({ n: 2 })

      db.prepare(`DELETE FROM parents WHERE id = 'loser'`).run()
      db.prepare(`UPDATE parents SET code = 'X' WHERE id = 'winner'`).run()
      for (const afterDelete of carry.afterDelete) afterDelete()
    })()

    // 2行とも生き残り、勝者の子になっている（カスケードで消えていない）
    expect(carry.movedChildren).toBe(2)
    expect(carry.lostChildren).toBe(0)
    expect(
      db.prepare(`SELECT id FROM notes WHERE code = 'X' ORDER BY id`).all()
    ).toEqual([{ id: 'n1' }, { id: 'n2' }])
  })
})

describe('外せない形では、失われた数を数えて伝える', () => {
  it('参照列が `NOT NULL` なら外せない', () => {
    db = createDb('not-null')
    db.pragma('foreign_keys = ON')
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT NOT NULL REFERENCES parents(code) ON DELETE CASCADE,
         body TEXT NOT NULL
       );`
    )
    db.exec(`INSERT INTO notes VALUES ('n1', 'X', 'a');`)

    expect(detachChildren(db, codeForeignKey(db), ['X'])).toBeNull()
  })

  it('参照列が子自身の主キーを兼ねていたら外せない（戻す行を指せなくなる）', () => {
    db = createDb('key-column')
    db.pragma('foreign_keys = ON')
    // 親のユニーク列を主キーとして持つ子（`profiles.code` が主キー兼外部キー）。
    // `TEXT PRIMARY KEY` は `PRAGMA table_info` では `notnull = 0` と見えるので、
    // NULL 可否の宣言だけ見ると「外せる」と誤判断する形
    createSchema(
      db,
      `CREATE TABLE profiles (
         code TEXT PRIMARY KEY REFERENCES parents(code) ON DELETE CASCADE,
         memo TEXT NOT NULL
       );`
    )
    db.exec(`INSERT INTO profiles VALUES ('X', 'memo');`)

    const foreignKey = codeForeignKey(db)
    expect(detachChildren(db, foreignKey, ['X'])).toBeNull()

    // 外せないと分かったので、数える方へ落ちる。**黙って消させない**
    const carry = emptyChildCarry()
    carryChildrenThroughDelete(db, foreignKey, ['X'], carry)
    expect(carry.afterDelete).toHaveLength(1)

    db.prepare(`DELETE FROM parents WHERE id = 'loser'`).run()
    for (const afterDelete of carry.afterDelete) afterDelete()

    expect(carry.lostChildren).toBe(1)
    expect(carry.movedChildren).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM profiles`).get()).toEqual({
      n: 0,
    })
  })

  it('`CHECK` で NULL を禁じている表では、失敗を拾って数える方へ落ちる', () => {
    db = createDb('check-not-null')
    db.pragma('foreign_keys = ON')
    // `NOT NULL` 以外の書き方で NULL を禁じている形。宣言を読むだけでは
    // 見分けられないので、実際に NULL を入れてみて失敗を拾う必要がある。
    // ここで例外を投げ抜けると、その相手からの同期が永久に止まる
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT REFERENCES parents(code) ON DELETE CASCADE,
         body TEXT NOT NULL,
         CHECK (code IS NOT NULL)
       );`
    )
    db.exec(`
      INSERT INTO notes VALUES ('n1', 'X', 'a');
      INSERT INTO notes VALUES ('n2', 'X', 'b');
    `)

    const foreignKey = codeForeignKey(db)
    expect(detachChildren(db, foreignKey, ['X'])).toBeNull()
    // 失敗した UPDATE は何も書き換えていない（外しかけの子が残らない）
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE code = 'X'`).get()
    ).toEqual({ n: 2 })

    const carry = emptyChildCarry()
    expect(() =>
      carryChildrenThroughDelete(db, foreignKey, ['X'], carry)
    ).not.toThrow()

    db.prepare(`DELETE FROM parents WHERE id = 'loser'`).run()
    for (const afterDelete of carry.afterDelete) afterDelete()

    // 2行ともカスケードで消えた。消えたこと自体は防げないが、**数は伝わる**
    expect(carry.lostChildren).toBe(2)
    expect(carry.movedChildren).toBe(0)
  })

  it('子が0行なら、削除後の数え上げを積まない', () => {
    db = createDb('nothing-to-count')
    db.pragma('foreign_keys = ON')
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT NOT NULL REFERENCES parents(code) ON DELETE CASCADE,
         body TEXT NOT NULL
       );`
    )

    // 呼び出し元（`repointChildren` の「勝者側の参照先が NULL」経路）は件数を
    // 確かめずにここへ渡す。0 行のまま積むと、削除後に意味の無い問い合わせが
    // 走るだけでなく、`afterDelete` の数が「手当てした外部キーの本数」と合わなくなる
    const carry = emptyChildCarry()
    countChildrenLostToDelete(db, codeForeignKey(db), ['X'], 0, carry)

    expect(carry).toEqual({
      movedChildren: 0,
      lostChildren: 0,
      afterDelete: [],
    })
  })

  it('`ON DELETE` が走っても同じ値を指したままの子は、失われたと数えない', () => {
    db = createDb('set-default-same-value')
    db.pragma('foreign_keys = ON')
    // 参照列が `NOT NULL` なので外せないが、`ON DELETE SET DEFAULT` の既定値が
    // 同じ値なので、動作が走っても子はその値を指したまま残る。
    // 「動作が及ぶ宣言だから失われたはず」と憶測で決めると、生きている子を
    // `lostChildren` として報告してしまう。**削除の前後で数えて差を取る**のはこのため
    createSchema(
      db,
      `CREATE TABLE notes (
         id   TEXT PRIMARY KEY,
         code TEXT NOT NULL DEFAULT 'X' REFERENCES parents(code) ON DELETE SET DEFAULT,
         body TEXT NOT NULL
       );`
    )
    db.exec(`INSERT INTO notes VALUES ('n1', 'X', 'a');`)

    const foreignKey = codeForeignKey(db)
    expect(detachChildren(db, foreignKey, ['X'])).toBeNull()

    const carry = emptyChildCarry()
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON')
      carryChildrenThroughDelete(db, foreignKey, ['X'], carry)
      db.prepare(`DELETE FROM parents WHERE id = 'loser'`).run()
      db.prepare(`UPDATE parents SET code = 'X' WHERE id = 'winner'`).run()
      for (const afterDelete of carry.afterDelete) afterDelete()
    })()

    expect(carry.lostChildren).toBe(0)
    expect(carry.movedChildren).toBe(1)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE code = 'X'`).get()
    ).toEqual({ n: 1 })
  })
})
