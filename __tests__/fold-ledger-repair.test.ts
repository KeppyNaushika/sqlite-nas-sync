/**
 * 起動時の帳簿の手当て —— `_id_merge` に残った**鎖**と**循環**を畳み直す。
 *
 * 読み替えは1段しか辿らない前提で使われているので、鎖が残っていると遅れて届いた子が
 * **既に死んでいる中間の行**へ向けられて捨てられる。ここで見るのは、旧バージョンが
 * 残しえた形を `setupChangelog` の1回で畳み切れること、そしてその手当てが
 * `_tombstone` の側も置き去りにしないことである。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupChangelog } from '../src/setup'
import { lookupIdMerge, recordMerge } from '../src/conflict/ledger'
import { TableConfig } from '../src/types'

interface TombstoneRow {
  deletedAt: string
  mergedInto: string | null
}

const testDir = path.join(__dirname, 'test-data-fold-ledger-repair')

/** ファイルDBを作る（`:memory:` ではトリガーの検証がしづらいため、実ファイルで揃える） */
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

describe('循環へ流れ込む鎖も、起動1回で畳み切る', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }]

  it('D→A と A↔B が同居していても、D は生き残った終端を指す', () => {
    db = createDb('cycle')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    // 旧バージョンが残しえた形を直接書く（循環 A↔B と、そこへ流れ込む D→A）
    const insert = db.prepare(
      `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
       VALUES ('items', ?, ?, ?)`
    )
    // A→B の方が新しい主張なので、循環の刈り取りでは B→A が消えて A→B が残る。
    // つまり刈ったあとに `D→A→B` という鎖が生まれる（1回の走査では見えない形）
    insert.run('A', 'B', '2026-02-01T00:00:00.000Z')
    insert.run('B', 'A', '2026-01-01T00:00:00.000Z')
    insert.run('D', 'A', '2026-03-01T00:00:00.000Z')

    // 起動時の掃除は setupChangelog が呼ぶ（＝利用者は何もしない）
    setupChangelog(db, TABLES, 'id')

    const records = db
      .prepare(`SELECT losingId, winningId FROM _id_merge ORDER BY losingId`)
      .all() as { losingId: string; winningId: string }[]

    // 循環はいちばん新しい主張（A→B）だけが残る
    expect(records.find((r) => r.losingId === 'B')).toBeUndefined()
    expect(records.find((r) => r.losingId === 'A')?.winningId).toBe('B')
    // **D は既に畳まれた A ではなく、終端の B を指すこと。**
    // 1回の走査で止めると `D→A→B` の鎖が残り、D の子が死んだ A へ向けられて捨てられる
    expect(records.find((r) => r.losingId === 'D')?.winningId).toBe('B')

    // 読み替えは1段で終わる（終端がさらに畳まれていない）
    const terminal = lookupIdMerge(db, 'items', 'D')!.winningId
    expect(lookupIdMerge(db, 'items', terminal)).toBeNull()
  })
})

