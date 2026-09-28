/**
 * **`UNIQUE` の統合の勝者が、あとから届いた変更で変わる**形の収束試験。
 *
 * 旧方式で見つかった反例の形を、案A でも全クライアントが一致することの回帰試験として残してある。
 *
 * 旧方式の差分同期は、相手の `_changelog` を `lastSeenId` より後ろだけ読んでいた。
 * 畳みの主張を行ごとに配っていたので、次の2つの形で1台だけが違う中身を持ったまま止まった。
 *
 * - 勝ち残る行のエントリを既に読み終えていたクライアントには、その行が二度と流れなかった。
 * - 主張を公開しなかったクライアントの判断は、誰にも伝わらなかった。
 *
 * 案A では、統合の勝者は同期のたびに `_sns_rows_*` のバージョンから決め直す。
 * 畳みの主張を配る仕組みは無い。
 *
 * どちらの筋書きも `convergence-properties.test.ts` が見つけた反例を決定的な形へ書き下したものである。
 *
 * **このファイルは自分の作業ディレクトリを持つ。**
 * `sync-fixtures` の注意書きのとおり、ファイルごとに分けないと、片方の後片付けがもう片方の走行中の DB を消す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-merge-winner-changes')

beforeEach(fixture.prepare)
afterEach(fixture.cleanup)

type Client = {
  id: string
  db: Database.Database
  config: ReturnType<typeof fixture.makeConfig>
}

function makeClients(): Client[] {
  return ['client-a', 'client-b', 'client-c'].map((id) => {
    const { db, dbPath } = fixture.createClientDb(id)
    return { id, db, config: fixture.makeConfig(dbPath, id) }
  })
}

/** ローカルの制約違反は、そのクライアントでは何も起きなかったことにする。性質テストと同じ扱いである。 */
function tolerateConstraint(error: unknown): void {
  const code = String((error as { code?: string }).code ?? '')
  if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
}

function upsertTag(
  db: Database.Database,
  id: string,
  name: string,
  at: string
): void {
  try {
    db.prepare(
      `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt`
    ).run(id, name, at)
  } catch (error) {
    tolerateConstraint(error)
  }
}

