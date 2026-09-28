/**
 * **子行が親行より先に届く**形の収束試験。
 *
 * 旧方式で見つかった反例の形を、案A でも全クライアントが一致することの回帰試験として残してある。
 *
 * 旧方式は、相手の `_changelog` を1件ずつユーザーテーブルへ当てて取り込んでいた。
 * 並べ替えの順は親が先ではなく、その行が最初に現れた位置だった。
 * そのため子行が先に入り、あとから届いた親行が `UNIQUE` で負けて畳まれると、子行は親の無い行として残った。
 * `PRAGMA foreign_keys = ON` なので COMMIT で `FOREIGN KEY constraint failed` になった。
 * 取り込みは1トランザクションだったので、その相手の取り込みが丸ごと巻き戻り、`lastSeenId` も進まなかった。
 * 次の同期でも同じ違反を出し、その相手からの同期が止まったままになった。
 * 止まったクライアントはその行を受け取れないので、黙って食い違ったままになった。
 *
 * 案A では、ユーザーテーブルを同期のたびに `_sns_rows_*` と `_tombstone` から作り直す。
 * 届く順は結果に効かない。
 * 親行が置かれていない子行はユーザーテーブルに置かないだけで、バージョンは残る。
 * 親行が届けば、次の作り直しで置かれる。
 * 取り込みが外部キーで止まる経路は無い。
 *
 * 筋書きは `convergence-properties.test.ts` が見つけた反例そのままである。
 * seed 1919755847 を10回縮小した3操作にあたる。
 *
 * **このファイルは自分の作業ディレクトリを持つ。**
 * `sync-fixtures` の注意書きのとおり、ファイルごとに分けないと、片方の後片付けがもう片方の走行中の DB を消す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-child-before-parent')

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

/**
 * 子行を書く前に親行を用意する。
 * 性質テストの `ensureTag` と同じ形である。
 *
 * **既にある親行の名前は書き換えない。**
 * 書き換えると、同期で届いていた相手の名前を上書きしてしまい、統合が起きる筋書きそのものが変わる。
 */
