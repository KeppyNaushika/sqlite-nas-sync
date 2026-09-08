/**
 * **引き方**の回帰テスト —— どの列で、どの表を、どう照合して引くか。
 *
 * 複合外部キーの NULL 規則、表ごとに違う時刻列、表名の大小。どれも「引けなかった」
 * ことが例外ではなく**静かな取りこぼし**として現れるので、形で固定する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupChangelog } from '../src/setup'
import { applyInsert, applyUpdate } from '../src/conflict'
import { recordMerge } from '../src/conflict/ledger'
import { readTombstoneClaim } from '../src/conflict/tombstone'
import { TableConfig } from '../src/types'

const testDir = path.join(__dirname, 'test-data-conflict-fk-lookup')

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

describe('NULL を含む複合外部キーは検査されない（捨てない）', () => {
  const TABLES: TableConfig[] = [{ name: 'parents' }, { name: 'children' }]

  it('参照列の片方が NULL の子は、畳み先が消えていても採る', () => {
    db = createDb('composite-null')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE parents (
        id        TEXT NOT NULL,
        tenantId  TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (id, tenantId)
      );
      CREATE TABLE children (
        id        TEXT PRIMARY KEY,
        parentId  TEXT,
        tenantId  TEXT,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (parentId, tenantId) REFERENCES parents(id, tenantId)
      );
    `)
    setupChangelog(db, TABLES, 'id')

    // 親 A は既に B へ畳まれて消えており、その B もそのあと消えている
    // （＝読み替え先が「消えたと分かっている」状態。ここで `ON DELETE` の再現に入る）
    recordMerge(db, 'parents', 'A', 'B', '2026-01-01T00:00:00.000Z')
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('parents', 'B', '2026-01-15T00:00:00.000Z')`
    ).run()

    // 遅れて届いた子。参照列の片方が NULL なので、SQLite はこの外部キーを検査しない
    const result = applyInsert(
      db,
      'children',
      'id',
      {
        id: 'c1',
        parentId: 'A',
        tenantId: null,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      ['id', 'parentId', 'tenantId', 'updatedAt']
    )

    // SQLite ならそのまま通る行を、こちらが勝手に捨てないこと
    expect(result.action).toBe('inserted')
    expect(result.warnings).toEqual([])
    const row = db.prepare(`SELECT id FROM children WHERE id = 'c1'`).get()
    expect(row).toBeDefined()
  })
})

describe('親の表は、親の時刻列で引く', () => {
  const TABLES: TableConfig[] = [
    { name: 'parents', timestampColumn: 'modifiedAt' },
    { name: 'children' },
  ]

  it('親だけ時刻列が違っても、畳みの記録の有効性を判定できる', () => {
    db = createDb('per-table-timestamp')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE parents (
        id         TEXT PRIMARY KEY,
        modifiedAt TEXT NOT NULL
      );
      CREATE TABLE children (
        id        TEXT PRIMARY KEY,
        parentId  TEXT REFERENCES parents(id),
        updatedAt TEXT NOT NULL
      );
    `)
    setupChangelog(db, TABLES, 'id')

    // 親 A は B へ畳まれた（判断は 2026-01）。しかし A の行はそのあと 2026-06 に
    // 更新されている ＝ この畳みはもう古い判断であり、読み替えてはいけない
    db.prepare(
      `INSERT INTO parents (id, modifiedAt) VALUES ('A', '2026-06-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO parents (id, modifiedAt) VALUES ('B', '2026-01-01T00:00:00.000Z')`
    ).run()
    recordMerge(db, 'parents', 'A', 'B', '2026-01-01T00:00:00.000Z')

    const timestampColumnFor = (tableName: string): string =>
      tableName.toLowerCase() === 'parents' ? 'modifiedAt' : 'updatedAt'

    const result = applyInsert(
      db,
      'children',
      'id',
      {
        id: 'c1',
        parentId: 'A',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      ['id', 'parentId', 'updatedAt'],
      'updatedAt',
      undefined,
      timestampColumnFor
    )

    expect(result.action).toBe('inserted')
    // 子の列名（updatedAt）で親を引くと `modifiedAt` に辿り着けず、記録が
    // いつまでも有効に見えて A の子が B へ向けられてしまう
    const row = db
      .prepare(`SELECT parentId FROM children WHERE id = 'c1'`)
      .get() as { parentId: string }
    expect(row.parentId).toBe('A')
  })
})

describe('表名の綴り違いでも tombstone を引ける', () => {
  const TABLES: TableConfig[] = [{ name: 'Items' }]

  it('相手が `items`、こちらが `Items` でも、削除済みの行は復活しない', () => {
    db = createDb('collate-nocase')
    db.exec(`
      CREATE TABLE Items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    // トリガは設定どおりの `Items` で書く
    db.prepare(
      `INSERT INTO Items (id, updatedAt) VALUES ('A', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(`DELETE FROM Items WHERE id = 'A'`).run()

    // 届くエントリは**相手の設定どおりの綴り**（`items`）を持つ
    const result = applyInsert(
      db,
      'items',
      'id',
      { id: 'A', updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'updatedAt']
    )

    // 引きが外れると、削除済みの行がここで復活する
    expect(result.action).toBe('skipped')
    const rows = db.prepare(`SELECT id FROM Items`).all()
    expect(rows).toHaveLength(0)
  })
})

describe('表名の綴りが違う tombstone が2行あっても、新しい方を見る', () => {
  const TABLES: TableConfig[] = [{ name: 'Items' }]

  it('古い方を拾って削除を見落とさない', () => {
    db = createDb('tombstone-collation-order')
    db.exec(`
      CREATE TABLE Items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, TABLES, 'id')

    // 読みは `COLLATE NOCASE` だが、**書き込み側の主キーは BINARY で照合される**
    // （`ON CONFLICT(tableName, recordId)` もトリガも表名をそのまま入れる）ので、
    // 設定の綴りがリリースをまたいで変わると、綴り違いの2行が同時に載りうる
    const insert = db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES (?, 'A', ?, NULL)`
    )
    insert.run('items', '2020-01-01T00:00:00.000Z')
    insert.run('Items', '2026-06-01T00:00:00.000Z')

    // 走査順まかせだと古い方（2020年）を拾い、2021年の行を「削除より新しい」として
    // 通してしまう。時刻で並べて新しい方を採る
    const result = applyInsert(
      db,
      'Items',
      'id',
      { id: 'A', updatedAt: '2021-01-01T00:00:00.000Z' },
      ['id', 'updatedAt']
    )
    expect(result.action).toBe('skipped')
    expect(db.prepare(`SELECT id FROM Items`).all()).toHaveLength(0)
  })
})

describe('親の列を明示した外部キーでも、綴りが違えば読み替える', () => {
  const TABLES: TableConfig[] = [{ name: 'parents' }, { name: 'kids' }]

  it('`REFERENCES parents(ID)` と設定の `id` を、字面で突き合わせない', () => {
    db = createDb('fk-parent-column-case')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE kids (
        id        TEXT PRIMARY KEY,
        parentId  TEXT REFERENCES parents(ID),
        updatedAt TEXT NOT NULL
      );
    `)
    setupChangelog(db, TABLES, 'id')

    // 親 A は B へ畳まれている（B は手元に在る）
    db.prepare(
      `INSERT INTO parents (id, updatedAt) VALUES ('B', '2026-01-01T00:00:00.000Z')`
    ).run()
    recordMerge(db, 'parents', 'A', 'B', '2026-01-01T00:00:00.000Z')

    // `PRAGMA foreign_key_list` は `REFERENCES` 句の綴り（`ID`）をそのまま返す。
    // 字面で比べると読み替えが**一度も走らず**、存在しない A を指したまま入って
    // 外部キー違反になり、その相手ぶんの取り込みが丸ごと巻き戻る
    const result = applyInsert(
      db,
      'kids',
      'id',
      { id: 'k1', parentId: 'A', updatedAt: '2026-02-01T00:00:00.000Z' },
      ['id', 'parentId', 'updatedAt']
    )
    expect(result.action).toBe('inserted')
    const kid = db
      .prepare(`SELECT parentId FROM kids WHERE id = 'k1'`)
      .get() as { parentId: string }
    expect(kid.parentId).toBe('B')
  })
})

describe('設定の綴りが表の宣言と違っても、レコードから値を引ける', () => {
  it('`timestampColumn: "updatedat"` でも、届いた更新を捨てない', () => {
    // SQL は大小を区別しないので `WHERE` もトリガも動くが、`SELECT *` が返す
    // オブジェクトの**キーは表が宣言したとおりの綴り**。設定の綴りでキーを引くと
    // `undefined` になり、両辺が空文字になって LWW の比較が常に偽 ——
    // **届いた更新が全部黙って捨てられ、カーソルだけ進む**（例外にならない）。
    db = createDb('record-key-timestamp-case')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        note      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, [{ name: 'items', timestampColumn: 'updatedat' }], 'id')
    db.prepare(
      `INSERT INTO items VALUES ('A', 'local', '2026-01-01T00:00:00.000Z')`
    ).run()

    const result = applyUpdate(
      db,
      'items',
      'id',
      { id: 'A', note: 'remote', updatedAt: '2026-06-01T00:00:00.000Z' },
      ['id', 'note', 'updatedAt'],
      'updatedat'
    )

    expect(result.action).toBe('updated')
    const row = db.prepare(`SELECT note FROM items WHERE id = 'A'`).get() as {
      note: string
    }
    expect(row.note).toBe('remote')
  })

  it('`primaryKey: "ID"` でも例外にならない', () => {
    // 主キーを取り逃がすと `.get(undefined)` が better-sqlite3 で例外になり、
    // その相手ぶんの取り込みが丸ごと巻き戻る
    db = createDb('record-key-pk-case')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, [{ name: 'items' }], 'ID')
    db.prepare(
      `INSERT INTO items VALUES ('A', '2026-01-01T00:00:00.000Z')`
    ).run()

    const result = applyUpdate(
      db,
      'items',
      'ID',
      { id: 'A', updatedAt: '2026-06-01T00:00:00.000Z' },
      ['id', 'updatedAt']
    )
    expect(result.action).toBe('updated')
  })
})

describe('綴り違いの tombstone は、1行を選ばず合成して読む', () => {
  it('畳み先を持たない新しい行が、畳み先を持つ行を隠さない', () => {
    // 同期経路が相手の綴りで書いた `('Items', L, mergedInto: W, 1月)` と、
    // ローカルの DELETE トリガが `INSERT OR REPLACE` で書いた
    // `('items', L, mergedInto: NULL, 6月)` が並ぶ。「新しい方の行」を丸ごと採ると
    // 畳み先を持たない方が返り、受け取った側は畳まずに DELETE して子を道連れにする。
    db = createDb('tombstone-coalesce')
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, [{ name: 'items' }], 'id')

    const insert = db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES (?, 'L', ?, ?)`
    )
    insert.run('Items', '2026-01-01T00:00:00.000Z', 'W')
    insert.run('items', '2026-06-01T00:00:00.000Z', null)

    const claim = readTombstoneClaim(db, 'items', 'L')
    // 削除時刻はいちばん新しいもの、畳み先は主張されている中でいちばん新しいもの
    expect(claim?.deletedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(claim?.mergedInto).toBe('W')
  })
})
