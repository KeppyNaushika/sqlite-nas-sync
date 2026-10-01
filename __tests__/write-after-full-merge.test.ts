/**
 * **フルマージへ切り替わったクライアントが、あとから統合に関わる主キーへ書く**形の収束試験。
 *
 * 旧方式で見つかった反例の形を、案A でも全クライアントが一致することの回帰試験として残してある。
 *
 * 旧方式の差分同期は、相手の `_changelog` を `lastSeenId` より後ろだけ読んでいた。
 * ある id が畳まれて消えたことを告げるエントリが相手の読み位置より手前にあると、その相手には二度と流れなかった。
 * そこへ相手のアプリケーションが同じ id へ書くと、他のクライアントは墓標の方が新しいとして採らず、書いたクライアントだけがその行を持ち続けた。
 * 旧方式はこれを、行が無い側が削除を配り直すことで直していた。
 *
 * 案A では、統合は削除ではなく、負けた行を隠すだけである。
 * 書き込みの勝ち負けは、主キーごとのバージョンを LWW で比べて決まる。
 * 取り込んだあとに書いた変更は、取り込んだ変更より後の変更として勝つ。
 *
 * 筋書きは `convergence-properties.test.ts` が見つけた反例そのままである。
 * seed 1318613340 にあたる。
 *
 * **このファイルは自分の作業ディレクトリを持つ。**
 * `sync-fixtures` の注意書きのとおり、ファイルごとに分けないと、片方の後片付けがもう片方の走行中の DB を消す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-write-after-full-merge')

beforeEach(fixture.prepare)
afterEach(fixture.cleanup)

type Client = {
  id: string
  db: Database.Database
  config: ReturnType<typeof fixture.makeConfig>
  peers: Client[]
}

function makeClients(): Client[] {
  const clients: Client[] = ['client-a', 'client-b', 'client-c'].map((id) => {
    const { db, dbPath } = fixture.createClientDb(id)
    return { id, db, config: fixture.makeConfig(dbPath, id), peers: [] }
  })
  for (const client of clients) {
    client.peers = clients.filter((other) => other !== client)
  }
  return clients
}

/** ローカルの制約違反は、そのクライアントでは何も起きなかったことにする。性質テストと同じ扱いである。 */
function tolerateConstraint(error: unknown): void {
  const code = String((error as { code?: string }).code ?? '')
  if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
}

/** 子行を書く前に親行を用意する。用意できなければ子行も作らない。性質テストと同じ扱いである。 */
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

function upsertTagNote(
  db: Database.Database,
  id: string,
  tagId: string,
  tagName: string,
  at: string
): void {
  if (!ensureTag(db, tagId, tagName, at)) return
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
  tagName: string,
  at: string
): void {
  if (!ensureTag(db, tagId, tagName, at)) return
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
function pruneChangelog(client: Client): void {
  let floor = Number.POSITIVE_INFINITY
  for (const peer of client.peers) {
    const state = peer.db
      .prepare(`SELECT lastSeenId FROM _sync_state WHERE remoteClientId = ?`)
      .get(client.id) as { lastSeenId: number } | undefined
    floor = Math.min(floor, state?.lastSeenId ?? 0)
  }
  if (!Number.isFinite(floor)) floor = 0
  client.db.prepare(`DELETE FROM _changelog WHERE id <= ?`).run(floor + 1)
}

/** 比べるのは同期するユーザーテーブルの中身だけである。内部テーブルはクライアントごとに違ってよい。 */
function snapshot(db: Database.Database): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const table of ['tags', 'tag_notes', 'tag_profiles']) {
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all() as Record<string, unknown>[]) {
      rows.push({ table, ...row })
    }
  }
  return rows
}

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('フルマージへ切り替わったクライアントがあとから書く', () => {
  it('統合と削除を取り込んだあとに書いた行は、全クライアントに残る', async () => {
    // 反例そのままの筋書きである。
    // 性質テスト seed 1318613340 にあたる。
    //
    // 旧方式で起きたこと。
    // A と B は `tags:g2` を `g1` へ畳み、`g2` を消えた id として扱った。
    // C は `_changelog` の隙間でフルマージへ切り替わり、この畳みのエントリを読む位置を通り過ぎた。
    // そのあと C のアプリケーションが `tags:g2` を 00:00 で書くと、A と B は畳みの墓標で採らず、C だけが `tags:g2` を持ち続けた。
    //
    // 案A で起きること。
    // 2ラウンド目に C が g3 を消すと、g3 と統合されていた g1 も原則3 どおり削除され、子行もカスケードで削除される。
    // A が書いた g1 と B が書いた n1 は、C の削除と並行で時刻が古いので、原則2 どおり削除が勝つ。
    // 3ラウンド目の C の書き込みは、それまでに取り込んだ変更より後の変更なので、LWW の1で勝つ。
    // 最後に全クライアントに残るのは、C が書いた `tags:g2` の名前 t1 の行だけである。
    const clients = makeClients()
    const [a, b, c] = clients
    const warnings: string[] = []
    const syncAll = async (): Promise<void> => {
      for (const client of clients) {
        warnings.push(
          ...(await performSync(client.db, client.config, TABLES)).warnings
        )
      }
    }

    try {
      // 1ラウンド目
      upsertTagProfile(b.db, 'g3', 't1', T2)
      upsertTagNote(c.db, 'n1', 'g1', 't1', T0)
      await syncAll()

      // 2ラウンド目。`pruneChangelog` で相手をフルマージへ切り替えさせる。
      upsertTag(a.db, 'g1', 't2', T0)
      pruneChangelog(a)
      upsertTagNote(b.db, 'n1', 'g2', 't2', T0)
      c.db.prepare(`DELETE FROM tags WHERE id = 'g3'`).run()
      await syncAll()

      // 3ラウンド目。C が g2 に名前 t1 を書く。
      upsertTag(c.db, 'g2', 't1', T0)
      await syncAll()

      // 状態が動かなくなるまで回す。
      // 1回の `performSync` が相手の写しから読めるのは、相手が前に同期したときまでの変更だけなので、1周では届かない変更がある。
      for (let round = 0; round < 6; round += 1) await syncAll()

      expect(
        warnings.filter((warning) => warning.startsWith('Sync failed'))
      ).toEqual([])

      const snapshots = clients.map((client) => snapshot(client.db))
      const describeAll = clients
        .map(
          (client, index) => `${client.id}: ${JSON.stringify(snapshots[index])}`
        )
        .join('\n')
      expect(
        snapshots[1],
        `クライアントどうしで中身が食い違っている\n${describeAll}`
      ).toEqual(snapshots[0])
      expect(
        snapshots[2],
        `クライアントどうしで中身が食い違っている\n${describeAll}`
      ).toEqual(snapshots[0])

      expect(snapshots[0]).toEqual([
        { table: 'tags', id: 'g2', name: 't1', updatedAt: T0 },
      ])
    } finally {
      for (const client of clients) client.db.close()
    }
  }, 60000)
})