function ensureTag(
  db: Database.Database,
  id: string,
  name: string,
  at: string
): void {
  try {
    db.prepare(
      `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(id, name, at)
  } catch (error) {
    const code = String((error as { code?: string }).code ?? '')
    if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
  }
}

function upsertTagNote(
  db: Database.Database,
  id: string,
  tagId: string,
  at: string
): void {
  db.prepare(
    `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, 'note-x', ?)
     ON CONFLICT(id) DO UPDATE SET tagId = excluded.tagId, updatedAt = excluded.updatedAt`
  ).run(id, tagId, at)
}

function upsertTagProfile(
  db: Database.Database,
  tagId: string,
  memo: string,
  at: string
): void {
  db.prepare(
    `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET memo = excluded.memo, updatedAt = excluded.updatedAt`
  ).run(tagId, memo, at)
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

/**
 * 操作を当てたあと、状態が動かなくなるまで同期を回して、2つを主張する。
 *
 * - `Sync failed` が1件も出ない。
 * - ユーザーテーブルの中身が全クライアントで一致する。
 *
 * 一致を確かめたあと、`check` に各クライアントと全クライアントを渡す。
 */
async function expectConvergence(
  play: (clients: Client[]) => void,
  check: (client: Client, clients: Client[]) => void
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
    play(clients)
    for (let round = 0; round < 6; round += 1) await syncAll()

    expect(
      warnings.filter((warning) => warning.startsWith('Sync failed')),
      `取り込みが例外で巻き戻っている\n` + JSON.stringify(warnings, null, 2)
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

    for (const client of clients) check(client, clients)
  } finally {
    for (const client of clients) client.db.close()
  }
}

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('子行が親行より先に届く', () => {
  it('全クライアントが一致し、親行が統合されたときは子行がバージョンを変えずに統合先の親の主キーで表示される', async () => {
    // 反例そのままの筋書きである。
    // 性質テスト seed 1919755847 を10回縮小した3操作にあたる。
    //
    // ```
    // client-b: upsertTagNote n3 → g2 (name t1, 00:02)
    //           upsertTagNote n3 → g3 (name t2, 00:00)
    // client-c: upsertTagProfile g2 (name t2, 00:02)
    // ```
    //
    // 旧方式で起きたこと。
    // C から見ると、B の差分には `tag_notes:n3` が `tags:g3` より先に並んだ。
    // C は `n3` をそのまま入れ、そのあと届いた `g3` を、同じ名前 `t2` を持つ手元の `g2` に負けたとして畳んだ。
    // `g3` はもう作られないので `n3` は親の無い行として残り、COMMIT で `FOREIGN KEY constraint failed` になった。
    // C は毎周そこで巻き戻り、`tag_notes:n3` を受け取れないままだった。
    //
    // 案A で起きること。
    // `tags:g2` への b と c の変更は、同じ時刻 00:02 で中身が違う。
    // どちらも最初の書き込みなので `_sns_lamport` も同じで、付則1 により `_sns_instance` の大きい方が勝つ。
    // `_sns_instance` は `setupSync` のたびに作る乱数なので、どちらが勝つかは走らせるたびに変わる。
    // そこで、勝った側に応じた結果を期待値にする。
    //
    // c の g2 が勝つと、g2 の名前は t2 になり、`tags:g3` と名前 t2 で衝突する。
    // 時刻の新しい g2 が勝って g3 は隠れる。
    // `n3` のバージョンは `tagId = g3` のまま残り、ユーザーテーブルでは統合先の `g2` を指して表示される。
    //
    // b の g2 が勝つと、g2 の名前は t1 になり、統合は起きない。
    // `n3` は `tagId = g3` のまま表示される。
    await expectConvergence(
      ([, b, c]) => {
        ensureTag(b.db, 'g2', 't1', T2)
        upsertTagNote(b.db, 'n3', 'g2', T2)
        ensureTag(b.db, 'g3', 't2', T0)
        upsertTagNote(b.db, 'n3', 'g3', T0)

        ensureTag(c.db, 'g2', 't2', T2)
        upsertTagProfile(c.db, 'g2', 'memo-x', T2)
      },
      ({ id, db }, [, b, c]) => {
        const instanceOf = (target: Client): string =>
          (
            target.db.prepare(`SELECT instanceId FROM _sns_clock`).get() as {
              instanceId: string
            }
          ).instanceId
        const cWins = instanceOf(c) > instanceOf(b)

        if (cWins) {
          expect(db.prepare(`SELECT * FROM tags`).all(), id).toEqual([
            { id: 'g2', name: 't2', updatedAt: T2 },
          ])
          expect(
            db
              .prepare(`SELECT tableName, trueId, winnerId FROM _sns_hidden`)
              .all(),
            id
          ).toEqual([{ tableName: 'tags', trueId: 'g3', winnerId: 'g2' }])
        } else {
          expect(
            db.prepare(`SELECT * FROM tags ORDER BY id`).all(),
            id
          ).toEqual([
            { id: 'g2', name: 't1', updatedAt: T2 },
            { id: 'g3', name: 't2', updatedAt: T0 },
          ])
          expect(db.prepare(`SELECT * FROM _sns_hidden`).all(), id).toEqual([])
        }
        expect(
          db.prepare(`SELECT id, tagId FROM tag_notes`).all(),
          `${id} ユーザーテーブルの表示`
        ).toEqual([{ id: 'n3', tagId: cWins ? 'g2' : 'g3' }])
        expect(
          db.prepare(`SELECT id, tagId FROM _sns_rows_tag_notes`).all(),
          `${id} 子行のバージョン`
        ).toEqual([{ id: 'n3', tagId: 'g3' }])
      }
    )
  }, 60000)
})
