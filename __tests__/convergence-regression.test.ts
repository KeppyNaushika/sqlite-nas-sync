/**
 * `convergence-properties.test.ts` が採った反例を、決定的な形へ書き下したもの。
 *
 * 性質テストは反例を毎回同じ形では出さないので、いちど採れた操作列は
 * ここへ手で並べて固定する。主張は性質テストと同じ1つだけ ——
 * **往復すれば全端末の中身は一致する。一致しないなら膠着として報告されている。**
 * 途中の帳簿（`_id_merge` / `_tombstone` / `_changelog`）の形は実装の都合なので
 * 固定しない（そこを固定すると、直し方を変えるたびに落ちる）。
 *
 * ## ここに置いてある操作列では、収束は破れていない
 *
 * 調べた結果、この操作列で収束は破れていなかった。だからこれは「未修理の破れの記録」
 * ではなく、**回帰テスト**として置いてある。
 *
 * ただし**「期待値が正しい」とは別の話**だった。最初にここへ書かれた期待値は
 * 「空のDBに対する削除でも墓標が立つ」という誤った前提から導かれていて、
 * ライブラリではなくテストが間違っていた（詳しくは各 `it` の中に書いた。要点は
 * **0行の DELETE では `AFTER DELETE ... FOR EACH ROW` のトリガが走らない**）。
 * 落ちているテストを見たとき、まず疑うべきは「この期待値はどこから来たのか」である。
 *
 * ## 性質テストの側で落ちて見えるもの —— 走らせる側の罠を書き留めておく
 *
 * 見かけの失敗の**大部分**はディスクの枯渇だったが、**全部ではない**。隔離環境で
 * 96本（19,200ケース）走らせた実測では 92本通過 / 4本失敗（約4.2%）で、
 * 残った4本は本物の破れである（`tag_profiles:g2` / `tag_notes:n1` /
 * `tag_profiles:g3` / `tag_notes:n3` が食い違ったまま、膠着として報告もされない）。
 * **これは子テーブルの族として実在し、別途修理されている。**「ディスクのせい」で
 * 全部を説明してはいけない —— そう数えたために本物の失敗4件を取り逃がした前例がある。
 *
 * 性質テストが落ちたとき、`fast-check` は `Counterexample:` の行を印字する。
 * **これは「収束が破れた」の意味ではない。** `fc` は述語が投げた例外を区別しないので、
 * ディスクが尽きて `SqliteError` が飛んだだけでも同じ行を印字し、しかも縮小まで走って
 * **`Counterexample: [[[[],[],[]]]]`（＝操作列が空）** のような、収束の破れとしては
 * ありえない形を報告する。読むべきは `Caused by:` の行だが、**`Caused by:` の有無は
 * ディスク由来の目印ではない**。本物のアサーション失敗も
 * `Caused by: AssertionError: ... が食い違ったまま` として同じ形で包まれる。
 * 見分けるのは中身で、**`ENOSPC` / `SQLITE_IOERR` / `disk I/O error` が出ているか**
 * だけがディスク由来の印である（この取り違えが、上の4件をディスクのせいと
 * 数え間違えた原因だった）。実測した誤診の内訳:
 *
 * - **ディスクの枯渇。** この性質テストは1回の走行（200件×3端末）で数百MBの空きを
 *   使い、しかもその領域は**プロセスが終わるまで解放されない**（実測: 走行中に
 *   312Mi → 132Mi まで減り、プロセス終了で 1.2Gi へ戻る）。空きが数百MBしか無い
 *   マシンでは走行中に0になり、`ENOSPC`（`fixture.prepare` の `mkdir`）や
 *   `SQLITE_IOERR_SHMSIZE` / `disk I/O error`（`applyOp` の中）で落ちる
 * - **他のテストとの同時実行。** このファイル族は作業ディレクトリを使うので、
 *   同じファイルを2つのプロセスで走らせると互いの `fixture.cleanup()` が相手の
 *   走行中のDBを消し、`SQLITE_IOERR_DELETE_NOENT` で落ちる
 *
 * どちらも操作列とは無関係なので、**シードを replay しても再現しない**。
 * 「replay したら通った」は「直った」ではなく、「そもそも操作列のせいではなかった」
 * ことの証拠になりうる。逆に、上の子テーブルの族のように replay で再現するものは
 * 本物である。
 *
 * ## 走らせ方の注意
 *
 * `convergence-properties.test.ts` と**同時に走らせないこと**。作業ディレクトリは
 * ファイルごとに分けてあるが、同じファイルを2プロセスで走らせると互いの
 * `fixture.cleanup()` が相手の走行中のDBを消す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-convergence-regression')

const CLIENT_IDS = ['client-a', 'client-b', 'client-c'] as const

type Client = {
  id: string
  db: Database.Database
  config: ReturnType<typeof fixture.makeConfig>
}

let clients: Client[]
let warnings: string[]

/** 性質テストが比べる表（`posts` は使わないので入れない）。 */
const WATCHED_TABLES = [
  'users',
  'decisions',
  'tags',
  'tag_notes',
  'tag_profiles',
  'accounts',
]