describe('鎖の畳み直しは `_tombstone.mergedInto` も連れて動く', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }]

  it('刈られた循環の tombstone は畳み先を名乗らなくなる', () => {
    db = createDb('cycle-tombstone')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    // 旧バージョンが残しえた形（循環 A↔B と、そこへ流れ込む D→A）を2つの帳簿へ直接書く
    const insertMerge = db.prepare(
      `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
       VALUES ('items', ?, ?, ?)`
    )
    const insertTombstone = db.prepare(
      `INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('items', ?, ?, ?)`
    )
    for (const [losingId, winningId, at] of [
      ['A', 'B', '2026-02-01T00:00:00.000Z'],
      ['B', 'A', '2026-01-01T00:00:00.000Z'],
      ['D', 'A', '2026-03-01T00:00:00.000Z'],
    ]) {
      insertMerge.run(losingId, winningId, at)
      insertTombstone.run(losingId, at, winningId)
    }

    // B の行は手元に**在る**（＝「消えた」という記録そのものが間違っている）
    db.prepare(
      `INSERT INTO items (id, updatedAt) VALUES ('B', '2026-04-01T00:00:00.000Z')`
    ).run()

    // 起動時の掃除は setupChangelog が呼ぶ
    setupChangelog(db, TABLES, 'id')

    const tombstoneOf = (recordId: string) =>
      db
        .prepare(
          `SELECT deletedAt, mergedInto FROM _tombstone
           WHERE tableName = 'items' AND recordId = ?`
        )
        .get(recordId) as TombstoneRow | undefined

    // 刈られた `B→A` の主張は、2つの帳簿の**どちらからも**消える。
    // `mergedInto` を NULL にして残すと、それは「B はただ消された」という主張に
    // なる。B の行は手元に在るのだから、その tombstone が同期で渡ると
    // 相手は B を畳まずに DELETE する（子も道連れ）。行ごと捨てる。
    expect(tombstoneOf('B')).toBeUndefined()
    // 張り替えた D は終端の B を指す（`_id_merge` と同じ向き）
    expect(tombstoneOf('D').mergedInto).toBe('B')
    // 時刻は動かさない
    expect(tombstoneOf('D').deletedAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('手元に行が無ければ、畳み先だけ外して「消えた」記録は残す', () => {
    db = createDb('cycle-tombstone-absent')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    // 循環 A↔B。刈り取りで残るのは新しい主張 A→B なので、B の記録が消える。
    // **B の行は手元に無い** ＝ その id は本当に消えている
    const insertMerge = db.prepare(
      `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
       VALUES ('items', ?, ?, ?)`
    )
    insertMerge.run('A', 'B', '2026-02-01T00:00:00.000Z')
    insertMerge.run('B', 'A', '2026-01-01T00:00:00.000Z')
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('items', 'B', '2026-01-01T00:00:00.000Z', 'A')`
    ).run()

    setupChangelog(db, TABLES, 'id')

    const tombstone = db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'B'`
      )
      .get() as TombstoneRow | undefined

    // 畳みの主張は捨てるが、**「消えた」という事実は残す**。行ごと消すと
    // `isShadowedByTombstone` が効かなくなり、相手の古い版がそのまま復活する
    expect(tombstone).toBeDefined()
    expect(tombstone!.mergedInto).toBeNull()
    expect(tombstone!.deletedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('循環の刈り取りは、時刻を「時刻として」比べる', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }]

  it('旧版のスペース形式と ISO-T 形式が混ざっても、新しい主張が残る', () => {
    db = createDb('cycle-mixed-format')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    // 循環 A↔B。**新しいのは `A→B`（10:00）** だが、そちらは旧版が書いた
    // スペース形式なので、字面で比べると ' '(0x20) < 'T'(0x54) で古い方が勝つ。
    // この掃除が相手にするのは旧版が残した記録そのものなので、混在は前提。
    const insertMerge = db.prepare(
      `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
       VALUES ('items', ?, ?, ?)`
    )
    insertMerge.run('A', 'B', '2026-06-01 10:00:00')
    insertMerge.run('B', 'A', '2026-06-01T09:00:00.000Z')

    setupChangelog(db, TABLES, 'id')

    const merges = db
      .prepare(`SELECT losingId, winningId FROM _id_merge ORDER BY losingId`)
      .all() as { losingId: string; winningId: string }[]
    // 残るのは新しい方の主張だけ（＝生き残るのは B）
    expect(merges).toEqual([{ losingId: 'A', winningId: 'B' }])
  })
})

describe('循環の刈り取りは、畳み先がずれていても主張を捨てる', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }]

  it('`_tombstone` が別の畳み先を名乗っていても、生き残る id の主張は残さない', () => {
    db = createDb('cycle-diverged-claim')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    // 循環 A↔B。刈り取りで残るのは新しい主張 B→A なので、A の記録が消える
    const insert = db.prepare(
      `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
       VALUES ('items', ?, ?, ?)`
    )
    insert.run('A', 'B', '2026-01-01T00:00:00.000Z')
    insert.run('B', 'A', '2026-02-01T00:00:00.000Z')

    // `_tombstone` 側は**別の畳み先**を名乗っている（2つの帳簿が既にずれた状態）
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('items', 'A', '2026-01-01T00:00:00.000Z', 'Z')`
    ).run()

    setupChangelog(db, TABLES, 'id')

    // A は循環で**生き残る**id。生きていると決めた以上、行き先が何であれ
    // 畳みの主張は矛盾する。畳み先の一致を条件にすると、ここだけ残って
    // 「引き先の `_id_merge` が無いのに畳まれたと主張する」状態になる。
    //
    // A の行は手元に無いので、捨てるのは**畳み先の主張だけ**（削除の事実は残る）
    const tombstone = db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as TombstoneRow | undefined
    expect(tombstone).toBeDefined()
    expect(tombstone!.mergedInto).toBeNull()
    expect(tombstone!.deletedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('利用者操作によるただの削除（畳み先なし）は触らない', () => {
    db = createDb('cycle-plain-delete')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    const insert = db.prepare(
      `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
       VALUES ('items', ?, ?, ?)`
    )
    insert.run('A', 'B', '2026-01-01T00:00:00.000Z')
    insert.run('B', 'A', '2026-02-01T00:00:00.000Z')
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('items', 'A', '2026-01-01T00:00:00.000Z', NULL)`
    ).run()

    setupChangelog(db, TABLES, 'id')

    const tombstone = db
      .prepare(
        `SELECT deletedAt FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as { deletedAt: string } | undefined
    expect(tombstone?.deletedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
