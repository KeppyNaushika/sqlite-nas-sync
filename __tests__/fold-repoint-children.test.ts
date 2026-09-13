/**
 * **付け替えられない子の扱い** —— `repointChildren` の、めったに通らない分かれ道。
 *
 * 畳みは「敗者を指している子を勝者へ付け替え、それから敗者行を消す」。だが
 * **主キー以外のユニーク列を指す外部キー**では、付け替え先が無い形が起こりうる
 * （勝者はまだその値を持っていない、あるいは NULL のまま）。そのときに何をするかで、
 * 子が黙って消えるかどうかが決まる。
 *
 * ここで確かめるのは3つ:
 *
 * - 敗者側の参照先が NULL なら、その参照で敗者を指している子は居ない（触らない）
 * - 勝者側の参照先が NULL で、しかも敗者を消すなら、**失われた数を数えて伝える**
 * - 畳みで解けない違反（`CHECK` やトリガーのような、ユニークでない制約）は
 *   握り潰さず呼び出し元へ抜ける
 *
 * 併せて、畳みの周りの「何もしないと決める」判断（`foldRowInto` の同一id、
 * `overwriteRow` の列なし）も固定する。どちらも**何もしないことを呼び出し元へ
 * 正しく伝える**のが役目で、間違えると行が消えたり同じ違反を投げ直したりする。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupChangelog } from '../src/setup'
import {
  foldRowInto,
  overwriteRow,
  repointChildren,
} from '../src/conflict/fold'
import { RecordFold, TableConfig } from '../src/types'

const testDir = path.join(__dirname, 'test-data-fold-repoint-children')

const TABLES: TableConfig[] = [{ name: 'parents' }, { name: 'notes' }]

/** ファイルDBを作る（畳みは `_changelog` / `_tombstone` へ書くので、実ファイルで揃える） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true })
  return new Database(path.join(testDir, `${name}.sqlite`))
}

/**
 * 「親のユニーク列（主キー以外）を子が指している」形を作る。
 *
 * この形でしか「付け替え先が無い」は起きない（主キーを指す外部キーでは、敗者と
 * 勝者で主キーが必ず違うので、参照先の値が同じ／NULL という分かれ道へ来ない）。
 */
