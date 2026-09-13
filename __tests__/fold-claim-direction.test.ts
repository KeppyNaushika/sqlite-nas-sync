/**
 * **畳みの主張の向き** —— 同じ2つの id について、端末どうしが逆向きの畳みを主張し、
 * しかもその主張の時刻が同じになる形を見る。
 *
 * 時刻が同じだと「新しい主張が勝つ」では決まらないので、**行の勝敗と同じ物差し**
 * （生き残る id が主キーの辞書順で小さい方）で決める必要がある。そこを端末ごとに
 * 違う向きで決めると、生き残る id が毎周入れ替わって永久に収束しない。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'
import {
  isFoldClaimOutranked,
  readOpposingFoldClaim,
} from '../src/conflict/ledger'

const { prepare, cleanup, createClientDb, makeConfig } = createSyncFixture(
  'test-data-fold-claim-direction'
)

interface Client {
  id: string
  db: Database.Database
  config: ReturnType<typeof makeConfig>
}

function makeClients(ids: string[]): Client[] {
  return ids.map((id) => {
    const { db, dbPath } = createClientDb(id)
    return { id, db, config: makeConfig(dbPath, id) }
  })
}

function insertTag(
  db: Database.Database,
  id: string,
  name: string,
  updatedAt: string
): void {
  db.prepare(`INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`).run(
    id,
    name,
    updatedAt
  )
}

function tagRows(db: Database.Database): { id: string; name: string }[] {
  return db.prepare(`SELECT id, name FROM tags ORDER BY id`).all() as {
    id: string
    name: string
  }[]
}

function noteRows(db: Database.Database): { id: string; tagId: string }[] {
  return db.prepare(`SELECT id, tagId FROM tag_notes ORDER BY id`).all() as {
    id: string
    tagId: string
  }[]
}

function profileRows(db: Database.Database): { id: string; memo: string }[] {
  return db.prepare(`SELECT id, memo FROM tag_profiles ORDER BY id`).all() as {
    id: string
    memo: string
  }[]
}

describe('逆向きで同時刻の畳みの主張', () => {
  beforeEach(prepare)
  afterEach(cleanup)

  it('3端末で生き残るidが振動せず、同じ行に収束する', async () => {
    const clients = makeClients(['client-a', 'client-b', 'client-c'])
    const [a, b, c] = clients

    // A は g1 の**古い版**しか持っていない。C はそれを見て「g1 は g2 より古い＝
    // g1 が負け」と判断するが、A と B は g1@6月 と g2@6月 を**同時刻**と見て、
    // 主キーの辞書順で g1 を勝たせる。向きが逆で時刻が同じ2つの主張が生まれる。
    insertTag(a.db, 'g1', 't1', '2026-01-01T00:00:00.000Z')
    insertTag(b.db, 'g1', 't1', '2026-06-01T00:00:00.000Z')
    insertTag(c.db, 'g2', 't1', '2026-06-01T00:00:00.000Z')

    const warnings: string[] = []
    for (let round = 0; round < 8; round += 1) {
      for (const client of clients) {
        warnings.push(
          ...(await performSync(client.db, client.config, TABLES)).warnings
        )
      }
    }

    const snapshots = clients.map((client) => tagRows(client.db))
    expect(snapshots[1], JSON.stringify(snapshots)).toEqual(snapshots[0])
    expect(snapshots[2], JSON.stringify(snapshots)).toEqual(snapshots[0])
    // 生き残るのは辞書順で小さい g1（全端末で同じ答えになること自体が要点）
    expect(snapshots[0]).toEqual([{ id: 'g1', name: 't1' }])
    expect(warnings.filter((w) => w.startsWith('Sync failed'))).toEqual([])

    for (const client of clients) client.db.close()
  }, 60000)

  it('向きが覆っても、子（参照する子・主キーを共有する1:1の子）が失われない', async () => {
    const clients = makeClients(['client-a', 'client-b', 'client-c'])
    const [a, b, c] = clients

    insertTag(a.db, 'g1', 't1', '2026-01-01T00:00:00.000Z')
    insertTag(b.db, 'g1', 't1', '2026-06-01T00:00:00.000Z')
    insertTag(c.db, 'g2', 't1', '2026-06-01T00:00:00.000Z')

    // C は g2 に子を持つ。C は一度 g1 を畳んで消すが、あとで向きが覆るので
    // g1 を復活させ、g2 を畳む側へ回る。そのとき子は g1 へ付け替わらなければならない
    // （取りこぼすと子が宙に浮くか、外部キー違反でその相手ぶんの同期が永久に止まる）。
    c.db
      .prepare(
        `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('n2', 'g2', 'g2の本文', '2026-06-01T00:00:00.000Z')
    c.db
      .prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (?, ?, ?)`
      )
      .run('g2', 'g2のメモ', '2026-06-01T00:00:00.000Z')
    // B は g1 に子を持つ（勝ち残る側の子）
    b.db
      .prepare(
        `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
      )
      .run('n1', 'g1', 'g1の本文', '2026-06-01T00:00:00.000Z')

    const warnings: string[] = []
    for (let round = 0; round < 8; round += 1) {
      for (const client of clients) {
        warnings.push(
          ...(await performSync(client.db, client.config, TABLES)).warnings
        )
      }
    }

    const tags = clients.map((client) => tagRows(client.db))
    const notes = clients.map((client) => noteRows(client.db))
    const profiles = clients.map((client) => profileRows(client.db))
    const dump = JSON.stringify({ tags, notes, profiles })

    expect(tags[1], dump).toEqual(tags[0])
    expect(tags[2], dump).toEqual(tags[0])
    expect(notes[1], dump).toEqual(notes[0])
    expect(notes[2], dump).toEqual(notes[0])
    expect(profiles[1], dump).toEqual(profiles[0])
    expect(profiles[2], dump).toEqual(profiles[0])

    // 子は失われず、生き残った親を指していること
    expect(tags[0]).toEqual([{ id: 'g1', name: 't1' }])
    expect(
      notes[0].map((note) => note.id),
      dump
    ).toEqual(['n1', 'n2'])
    for (const note of notes[0]) expect(note.tagId, dump).toBe('g1')
    // 1:1 の子は席が1つしか無いので、残るのは g1 の席の1行
    expect(
      profiles[0].map((profile) => profile.id),
      dump
    ).toEqual(['g1'])

    // 外部キー違反でその相手ぶんの取り込みが巻き戻ると、ここに出る
    expect(warnings.filter((w) => w.startsWith('Sync failed'))).toEqual([])

    for (const client of clients) client.db.close()
  }, 60000)

  it('2端末の普通の同着（同時刻・別idの同じユニークキー）は今までどおり収束する', async () => {
    const clients = makeClients(['client-a', 'client-b'])
    const [a, b] = clients

    // 同着では `mergedAt`（＝勝者行の時刻）が敗者行の時刻と必ず一致する。
    // 「同時刻なら畳みを無効にする」形にすると、ここで新しい振動が生まれる。
    insertTag(a.db, 'g1', 't1', '2026-06-01T00:00:00.000Z')
    insertTag(b.db, 'g2', 't1', '2026-06-01T00:00:00.000Z')

    const warnings: string[] = []
    for (let round = 0; round < 4; round += 1) {
      for (const client of clients) {
        warnings.push(
          ...(await performSync(client.db, client.config, TABLES)).warnings
        )
      }
    }

    const snapshots = clients.map((client) => tagRows(client.db))
    expect(snapshots[1], JSON.stringify(snapshots)).toEqual(snapshots[0])
    expect(snapshots[0]).toEqual([{ id: 'g1', name: 't1' }])
    expect(warnings.filter((w) => w.startsWith('Sync failed'))).toEqual([])

    for (const client of clients) client.db.close()
  }, 60000)
})

/**
 * 向きの決着そのものを、関数の高さで押さえる。
 *
 * 上の同期経路のテストは「通しで収束する」ことを見るが、それだと**なぜ収束したか**が
 * 分からないまま通ることがある（周回数を増やせば偶然そろう形もある）。
 * 判断を下している関数に直接尋ねて、**2つの端末が同じ答えを出す**ことを固定する。
 */