/** 子行を書く前に親行を用意する。既にある親行の名前は書き換えない。性質テストの `ensureTag` と同じ形である。 */
function ensureTag(
  db: Database.Database,
  id: string,
  name: string,
  at: string
): boolean {
  try {
    db.prepare(
      `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(id, name, at)
  } catch (error) {
    tolerateConstraint(error)
  }
  return db.prepare(`SELECT 1 FROM tags WHERE id = ?`).get(id) !== undefined
}

function upsertTagNote(
  db: Database.Database,
  id: string,
  tagId: string,
  at: string
): void {
  try {
    db.prepare(
      `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, 'note-x', ?)
       ON CONFLICT(id) DO UPDATE SET tagId = excluded.tagId, updatedAt = excluded.updatedAt`
    ).run(id, tagId, at)
  } catch (error) {
    tolerateConstraint(error)
  }
}

function upsertTagProfile(
  db: Database.Database,
  tagId: string,
  at: string
): void {
  try {
    db.prepare(
      `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (?, 'memo-x', ?)
       ON CONFLICT(id) DO UPDATE SET memo = excluded.memo, updatedAt = excluded.updatedAt`
    ).run(tagId, at)
  } catch (error) {
    tolerateConstraint(error)
  }
}

/**
 * このクライアントの `_changelog` の先頭を、まだどの相手も読んでいない位置まで消す。
 * 相手はこのクライアントからの取り込みで隙間を見つけ、フルマージに切り替える。
 * 性質テストの `pruneChangelog` と同じ操作である。
 */
function pruneChangelog(client: Client, peers: Client[]): void {
  let floor = Number.POSITIVE_INFINITY
  for (const peer of peers) {
    const state = peer.db
      .prepare(`SELECT lastSeenId FROM _sync_state WHERE remoteClientId = ?`)
      .get(client.id) as { lastSeenId: number } | undefined
    floor = Math.min(floor, state?.lastSeenId ?? 0)
  }
  if (!Number.isFinite(floor)) floor = 0
  client.db.prepare(`DELETE FROM _changelog WHERE id <= ?`).run(floor + 1)
}

const WATCHED = ['tags', 'tag_notes', 'tag_profiles']

/** 比べるのは同期するユーザーテーブルの中身だけである。内部テーブルはクライアントごとに違ってよい。 */
function snapshot(db: Database.Database): Map<string, string> {
  const rows = new Map<string, string>()
  for (const table of WATCHED) {
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all() as Record<string, unknown>[]) {
      rows.set(`${table}:${String(row.id)}`, JSON.stringify(row))
    }
  }
  return rows
}

/** 全クライアントの総当たりで食い違っている行のキー。形は `表:id` である。 */
function differingKeys(clients: Client[]): string[] {
  const snapshots = clients.map((client) => snapshot(client.db))
  const keys = new Set<string>()
  for (let i = 0; i < snapshots.length; i += 1) {
    for (let j = i + 1; j < snapshots.length; j += 1) {
      for (const key of new Set([
        ...snapshots[i].keys(),
        ...snapshots[j].keys(),
      ])) {
        if (snapshots[i].get(key) !== snapshots[j].get(key)) keys.add(key)
      }
    }
  }
  return [...keys].sort()
}

/**
 * 操作を当てたあと、状態が動かなくなるまで同期を回して、2つを主張する。
 *
 * - `Sync failed` が1件も出ない。
 * - ユーザーテーブルの中身が全クライアントで一致する。
 *
 * 同じ時刻で中身が違う行も、付則1 により `_sns_instance` で1つに決まるので、食い違いは1件も許さない。
 */
async function expectConvergence(
  play: (clients: Client[], sync: () => Promise<void>) => Promise<void>
): Promise<void> {
  const clients = makeClients()
  const warnings: string[] = []
  const syncAll = async (): Promise<void> => {
    for (const client of clients) {
      warnings.push(
        ...(await performSync(client.db, client.config, TABLES)).warnings
      )
    }
  }

  try {
    await play(clients, syncAll)
    for (let round = 0; round < 6; round += 1) await syncAll()

    expect(
      warnings.filter((warning) => warning.startsWith('Sync failed')),
      `取り込みが例外で巻き戻っている\n` + JSON.stringify(warnings, null, 2)
    ).toEqual([])

    const differing = differingKeys(clients)
    expect(
      differing,
      `クライアントどうしで中身が食い違っている\n` +
        differing
          .map((key) =>
            clients
              .map(
                (client) =>
                  `${key} ${client.id}: ${snapshot(client.db).get(key) ?? '無'}`
              )
              .join('\n')
          )
          .join('\n') +
        `\nwarnings: ${JSON.stringify(warnings, null, 2)}`
    ).toEqual([])
  } finally {
    for (const client of clients) client.db.close()
  }
}

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('統合の勝者があとから届いた変更で変わる', () => {
  it('古いバージョンで統合を決めたクライアントも、新しいバージョンが届けば全クライアントと同じ勝者に揃う', async () => {
    // 旧方式で起きたこと。
    // c は `g2` の古いバージョンしか見ていないうちに、`g2→g3` の畳みを記録した。
    // 全クライアントが揃った時点の正しい向きは `g3→g2` だった。
    // 勝者行のエントリを既に読み終えていた c には、向きが覆っても勝者行が二度と流れてこなかった。
    //
    // 案A では、統合の勝者は同期のたびに `_sns_rows_*` のバージョンから決め直す。
    //
    // 筋書き。
    // `tags:g2` は a が 00:00、b が 00:02 で書き、`tags:g3` は c が 00:02 で書く。
    // どれも名前 t1 を取り合う。
    // そのあと b は g3 に 1:1 の子行を付け、c は g3 を消す。
    await expectConvergence(async (clients, sync) => {
      const [a, b, c] = clients
      upsertTag(a.db, 'g2', 't1', T0)
      upsertTag(b.db, 'g2', 't1', T2)
      upsertTag(c.db, 'g3', 't1', T2)
      await sync()

      if (ensureTag(b.db, 'g3', 't2', T0)) upsertTagProfile(b.db, 'g3', T0)
      c.db.prepare(`DELETE FROM tags WHERE id = 'g3'`).run()
      await sync()
    })
  }, 60000)

  it('隠れた主キーを新しい時刻で書き直すと、書き直した行も全クライアントで同じ扱いになる', async () => {
    // 旧方式で起きたこと。
    // 畳まれた id を畳みより新しいバージョンで作り直すと、同じ2つの id が別のバージョンでもう一度衝突した。
    // 旧方式は勝者 id が前と同じだからと新しい畳みの主張を公開せず、作り直したクライアントには古い時刻の主張しか届かなかった。
    // そのクライアントは作り直した行の方が新しいので畳みを断り続け、そのクライアントだけが行を持ち続けた。
    //
    // 案A では、統合するかどうかは同期のたびに各主キーの最新のバージョンから決め直す。
    //
    // 筋書き。
    // 1. `tags:g1` は a が 00:00、b が 00:02 で名前 t1 を付け、`tags:g3` は c が 00:00 で名前 t1 を付ける。
    //    a と c は `_changelog` を削り、相手をフルマージへ切り替えさせる。
    // 2. a が g1 を t2 へ 00:02 で改名する。
    //    この改名は b の g1 への書き込みと同じ時刻で、付則1 の順序で1つに決まる。
    // 3. a が g3 を名前 t1 と 1:1 の子行つきで 00:02 で書き直す。
    await expectConvergence(async (clients, sync) => {
      const [a, b, c] = clients
      const peersOf = (self: Client): Client[] =>
        clients.filter((client) => client !== self)

      if (ensureTag(a.db, 'g1', 't1', T0)) upsertTagNote(a.db, 'n1', 'g1', T0)
      pruneChangelog(a, peersOf(a))
      if (ensureTag(b.db, 'g1', 't1', T2)) upsertTagNote(b.db, 'n1', 'g1', T2)
      upsertTag(b.db, 'g2', 't2', T0)
      upsertTag(c.db, 'g3', 't1', T0)
      pruneChangelog(c, peersOf(c))
      await sync()

      upsertTag(a.db, 'g1', 't2', T2)
      await sync()

      if (ensureTag(a.db, 'g3', 't1', T2)) upsertTagProfile(a.db, 'g3', T2)
      await sync()
    })
  }, 60000)
})
