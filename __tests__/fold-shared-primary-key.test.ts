/**
 * **親と主キーを共有する1:1の子**（`tag_profiles.id` が `tags.id` を指す主キー）の族。
 *
 * この形の表では、行の id を持っているのは親である —— 親が畳まれれば子の id はその
 * まま動く（`conflict/fold.ts` の `repointChild`）。id の持ち主が別の表に居るせいで、
 * ふつうの表では起きない壊れ方が5つある。ここに置いてあるのはそのそれぞれで、
 * どれも `convergence-properties.test.ts`（3端末・無作為な操作列）が見つけた反例を
 * **決定的な形へ書き下したもの**である。各 `it` の頭に、どの規則を留めているかを書いた。
 *
 * 1つめは**例外**（`UNIQUE constraint failed: tag_profiles.id`）で、このライブラリで
 * 唯一許されない壊れ方だった —— 取り込みは1つのトランザクションで走るので、例外が出ると
 * その相手ぶんの差分が丸ごと巻き戻り `lastSeenId` も進まない。次の同期でも同じ差分を
 * 読んで同じ例外を出すため、**その相手からの同期が永久に止まる**。残り4つは黙って
 * 食い違う形（膠着としても報告されない）。
 *
 * **このファイルは自分の作業ディレクトリを持つ**（`sync-fixtures` の注意書きのとおり、
 * ファイルごとに分けないと、片方の後片付けがもう片方の走行中のDBを消す）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-fold-shared-pk')

beforeEach(fixture.prepare)
afterEach(fixture.cleanup)

type Client = {
  id: string
  db: Database.Database
  config: ReturnType<typeof fixture.makeConfig>
}

/** 3端末ぶんのDBと設定。`performSync` はこの順に回す。 */
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
 * 子を書く前に親を用意する（性質テストの `ensureTag` と同じ形）。
 *
 * **既に在る親の名前は書き換えない**（`DO NOTHING`）。書き換える形にすると、同期で
 * 届いていた相手の名前を潰してしまい、畳みが起きる筋書きそのものが変わる。
 * 名前は2種類しか無い名前空間から引くので、親の用意自体がユニーク違反で失敗しうる。
 * そのときアプリは「その端末では起きなかった」ことにする（性質テストと同じ）。
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
 * この端末の changelog の頭を削り、**まだ誰も読んでいない位置まで**巻き込む
 * （＝相手をフルマージ経路へ落とす）。性質テストの `pruneChangelog` と同じ。
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

