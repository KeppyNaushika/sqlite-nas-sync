/**
 * **親行と主キーを共有する 1:1 の子行**の収束試験。
 * `tag_profiles.id` が主キーであり、同時に `tags.id` を指す外部キーである形を扱う。
 *
 * 旧方式で見つかった反例の形を、案A でも全クライアントが一致することの回帰試験として残してある。
 *
 * この形の表では、子行の主キーは親行の主キーと同じ値である。
 * 親行が統合されると、子行はユーザーテーブルで統合先の親の主キーで表示される。
 * 子行のバージョンの主キーは変わらない。
 * 表示される主キーに別の子行が既にあることがあり、ふつうの表では起きない形になる。
 *
 * ここにある6つの筋書きは、どれも `convergence-properties.test.ts` が見つけた反例を決定的な形へ書き下したものである。
 * 1つめは、旧方式で `UNIQUE constraint failed: tag_profiles.id` の例外になった形である。
 * 旧方式の取り込みは1つのトランザクションで走ったので、例外が出るとその相手の差分が丸ごと巻き戻り、`lastSeenId` も進まなかった。
 * 次の同期でも同じ差分を読んで同じ例外を出すため、その相手からの同期が止まったままになった。
 * 残りの5つは、旧方式で黙って食い違った形である。
 *
 * **このファイルは自分の作業ディレクトリを持つ。**
 * `sync-fixtures` の注意書きのとおり、ファイルごとに分けないと、片方の後片付けがもう片方の走行中の DB を消す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-shared-primary-key')

beforeEach(fixture.prepare)
afterEach(fixture.cleanup)

type Client = {
  id: string
  db: Database.Database
  config: ReturnType<typeof fixture.makeConfig>
}

/** 3つのクライアントの DB と設定。`performSync` はこの順に回す。 */
function makeClients(): Client[] {
  return ['client-a', 'client-b', 'client-c'].map((id) => {
    const { db, dbPath } = fixture.createClientDb(id)
    return { id, db, config: fixture.makeConfig(dbPath, id) }
  })
}

function upsertTag(
  db: Database.Database,
  id: string,
  name: string,
  at: string
): void {
  db.prepare(
    `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt`
  ).run(id, name, at)
}

/**
 * 子行を書く前に親行を用意する。
 * 性質テストの `ensureTag` と同じ形である。
 *
 * **既にある親行の名前は書き換えない。**
 * 書き換えると、同期で届いていた相手の名前を上書きしてしまい、統合が起きる筋書きそのものが変わる。
 * 名前は2種類しかないので、親行の用意そのものが `UNIQUE` の違反で失敗しうる。
 * そのときアプリケーションは、そのクライアントでは何も起きなかったことにする。
 * 性質テストと同じ扱いである。
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
 * 操作を当てる手続きを受け取り、そのあと状態が動かなくなるまで同期を回して、2つを主張する。
 *
 * - `Sync failed` が1件も出ない。
 * - ユーザーテーブルの中身が全クライアントで一致する。
 *
 * 同期を何周も回すのは、1回の `performSync` が相手の写しから読めるのが、相手が前に同期したときまでの変更だけだからである。
 * 3つのクライアントでは、A が B の変更を取り込み、それを C が受け取るまでに数周かかる。
 *
 * 一致を確かめたあと、`check` があれば先頭のクライアントを渡す。
 */
