/**
 * **列の値から相手を引ける索引だけを数える** —— ユニークキーの列挙の境目。
 *
 * 畳みは「この書き込みは、ローカルのどの行とぶつかるか」を索引から先に引いて決める。
 * ここで数える索引を増やしすぎると、**実際にはぶつからない行を相手だと思い込んで
 * 畳む**（＝生きている行を消す）。減らしすぎると、ぶつかる相手を取り逃がして
 * 畳めるはずの衝突が例外で抜ける。
 *
 * 部分索引と式索引は、列の値だけでは相手を引けないので**先に外す**。外した結果として
 * 残った違反は例外として呼び出し元へ抜ける（畳まずに投げる）——それが正しい諦め方で
 * ある、という線をここで固定する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import {
  findUniqueRivals,
  primaryKeyAsUniqueKey,
  readSecondaryUniqueKeys,
} from '../src/conflict/unique'

const testDir = path.join(__dirname, 'test-data-unique-index-shapes')

/** ファイルDBを作る（`:memory:` では他のテストと形を揃えづらいため、実ファイルで揃える） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true })
  return new Database(path.join(testDir, `${name}.sqlite`))
}

let db: Database.Database

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

afterEach(() => {
  if (db && db.open) db.close()
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('スキーマのUNIQUE宣言がそのまま宣言である', () => {
  it('`UNIQUE` 列と複合UNIQUEを、主キーは外して数える', () => {
    db = createDb('declared')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        code      TEXT NOT NULL UNIQUE,
        tenantId  TEXT NOT NULL,
        slug      TEXT NOT NULL,
        UNIQUE (tenantId, slug)
      )
    `)

    const uniqueKeys = readSecondaryUniqueKeys(db, 'items')

    // 主キーの衝突は同一行のLWWであって、別idの行を1つへ畳む話とは扱いが違う。
    // ここに混ぜると、同じidの行を「畳む相手」として扱い始める
    expect(uniqueKeys.map((key) => key.columns.map((c) => c.name))).toEqual(
      expect.arrayContaining([['code'], ['tenantId', 'slug']])
    )
    expect(uniqueKeys).toHaveLength(2)
  })

  it('主キーの組が要る場面では明示的に足す', () => {
    db = createDb('pk-as-key')
    db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, code TEXT)`)

    // `PRAGMA index_list` は rowid別名の主キーを索引として返さない。
    // 付け替えで行のidそのものが動く形では、動いた先のidを占めている行も
    // 相手なので、これを足さないと主キー違反がどの catch にも捕まらない
    expect(readSecondaryUniqueKeys(db, 'items')).toEqual([])
    expect(primaryKeyAsUniqueKey('id')).toEqual({
      columns: [{ name: 'id', collation: 'BINARY' }],
    })
  })

  it('ユニークでない索引は数えない', () => {
    db = createDb('non-unique')
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT);
      CREATE INDEX items_code ON items(code);
    `)

    // 数えると、値が同じだけの行（ぶつかってすらいない）を畳んで消す
    expect(readSecondaryUniqueKeys(db, 'items')).toEqual([])
  })

  it('索引が使っている照合順序まで引く', () => {
    db = createDb('collation')
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT);
      CREATE UNIQUE INDEX items_name ON items(name COLLATE NOCASE);
    `)

    const uniqueKeys = readSecondaryUniqueKeys(db, 'items')
    expect(uniqueKeys).toEqual([
      { columns: [{ name: 'name', collation: 'NOCASE' }] },
    ])

    // 列の既定照合順序で引くと相手を取り逃がす（`Tag` と `tag` はこの索引では衝突する）
    db.prepare(`INSERT INTO items VALUES ('a', 'Tag')`).run()
    const rivals = findUniqueRivals(
      db,
      'items',
      'id',
      { id: 'b', name: 'tag' },
      'b',
      uniqueKeys
    )
    expect(rivals.map((row) => row.id)).toEqual(['a'])
  })
})

describe('列の値から相手を引けない索引は、数える前に外す', () => {
  it('部分索引は外す（どの行が載っているかは述語を評価しないと分からない）', () => {
    db = createDb('partial')
    db.exec(`
      CREATE TABLE items (
        id      TEXT PRIMARY KEY,
        code    TEXT,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX items_code_live ON items(code) WHERE deleted = 0;
    `)

    expect(readSecondaryUniqueKeys(db, 'items')).toEqual([])

    // `deleted = 1` の行は索引に載っていないので、同じ `code` でもぶつからない。
    // 部分索引を数えていたら、この行を「相手」だと思い込んで畳んで消してしまう
    db.prepare(`INSERT INTO items VALUES ('a', 'X', 1)`).run()
    expect(
      findUniqueRivals(
        db,
        'items',
        'id',
        { id: 'b', code: 'X', deleted: 0 },
        'b',
        readSecondaryUniqueKeys(db, 'items')
      )
    ).toEqual([])
    // 実際に入る（ぶつからないので、畳む必要がそもそも無い）
    expect(() =>
      db.prepare(`INSERT INTO items VALUES ('b', 'X', 0)`).run()
    ).not.toThrow()
  })

  it('式索引は外す（引くべき値が列に無い）', () => {
    db = createDb('expression')
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE UNIQUE INDEX items_lower_name ON items(lower(name));
    `)

    // `PRAGMA index_xinfo` は式の列を名前 null で返す。列名が無いのだから
    // `WHERE <列> = ?` を組み立てられない
    expect(readSecondaryUniqueKeys(db, 'items')).toEqual([])

    db.prepare(`INSERT INTO items VALUES ('a', 'Tag')`).run()

    // 相手を特定できない（畳めない）ことを、握り潰さずに残す。呼び出し元は
    // 相手 0 件を見て例外をそのまま投げ、取り込みは巻き戻って次回やり直せる
    expect(
      findUniqueRivals(
        db,
        'items',
        'id',
        { id: 'b', name: 'tag' },
        'b',
        readSecondaryUniqueKeys(db, 'items')
      )
    ).toEqual([])
    // 実際の書き込みはこの索引で違反する（＝「ぶつからない」のではなく「引けない」）
    expect(() =>
      db.prepare(`INSERT INTO items VALUES ('b', 'tag')`).run()
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('式を含む複合UNIQUE索引も丸ごと外す', () => {
    db = createDb('expression-composite')
    db.exec(`
      CREATE TABLE items (
        id       TEXT PRIMARY KEY,
        tenantId TEXT NOT NULL,
        name     TEXT NOT NULL,
        code     TEXT NOT NULL UNIQUE
      );
      CREATE UNIQUE INDEX items_tenant_lower_name
        ON items(tenantId, lower(name));
    `)

    // 1本でも式の列があれば、そのキーでは相手を引けない。
    // 引ける列だけで引くと、実際にはぶつからない行まで相手に数えてしまう
    expect(readSecondaryUniqueKeys(db, 'items')).toEqual([
      { columns: [{ name: 'code', collation: 'BINARY' }] },
    ])
  })
})

describe('索引の並びが変わったら数え直す', () => {
  it('`CREATE INDEX` のあとは新しいユニークキーが見える', () => {
    db = createDb('cache-invalidation')
    db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT)`)

    expect(readSecondaryUniqueKeys(db, 'items')).toEqual([])

    db.exec(`CREATE UNIQUE INDEX items_code ON items(code)`)

    // キャッシュの寿命は `PRAGMA schema_version` が変わるまで。古い答えを
    // 返し続けると、新しいユニークの衝突を畳めないまま例外で抜ける
    expect(readSecondaryUniqueKeys(db, 'items')).toEqual([
      { columns: [{ name: 'code', collation: 'BINARY' }] },
    ])
  })
})

describe('NULL を含むキーでは相手を引かない', () => {
  it('SQLiteのUNIQUEはNULL同士を衝突させない', () => {
    db = createDb('null-key')
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT UNIQUE);
      INSERT INTO items VALUES ('a', NULL);
    `)

    // `code IS NULL` の行を相手に数えると、ぶつかっていない行を畳んで消す
    expect(
      findUniqueRivals(
        db,
        'items',
        'id',
        { id: 'b', code: null },
        'b',
        readSecondaryUniqueKeys(db, 'items')
      )
    ).toEqual([])
  })
})