/** 比べるのは同期対象の中身だけ（帳簿や changelog は端末ごとに違ってよい）。 */
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
 * 1本ぶんの足場。操作を当てる手続きを受け取り、そのあと**状態が動かなくなるまで**
 * 同期を回して、2つを主張する:
 *
 * - `Sync failed` が1件も出ない（例外で取り込みが巻き戻っていない）
 * - 全端末の中身が一致する
 *
 * 往復を何度も回すのは、押し出しが pull より先だからである（片道1回では相手の変更は
 * 届かない。3端末なら「AがBの判断を取り込み、それをCが受け取る」まで数える）。
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
      `取り込みが例外で巻き戻っている（その相手からの同期は永久に止まる）\n` +
        JSON.stringify(warnings, null, 2)
    ).toEqual([])

    const snapshots = clients.map((client) => snapshot(client.db))
    const describeAll = clients
      .map(
        (client, index) => `${client.id}: ${JSON.stringify(snapshots[index])}`
      )
      .join('\n')
    expect(
      snapshots[1],
      `端末どうしで中身が食い違っている\n${describeAll}`
    ).toEqual(snapshots[0])
    expect(
      snapshots[2],
      `端末どうしで中身が食い違っている\n${describeAll}`
    ).toEqual(snapshots[0])
  } finally {
    for (const client of clients) client.db.close()
  }
}

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('親と主キーを共有する1:1の子', () => {
  it('畳む向きは親が決める（子の時刻で決めると取り込みが例外で止まる）', async () => {
    // 規則: **この形の表の畳む向きは、親の帳簿が握る**
    // （`conflict/ledger.ts` の `readIdentityOwnerVerdict`）。
    //
    // 子の畳みの主張が名乗る時刻は `repointChild` が刻む**子の行の版**なので、
    // 親の畳みの時刻とは無関係に並ぶ。ここでは子の版がどちらも 00:00 で同着になり、
    // 同着決着（生き残る id の辞書順）が親と**逆向き**の `g2→g1` を選んでいた。
    // すると届いた勝者行は `remapMergedForeignKeys` で id を `g2` へ読み替えられ
    // （主キーが外部キーなので id そのものが動く）、`foldAndReplace` が既に在る
    // `g2` へ INSERT して `UNIQUE constraint failed: tag_profiles.id` を投げた。
    await expectConvergence(async (clients, sync) => {
      const [a, b, c] = clients
      // b は g1（t1）とその 1:1 の子、c は g2 に同じ名前 t1 を付ける
      ensureTag(b.db, 'g1', 't1', T0)
      upsertTagProfile(b.db, 'g1', 'memo-x', T0)
      upsertTag(c.db, 'g2', 't1', T2)
      await sync()

      // a は g1 を t2 へ改名し、b は g2 にも 1:1 の子を作る。これで b には
      // tag_profiles が g1 / g2 の両方に在り、親は t1 / t2 を取り合って畳まれる ——
      // **子の id が動いた先の席が埋まっている**形になる
      upsertTag(a.db, 'g1', 't2', T2)
      ensureTag(b.db, 'g2', 't2', T0)
      upsertTagProfile(b.db, 'g2', 'memo-x', T0)
      await sync()
    })
  }, 60000)

  it('親ごと消えた巻き添えを、動いた先の行への削除と読み替えない', async () => {
    // 規則: **親の死と同時刻（かそれより古い）削除は、その死の巻き添えである**
    // （`sync/entries.ts` の `resolveMovedId`）。親を消せば子はカスケードで消え、
    // その削除は「子の**古い** id」として渡ってくる。動いた先の行 ——
    // **生きている親の子** —— を消してよい根拠にはならない。
    //
    // 併せて規則: **読み替えて別の id を消したなら、その削除は公開する**
    // （`applyTombstoneDelete` の `writeFoldDeletion`）。フルマージはトリガーを
    // 外して走るので、消しただけでは差分経路に何も残らない。消した側にはローカルの
    // 墓標（現在時刻）だけが残り、行を持ったままの端末は誰からも訂正されない。
    await expectConvergence(async (clients, sync) => {
      const [a, b] = clients
      ensureTag(a.db, 'g3', 't1', T0)
      upsertTagProfile(a.db, 'g3', 'memo-x', T0)
      ensureTag(b.db, 'g1', 't1', T2)
      upsertTagProfile(b.db, 'g1', 'memo-x', T2)
      await sync()

      // g3 は g1 へ畳まれ、子の id も動く。そこへ a が**親ごと**消す
      // （カスケードで `tag_profiles:g3` の削除が渡る）。あわせて changelog を
      // 削り、相手をフルマージ経路へ落とす
      a.db.prepare(`DELETE FROM tags WHERE id = 'g3'`).run()
      pruneChangelog(
        a,
        clients.filter((client) => client !== a)
      )
      await sync()
    })
  }, 60000)

  it('写されただけの削除を、相手の最後の出来事として採らない', async () => {
    // 旧方式で何が起きたか: 相手の `_changelog` は「相手が自分の行に行った操作の
    // 記録」ではない —— フルマージが**他人のエントリをそのまま写す**ので、相手自身が
    // 採らなかった削除がそこに並ぶ。時刻や id の大小で「相手で最後に起きたこと」を
    // 決めると、写された削除が相手の生きた行の書き込みを覆い隠した。しかも相手には
    // 墓標が無いので削除時刻は `entry.changedAt`（現在時刻）に落ち、受け取った側は
    // **現在時刻の墓標**を立てて相手の生きた行を永久に拒んだ。
    //
    // 案A では `_changelog` は「どの主キーが変わったか」の通知でしかなく、勝ち負けは
    // 相手の `_sns_rows_*` と `_tombstone` のバージョンだけで決まる。写されたエントリが
    // 削除を名乗ることはない。
    await expectConvergence(async (clients, sync) => {
      const [a, b, c] = clients
      // a は changelog を削って相手をフルマージへ落とす
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

      // b の g3（t1）は g1 と同着で、辞書順により g1 が勝って g3 は畳まれる。
      // c は同じ id を **t2 へ改名したうえで** 1:1 の子を付ける（00:02）ので、
      // c にとってその畳みはもう古い判断であり、c の g3 は生き残る
      upsertTag(b.db, 'g3', 't1', T0)
      ensureTag(c.db, 'g3', 't2', T2)
      upsertTagProfile(c.db, 'g3', 'memo-x', T2)
      await sync()
    })
  }, 60000)

  it('畳みのあとに本物の削除が来た id へ書き直した行は、書いた端末で落とす', async () => {
    // 規則: **行が生き残るかは、2つの主張の両方と比べて決める**
    // （`sync/self-check.ts` の `dropLocalWriteToFold`）。同じ id が、畳まれた
    // あとに**本物の削除**でも死んでいることがあり、そのとき `_tombstone.deletedAt`
    // は畳みの時刻より先へ進んでいる。受け取る側が見るのはその `deletedAt` の方
    // （`isShadowedByTombstone`）なので、畳みの記録だけで判断すると
    // **こちらは「相手も採る」と読み、相手は採らない**という食い違いになる。
    await expectConvergence(async (clients, sync) => {
      const [a, b, c] = clients
      ensureTag(b.db, 'g2', 't1', T0)
      upsertTagProfile(b.db, 'g2', 'memo-x', T0)
      await sync()

      // a の g1（t1）は g2 と同着で、辞書順により g1 が勝つ（a は敗者行を持たない
      // 側の畳みを記録する）。同時に b は g2 を**本物の削除**で消す
      ensureTag(a.db, 'g1', 't1', T0)
      upsertTagNote(a.db, 'n1', 'g1', T0)
      b.db.prepare(`DELETE FROM tags WHERE id = 'g2'`).run()
      await sync()

      // c は死んだ id を、**削除より古い時刻**（00:02 < 削除の現在時刻）で作り直し、
      // そこへ子を付け替える。他端末は現在時刻の墓標でこれを拒むので、
      // c が落とさないと c だけがこの親子を持ち続ける
      ensureTag(c.db, 'g2', 't2', T2)
      upsertTagNote(c.db, 'n1', 'g2', T2)
      await sync()
    })
  }, 60000)

  it('親の id が生き返ったら、写された子の畳みの主張はもう止められない', async () => {
    // 規則: **写された畳みの主張は、親の id が生き返っていれば古い判断である**
    // （`conflict/tombstone.ts` の `isShadowedByTombstone`）。この形の表の子の
    // 畳みの主張は「親の id が動いた」という親の決着の写しでしかない。親の畳みは
    // **畳みより新しい版でその id が作り直されれば覆る**（`isShadowedByTombstone`
    // の本体がその行を通す）ので、覆ったあとの写しはその id の到着を止める根拠に
    // ならない。
    //
    // 踏む順序:
    //
    // 1. c が `g3`（t2）とその 1:1 の子を、a が `g2`（t2）を、どちらも 00:00 で作る。
    //    c は a の `g2` を受け取って**同着**になり、決着（生き残る id の辞書順）で
    //    `g3→g2` に畳む —— 子の id も `g2` へ動き、`tag_profiles:g3` に
    //    「`g2` へ畳まれた（00:00）」の墓標が残る
    // 2. a は `g3` を **00:02 で作り直し**（親の id が生き返る）、changelog を削って
    //    相手をフルマージへ落とし、畳みの勝者だった `g2` を消す
    //
    // すると c は、生き返った親 `g3` を受け入れながら、届いた `tag_profiles:g3`
    // （00:00）を**自分が刻んだ 00:00 の畳みの墓標**で同時刻ゆえに拒んでいた。
    // a と b は畳みを経験していないのでその子を持つ。**親が生きているのだから
    // 収束先は「子も生きている」の側**であり、c だけが永久に子を持てなかった
    // （膠着としても報告されない）。
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

  it('親の作り直しで子の畳みを断った端末は、手元の子を名乗り直す', async () => {
    // 規則: **子の畳みを `isIdentityFoldOverruled` で断ったら、手元の子を名乗り直す**
    // （`sync/entries.ts` の `applyTombstoneDelete`）。
    //
    // この形の表で畳みを覆すのは**親の行の新しい版**で、子の行は書き換わらない。
    // 畳みで子を消した端末は、その子のエントリをもう読み終えているので、親が
    // 生き返っても子は二度と流れてこない。
    //
    // 踏む順序（`convergence-properties.test.ts` の反例そのまま、差分経路だけで起きる）:
    //
    // 1. b は `g3`（`t2`）とその子、c は `g1`（`t2`）とその子、さらに `g3`（`t1`）を
    //    どれも 00:00 で作る。`tags:g3` は b と c で同時刻・中身違いの膠着になる
    //    （`Stalemate on tags:g3` として報告される）
    // 2. a と b は b の `g3`（`t2`）と c の `g1`（`t2`）を同着の辞書順で `g3→g1` に
    //    畳み、`tag_profiles:g3` も `g1` へ畳んで消す。c の `g3` は `t1` なので
    //    c では衝突せず、c は子を持ち続ける
    // 3. c が `g3` を `t1`（00:02）へ直す。a/b では `g3` が畳みより新しい版として
    //    生き返るが、`tag_profiles:g3` は届かず、**c だけがその子を持ち続けた**
    //    （その行のキーでは膠着としても報告されない）
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