async function expectConvergence(
  play: (clients: Client[], sync: () => Promise<void>) => Promise<void>,
  check?: (db: Database.Database) => void
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

    check?.(clients[0].db)
  } finally {
    for (const client of clients) client.db.close()
  }
}

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('親行と主キーを共有する 1:1 の子行', () => {
  it('表示される主キーに別の 1:1 の子行があっても、取り込みは例外で止まらない', async () => {
    // 旧方式で起きたこと。
    // 旧方式は、子行の畳む向きを子行のバージョンの時刻で決めていた。
    // この筋書きでは子行のバージョンがどちらも 00:00 で同着になり、親行と逆向きの `g2→g1` が選ばれた。
    // 届いた勝者行は主キーを `g2` へ読み替えられ、既にある `g2` へ INSERT して `UNIQUE constraint failed: tag_profiles.id` を投げた。
    //
    // 案A では、子行のバージョンは主キーを変えずに残り、表示する主キーは作り直しのときに決まる。
    await expectConvergence(async (clients, sync) => {
      const [a, b, c] = clients
      // b は g1 に名前 t1 と 1:1 の子行を付け、c は g2 に同じ名前 t1 を付ける。
      ensureTag(b.db, 'g1', 't1', T0)
      upsertTagProfile(b.db, 'g1', 'memo-x', T0)
      upsertTag(c.db, 'g2', 't1', T2)
      await sync()

      // a は g1 を t2 へ改名し、b は g2 にも 1:1 の子行を作る。
      // b では tag_profiles が g1 と g2 の両方にあり、親行は t1 と t2 を取り合う。
      // 親行が統合されると、子行が表示される主キーに別の子行が既にある形になる。
      upsertTag(a.db, 'g1', 't2', T2)
      ensureTag(b.db, 'g2', 't2', T0)
      upsertTagProfile(b.db, 'g2', 'memo-x', T0)
      await sync()
    })
  }, 60000)

  it('統合を知らないクライアントが隠れる側の親行を消しても、統合先の親行と 1:1 の子行は残る', async () => {
    // 旧方式で起きたこと。
    // 親行を消すと子行もカスケードで消え、その削除は子行の古い主キーで他のクライアントへ渡った。
    // 旧方式は、その削除を統合先の主キーの子行への削除と読み替え、生きている親行の子行を消すことがあった。
    // 読み替えて消したことはフルマージの経路では記録されず、行を持ったままのクライアントとの食い違いが残った。
    //
    // 案A では、削除は消した主キーのバージョンにだけ効き、統合先の主キーのバージョンには効かない。
    await expectConvergence(async (clients, sync) => {
      const [a, b] = clients
      ensureTag(a.db, 'g3', 't1', T0)
      upsertTagProfile(a.db, 'g3', 'memo-x', T0)
      ensureTag(b.db, 'g1', 't1', T2)
      upsertTagProfile(b.db, 'g1', 'memo-x', T2)
      await sync()

      // g3 と g1 は名前 t1 を取り合い、時刻の新しい g1 が勝つ。
      // a はまだ g1 を取り込んでいないので、g3 を親行ごと消す。
      // あわせて `_changelog` を削り、相手をフルマージへ切り替えさせる。
      a.db.prepare(`DELETE FROM tags WHERE id = 'g3'`).run()
      pruneChangelog(
        a,
        clients.filter((client) => client !== a)
      )
      await sync()
    })
  }, 60000)

  it('フルマージで写した変更の記録は、行の勝ち負けに効かない', async () => {
    // 旧方式で起きたこと。
    // 相手の `_changelog` は、相手が自分の行に行った操作の記録ではなかった。
    // フルマージが他のクライアントのエントリをそのまま写すので、相手自身が採らなかった削除がそこに並んだ。
    // 時刻や id の大小で相手で最後に起きたことを決めると、写された削除が相手の生きた行の書き込みを覆い隠した。
    // しかも相手には墓標が無いので、削除時刻は `entry.changedAt` の現在時刻になった。
    // 受け取った側は現在時刻の墓標を立て、相手の生きた行を拒み続けた。
    //
    // 案A では、`_changelog` はどの主キーが変わったかの通知でしかない。
    // 勝ち負けは相手の `_sns_rows_*` と `_tombstone` のバージョンだけで決まる。
    await expectConvergence(async (clients, sync) => {
      const [a, b, c] = clients
      // a は `_changelog` を削って相手をフルマージへ切り替えさせる。
      a.db
        .prepare(`INSERT INTO decisions VALUES ('d1', 'c1', 'yes', ?)`)
        .run(T0)
      pruneChangelog(
        a,
        clients.filter((client) => client !== a)
      )
      ensureTag(c.db, 'g1', 't1', T0)
      upsertTagNote(c.db, 'n1', 'g1', T0)
      await sync()

      // b は g3 に g1 と同じ名前 t1 を同じ時刻で付ける。
      // c は同じ主キー g3 を t2 で作り、1:1 の子行を付ける。
      // g3 への2つの変更は並行なので、時刻の新しい c の方が勝ち、g3 は t2 になって g1 とは衝突しない。
      upsertTag(b.db, 'g3', 't1', T0)
      ensureTag(c.db, 'g3', 't2', T2)
      upsertTagProfile(c.db, 'g3', 'memo-x', T2)
      await sync()
    })
  }, 60000)

  it('削除を取り込んだあとに同じ主キーで書き直した行は、全クライアントに残る', async () => {
    // 旧方式で起きたこと。
    // 同じ主キーが、畳まれたあとに本物の削除でも消えていることがあった。
    // 旧方式は畳みの記録と墓標の時刻を別々に見ていたので、書き直した行を採るかどうかの判断がクライアントごとに食い違った。
    //
    // 案A で起きること。
    // c は b の削除を取り込んだあとに g2 を書き直すので、その書き直しは削除より後の変更である。
    // LWW の1で書き直しが勝つので、原則2 どおり g2 と、g2 を指す n1 は全クライアントに残る。
    // 書き直しのバージョンの `_sns_ts` は、単調化によって削除の時刻以上になる。
    await expectConvergence(
      async (clients, sync) => {
        const [a, b, c] = clients
        ensureTag(b.db, 'g2', 't1', T0)
        upsertTagProfile(b.db, 'g2', 'memo-x', T0)
        await sync()

        // a は g1 に g2 と同じ名前 t1 を同じ時刻で付け、子行 n1 を作る。
        // 同時に b は g2 を消す。
        ensureTag(a.db, 'g1', 't1', T0)
        upsertTagNote(a.db, 'n1', 'g1', T0)
        b.db.prepare(`DELETE FROM tags WHERE id = 'g2'`).run()
        await sync()

        // c は削除を取り込んだあとで、g2 をアプリケーションが書いた時刻 00:02 で作り直し、n1 の tagId を g2 に書き換える。
        // 00:02 は削除を実行した現在時刻より古い。
        ensureTag(c.db, 'g2', 't2', T2)
        upsertTagNote(c.db, 'n1', 'g2', T2)
        await sync()
      },
      (db) => {
        expect(db.prepare(`SELECT * FROM tags ORDER BY id`).all()).toEqual([
          { id: 'g1', name: 't1', updatedAt: T0 },
          { id: 'g2', name: 't2', updatedAt: T2 },
        ])
        expect(db.prepare(`SELECT id, tagId FROM tag_notes`).all()).toEqual([
          { id: 'n1', tagId: 'g2' },
        ])
        expect(db.prepare(`SELECT id FROM tag_profiles`).all()).toEqual([])
        const version = db
          .prepare(`SELECT _sns_ts AS ts FROM _sns_rows_tags WHERE id = 'g2'`)
          .get() as { ts: string }
        expect(version.ts > T2).toBe(true)
      }
    )
  }, 60000)

  it('統合先の親行が消え、隠れていた親行があとで書き直されれば、1:1 の子行も全クライアントで表示される', async () => {
    // 旧方式で起きたこと。
    // c は `g3→g2` の畳みで子行の主キーも `g2` へ動かし、`tag_profiles:g3` に畳みの墓標を残した。
    // そのあと親行の `g3` が新しい時刻で作り直されても、c は届いた `tag_profiles:g3` を同じ時刻の墓標で拒み続けた。
    // a と b はその子行を持ち、c だけが子行を持てなかった。
    //
    // 案A では、子行のバージョンは統合で消えないので、親行が表示されれば子行も表示される。
    //
    // 筋書き。
    // 1. c が g3 に名前 t2 と 1:1 の子行を付け、a が g2 に名前 t2 を付ける。どちらも 00:00 である。
    //    c では g3 と g2 が名前 t2 を取り合い、付則1 の順序で1つに統合される。
    // 2. a は g3 を t1 として 00:02 で書き、`_changelog` を削って相手をフルマージへ切り替えさせ、g2 を消す。
    await expectConvergence(async (clients, sync) => {
      const [a, , c] = clients
      upsertTag(a.db, 'g2', 't2', T0)
      ensureTag(c.db, 'g3', 't2', T0)
      upsertTagProfile(c.db, 'g3', 'memo-x', T0)
      await sync()

      upsertTag(a.db, 'g3', 't1', T2)
      pruneChangelog(
        a,
        clients.filter((client) => client !== a)
      )
      a.db.prepare(`DELETE FROM tags WHERE id = 'g2'`).run()
      await sync()
    })
  }, 60000)

  it('同じ時刻で中身の違う親行があとで書き直されれば、1:1 の子行も全クライアントで表示される', async () => {
    // 旧方式で起きたこと。
    // 旧方式では、子行を畳んで消したクライアントは、その子行のエントリをもう読み終えていた。
    // 親行が新しいバージョンで作り直されても子行は二度と流れてこず、c だけがその子行を持ち続けた。
    //
    // 筋書き。`convergence-properties.test.ts` の反例そのままで、差分同期だけで起きる。
    // 1. b は g3 に名前 t2 と子行を、c は g1 に名前 t2 と子行を付け、さらに g3 に名前 t1 を付ける。
    //    どれも 00:00 である。
    //    `tags:g3` への b と c の変更は同じ時刻で中身が違い、付則1 の順序で1つに決まる。
    // 2. b の g3 が勝つクライアントでは、g3 と g1 が名前 t2 を取り合って統合される。
    // 3. c が g3 を t1 として 00:02 で書き直すと、g3 は g1 と衝突しなくなり、`tag_profiles:g3` も表示される。
    await expectConvergence(async (clients, sync) => {
      const [, b, c] = clients
      ensureTag(b.db, 'g3', 't2', T0)
      upsertTagProfile(b.db, 'g3', 'memo-x', T0)
      ensureTag(c.db, 'g1', 't2', T0)
      upsertTagProfile(c.db, 'g1', 'memo-x', T0)
      upsertTag(c.db, 'g3', 't1', T0)
      await sync()

      upsertTag(c.db, 'g3', 't1', T2)
      await sync()
    })
  }, 60000)
})