function createCodeSchema(
  db: Database.Database,
  childDefinition: string
): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE parents (
      id        TEXT PRIMARY KEY,
      code      TEXT UNIQUE,
      updatedAt TEXT NOT NULL
    );
    ${childDefinition}
  `)
  setupChangelog(db, TABLES, 'id')
}

let db: Database.Database

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

afterEach(() => {
  if (db && db.open) db.close()
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('敗者側の参照先が NULL なら、その参照では何も起きない', () => {
  it('勝者を指している子を、敗者の子と取り違えない', () => {
    db = createDb('losing-null')
    createCodeSchema(
      db,
      `CREATE TABLE notes (
         id        TEXT PRIMARY KEY,
         code      TEXT REFERENCES parents(code) ON DELETE CASCADE,
         body      TEXT NOT NULL,
         updatedAt TEXT NOT NULL
       );`
    )
    db.exec(`
      INSERT INTO parents VALUES ('loser',  NULL, '2026-01-01T00:00:00.000Z');
      INSERT INTO parents VALUES ('winner', 'X',  '2026-02-01T00:00:00.000Z');
      INSERT INTO notes VALUES ('n1', 'X', 'a', '2026-01-01T00:00:00.000Z');
    `)

    const folds: RecordFold[] = []
    const carry = repointChildren(
      db,
      'parents',
      'id',
      { id: 'loser', code: null, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'winner', code: 'X', updatedAt: '2026-02-01T00:00:00.000Z' },
      'updatedAt',
      new Set<string>(),
      folds,
      true
    )

    // 敗者を指している子は居ないのだから、動いた子も失われた子も 0。
    // 勝者側の値で数えてしまうと、既に勝者の子である `n1` を
    // 「引き継いだ」と報告することになる（利用者から見れば数が合わない）
    expect(carry).toEqual({
      movedChildren: 0,
      lostChildren: 0,
      afterDelete: [],
    })
    expect(folds).toEqual([])
    expect(db.prepare(`SELECT code FROM notes WHERE id = 'n1'`).get()).toEqual({
      code: 'X',
    })
  })
})

describe('勝者側の参照先が NULL なら、付け替え先が無い', () => {
  const childDefinition = `CREATE TABLE notes (
       id        TEXT PRIMARY KEY,
       code      TEXT NOT NULL REFERENCES parents(code) ON DELETE CASCADE,
       body      TEXT NOT NULL,
       updatedAt TEXT NOT NULL
     );`

  function seed(): void {
    db.exec(`
      INSERT INTO parents VALUES ('loser',  'X',  '2026-01-01T00:00:00.000Z');
      INSERT INTO parents VALUES ('winner', NULL, '2026-02-01T00:00:00.000Z');
      INSERT INTO notes VALUES ('n1', 'X', 'a', '2026-01-01T00:00:00.000Z');
      INSERT INTO notes VALUES ('n2', 'X', 'b', '2026-01-01T00:00:00.000Z');
    `)
  }

  const losingRow = {
    id: 'loser',
    code: 'X',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const winningRow = {
    id: 'winner',
    code: null,
    updatedAt: '2026-02-01T00:00:00.000Z',
  }

  it('敗者を消すなら、失われた子の数を数えて伝える', () => {
    db = createDb('winning-null-delete')
    createCodeSchema(db, childDefinition)
    seed()

    const carry = repointChildren(
      db,
      'parents',
      'id',
      losingRow,
      winningRow,
      'updatedAt',
      new Set<string>(),
      [],
      true
    )

    // 数え上げは削除のあとでないと確定しない（`ON DELETE` が本当に及ぶかを
    // 憶測で決めず、前後で数えて差を取る）
    expect(carry.afterDelete).toHaveLength(1)
    expect(carry.lostChildren).toBe(0)

    db.prepare(`DELETE FROM parents WHERE id = 'loser'`).run()
    for (const afterDelete of carry.afterDelete) afterDelete()

    // 付け替え先が無いまま消したので、2行はカスケードで道連れになった。
    // 防げないが**黙って消させない**のがこの経路の役目
    expect(carry.lostChildren).toBe(2)
    expect(carry.movedChildren).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notes`).get()).toEqual({
      n: 0,
    })
  })

  it('敗者を消さない経路（idが動くだけ）では、子を数えも守りもしない', () => {
    db = createDb('winning-null-no-delete')
    createCodeSchema(db, childDefinition)
    seed()

    const carry = repointChildren(
      db,
      'parents',
      'id',
      losingRow,
      winningRow,
      'updatedAt',
      new Set<string>(),
      [],
      false
    )

    // この経路では行が消えない（1行のidが動くだけ）。ここで「失われた」を
    // 積むと、何も失われていないのに `lostChildren` が立つ
    expect(carry).toEqual({
      movedChildren: 0,
      lostChildren: 0,
      afterDelete: [],
    })
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE code = 'X'`).get()
    ).toEqual({ n: 2 })
  })
})

describe('畳みで解けない違反は握り潰さない', () => {
  it('ユニークでない制約（アプリのルール）に当たったら呼び出し元へ抜ける', () => {
    db = createDb('non-unique-violation')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE notes (
        id        TEXT PRIMARY KEY,
        parentId  TEXT REFERENCES parents(id) ON DELETE CASCADE,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `)
    setupChangelog(db, TABLES, 'id')
    db.exec(`
      INSERT INTO parents VALUES ('loser',  '2026-01-01T00:00:00.000Z');
      INSERT INTO parents VALUES ('winner', '2026-02-01T00:00:00.000Z');
      INSERT INTO notes VALUES ('n1', 'loser', 'a', '2026-01-01T00:00:00.000Z');
    `)
    // 利用者が張った業務ルール。畳みはこれを解けない（どちらの行を残しても
    // ルールに反する）ので、ユニーク衝突のように子どうしを畳んで済ませてはいけない
    db.exec(`
      CREATE TRIGGER notes_guard BEFORE UPDATE OF parentId ON notes
      FOR EACH ROW WHEN NEW.parentId = 'winner'
      BEGIN
        SELECT RAISE(ABORT, 'notes must not move to winner');
      END
    `)

    // 握り潰すと、付け替えたつもりで敗者を消し、子を道連れにする。
    // 抜けさせれば、その相手ぶんの取り込みだけが巻き戻って次回やり直せる
    expect(() =>
      repointChildren(
        db,
        'parents',
        'id',
        { id: 'loser', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'winner', updatedAt: '2026-02-01T00:00:00.000Z' },
        'updatedAt',
        new Set<string>(),
        [],
        true
      )
    ).toThrow(/notes must not move to winner/)

    // 子は敗者を指したまま（付け替えが半端に効いていない）
    expect(
      db.prepare(`SELECT parentId FROM notes WHERE id = 'n1'`).get()
    ).toEqual({
      parentId: 'loser',
    })
  })
})