function client(id: (typeof CLIENT_IDS)[number]): Client {
  const found = clients.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`unknown client: ${id}`)
  return found
}

/**
 * 全端末で1回ずつ `performSync` する。順番は a → b → c に固定してある ——
 * 反例の再現には「誰が先に押し出したか」まで効く。
 */
async function syncAll(): Promise<void> {
  for (const target of clients) {
    const result = await performSync(target.db, target.config, TABLES)
    warnings.push(...result.warnings)
  }
}

/**
 * 比較のために、同期対象の中身だけを取り出す。
 *
 * 時刻列は**時刻として**正規化して持つ。同じ瞬間でも書式は端末ごとに違い
 * （ISO-T と旧版のスペース形式）、LWWは同着の行を書き換えないので字面は揃わない
 * まま残る。これは中身の食い違いではないので、ここでは差と数えない
 * （性質テストの `snapshot` と同じ扱い）。
 */
function snapshot(db: Database.Database): Map<string, Record<string, unknown>> {
  const toJulian = db.prepare(`SELECT julianday(?) AS j`)
  const rows = new Map<string, Record<string, unknown>>()
  for (const table of WATCHED_TABLES) {
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all() as Record<string, unknown>[]) {
      const normalized = { ...row }
      normalized.updatedAt =
        (toJulian.get(String(normalized.updatedAt)) as { j: number | null })
          .j ?? String(normalized.updatedAt)
      rows.set(`${table}:${String(row.id)}`, normalized)
    }
  }
  return rows
}

/** 全端末の総当たりで食い違っている行のキー（`表:id`）を挙げる。 */
function allDifferingKeys(): string[] {
  const snapshots = clients.map((target) => snapshot(target.db))
  const keys = new Set<string>()
  for (let i = 0; i < snapshots.length; i += 1) {
    for (let j = i + 1; j < snapshots.length; j += 1) {
      const all = new Set([...snapshots[i].keys(), ...snapshots[j].keys()])
      for (const key of all) {
        if (
          JSON.stringify(snapshots[i].get(key)) !==
          JSON.stringify(snapshots[j].get(key))
        ) {
          keys.add(key)
        }
      }
    }
  }
  return [...keys].sort()
}

/**
 * 状態が動かなくなるまで回したうえで、残った食い違いが**膠着として報告されている**
 * ことを確かめる（性質テストが主張しているものと同じ）。
 *
 * 押し出しが pull より先なので片道1回では相手の変更は届かず、3端末では
 * 「AがBの判断を取り込み、それをCが受け取る」まで数えるので余分に回す必要がある。
 */
