/**
 * 3端末が収束しなかった形を、1本ずつ手で並べたもの。
 *
 * どれも `convergence-properties.test.ts` が無作為な操作列から掘り出した反例で、
 * **黙って食い違ったまま残る**（膠着としても報告されない）という壊れ方をしていた。
 * 性質テストは反例を毎回同じ形では出さないので、突き止めた機構をここへ決定的な形で
 * 固定しておく。
 *
 * どの本も「往復すれば全端末の中身が一致する」だけを主張する。途中の帳簿の形は
 * 実装の都合なので固定しない（そこを固定すると、直し方を変えるたびに落ちる）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-full-merge-convergence')

const CLIENT_IDS = ['client-a', 'client-b', 'client-c'] as const

type Client = {
  id: string
  db: Database.Database
  config: ReturnType<typeof fixture.makeConfig>
}

let clients: Client[]
let warnings: string[]

/** `clients[0]` = a, `[1]` = b, `[2]` = c。 */
function client(id: (typeof CLIENT_IDS)[number]): Client {
  const found = clients.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`unknown client: ${id}`)
  return found
}

/**
 * 全端末で1回ずつ `performSync` する。
 *
 * 押し出しが pull より先なので、片道1回では相手の変更は届かない。順番は毎回同じに
 * 固定してある（a → b → c）—— 反例の再現には「誰が先に押し出したか」まで効くため。
 */
async function syncAll(): Promise<void> {
  for (const c of clients) {
    const result = await performSync(c.db, c.config, TABLES)
    warnings.push(...result.warnings)
  }
}

/** 状態が動かなくなるまで回す（3端末なので中継のぶんだけ余分に要る）。 */
async function syncUntilSettled(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await syncAll()
  }
}

/** 比較のために表の中身を取り出す。 */
function rowsOf(db: Database.Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
}

/** 全端末でその表の中身が一致していること（一致しない行を読める形で見せる）。 */
function expectSameTable(table: string): void {
  const snapshots = clients.map((c) => ({
    id: c.id,
    rows: rowsOf(c.db, table),
  }))
  const detail =
    snapshots.map((s) => `${s.id}: ${JSON.stringify(s.rows)}`).join('\n') +
    `\nwarnings: ${JSON.stringify(warnings)}`
  for (const snapshot of snapshots.slice(1)) {
    expect(snapshot.rows, `${table} が全端末で揃っていない\n${detail}`).toEqual(
      snapshots[0].rows
    )
  }
}

beforeEach(() => {
  fixture.prepare()
  warnings = []
  clients = CLIENT_IDS.map((id) => {
    const { db, dbPath } = fixture.createClientDb(id)
    return { id, db, config: fixture.makeConfig(dbPath, id) }
  })
})

afterEach(() => {
  for (const c of clients) c.db.close()
  fixture.cleanup()
})