describe('衝突相手を索引から引けないときは、握り潰さず投げる', () => {
  it('式で張られたユニーク索引の違反は、畳まずに呼び出し元へ抜ける', () => {
    db = createDb('expression-rival')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE notes (
        id        TEXT PRIMARY KEY,
        parentId  TEXT REFERENCES parents(id) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      );
      -- 「1つの親につき1行」を式索引で張っている形（大小を無視して1行だけ）。
      -- 列の値からは相手を引けないので、畳みの候補を数えられない
      CREATE UNIQUE INDEX notes_one_per_parent ON notes(lower(parentId));
    `)
    setupChangelog(db, TABLES, 'id')
    db.exec(`
      INSERT INTO parents VALUES ('loser',  '2026-01-01T00:00:00.000Z');
      INSERT INTO parents VALUES ('winner', '2026-02-01T00:00:00.000Z');
      INSERT INTO notes VALUES ('n1', 'loser',  '2026-01-01T00:00:00.000Z');
      INSERT INTO notes VALUES ('n2', 'winner', '2026-03-01T00:00:00.000Z');
    `)

    // 付け替えはユニーク違反になるが、相手（`n2`）を索引から特定できない。
    // ここで「相手0件だから畳めた」と扱うと、違反を握り潰したまま先へ進み、
    // 敗者行を消して子を道連れにする
    expect(() =>
      repointChildren(
        db,
        'parents',
        'id',
        { id: 'loser', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'winner', updatedAt: '2026-02-01T00:00:00.000Z' },
        'updatedAt',
        new Set<string>(),
        [],
        true
      )
    ).toThrow(/UNIQUE constraint failed/)

    // どちらの子も元のまま（半端に畳まれていない）
    expect(
      db.prepare(`SELECT id, parentId FROM notes ORDER BY id`).all()
    ).toEqual([
      { id: 'n1', parentId: 'loser' },
      { id: 'n2', parentId: 'winner' },
    ])
  })
})

describe('畳みが成り立たない組み合わせでは、何もせず「畳めなかった」と答える', () => {
  it('敗者idと勝者idが同じなら、行を消さず false を返す', () => {
    db = createDb('same-id')
    db.exec(`
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        code      TEXT UNIQUE,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE notes (
        id        TEXT PRIMARY KEY,
        code      TEXT,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `)
    setupChangelog(db, TABLES, 'id')
    db.exec(
      `INSERT INTO parents VALUES ('a', 'X', '2026-01-01T00:00:00.000Z');`
    )

    const folds: RecordFold[] = []
    const didFold = foldRowInto(
      db,
      'parents',
      'id',
      { id: 'a', code: 'X', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'a', code: 'X', updatedAt: '2026-02-01T00:00:00.000Z' },
      'updatedAt',
      new Set<string>(),
      folds,
      '2026-02-01T00:00:00.000Z'
    )

    // 畳みは「敗者idの行を消して勝者idへ寄せる」こと。同じidでは成り立たないので、
    // **消してはいけない**（消すと勝者もろとも行が失われる）。呼び出し元が
    // 「畳めたつもり」で先へ進まないよう false で伝える
    expect(didFold).toBe(false)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM parents`).get()).toEqual({
      n: 1,
    })
    expect(folds).toEqual([])
    // 帳簿にも「a は a へ畳まれた」という自己参照を残さない
    expect(db.prepare(`SELECT COUNT(*) AS n FROM _tombstone`).get()).toEqual({
      n: 0,
    })
  })

  it('主キー以外に列が無い表では、中身の上書きは何もしない', () => {
    db = createDb('pk-only')
    db.exec(`CREATE TABLE keys_only (id TEXT PRIMARY KEY)`)
    db.exec(`INSERT INTO keys_only VALUES ('a')`)

    // 上書きは `SET` 句を組み立てられない（列が無い）。組み立てを試みると
    // 構文エラーで落ち、その相手ぶんの取り込みが丸ごと巻き戻る
    expect(() => overwriteRow(db, 'keys_only', 'id', { id: 'a' })).not.toThrow()
    expect(db.prepare(`SELECT id FROM keys_only`).all()).toEqual([{ id: 'a' }])
  })
})