async function expectConverged(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    if (allDifferingKeys().length === 0) break
    await syncAll()
  }

  for (const key of allDifferingKeys()) {
    const [table, id] = key.split(':')
    expect(
      warnings.some(
        (warning) =>
          warning.startsWith('Stalemate on ') &&
          warning.includes(`${table}:${id}`)
      ),
      `${key} が食い違ったまま、膠着として報告もされていない\n` +
        clients
          .map(
            (target) =>
              `${target.id}: ${JSON.stringify(snapshot(target.db).get(key))}`
          )
          .join('\n') +
        `\nwarnings: ${JSON.stringify(warnings)}`
    ).toBe(true)
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
  for (const target of clients) target.db.close()
  fixture.cleanup()
})

describe('性質テストが採った操作列（決定的な形）', () => {
  it('ほとんどが削除で、1端末だけが旧版のスペース書式で書いても収束する', async () => {
    // 性質テストが縮小して報告してきた操作列そのまま（1ラウンドだけ）。
    //
    // 特徴は3つ。**ほとんどが空のDBに対する削除**、**`c` だけが旧版のスペース書式**で
    // 時刻を書いている、**同期を挟まない1ラウンド**。
    //
    // ## この操作列では墓標が1つも立たない —— 同じ誤解を繰り返さないための記録
    //
    // 以前ここには「空のDBへの削除でも `a` には現在時刻の墓標が立つ」と書いてあり、
    // それを前提に「`a` の現在時刻の墓標が `c` の 00:00:01 の行に勝つので `g2` は
    // どこにも残らない」という期待値が置かれていた。**前提が誤りで、期待値も誤り**
    // だった（この期待値のまま落ちていた）。
    //
    // 削除の追跡は `AFTER DELETE ON <表> FOR EACH ROW` のトリガで行うので、
    // **消える行が0件ならトリガは1度も走らない**。実測（`tags` が空のDBで
    // `DELETE FROM tags WHERE id = 'g2'`）:
    //
    //     changes: 0 / _changelog: 0 件 / _tombstone: 0 件
    //
    // 比較のため、実在する行を消した場合は `changes: 1` で `_changelog` に DELETE が
    // 1 行、`_tombstone` に 1 行載る。つまりここでの4つの削除 —— `a` の
    // `users:u1` / `tags:g2` と `b` の `tags:g1` / `tag_profiles:g1` は、**どれも空振りで
    // 何の主張も残さない**。「削除したのだから削除の主張が伝わるはず」と読むと、
    // この操作列の収束先を丸ごと読み違える。
    //
    // したがって `tags:g2` を主張しているのは `c` だけで、`c` の行が素直に全端末へ
    // 届く。**正しい収束先は「全端末が `tags:g2` を持つ」**である。
    //
    // なお「旧版のスペース書式が混ざっても収束するか」という元の狙いは、この操作列
    // だけでは検証できない（突き合わせる相手が居ないので、書式の比べ方は結果に出ない）。
    // その検証は下の `it` で、**墓標が実際に立つ操作列**と**同日1秒差の書式混在**として
    // 別に置いてある。
    const a = client('client-a')
    const b = client('client-b')
    const c = client('client-c')

    // a: deleteUser u1 / deleteTag g2
    a.db.prepare(`DELETE FROM users WHERE id = 'u1'`).run()
    a.db.prepare(`DELETE FROM tags WHERE id = 'g2'`).run()

    // b: upsertUser u3 / deleteTag g1 / upsertAccount a2 / deleteTagProfile g1
    b.db
      .prepare(
        `INSERT INTO users (id, name, updatedAt)
         VALUES ('u3', 'Alice', '2026-01-01T00:00:02.000Z')`
      )
      .run()
    b.db.prepare(`DELETE FROM tags WHERE id = 'g1'`).run()
    b.db
      .prepare(
        `INSERT INTO accounts (id, username, email, updatedAt)
         VALUES ('a2', 'uB', 'eB', '2026-01-01T00:00:01.000Z')`
      )
      .run()
    b.db.prepare(`DELETE FROM tag_profiles WHERE id = 'g1'`).run()

    // c: upsertTag g2 —— **旧版のスペース書式**で時刻を書く
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt)
         VALUES ('g2', 't1', '2026-01-01 00:00:01')`
      )
      .run()

    await syncAll()
    await expectConverged()

    // 収束先も固定しておく（「揃っていれば何でもよい」では、全端末から行が
    // 消えても通ってしまう）。**空振りの削除は何も主張しない**ので、
    // 生き残るのは誰かが作った行だけ。
    // - `users:u3` と `accounts:a2` は `b` が作った行。誰も消していないので全端末に在る
    //   （`a` の `users:u1` の削除は空振りで、`u3` とは関係が無い）
    // - `tags:g2` は `c` が作った行。`a` の削除は空振りで墓標が立たないため
    //   突き合わせる相手が居ず、そのまま全端末へ届く。**書式（スペース）も
    //   `c` が書いたまま残る**（LWWは同着の行を書き換えない）
    for (const target of clients) {
      expect(
        target.db.prepare(`SELECT id FROM users ORDER BY id`).all()
      ).toEqual([{ id: 'u3' }])
      expect(
        target.db.prepare(`SELECT id FROM accounts ORDER BY id`).all()
      ).toEqual([{ id: 'a2' }])
      expect(
        target.db
          .prepare(`SELECT id, name, updatedAt FROM tags ORDER BY id`)
          .all()
      ).toEqual([{ id: 'g2', name: 't1', updatedAt: '2026-01-01 00:00:01' }])
    }
  })

  /**
   * 上の操作列から抜け落ちた「書式混在」の検証を、**成立する形**で置き直したもの。
   *
   * 上では削除が空振りで墓標が立たず、時刻の比べ方が結果に現れなかった。ここでは
   * **先に行を作ってから消す**ことで墓標を実際に立て、さらに行どうしの突き合わせも
   * 作って、`julianday()` による正規化が効いていることを中身で確かめる。
   */
  it('旧版のスペース書式が混ざっても、勝ち負けが時刻として決まる', async () => {
    const a = client('client-a')
    const b = client('client-b')
    const c = client('client-c')

    // (A) **本物の削除の版** vs 古い時刻の行。
    //
    // **原則2 で期待値が変わった。** 0.20.0 までは、削除の版の `_sns_ts` は
    // 消される直前の行の時刻だったので、あとから届いた 2026-01-01 00:00:01 の
    // 行が勝ち、`g7` は残った。いまは `DELETE` も1つの変更として、
    // **削除を実行した時刻**で比べる。`a` が消したのはこの試験を走らせた
    // 「いま」なので、2026年の書き込みより後であり、`g7` は消えたままになる。
    //
    // 書式混在（`julianday()` による正規化）の検証は (B) が持っている。
    // ここでは日付が離れてしまい、字面でも時刻でも同じ答えになる。
    a.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt)
         VALUES ('g7', 'n7a', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    a.db.prepare(`DELETE FROM tags WHERE id = 'g7'`).run()
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt)
         VALUES ('g7', 'n7c', '2026-01-01 00:00:01')`
      )
      .run()

    // (B) 行 vs 行、**同日・1秒差で書式だけ違う**。ここが書式混在の肝。
    // 時刻として見れば `c`（00:00:01）が `b`（00:00:00）より後なので `c` が勝つ。
    // ところが字面で比べると同日では ' '(0x20) < 'T'(0x54) となり、スペース書式の
    // `c` が常に小さく扱われて `b` が勝ってしまう。**どちらが勝ったかは `name` に
    // 出る**ので、`julianday()` の正規化が外れたらこのテストは `n9b` を見て落ちる
    // （日付が違う組み合わせでは字面と時刻の答えが一致してしまい、検証にならない。
    // だから 1 秒差の同日にしてある）。
    b.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt)
         VALUES ('g9', 'n9b', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    c.db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt)
         VALUES ('g9', 'n9c', '2026-01-01 00:00:01')`
      )
      .run()

    await syncAll()
    await expectConverged()

    for (const target of clients) {
      expect(
        target.db.prepare(`SELECT id, name FROM tags ORDER BY id`).all()
      ).toEqual([{ id: 'g9', name: 'n9c' }])
    }
  })
})
