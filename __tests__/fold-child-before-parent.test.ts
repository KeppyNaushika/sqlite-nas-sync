/**
 * **子が親より先に届いて、そのあと親の畳みが決まる**形の族。
 *
 * 差分の取り込みは、相手の `_changelog` を1件ずつ当てていく。並べ替えは
 * `deduplicateEntries` が行うが、その順は**「その行が最初に現れた位置」**であって
 * 「親が先」ではない。したがって、
 *
 * 1. 子（`tag_notes` / `tag_profiles`）が先に入り、
 * 2. そのあと届いた親が `local_wins` で畳まれ、**その id は二度と作られない**と決まる
 *
 * という順序がふつうに起きる。1. の時点では畳みがまだ決まっていないので
 * {@link remapMergedForeignKeys} は読み替える先を知らず、子は素通しで入る。
 *
 * このとき子は**永久に親の無い行**になる。`better-sqlite3` は接続を開くときに
 * `PRAGMA foreign_keys = ON` を入れるので、これは COMMIT 時の
 * `FOREIGN KEY constraint failed` であり、取り込みは1つのトランザクションなので
 * **その相手ぶんの差分が丸ごと巻き戻り `lastSeenId` も進まない** ——
 * 次の同期でも同じ差分を読んで同じ違反を出すため、**その相手からの同期が永久に
 * 止まる**（このライブラリで唯一許されない壊れ方）。しかも止まった端末はその行を
 * 受け取れないので、**膠着としても報告されないまま黙って食い違う**。
 *
 * 直し方は「畳みを受け入れると決めた場所で、その id を指したままの子を勝者へ
 * 付け替える」——判断も実測も `conflict/fold.ts` の
 * `repointChildrenOfFoldedAwayId` 1か所に置いてある。あとから届く子を
 * `remapMergedForeignKeys` が同じ勝者へ向けるのと同じ答えなので、**子が先に着いたか
 * 後に着いたかで結果が変わらなくなる**のが要点である。
 *
 * ここに置いてあるのは `convergence-properties.test.ts`（3端末・無作為な操作列）が
 * 見つけた反例そのまま（seed 1919755847 を10回縮小した3操作）である。
 *
 * **このファイルは自分の作業ディレクトリを持つ**（`sync-fixtures` の注意書きのとおり、
 * ファイルごとに分けないと、片方の後片付けがもう片方の走行中のDBを消す）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-fold-child-before-parent')

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
 * 子を書く前に親を用意する（性質テストの `ensureTag` と同じ形）。
 *
 * **既に在る親の名前は書き換えない**（`DO NOTHING`）。書き換えると、同期で届いていた
 * 相手の名前を潰してしまい、畳みが起きる筋書きそのものが変わる。
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

/** 比べるのは同期対象の中身だけ（帳簿や changelog は端末ごとに違ってよい）。 */
function snapshot(db: Database.Database): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const table of ['tag_notes', 'tag_profiles']) {
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all() as Record<string, unknown>[]) {
      rows.push({ table, ...row })
    }
  }
  return rows
}

/**
 * 操作を当てたあと**状態が動かなくなるまで**同期を回して、2つを主張する:
 *
 * - `Sync failed` が1件も出ない（例外で取り込みが巻き戻っていない）
 * - 子の表（`tag_notes` / `tag_profiles`）の中身が全端末で一致する
 *
 * 親の表（`tags`）は比べない。この族の筋書きは**同じ時刻で名前が違う親**を作るので、
 * `tags` は解けない膠着として残るのが正しい（ちゃんと `Stalemate on tags:…` として
 * 報告される）。壊れているのは子の側で、そこを見たい。
 */
async function expectChildrenConverge(
  play: (clients: Client[]) => void
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
      `子の表が端末どうしで食い違っている\n${describeAll}`
    ).toEqual(snapshots[0])
    expect(
      snapshots[2],
      `子の表が端末どうしで食い違っている\n${describeAll}`
    ).toEqual(snapshots[0])
  } finally {
    for (const client of clients) client.db.close()
  }
}

const T0 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

describe('子が親より先に届いてから親の畳みが決まる', () => {
  it('親を指す普通の子は、その親が畳まれたら勝者へ付け替わる', async () => {
    // 規則: **畳みを受け入れた id を指す子を、手元に残してはいけない**
    //
    // 反例そのまま（性質テスト seed 1919755847 を10回縮小した3操作）:
    //
    // ```
    // client-b: upsertTagNote n3 → g2 (name t1, 00:02)
    //           upsertTagNote n3 → g3 (name t2, 00:00)
    // client-c: upsertTagProfile g2 (name t2, 00:02)
    // ```
    //
    // C から見ると、B の差分には `tag_notes:n3`（親は `g3`）が `tags:g3` より
    // **先**に並ぶ（`n3` が最初に現れるのは1つめの操作）。C は `n3` を素通しで入れ、
    // そのあと届いた `g3`（name `t2`、00:00）を、同じ名前を持つ手元の `g2`（00:02）に
    // 負けたと見て畳む —— `g3` はもう作られないので、`n3` は親の無い行として残り、
    // COMMIT で `FOREIGN KEY constraint failed`。**C は毎周そこで巻き戻り、
    // `tag_notes:n3` を永久に受け取れなかった**（膠着としても報告されない）。
    await expectChildrenConverge(([, b, c]) => {
      ensureTag(b.db, 'g2', 't1', T2)
      upsertTagNote(b.db, 'n3', 'g2', T2)
      ensureTag(b.db, 'g3', 't2', T0)
      upsertTagNote(b.db, 'n3', 'g3', T0)

      ensureTag(c.db, 'g2', 't2', T2)
      upsertTagProfile(c.db, 'g2', 'memo-x', T2)
    })
  }, 60000)
})
