/**
 * **畳みと削除がすれ違う形**で3端末が収束しなかった筋書きを、手で並べたもの。
 *
 * どちらも `convergence-properties.test.ts` が無作為な操作列から掘り出した反例で、
 * **黙って食い違ったまま残る**（膠着としても報告されない）という壊れ方をしていた。
 * 性質テストは反例を毎回同じ形では出さないので、突き止めた機構をここへ決定的な形で
 * 固定しておく。
 *
 * 2本は表も違うが、根は1つである。**畳みは「この2つの id は同じ1行だった」と決める
 * ことなので、その id への削除がどの行に効くかが端末ごとに変わる。**
 *
 * 2本で主張が違う。1本目（`accounts`）は**解けない**と結論した形で、主張するのは
 * 「食い違うなら膠着として報告される」こと。2本目（`tag_profiles`）は直した形で、
 * 主張するのは「往復すれば全端末の中身が一致する」こと。
 *
 * 途中の帳簿の形は実装の都合なので固定しない（そこを固定すると、直し方を変えるたびに
 * 落ちる）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-fold-crossing-deletion')

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

/**
 * 性質テストの `applyOp` と同じく、ローカルのユニーク制約違反は
 * 「その端末では起きなかった」ことにする（アプリ側がそう振る舞う）。
 */
