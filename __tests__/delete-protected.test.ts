/**
 * `TableConfig.deleteProtected` が案A で効くことを押さえる。
 *
 * 決めごとは1つだけ:
 *
 * > `deleteProtected` の表では、削除の版は**表示の計算で勝たない**。
 * > 行の版がある限り、その行は置かれる。
 *
 * 大事なのは「削除の版を捨てない」ことである。取り込みは削除の版が勝っても
 * `_sns_rows_<表>` の行を消さずに残し、見え方の計算（`src/rows/derive.ts`）だけが
 * 削除の版を見ない。こうしておくと**設定を外したときに削除が効く** —— 消して
 * しまうと、外しても戻すものが無い。
 *
 * この設定は**全端末で同じである前提**（前提 P4）。食い違いは見送りではなく
 * 警告で知らせる（見送ると、設定を直すための版すら届かなくなる）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { TableConfig } from '../src/types'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-delete-protected')

/** `users` だけ守る。`posts` は今までどおり削除が効く対照。 */
const PROTECTED: TableConfig[] = TABLES.map((table) =>
  table.name === 'users' ? { ...table, deleteProtected: true } : table
)

type Client = { id: string; db: Database.Database; dbPath: string }

let a: Client
let b: Client

function open(id: string): Client {
  const { db, dbPath } = fixture.createClientDb(id)
  return { id, db, dbPath }
}

async function sync(
  client: Client,
  tables: TableConfig[] = PROTECTED
): Promise<string[]> {
  const result = await performSync(
    client.db,
    fixture.makeConfig(client.dbPath, client.id),
    tables
  )
  // 本物の失敗は握りつぶされて警告になるので、必ず見る
  expect(
    result.warnings.filter((warning) => warning.startsWith('Sync failed'))
  ).toEqual([])
  return result.warnings
}

function userNames(db: Database.Database): { id: string; name: string }[] {
  return db.prepare(`SELECT id, name FROM users ORDER BY id`).all() as {
    id: string
    name: string
  }[]
}

function postIds(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT id FROM posts ORDER BY id`).all() as { id: string }[]
  ).map((row) => row.id)
}

beforeEach(() => {
  fixture.prepare()
  a = open('client-a')
  b = open('client-b')
})

afterEach(() => {
  a.db.close()
  b.db.close()
  fixture.cleanup()
})

/** A が `u1` と `p1` を作り、B まで行き渡らせる。 */
async function arrange(): Promise<void> {
  a.db
    .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
    .run('u1', 'first', '2026-01-01T00:00:00.000Z')
  a.db
    .prepare(
      `INSERT INTO posts (id, title, userId, updatedAt) VALUES (?, ?, ?, ?)`
    )
    .run('p1', 'hello', 'u1', '2026-01-01T00:00:00.000Z')
  await sync(a)
  await sync(b)
  expect(userNames(b.db)).toEqual([{ id: 'u1', name: 'first' }])
  expect(postIds(b.db)).toEqual(['p1'])
}

describe('deleteProtected（案A）', () => {
  it('他端末の削除が届いても、守られた表の行は残る', async () => {
    await arrange()

    b.db.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await sync(b)
    await sync(a)

    // A は墓標を受け取ったが、行の版が残っているので行も残る
    expect(userNames(a.db)).toEqual([{ id: 'u1', name: 'first' }])
    // 墓標そのものは捨てていない（設定を外したときに効かせるため）
    expect(
      a.db
        .prepare(
          `SELECT COUNT(*) AS n FROM _tombstone
            WHERE tableName = 'users' AND recordId = 'u1'`
        )
        .get()
    ).toEqual({ n: 1 })
  })

  it('消した側も、行の版を持っている端末から取り戻して一致する', async () => {
    await arrange()

    b.db.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await sync(b)
    // 消した直後の B には行の版が無い（自分の DELETE は自分の表から消える）
    expect(userNames(b.db)).toEqual([])

    await sync(a)
    await sync(b)

    // A が持っている行の版が B へ戻り、両端末の見え方が一致する
    expect(userNames(a.db)).toEqual([{ id: 'u1', name: 'first' }])
    expect(userNames(b.db)).toEqual([{ id: 'u1', name: 'first' }])
  })

  it('守られた行をあとから編集したら、その編集は行き渡る', async () => {
    await arrange()

    b.db.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await sync(b)
    await sync(a)
    expect(userNames(a.db)).toEqual([{ id: 'u1', name: 'first' }])

    // 墓標より新しい編集。行の版が入れ替わって、相手まで届く
    a.db
      .prepare(`UPDATE users SET name = ?, updatedAt = ? WHERE id = ?`)
      .run('second', '2026-06-01T00:00:00.000Z', 'u1')
    await sync(a)
    await sync(b)

    expect(userNames(a.db)).toEqual([{ id: 'u1', name: 'second' }])
    expect(userNames(b.db)).toEqual([{ id: 'u1', name: 'second' }])
  })

  it('設定を外すと、取ってあった削除が効く', async () => {
    await arrange()

    b.db.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await sync(b)
    await sync(a)
    expect(userNames(a.db)).toEqual([{ id: 'u1', name: 'first' }])

    // 守るのをやめる。版は1つも動かないので、設定が変わったことだけを頼りに
    // 作り直しが走らなければならない
    const warnings = await sync(a, TABLES)
    expect(
      warnings.some((warning) => warning.includes('deleteProtected の設定'))
    ).toBe(true)
    expect(userNames(a.db)).toEqual([])
  })

  it('守っていない表では、今までどおり削除が効く', async () => {
    await arrange()

    b.db.prepare(`DELETE FROM posts WHERE id = ?`).run('p1')
    await sync(b)
    await sync(a)

    expect(postIds(a.db)).toEqual([])
    expect(postIds(b.db)).toEqual([])
    // 守られた表の行は巻き添えにならない
    expect(userNames(a.db)).toEqual([{ id: 'u1', name: 'first' }])
  })

  it('相手と設定が食い違っていたら警告する（見送りはしない）', async () => {
    await arrange()

    // B だけ守らない設定で回す。A の写しには `users` が守られていると書いてある
    const warnings = await sync(b, TABLES)
    expect(
      warnings.some(
        (warning) =>
          warning.includes('deleteProtected が client-a と食い違っている') &&
          warning.includes('users')
      )
    ).toBe(true)
    // 見送っていない（相手の版はちゃんと取り込めている）
    expect(userNames(b.db)).toEqual([{ id: 'u1', name: 'first' }])
  })
})
