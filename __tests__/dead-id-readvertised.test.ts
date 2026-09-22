/**
 * **その id が死んだことを知っているのが1台だけ**のときの族。
 *
 * 差分同期は相手の `_changelog` を `lastSeenId` より後ろだけ読む。だから「この id は
 * 死んだ」を告げるエントリが相手の読み位置より**手前**にあると（＝相手は一度それを
 * 読み終えている、あるいは掃除で消えている）、その相手には二度と流れない。
 *
 * そこへ相手のアプリが**同じ id へ書く**と、
 *
 * - こちらは `isShadowedByTombstone` どおり採らず（墓標の方が新しい）、
 * - 相手はその死を知らないので、書いた行を持ち続け、
 * - `sync/self-check.ts` は**自分の帳簿に載っている死**しか見ないので気づけない
 *
 * ——**書いた端末だけがその行を持ち続けます**（膠着としても報告されません）。
 *
 * 直し方は `advertiseLocalRow`（「こちらの版が新しいので採らなかった」を名乗り直す）
 * と同じ形で、**行が無い側**の名乗り直し（`sync/entries.ts` の
 * `advertiseLocalDeath`）である。書くのは DELETE 1行だけで、意味（ただの削除か
 * 畳みか）は `_tombstone` の行が運ぶので、受け取った側はふだんの削除とまったく同じ
 * 経路で決着させる。
 *
 * **同着では名乗らない**のが要点で、そこは `fold-crossing-deletion.test.ts` が
 * 固定している別の族（畳む向きが食い違い、墓標の取り消しで決着する形）と重なる ——
 * 同着の死を配ると、決着では**生き残るはずの行**を全端末から消してしまう。
 *
 * ここに置いてあるのは `convergence-properties.test.ts`（3端末・無作為な操作列）が
 * 見つけた反例そのまま（seed 1318613340）である。
 *
 * **このファイルは自分の作業ディレクトリを持つ**（`sync-fixtures` の注意書きのとおり、
 * ファイルごとに分けないと、片方の後片付けがもう片方の走行中のDBを消す）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-dead-id-readvertised')

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

/** ローカルのユニーク違反は「その端末では起きなかった」ことにする（性質テストと同じ）。 */
function tolerateConstraint(error: unknown): void {
  const code = String((error as { code?: string }).code ?? '')
  if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
}

/** 子を書く前に親を用意する。用意できなければ子も作らない（性質テストと同じ）。 */
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
 * この端末の changelog の頭を削り、**まだ誰も読んでいない位置まで**巻き込む
 * （＝相手をフルマージ経路へ落とす）。性質テストの `pruneChangelog` と同じ。
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

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('死を知っているのが1台だけのとき', () => {
  it('死んだ id へ書かれた行は、死を知っている端末が名乗り直して消える', async () => {
    // 規則: **採らなかった理由がこちらでの死なら、その死を名乗り直す**
    //
    // 反例そのまま（性質テスト seed 1318613340）。要点だけ書くと:
    //
    // 1. A/B は `tags:g2` を `g1` へ畳む（`g2` は全端末で永久に死ぬ）
    // 2. C は changelog に隙間を作られてフルマージへ落ちており、この畳みの
    //    エントリを読む位置を通り過ぎる
    // 3. そのあと C のアプリが `tags:g2`（00:00）を書く
    //
    // A/B は墓標（畳み。時刻は `g2` の版より新しい）で採らず、畳みの DELETE エントリは
    // C の読み位置より手前なので二度と流れない ——**C だけが `tags:g2` を持ち続けた**
    // （膠着としても報告されない）。
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

      // 2ラウンド目。`pruneChangelog` が相手をフルマージへ落とす
      upsertTag(a.db, 'g1', 't2', T0)
      pruneChangelog(a)
      upsertTagNote(b.db, 'n1', 'g2', 't2', T0)
      c.db.prepare(`DELETE FROM tags WHERE id = 'g3'`).run()
      await syncAll()

      // 3ラウンド目。C は `g2` が畳まれて死んだことを知らないまま、その id へ書く
      upsertTag(c.db, 'g2', 't1', T0)
      await syncAll()

      // 状態が動かなくなるまで回す（押し出しが pull より先なので片道では届かない）
      for (let round = 0; round < 6; round += 1) await syncAll()

      // 例外で取り込みが巻き戻る形だけは許されない（その相手からの同期が止まる）
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
        `端末どうしで中身が食い違っている\n${describeAll}`
      ).toEqual(snapshots[0])
      expect(
        snapshots[2],
        `端末どうしで中身が食い違っている\n${describeAll}`
      ).toEqual(snapshots[0])
    } finally {
      for (const client of clients) client.db.close()
    }
  }, 60000)
})