function tolerateConstraint(run: () => void): void {
  try {
    run()
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
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

describe('畳みと削除がすれ違う形の収束', () => {
  it('畳む向きが食い違って追いつけない形は、膠着として報告される', async () => {
    // **畳みの向きが端末ごとに違うまま、片方の勝者が消される形。**
    //
    // `a1`（00:01）と `a2`（00:02）は `username` が同じなので畳みが起きる。C はまず
    // 「新しい方が勝つ」で `a1→a2` を畳む。そのあと `a1` が 00:02 へ更新されて**同着**に
    // なり、そこから見ると決着は変わる —— 同着は生き残る id の辞書順で決めるので
    // `a2→a1` である。B は `a1` の新しい版しか見ていないので、その逆向きを畳む。
    // 決着は全端末で同じ（`a1` が生き残る）が、**負けた向きを刻んでしまった A/C は
    // `a1` の墓標を自分では取り消せない**ので、`a1` を受け取れない。
    //
    // さらに C が `a2` を消す。C から見れば `a2` はその一群の生きている唯一の行で
    // あり、消すとは「このアカウントを消す」ことである。ところが `a2` は B では
    // ただの死んだ id なので、B はその削除を素通りさせて `a1` を持ち続ける。
    //
    // **どちらへ寄せても、どこかで書かれたものが消える**（理由は
    // `conflict/merged-delete.ts` の `describeContestedFoldDirection`）。
    // 解けないものは解かずに報告する、というこのライブラリの決め事に従う ——
    // ここで主張するのは**膠着として報告されること**である。
    const b = client('client-b')
    const c = client('client-c')

    b.db
      .prepare(
        `INSERT INTO accounts (id, username, email, updatedAt)
         VALUES ('a1', 'uA', 'eB', '2026-01-01T00:00:01.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO accounts (id, username, email, updatedAt)
         VALUES ('a2', 'uA', 'eA', '2026-01-01T00:00:02.000Z')`
      )
      .run()
    await syncAll()
    // 前提: C は「新しい方が勝つ」で a1→a2 を畳んでおり、a2 だけを持っている
    expect(rowsOf(c.db, 'accounts')).toEqual([
      {
        id: 'a2',
        username: 'uA',
        email: 'eA',
        updatedAt: '2026-01-01T00:00:02.000Z',
      },
    ])

    // B は a1 を 00:02 へ（＝a2 と同着へ）更新する。同着の決着は辞書順なので、
    // ここから先 B は逆向き（a2→a1）を畳む
    b.db
      .prepare(
        `UPDATE accounts SET email = 'eA', updatedAt = '2026-01-01T00:00:02.000Z'
         WHERE id = 'a1'`
      )
      .run()
    // C は自分の手元で生きている唯一の行を消す
    c.db.prepare(`DELETE FROM accounts WHERE id = 'a2'`).run()

    await syncUntilSettled()

    // 例外で取り込みが巻き戻る形だけは許されない（その相手からの同期が止まる）
    expect(
      warnings.filter((warning) => warning.startsWith('Sync failed'))
    ).toEqual([])

    // 食い違いが残るなら、**膠着として報告されている**こと。
    // 収束していればそれでよい（実装が追いつけるようになった場合）。
    const snapshots = clients.map((c2) => rowsOf(c2.db, 'accounts'))
    const settled = snapshots.every(
      (rows) => JSON.stringify(rows) === JSON.stringify(snapshots[0])
    )
    if (!settled) {
      expect(
        warnings.some((warning) =>
          warning.startsWith('Stalemate on accounts:a1')
        ),
        `accounts:a1 が食い違ったまま、膠着として報告もされていない\n` +
          clients
            .map(
              (c2) => `${c2.id}: ${JSON.stringify(rowsOf(c2.db, 'accounts'))}`
            )
            .join('\n') +
          `\nwarnings: ${JSON.stringify(warnings)}`
      ).toBe(true)
    }

    // いま実際に起きているのは「B だけが a1 を持つ」形。これが変わったら
    // （収束するようになったら）上の分岐が拾うので、ここは実態の記録として置く
    expect(rowsOf(b.db, 'accounts')).toEqual([
      {
        id: 'a1',
        username: 'uA',
        email: 'eA',
        updatedAt: '2026-01-01T00:00:02.000Z',
      },
    ])
  })

  it('親の畳みから導いた読み替えは、その行を手元に持っている端末だけが行う', async () => {
    // **親と主キーを共有する1:1の子（`tag_profiles`）の削除を、親の畳みの記録だけを
    // 根拠に読み替えると、無関係な行を殺す形。**
    //
    // 親の記録が言っているのは「親の id が動いた」ことだけで、「古い id に在った子が
    // 今この id に在る」はこちらの推測である。動いた先の席は**別の子がもともと
    // 持っていた**ことがあり、そのときこの推測は外れる。
    //
    // 筋書き: C は `tags:g2`（name = t2）を作り、その子 `tag_profiles:g2` を作って
    // すぐ消し、そのあと**別の親の子** `tag_profiles:g1` を作る。A/B は
    // `tags:g2→g1` を畳んでいるので、`tag_profiles:g2` の削除を `g1` へ読み替える
    // —— ところが A/B はその行を持っていないので、**誰にも伝わらないローカルの墓標**を
    // 現在時刻で立てるだけになる。C の `tag_profiles:g1`（00:00）はその墓標に負けて
    // 二度と入らず、**C だけがその行を持ち続けた**（膠着としても報告されない）。
    //
    // 行が手元に在るなら読み替えてよい。そのときは実際に消せて、その DELETE が
    // `_changelog` と `_tombstone` から全端末へ渡るので、推測が当たっていたことも
    // 外れていたことも、そこから先は同じ1つの事実として共有される。
    const b = client('client-b')
    const c = client('client-c')

    // A/B が持つことになる親。C は同じ name を**別id**で作るので畳みの種になる
    b.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g1', 't2', '2026-01-01T00:00:02.000Z')`
      )
      .run()
    // C は g1 を**別の name**で埋めてある —— これで `tags:g1` は同時刻・中身違いの
    // 膠着になり、`tags:g2` の畳みだけが A/B で起きる
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES ('g1', 't1', '2026-01-01T00:00:02.000Z')`
      )
      .run()
    await syncAll()

    // C が `tags:g2`（name = t2。A/B の g1 と衝突する）と、その1:1の子を作って消す
    tolerateConstraint(() =>
      c.db
        .prepare(
          `INSERT INTO tags (id, name, updatedAt) VALUES ('g2', 't2', '2026-01-01T00:00:00.000Z')`
        )
        .run()
    )
    c.db
      .prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES ('g2', 'memo-x', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    c.db.prepare(`DELETE FROM tag_profiles WHERE id = 'g2'`).run()
    // **別の親の子**。A/B が `tags:g2→g1` を畳むと、上の削除がこの id へ読み替わる
    c.db
      .prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES ('g1', 'memo-x', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    await syncUntilSettled()

    expectSameTable('tag_profiles')
    // 消されたのは `g2` の子だけ。`g1` の子は生きて全端末へ渡る
    expect(rowsOf(b.db, 'tag_profiles')).toEqual([
      { id: 'g1', memo: 'memo-x', updatedAt: '2026-01-01T00:00:00.000Z' },
    ])

    // `tags:g1` は同時刻・中身違いなので解けない。**解かずに報告する**のが設計上の答え
    expect(
      warnings.some((warning) => warning.startsWith('Stalemate on tags:g1')),
      `tags:g1 の膠着が報告されていない\nwarnings: ${JSON.stringify(warnings)}`
    ).toBe(true)
  })
})