describe('フルマージを挟んだ3端末の収束', () => {
  it('写してきたエントリが、同じ時刻の自分の DELETE を覆い隠さない', async () => {
    // `mergeChangelog` は取り込んだ相手のエントリを**元の `changedAt` のまま、
    // 新しく採番したid**で書く。`changedAt` が同じミリ秒だと時刻では差が付かず、
    // `deduplicateEntries` が id で決めると**写してきた UPDATE が自分の DELETE を
    // 覆い隠す**。しかもその行は写した側のDBに無いので、取り込み側は
    // `if (!remoteRecord) continue` で捨て、`lastSeenId` だけが進む ——
    // 削除は二度と届かない（警告も出ない）。
    const a = client('client-a')
    const b = client('client-b')
    const c = client('client-c')

    a.db
      .prepare(
        `INSERT INTO decisions (id, cellKey, value, updatedAt)
         VALUES ('d1', 'c1', 'yes', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    await syncAll()
    await syncAll()
    // 前提: 3端末とも d1 を持っている（ここが崩れていると以降は何も試せない）
    for (const target of clients) {
      expect(rowsOf(target.db, 'decisions')).toHaveLength(1)
    }

    // B が行を消す（削除時刻は「今」）。A は同じ行をもっと新しい版へ更新する
    b.db.prepare(`DELETE FROM decisions WHERE id = 'd1'`).run()
    a.db
      .prepare(
        `UPDATE decisions SET value = 'no', updatedAt = '2026-01-01T00:00:02.000Z'
         WHERE id = 'd1'`
      )
      .run()
    await performSync(a.db, a.config, TABLES)

    // **`mergeChangelog` が作る並びを、ここで手で作る。** 本物の経路は
    // 「B が A をフルマージで取り込む」ことでこの形になるが、そのためには A の
    // changelog に隙間を開ける必要があり、すると C も同じ隙間を見てフルマージへ落ちる
    // ——`applyTombstones` が B の `_tombstone` を全件読むので、**試したい差分経路を
    // そもそも通らなくなる**。壊れていたのは並びの読み方なので、並びだけを作る。
    //
    // 写してきたエントリは**相手が書いた `changedAt` のまま、新しく採番したid**で入る
    // （`mergeChangelog` はそう書く。理由はその関数のコメント）。`changedAt` が
    // 同じミリ秒だと時刻では差が付かず、id で決めると**写してきた書き込みが自分の
    // DELETE を覆い隠す**。しかもその行は B のDBに無いので、取り込み側は
    // `if (!remoteRecord) continue` で捨て、`lastSeenId` だけが進む ——
    // B の削除は二度と届かない（警告も出ない）。
    //
    // 時刻は**今**にする。固定の日付を書くと保持期間（既定7日）を過ぎたときに
    // `cleanupChangelog` がこのエントリを刈り、相手から見て隙間になる（同じ理由で
    // 差分経路を通らなくなる）。
    const tie = new Date().toISOString()
    b.db
      .prepare(
        `UPDATE _changelog SET changedAt = ?
         WHERE tableName = 'decisions' AND recordId = 'd1' AND operation = 'DELETE'`
      )
      .run(tie)
    b.db
      .prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
         VALUES ('decisions', 'd1', 'UPDATE', ?)`
      )
      .run(tie)

    // 写してきた書き込みの方が id が大きい（＝id で決めると DELETE が負ける）こと
    const order = b.db
      .prepare(
        `SELECT operation FROM _changelog
          WHERE tableName = 'decisions' AND recordId = 'd1' ORDER BY id`
      )
      .all() as { operation: string }[]
    expect(order).toHaveLength(3)
    expect(order[1].operation).toBe('DELETE')
    expect(order[2].operation).toBe('UPDATE')

    // C は B から差分で取り込む。ここで DELETE が選ばれなければ収束しない
    // B が押し出して、この並びを C から読める場所へ置く
    await performSync(b.db, b.config, TABLES)
    expect(rowsOf(b.db, 'decisions')).toEqual([])

    const pull = await performSync(c.db, c.config, TABLES)
    expect(pull.hadChangelogGap).toBe(false)
    expect(rowsOf(c.db, 'decisions')).toEqual([])

    await syncUntilSettled()

    expectSameTable('decisions')
    expect(rowsOf(c.db, 'decisions')).toEqual([])
  })

  it('畳み先が消されていれば、敗者行もその一群の死をもって消える', async () => {
    // 畳み先（勝ち残った行）が、畳みのあとで消されることがある。
    // 手元に無いその勝者行を取り込み元から読んで入れると**削除済みの id が復活**し
    // （次の `performSync` で自分の self-check が消す）、逆に「畳み先が見つからない」
    // として敗者行を残すと**届く見込みの無い勝者を永久に待つ**。
    // どちらも収束しない。畳まれた先が死んでいるなら、この行も一緒に死んでいる。
    const a = client('client-a')
    const b = client('client-b')
    const c = client('client-c')

    const upsertAccount = (
      db: Database.Database,
      id: string,
      at: string
    ): void => {
      db.prepare(
        `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, 'uA', 'eA', ?)`
      ).run(id, at)
    }

    // C が a3 を作り、押し出す
    upsertAccount(c.db, 'a3', '2026-01-01T00:00:02.000Z')
    await syncAll()

    // A も同じユニークキーの行を別idで作る（畳みの種）
    upsertAccount(a.db, 'a1', '2026-01-01T00:00:02.000Z')
    // B は同じ id を作ってから消す ——「a1 は消えた」という**新しい**削除を持つ
    upsertAccount(b.db, 'a1', '2026-01-01T00:00:00.000Z')
    b.db.prepare(`DELETE FROM accounts WHERE id = 'a1'`).run()
    // さらに B は別idで同じユニークキーの行を作る
    upsertAccount(b.db, 'a2', '2026-01-01T00:00:00.000Z')

    await syncUntilSettled()

    expectSameTable('accounts')
    // a1 の削除がいちばん新しいので、一群ごと消えているのが答え
    expect(rowsOf(a.db, 'accounts')).toEqual([])
  })

  it('畳みで動いた子のidが、フルマージでも差分経路に載る', async () => {
    // 親と主キーを共有する1:1の子（`tag_profiles`）は、親が畳まれると**子のidそのものが
    // 動く**。動いた先の行は「相手からもらった行」ではなく**この端末でidが動いて
    // 生まれた姿**で、他端末には送り主から「古いidは畳まれた」という削除しか届かない。
    // ふだんは UPDATEトリガがその1行を記録するが、フルマージはトリガーを外して走るので
    // 記録が生まれず、**フルマージした端末にだけその行が残った**。
    const a = client('client-a')
    const c = client('client-c')

    // A は tags g1（name = t2）。changelog の頭を削って、他端末をフルマージへ落とす。
    // **2件目の書き込みが要る。** 頭を削って changelog が空になると
    // `hasChangelogGap` は隙間と呼ばない（空は「掃除で全部消えた」とも「まだ何も
    // 起きていない」とも読めないため。理由はその関数のコメント）。1件残しておけば
    // `MIN(id) > lastSeenId + 1` で隙間になる。
    a.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g1', 't2', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    a.db
      .prepare(
        `INSERT INTO decisions (id, cellKey, value, updatedAt)
         VALUES ('d9', 'c9', 'yes', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    a.db.prepare(`DELETE FROM _changelog WHERE id <= 1`).run()

    // C は別idで同じ name の tags と、その1:1の子を持つ
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g2', 't2', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES ('g2', 'memo-x', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    // A が押し出してから C が取り込む。ここが**トリガーを外したフルマージ**で、
    // 畳みも子のidの移動もこの中で起きる
    await performSync(a.db, a.config, TABLES)
    const fullMerge = await performSync(c.db, c.config, TABLES)
    expect(fullMerge.hadChangelogGap).toBe(true)
    expect(rowsOf(c.db, 'tag_profiles')).toEqual([
      { id: 'g1', memo: 'memo-x', updatedAt: '2026-01-01T00:00:00.000Z' },
    ])

    await syncUntilSettled()

    expectSameTable('tags')
    expectSameTable('tag_profiles')
    // 同時刻の畳みは主キーの辞書順で決まる（g1 < g2）。子のidも g1 へ動く
    expect(rowsOf(c.db, 'tag_profiles')).toEqual([
      { id: 'g1', memo: 'memo-x', updatedAt: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('採らなかった側が自分の版を名乗り直すので、古い版を持つ端末が直る', async () => {
    // 相手はこちらの `_changelog` を `lastSeenId` より後ろだけ読む。こちらの新しい版の
    // エントリがその位置より**手前**にあると（＝相手は一度それを読んでいる）、
    // こちらが黙って採らないかぎり相手は古い版を持ったまま二度と直らない。
    const a = client('client-a')
    const c = client('client-c')

    a.db
      .prepare(
        `INSERT INTO accounts (id, username, email, updatedAt)
         VALUES ('a2', 'uA', 'eA', '2026-01-01T00:00:01.000Z')`
      )
      .run()
    await syncAll()
    await syncAll()
    for (const target of clients) {
      expect(rowsOf(target.db, 'accounts')).toHaveLength(1)
    }

    // C のアプリが同じ行を**古い時刻**で書き直す（`updatedAt` に過去を入れた形）。
    // A はLWWどおり採らない。名乗り直しが無いと、C だけが 00:00 を持ち続ける。
    c.db
      .prepare(
        `UPDATE accounts SET username = 'uB', updatedAt = '2026-01-01T00:00:00.000Z'
         WHERE id = 'a2'`
      )
      .run()

    await syncUntilSettled()

    expectSameTable('accounts')
    expect(rowsOf(a.db, 'accounts')).toEqual([
      {
        id: 'a2',
        username: 'uA',
        email: 'eA',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    ])
  })

  it('畳みで id が動いた1:1の子は、古い id への削除でも消える', async () => {
    // 親と主キーを共有する1:1の子は、親が畳まれると**その子の主キーそのものが動く**。
    // 1行が名前を変えただけなので、その行への削除は動いた先へ届かなければならない。
    // 届かないと、動かした端末には行が残り、先に消した端末には無い —— **その行の
    // 存在そのものが永久に食い違う**（膠着としても報告されない）。
    //
    // しかも**子が後から届いた端末では、動かしたのは `repointChild` ではなく
    // `remapMergedForeignKeys`** で、そちらは畳みの記録を書かない（書き換えているのは
    // 届いた行の外部キーの列であって、手元の行を動かしたわけではないため）。
    // 移動そのものは**親の畳みの記録**に載っているので、そちらも引く。
    const b = client('client-b')
    const c = client('client-c')

    // B は tags g2（name = t2）
    b.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g2', 't2', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    // C は同じ name を**別id**で持ち（畳みの種）、その1:1の子も持つ。
    // さらに g2 の席を**別の name**で埋めてある —— これで B の g2 は C に入れず
    // （同時刻・中身違いの膠着）、**C だけが畳みを知らないまま**になる。
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g2', 't1', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g3', 't2', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES ('g3', 'memo-x', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    // C の changelog に隙間を作る（他端末をフルマージへ落とす）。1件は残すこと
    c.db.prepare(`DELETE FROM _changelog WHERE id <= 1`).run()

    // 1周だけ回す。**C が畳みを知る前に**消させたいので、ここで止める
    // （押し出しが pull より先なので、1周では C の行はまだ誰にも届いていない）。
    await syncAll()
    expect(rowsOf(c.db, 'tag_profiles')).toEqual([
      { id: 'g3', memo: 'memo-x', updatedAt: '2026-01-01T00:00:00.000Z' },
    ])

    // C が**古い id で**その行を消す。この先で A と B はその行を受け取り、
    // 畳みに合わせて id を g2 へ動かす —— 削除がそこへ届かなければ収束しない
    c.db.prepare(`DELETE FROM tag_profiles WHERE id = 'g3'`).run()

    await syncUntilSettled()

    expectSameTable('tag_profiles')
    expect(rowsOf(c.db, 'tag_profiles')).toEqual([])
  })

  it('畳まれた id が新しい版で作り直されたら、その子は畳み先へ読み替えない', async () => {
    // 畳みの敗者idは死んでいるが、**畳みより新しい版で作り直せば生き返る**
    // （`isShadowedByTombstone` がそれを通す）。そのとき、同じ取り込みで届いた
    // その子だけを畳み先へ読み替えると、子は勝者の行を上書きし、作り直した端末にだけ
    // 元の子が残る。読み替えの有効性は**ローカルの敗者行**だけでなく、
    // 取り込み元に作り直された行があるかも見る（`makeResurrectionProbe`）。
    const a = client('client-a')
    const c = client('client-c')

    a.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g1', 't1', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g3', 't1', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES ('g3', 'memo-x', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    await syncAll()
    // 同時刻なので主キーの辞書順で g1 が勝ち、C の g3 は g1 へ畳まれる
    expect(rowsOf(c.db, 'tags')).toEqual([
      { id: 'g1', name: 't1', updatedAt: '2026-01-01T00:00:00.000Z' },
    ])

    // C が死んだ id を**新しい版で**作り直す（別の name なのでユニークは衝突しない）
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g3', 't2', '2026-01-01T00:00:01.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES ('g3', 'memo-y', '2026-01-01T00:00:01.000Z')`
      )
      .run()

    await syncUntilSettled()

    expectSameTable('tags')
    expectSameTable('tag_profiles')
    // 作り直した g3 とその子が全端末に居ること（勝者 g1 の子を上書きしていないこと）
    expect(rowsOf(a.db, 'tag_profiles')).toEqual([
      { id: 'g1', memo: 'memo-x', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'g3', memo: 'memo-y', updatedAt: '2026-01-01T00:00:01.000Z' },
    ])
  })
})
