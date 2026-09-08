/**
 * ユニーク衝突の相手を**索引から先に全部引く**という設計と、畳みで子を失わないこと。
 *
 * 1本ずつ畳んで確かめる形だと「先に見えた相手を畳んでから次の相手に負け、書き込みは
 * 拒まれたのに畳んだ行だけが消えたまま」という穴が開く。ここではその穴が
 * **そもそも開かない**ことを、ユニークが複数本ある表で固定する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyInsert, applyUpdate } from '../src/conflict'
import { setupChangelog } from '../src/setup'

let db: Database.Database
const columns = ['id', 'name', 'email', 'updatedAt']

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      updatedAt TEXT NOT NULL
    )
  `)
})

afterEach(() => {
  db.close()
})

describe('ユニークを索引から先に数える', () => {
  const accountColumns = ['id', 'username', 'email', 'updatedAt']

  interface AccountRow {
    id: string
    username: string
    email: string
  }

  interface MergeRow {
    losingId: string
    winningId: string
  }

  /** ユニークが2本ある表（`User(username UNIQUE, email UNIQUE)` の形） */
  function createAccounts(): void {
    db.exec(`
      CREATE TABLE accounts (
        id        TEXT PRIMARY KEY,
        username  TEXT NOT NULL UNIQUE,
        email     TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
  }

  function insertAccount(
    id: string,
    username: string,
    email: string,
    updatedAt: string
  ): void {
    db.prepare(
      `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run(id, username, email, updatedAt)
  }

  function accountRows(): AccountRow[] {
    return db
      .prepare(`SELECT id, username, email FROM accounts ORDER BY id`)
      .all() as AccountRow[]
  }

  /** `_id_merge` の中身。畳みが一度も起きていなければテーブルごと無い */
  function idMergeRows(): MergeRow[] {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get('_id_merge')
    if (!exists) return []
    return db
      .prepare(`SELECT losingId, winningId FROM _id_merge ORDER BY losingId`)
      .all() as MergeRow[]
  }

  it('作成が2本目のユニークで拒まれる場合、1本目の相手は巻き添えにならない', () => {
    // これが塞ぎたかった穴そのもの。SQLiteが最初に告げるのは email の違反なので、
    // エラー文からしか相手を知れないうちは「先に r1 を畳んでから r2 に負ける」になる。
    createAccounts()
    // email でぶつかる古い相手（届いた行が勝つ側）
    insertAccount('r1', 'name1', 'mailX', '2024-01-01T00:00:00Z')
    // username でぶつかる新しい相手（届いた行が負ける側）
    insertAccount('r2', 'nameX', 'mail2', '2024-12-01T00:00:00Z')

    const result = applyInsert(
      db,
      'accounts',
      'id',
      {
        id: 'r0',
        username: 'nameX',
        email: 'mailX',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      accountColumns
    )

    expect(result.action).toBe('skipped')
    expect(result.conflict?.resolution).toBe('local_wins')
    expect(result.conflict?.recordId).toBe('r2')

    // 拒むと決めたのだから、1本目で見えた r1 は一行も動いていないこと
    expect(accountRows()).toEqual([
      { id: 'r1', username: 'name1', email: 'mailX' },
      { id: 'r2', username: 'nameX', email: 'mail2' },
    ])
    expect(idMergeRows()).toEqual([{ losingId: 'r0', winningId: 'r2' }])
    expect(result.folds).toEqual([
      {
        tableName: 'accounts',
        losingId: 'r0',
        winningId: 'r2',
        removedLocalRow: false,
        // ローカルに敗者行が無いので、付け替える子も居ない
        movedChildren: 0,
        lostChildren: 0,
      },
    ])
  })

  it('作成が相手全員に勝つ場合、索引ごとの相手をまとめて1行へ畳む', () => {
    createAccounts()
    insertAccount('r1', 'name1', 'mailX', '2024-01-01T00:00:00Z')
    insertAccount('r2', 'nameX', 'mail2', '2024-02-01T00:00:00Z')

    const result = applyInsert(
      db,
      'accounts',
      'id',
      {
        id: 'r0',
        username: 'nameX',
        email: 'mailX',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      accountColumns
    )

    expect(result.action).toBe('upserted')
    expect(result.conflict?.resolution).toBe('remote_wins')
    expect(accountRows()).toEqual([
      { id: 'r0', username: 'nameX', email: 'mailX' },
    ])
    expect(idMergeRows()).toEqual([
      { losingId: 'r1', winningId: 'r0' },
      { losingId: 'r2', winningId: 'r0' },
    ])
    expect(
      [...result.folds].sort((a, b) => a.losingId.localeCompare(b.losingId))
    ).toEqual([
      {
        tableName: 'accounts',
        losingId: 'r1',
        winningId: 'r0',
        removedLocalRow: true,
        movedChildren: 0,
        lostChildren: 0,
      },
      {
        tableName: 'accounts',
        losingId: 'r2',
        winningId: 'r0',
        removedLocalRow: true,
        movedChildren: 0,
        lostChildren: 0,
      },
    ])
  })

  it('更新が相手全員に勝つ場合も、索引ごとの相手をまとめて1行へ畳む', () => {
    createAccounts()
    insertAccount('r0', 'name0', 'mail0', '2024-05-01T00:00:00Z')
    insertAccount('r1', 'name1', 'mailX', '2024-01-01T00:00:00Z')
    insertAccount('r2', 'nameX', 'mail2', '2024-02-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'accounts',
      'id',
      {
        id: 'r0',
        username: 'nameX',
        email: 'mailX',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      accountColumns
    )

    expect(result.action).toBe('updated')
    expect(result.conflict?.resolution).toBe('remote_wins')
    expect(accountRows()).toEqual([
      { id: 'r0', username: 'nameX', email: 'mailX' },
    ])
    expect(idMergeRows()).toEqual([
      { losingId: 'r1', winningId: 'r0' },
      { losingId: 'r2', winningId: 'r0' },
    ])
  })

  it('照合順序つきのユニーク索引でも相手を引ける', () => {
    // `name COLLATE NOCASE` で張られたユニーク。エラー文は列名 `labels.name` しか
    // 告げないので、列の既定の照合順序（BINARY）で引くと相手を取り逃がす。
    db.exec(`
      CREATE TABLE labels (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(
      `CREATE UNIQUE INDEX labels_name_nocase ON labels(name COLLATE NOCASE)`
    )
    db.prepare(`INSERT INTO labels (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'l1',
      'Alpha',
      '2024-01-01T00:00:00Z'
    )

    const result = applyInsert(
      db,
      'labels',
      'id',
      { id: 'l2', name: 'alpha', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'name', 'updatedAt']
    )

    expect(result.action).toBe('upserted')
    expect(result.conflict?.resolution).toBe('remote_wins')
    expect(db.prepare(`SELECT id, name FROM labels`).all()).toEqual([
      { id: 'l2', name: 'alpha' },
    ])
    expect(idMergeRows()).toEqual([{ losingId: 'l1', winningId: 'l2' }])
  })

  it('主キー由来の索引をセカンダリUNIQUEと取り違えない', () => {
    // 主キーの衝突は同一行のLWW。別idを1行へ畳む話ではないので、畳みの記録は生まれない。
    createAccounts()
    insertAccount('r0', 'name0', 'mail0', '2024-01-01T00:00:00Z')

    const result = applyInsert(
      db,
      'accounts',
      'id',
      {
        id: 'r0',
        username: 'name0b',
        email: 'mail0b',
        updatedAt: '2024-06-01T00:00:00Z',
      },
      accountColumns
    )

    expect(result.action).toBe('upserted')
    expect(result.conflict?.resolution).toBe('remote_wins')
    expect(result.folds).toEqual([])
    expect(idMergeRows()).toEqual([])
    expect(accountRows()).toEqual([
      { id: 'r0', username: 'name0b', email: 'mail0b' },
    ])
  })

  it('部分索引のユニークは畳まない（相手を先に数えられないため投げる）', () => {
    // `WHERE` 付きの索引は、どの行が索引に載っているかを述語まで見ないと決められない。
    // 列の値だけで引くと、実際にはぶつからない行を相手だと思い込んで畳んでしまう。
    // 数えられないものは畳まず、違反をそのまま呼び出し元へ渡す。
    db.exec(`
      CREATE TABLE slots (
        id        TEXT PRIMARY KEY,
        seat      INTEGER NOT NULL,
        active    INTEGER NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(
      `CREATE UNIQUE INDEX slots_active_seat ON slots(seat) WHERE active = 1`
    )
    const slotColumns = ['id', 'seat', 'active', 'updatedAt']
    const insertSlot = db.prepare(
      `INSERT INTO slots (id, seat, active, updatedAt) VALUES (?, ?, ?, ?)`
    )
    // 索引に載っていない行（active = 0）。座席は同じだが、これは相手ではない。
    insertSlot.run('s0', 1, 0, '2024-01-01T00:00:00Z')
    insertSlot.run('s1', 1, 1, '2024-06-01T00:00:00Z')

    expect(() =>
      applyInsert(
        db,
        'slots',
        'id',
        { id: 's2', seat: 1, active: 1, updatedAt: '2024-03-01T00:00:00Z' },
        slotColumns
      )
    ).toThrow(/UNIQUE constraint failed/)

    // 何も畳んでいないこと（索引に載っていない s0 を巻き添えにしない）
    expect(db.prepare(`SELECT id FROM slots ORDER BY id`).all()).toEqual([
      { id: 's0' },
      { id: 's1' },
    ])
    expect(idMergeRows()).toEqual([])
  })
})

describe('畳みで子を失わない', () => {
  interface ProfileRow {
    id: string
    updatedAt: string
  }

  interface ChildRow {
    id: string
    pcode: string | null
  }

  /** 外部キーが子の主キーを兼ねる 1:1（親の id を共有する表） */
  function createSharedIdSchema(): void {
    db.exec(`
      CREATE TABLE owners (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE profile (
        id        TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      )
    `)
  }

  function insertOwner(id: string, name: string, updatedAt: string): void {
    db.prepare(`INSERT INTO owners (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      id,
      name,
      updatedAt
    )
  }

  function insertProfile(id: string, updatedAt: string): void {
    db.prepare(`INSERT INTO profile (id, updatedAt) VALUES (?, ?)`).run(
      id,
      updatedAt
    )
  }

  function profileRows(): ProfileRow[] {
    return db
      .prepare(`SELECT id, updatedAt FROM profile ORDER BY id`)
      .all() as ProfileRow[]
  }

  it('子の外部キーが子の主キーを兼ねていて、動かす側の子が新しくても投げない', () => {
    // 親 o1 が o2 へ畳まれると、profile o1 は id を o2 へ動かすことになる。
    // その席には profile o2 が既に居るので、席の先客は「畳む相手」にできない
    // （敗者idと勝者idが同じになり foldRowInto が何もせず戻る）。
    createSharedIdSchema()
    insertOwner('o1', 'A', '2024-01-01T00:00:00Z')
    insertOwner('o2', 'B', '2024-02-01T00:00:00Z')
    insertProfile('o1', '2024-09-01T00:00:00Z')
    insertProfile('o2', '2024-03-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'owners',
      'id',
      { id: 'o2', name: 'A', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'name', 'updatedAt']
    )

    expect(result.action).toBe('updated')
    expect(db.prepare(`SELECT id, name FROM owners ORDER BY id`).all()).toEqual(
      [{ id: 'o2', name: 'A' }]
    )
    // 席は1つしか無いので子も1行。新しい方（profile o1）の中身が残る
    expect(profileRows()).toEqual([
      { id: 'o2', updatedAt: '2024-09-01T00:00:00Z' },
    ])
    expect(
      result.folds.map(
        (fold) => `${fold.tableName}:${fold.losingId}->${fold.winningId}`
      )
    ).toEqual(['profile:o1->o2', 'owners:o1->o2'])
  })

  it('席の先客の方が新しければ、先客の中身が残る（鏡像）', () => {
    createSharedIdSchema()
    insertOwner('o1', 'A', '2024-01-01T00:00:00Z')
    insertOwner('o2', 'B', '2024-02-01T00:00:00Z')
    insertProfile('o1', '2024-03-01T00:00:00Z')
    insertProfile('o2', '2024-09-01T00:00:00Z')

    applyUpdate(
      db,
      'owners',
      'id',
      { id: 'o2', name: 'A', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'name', 'updatedAt']
    )

    expect(profileRows()).toEqual([
      { id: 'o2', updatedAt: '2024-09-01T00:00:00Z' },
    ])
  })

  it('主キー以外のユニーク列を指す子は、敗者の削除で道連れにならない', () => {
    // 子は親の `code` を値で握っている。勝者はまだその値を持っていない
    // （書き込みは畳みの後に走る）ので「もう勝者を指している」とは言えない。
    // 敗者を消せば ON DELETE CASCADE が子に及ぶ
    // （defer_foreign_keys が遅らせるのは検査であって動作ではない）。
    db.exec(`
      CREATE TABLE codeOwners (
        id        TEXT PRIMARY KEY,
        code      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE codeChildren (
        id        TEXT PRIMARY KEY,
        pcode     TEXT REFERENCES codeOwners(code) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      )
    `)
    const insertCodeOwner = db.prepare(
      `INSERT INTO codeOwners (id, code, updatedAt) VALUES (?, ?, ?)`
    )
    insertCodeOwner.run('p0', 'c0', '2024-01-01T00:00:00Z')
    insertCodeOwner.run('p1', 'cX', '2024-02-01T00:00:00Z')
    db.prepare(
      `INSERT INTO codeChildren (id, pcode, updatedAt) VALUES (?, ?, ?)`
    ).run('k1', 'cX', '2024-01-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'codeOwners',
      'id',
      { id: 'p0', code: 'cX', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'code', 'updatedAt']
    )

    expect(result.action).toBe('updated')
    expect(
      db.prepare(`SELECT id, code FROM codeOwners ORDER BY id`).all()
    ).toEqual([{ id: 'p0', code: 'cX' }])

    // 子は勝者（p0）へ引き継がれること
    expect(
      db.prepare(`SELECT id, pcode FROM codeChildren ORDER BY id`).all()
    ).toEqual<ChildRow[]>([{ id: 'k1', pcode: 'cX' }])

    // 引き継いだ子の数が呼び出し元へ伝わること（0 のまま黙らない）
    expect(result.folds).toHaveLength(1)
    expect(result.folds[0].losingId).toBe('p1')
    expect(result.folds[0].winningId).toBe('p0')
    expect(result.folds[0].movedChildren).toBe(1)
    expect(result.folds[0].lostChildren).toBe(0)
  })

  it('参照列が NOT NULL で子を外せない場合は、失った数を数えて伝える', () => {
    // 参照列を一旦 NULL にして敗者から外す手が使えない形。子は
    // ON DELETE CASCADE で消えるが、**消えたことを黙らない**。
    db.exec(`
      CREATE TABLE codeOwners (
        id        TEXT PRIMARY KEY,
        code      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE codeChildren (
        id        TEXT PRIMARY KEY,
        pcode     TEXT NOT NULL REFERENCES codeOwners(code) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      )
    `)
    const insertCodeOwner = db.prepare(
      `INSERT INTO codeOwners (id, code, updatedAt) VALUES (?, ?, ?)`
    )
    insertCodeOwner.run('p0', 'c0', '2024-01-01T00:00:00Z')
    insertCodeOwner.run('p1', 'cX', '2024-02-01T00:00:00Z')
    const insertCodeChild = db.prepare(
      `INSERT INTO codeChildren (id, pcode, updatedAt) VALUES (?, ?, ?)`
    )
    insertCodeChild.run('k1', 'cX', '2024-01-01T00:00:00Z')
    insertCodeChild.run('k2', 'cX', '2024-01-01T00:00:00Z')

    const result = applyUpdate(
      db,
      'codeOwners',
      'id',
      { id: 'p0', code: 'cX', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'code', 'updatedAt']
    )

    expect(result.folds).toHaveLength(1)
    expect(result.folds[0].movedChildren).toBe(0)
    expect(result.folds[0].lostChildren).toBe(2)
  })

  it('値で繋がった子を守ったとき、その子は削除として他クライアントへ伝わらない', () => {
    // 一旦 NULL にして戻すだけなので、子に DELETE トリガーは掛からない。
    // 掛かると tombstone が載り、他のクライアントでもその子が消える。
    db.exec(`
      CREATE TABLE codeOwners (
        id        TEXT PRIMARY KEY,
        code      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE codeChildren (
        id        TEXT PRIMARY KEY,
        pcode     TEXT REFERENCES codeOwners(code) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, [{ name: 'codeOwners' }, { name: 'codeChildren' }], 'id')
    const insertCodeOwner = db.prepare(
      `INSERT INTO codeOwners (id, code, updatedAt) VALUES (?, ?, ?)`
    )
    insertCodeOwner.run('p0', 'c0', '2024-01-01T00:00:00Z')
    insertCodeOwner.run('p1', 'cX', '2024-02-01T00:00:00Z')
    db.prepare(
      `INSERT INTO codeChildren (id, pcode, updatedAt) VALUES (?, ?, ?)`
    ).run('k1', 'cX', '2024-01-01T00:00:00Z')

    applyUpdate(
      db,
      'codeOwners',
      'id',
      { id: 'p0', code: 'cX', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'code', 'updatedAt']
    )

    expect(db.prepare(`SELECT id, pcode FROM codeChildren`).all()).toEqual([
      { id: 'k1', pcode: 'cX' },
    ])
    // 畳まれた親には tombstone が載り、守った子には載らないこと
    expect(
      db
        .prepare(
          `SELECT tableName, recordId, mergedInto FROM _tombstone ORDER BY tableName`
        )
        .all()
    ).toEqual([{ tableName: 'codeOwners', recordId: 'p1', mergedInto: 'p0' }])
  })

  it('席へ移す中身がその表のユニークを持っていても、順序でぶつからない', () => {
    // 席の行へ中身を移すとき、明け渡す側の行がまだ在ると、その行が握っている
    // ユニークな値（slug）と衝突する。中身を移すのは明け渡す側を畳んだあと。
    db.exec(`
      CREATE TABLE owners (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE slugProfiles (
        id        TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
        slug      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    insertOwner('o1', 'A', '2024-01-01T00:00:00Z')
    insertOwner('o2', 'B', '2024-02-01T00:00:00Z')
    const insertSlugProfile = db.prepare(
      `INSERT INTO slugProfiles (id, slug, updatedAt) VALUES (?, ?, ?)`
    )
    insertSlugProfile.run('o1', 'alpha', '2024-09-01T00:00:00Z')
    insertSlugProfile.run('o2', 'beta', '2024-03-01T00:00:00Z')

    applyUpdate(
      db,
      'owners',
      'id',
      { id: 'o2', name: 'A', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'name', 'updatedAt']
    )

    expect(
      db.prepare(`SELECT id, slug FROM slugProfiles ORDER BY id`).all()
    ).toEqual([{ id: 'o2', slug: 'alpha' }])
  })

  it('席を明け渡す側の孫も、席に残る側の孫も、どちらも残る', () => {
    createSharedIdSchema()
    db.exec(`
      CREATE TABLE profileNotes (
        id        TEXT PRIMARY KEY,
        profileId TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      )
    `)
    insertOwner('o1', 'A', '2024-01-01T00:00:00Z')
    insertOwner('o2', 'B', '2024-02-01T00:00:00Z')
    insertProfile('o1', '2024-09-01T00:00:00Z')
    insertProfile('o2', '2024-03-01T00:00:00Z')
    const insertNote = db.prepare(
      `INSERT INTO profileNotes (id, profileId, updatedAt) VALUES (?, ?, ?)`
    )
    insertNote.run('n1', 'o1', '2024-01-01T00:00:00Z')
    insertNote.run('n2', 'o2', '2024-01-01T00:00:00Z')

    applyUpdate(
      db,
      'owners',
      'id',
      { id: 'o2', name: 'A', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'name', 'updatedAt']
    )

    expect(
      db.prepare(`SELECT id, profileId FROM profileNotes ORDER BY id`).all()
    ).toEqual([
      { id: 'n1', profileId: 'o2' },
      { id: 'n2', profileId: 'o2' },
    ])
  })

  it('子のidが動くだけの経路では、値で繋がった孫を外さない', () => {
    // 敗者行の DELETE が無い経路（1行のidが動くだけ）。ここで子を
    // 「削除から守る」細工をすると、外したまま戻す機会が無く NULL が残る。
    createSharedIdSchema()
    db.exec(`
      CREATE TABLE profileSlugNotes (
        id        TEXT PRIMARY KEY,
        slug      TEXT REFERENCES profileSlugs(slug) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE profileSlugs (
        id        TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
        slug      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `)
    insertOwner('o1', 'A', '2024-01-01T00:00:00Z')
    insertOwner('o2', 'B', '2024-02-01T00:00:00Z')
    db.prepare(
      `INSERT INTO profileSlugs (id, slug, updatedAt) VALUES (?, ?, ?)`
    ).run('o1', 'alpha', '2024-01-01T00:00:00Z')
    db.prepare(
      `INSERT INTO profileSlugNotes (id, slug, updatedAt) VALUES (?, ?, ?)`
    ).run('n1', 'alpha', '2024-01-01T00:00:00Z')

    applyUpdate(
      db,
      'owners',
      'id',
      { id: 'o2', name: 'A', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'name', 'updatedAt']
    )

    // 子（profileSlugs）は id が o1 → o2 へ動くだけ。孫の参照は無傷であること
    expect(db.prepare(`SELECT id, slug FROM profileSlugs`).all()).toEqual([
      { id: 'o2', slug: 'alpha' },
    ])
    expect(db.prepare(`SELECT id, slug FROM profileSlugNotes`).all()).toEqual([
      { id: 'n1', slug: 'alpha' },
    ])
  })
})