describe('向きの決着（関数の高さ）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE _id_merge (
        tableName TEXT NOT NULL,
        losingId  TEXT NOT NULL,
        winningId TEXT NOT NULL,
        mergedAt  TEXT NOT NULL,
        PRIMARY KEY (tableName, losingId)
      )
    `)
  })

  afterEach(() => {
    db.close()
  })

  const claim = (
    losingId: string,
    winningId: string,
    mergedAt: string
  ): void => {
    db.prepare(
      `INSERT INTO _id_merge (tableName, losingId, winningId, mergedAt) VALUES ('tags', ?, ?, ?)`
    ).run(losingId, winningId, mergedAt)
  }

  const T = '2026-06-01T00:00:00.000Z'

  it('逆向き・同時刻なら、両端末が同じ答えを出す（小さいidが生き残る）', () => {
    // 一方の端末は `g2→g1` を持ち、`g1→g2` が届く。もう一方はその逆。
    // どちらの端末でも「生き残るのは g1」に落ちなければ振動する。
    claim('g2', 'g1', T)
    // 届いた `g1→g2`（生き残るのは g2）は、既にある `g2→g1` に負ける
    expect(isFoldClaimOutranked(db, 'tags', 'g1', 'g2', T)).toBe(true)

    // 逆の端末: `g1→g2` を持っていて `g2→g1` が届く
    const other = new Database(':memory:')
    other.exec(
      `CREATE TABLE _id_merge (tableName TEXT NOT NULL, losingId TEXT NOT NULL, winningId TEXT NOT NULL, mergedAt TEXT NOT NULL, PRIMARY KEY (tableName, losingId))`
    )
    other
      .prepare(
        `INSERT INTO _id_merge (tableName, losingId, winningId, mergedAt) VALUES ('tags', 'g1', 'g2', ?)`
      )
      .run(T)
    // 届いた `g2→g1`（生き残るのは g1）は勝つ＝こちらも「g1 が生き残る」へ動く
    expect(isFoldClaimOutranked(other, 'tags', 'g2', 'g1', T)).toBe(false)
    other.close()
  })

  it('新しい主張は、向きが逆でも時刻で勝つ', () => {
    claim('g2', 'g1', '2026-01-01T00:00:00.000Z')
    expect(
      isFoldClaimOutranked(db, 'tags', 'g1', 'g2', '2026-06-01T00:00:00.000Z')
    ).toBe(false)
  })

  it('古い主張は、向きが逆なら時刻で負ける', () => {
    claim('g2', 'g1', '2026-06-01T00:00:00.000Z')
    expect(
      isFoldClaimOutranked(db, 'tags', 'g1', 'g2', '2026-01-01T00:00:00.000Z')
    ).toBe(true)
  })

  it('鎖は逆向きと誤認しない', () => {
    // `A→C` を持っている端末へ `C→B` が届くのは、**向きの食い違いではなく鎖**。
    // ここを逆向きと誤認すると、正しい鎖の張り替えが断られ、読み替えが1段で
    // 終わらなくなる（遅れて届いた子が死んだ id を指したまま残る）。
    claim('gA', 'gC', T)
    expect(readOpposingFoldClaim(db, 'tags', 'gC', 'gB')).toBeNull()
    expect(isFoldClaimOutranked(db, 'tags', 'gC', 'gB', T)).toBe(false)
  })

  it('関係の無い記録は、向きの食い違いと見ない', () => {
    claim('gX', 'gY', T)
    expect(readOpposingFoldClaim(db, 'tags', 'g1', 'g2')).toBeNull()
  })

  it('帳簿がまだ無いDBでも例外にならない', () => {
    const bare = new Database(':memory:')
    expect(readOpposingFoldClaim(bare, 'tags', 'g1', 'g2')).toBeNull()
    expect(isFoldClaimOutranked(bare, 'tags', 'g1', 'g2', T)).toBe(false)
    bare.close()
  })
})
