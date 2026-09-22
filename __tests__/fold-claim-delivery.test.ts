/**
 * **畳みの主張が相手へ届かない**形を2つ留める。
 *
 * 畳む向きの決着そのものは全端末で同じ答えになる（`fold-claim-direction.test.ts`）。
 * ここで見るのはそのあと —— **決着したのに追いつけない**形である。差分同期は相手の
 * `_changelog` を `lastSeenId` より後ろだけ読むので、
 *
 * - 勝ち残る行のエントリを**もう読み終えている**端末には、その行が二度と流れない
 * - 主張そのものを**公開しなかった**端末の判断は、誰にも伝わらない
 *
 * どちらも、決着は正しいのに1台だけが違う中身を持ったまま止まる（膠着としても
 * 報告されない）。どちらも `convergence-properties.test.ts`（3端末・無作為な操作列）が
 * 見つけた反例を決定的な形へ書き下したもので、各 `it` の頭にどの規則を留めているかを書いた。
 *
 * **このファイルは自分の作業ディレクトリを持つ**（`sync-fixtures` の注意書きのとおり、
 * ファイルごとに分けないと、片方の後片付けがもう片方の走行中のDBを消す）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-fold-claim-delivery')

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

/** ローカルの制約違反は「その端末では起きなかった」ことにする（性質テストと同じ）。 */
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

/** 子を書く前に親を用意する。既に在る親の名前は書き換えない（性質テストの `ensureTag`）。 */
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

const WATCHED = ['tags', 'tag_notes', 'tag_profiles']

/** 比べるのは同期対象の中身だけ（帳簿や changelog は端末ごとに違ってよい）。 */
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

/** 全端末の総当たりで食い違っている行のキー（`表:id`）。 */
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
 * 操作を当てたあと**状態が動かなくなるまで**同期を回し、性質テストと同じことを主張する:
 *
 * - `Sync failed` が1件も出ない（例外で取り込みが巻き戻っていない）
 * - 残った食い違いは**膠着として、その行のキーで**報告されている
 *
 * 「一致する」ではなく「食い違うなら報告されている」にしているのは、同時刻で中身が
 * 違う行（＝どちらも勝てない）はライブラリには解けないためである。解かずに知らせるのが
 * 設計上の答えで、**黙って食い違うのが不具合**である。
 */
async function expectConvergenceOrStalemate(
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
    for (let round = 0; round < 6; round += 1) {
      if (differingKeys(clients).length === 0) break
      await syncAll()
    }

    expect(
      warnings.filter((warning) => warning.startsWith('Sync failed')),
      `取り込みが例外で巻き戻っている（その相手からの同期は永久に止まる）\n` +
        JSON.stringify(warnings, null, 2)
    ).toEqual([])

    for (const key of differingKeys(clients)) {
      expect(
        warnings.some(
          (warning) =>
            warning.startsWith('Stalemate on ') && warning.includes(key)
        ),
        `${key} が食い違ったまま、膠着として報告もされていない\n` +
          clients
            .map(
              (client) =>
                `${client.id}: ${snapshot(client.db).get(key) ?? '無'}`
            )
            .join('\n') +
          `\nwarnings: ${JSON.stringify(warnings, null, 2)}`
      ).toBe(true)
    }
  } finally {
    for (const client of clients) client.db.close()
  }
}

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('決着したあと、畳みの主張と勝者行が相手へ届くか', () => {
  it('向きが覆った端末は、主張と一緒に届いた勝者行を受け取れる', async () => {
    // 規則: **畳めなかったときでも、主張が指している勝者行はふつうの取り込みとして採る**
    // （`sync/entries.ts` の `takeFoldWinnerRow`）。
    //
    // 覆った向きを刻んでしまった端末には、勝ち残る行が**二度と流れてこない** ——
    // 差分同期は相手の `_changelog` を `lastSeenId` より後ろだけ読むので、勝者行の
    // エントリを既に読み終えている端末（読んだ時点では自分の向きに従って畳んで
    // 捨てた）は、向きが覆っても同じエントリを読み直せない。墓標の取り消しは
    // 「もう止めない」までしか言えず、行そのものを連れて来ない。
    //
    // 踏む順序: `tags:g2`（a 00:00 / b 00:02）と `tags:g3`（c 00:02）が同じ名前 t1 を
    // 取り合う。c は**古い版の g2**しか見ていないので `g2→g3`（新しい方が勝つ）を
    // 刻むが、全端末が揃った時点での正しい決着は同着の辞書順で `g3→g2` である。
    // そのあと c が g3 を消すので、c には g2 も g3 も無い。
    await expectConvergenceOrStalemate(async (clients, sync) => {
      const [a, b, c] = clients
      upsertTag(a.db, 'g2', 't1', T0)
      upsertTag(b.db, 'g2', 't1', T2)
      upsertTag(c.db, 'g3', 't1', T2)
      await sync()

      // b は畳みの勝者に 1:1 の子を付け、c は自分が生き残らせた g3 を消す
      if (ensureTag(b.db, 'g3', 't2', T0)) upsertTagProfile(b.db, 'g3', T0)
      c.db.prepare(`DELETE FROM tags WHERE id = 'g3'`).run()
      await sync()
    })
  }, 60000)

  it('作り直された id の畳みは、勝者idが同じでも新しい主張として公開される', async () => {
    // 規則: **「既に公開済みの主張」は勝者idだけでは決まらない。時刻も見る**
    // （`conflict/fold-changelog.ts` の `recordMergeWithoutLocalRow`）。
    //
    // 畳まれた id は**畳みより新しい版で作り直せば生き返る**ので、同じ2つの id が
    // 別の版でもう一度衝突する。そのときの畳みは新しい判断（時刻は新しい勝者行の版）
    // であって、前の畳みとは別の事実である。勝者idが同じだからと公開を省くと、
    // 作り直した端末には**古い時刻の主張しか届かない** —— その端末では
    // 「作り直した行の方が新しい」ので畳みを断り続け、その端末だけが行を持ち続ける。
    //
    // 踏む順序: `tags:g3`(c 00:00) が `tags:g1`(00:00) へ畳まれたあと、a が g1 を
    // t2 へ改名し（この改名は b の t1 と同時刻で**膠着**する）、さらに g3 を
    // 00:02 で作り直す。a では g1 が t2 なので g3(t1) は衝突せず残るが、
    // b/c では g1 が t1 なので同じ名前を取り合って `g3→g1`（00:02）へ畳まれる。
    // その新しい主張が a へ届かないと、a だけが g3 とその 1:1 の子を持ち続ける。
    await expectConvergenceOrStalemate(async (clients, sync) => {
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

      // 畳まれて消えた `g3` を、畳みより新しい時刻で作り直す（1:1 の子つき）
      if (ensureTag(a.db, 'g3', 't1', T2)) upsertTagProfile(a.db, 'g3', T2)
      await sync()
    })
  }, 60000)
})
