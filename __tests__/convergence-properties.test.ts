/**
 * 3端末が同じ状態へ収束することを、無作為な操作列で確かめる。
 *
 * 同期の正しさは、突きつめれば「どちらの端末で、どの順に適用しても、同じ答えに
 * 落ち着く」の一点である。個別の筋書きを1本ずつ書いても、順序の組み合わせは
 * 手では並べきれない。ここでは操作列そのものを fast-check に作らせ、
 * **結果の一致だけ**を主張する。
 *
 * 端末は3台にしてある。2台だと「相手は1人」しか踏めず、片方の端末で畳んだ結果を
 * 3人目が別の判断とともに持ち込む形（畳みの主張がすれ違う形）が出ない。
 *
 * わざと濃く踏ませているもの:
 *
 * - **同着と書式違い。** 時刻は少ない種類から引き、書式（ISO-T / 旧版のスペース形式）も
 *   混ぜる。同期の一番きわどい交点だからである。
 * - **畳み（fold）。** 別の主キーで同じセカンダリUNIQUEキーを作ると畳みが起きる。
 *   `decisions.cellKey` / `tags.name` / `accounts` の2本のユニークを、それぞれ
 *   2〜3種類しか無い名前空間から引くことで、別idの同じキーが頻繁に生まれる。
 *   さらに `tag_notes`（親を指す子）と `tag_profiles`（親と主キーを共有する子）を
 *   足して、**子を持つ親が畳まれる**形を作る。
 * - **フルマージ経路。** `_changelog` に隙間があると `hasChangelogGap` が真になり
 *   フルマージへ落ちる。操作列に「changelog を掃除する」を混ぜて、通常経路と
 *   フルマージ経路の両方を通らせる。
 * - **削除。** 各表に削除を用意し、操作を**ラウンドに分けて**同期を挟むことで、
 *   畳みの主張と削除の主張がすれ違う順序が出る。
 *
 * ## このテストが見つけた不具合（すべて修正済み）
 *
 * どれも**黙って食い違ったまま残る**（膠着としても報告されない）形だった。
 * 決定的な形は `sync-full-merge-convergence.test.ts` / `changelog-order.test.ts` /
 * `fold-claim-direction.test.ts` / `fold-record-sync.test.ts` / `self-check.test.ts`
 * に1本ずつ置いてある。
 *
 * - `deduplicateEntries` が「同じ行なら最後の id」を採っていた。`mergeChangelog` が
 *   取り込んだ相手のエントリを**元の `changedAt` のまま新しい id**で書くため id 順と
 *   時刻順がねじれ、削除が古い INSERT に覆い隠されて永久に届かなかった
 *   （→ 時刻で選ぶ。同時刻は**相手の現在の中身と話が合う方**を採る。`sync/state.ts`）
 * - 逆向きで同時刻の畳みの主張が互いを打ち消して振動した
 *   （→ 同時刻なら生き残る id の辞書順で決める。`conflict/ledger.ts`）
 * - 消えた親を指す子が素通しで入り、COMMIT 時の外部キー違反で取り込みが恒久的に
 *   巻き戻った（→ `ON DELETE` に従う。`conflict/remap.ts`）
 * - アプリがローカルへ削除より古い時刻で書いた行が、書いた端末だけに残り続けた
 *   （→ `sync/self-check.ts`。**畳まれて死んだ id へ書き直した行**も同じ形）
 * - 畳み先が畳みのあとに消されていると、片方は削除済みの id を復活させ、片方は
 *   届く見込みの無い勝者を永久に待った（→ 一群の死をこの行の死として扱う。
 *   `sync/entries.ts`）
 * - 畳みで**子のidが動いた**行が、フルマージ中はトリガーが外れていて `_changelog` に
 *   載らず、フルマージした端末にだけ残った（→ 手で載せる。`conflict/fold-changelog.ts`）
 * - 「こちらの版が新しいので採らなかった」を相手へ伝えていなかった。相手はこちらの
 *   エントリを読み終えているので、古い版を持ったまま二度と直らなかった
 *   （→ 採らなかった側が自分の版を名乗り直す。`sync/entries.ts`）
 * - 畳みで**id が動いた1:1の子**が、古い id への削除で消えなかった（→ 主キーが
 *   外部キーを兼ねている表に限り、削除の id を動いた先へ読み替える。`sync/entries.ts`）
 * - 畳まれた id が**新しい版で作り直された**のに、同じ取り込みで届いたその子だけが
 *   畳み先へ読み替えられ、勝者の行を上書きした（→ 読み替えの有効性は取り込み元の
 *   作り直しも見る。`conflict/remap.ts`）
 *
 * ## 最後に残っていた族（塞いだ／報告へ寄せた）
 *
 * 最後まで残っていたのは「**畳みと削除がすれ違う**」族で、中身は2つだった。
 * どちらも決定的な形が `fold-crossing-deletion.test.ts` に1本ずつ置いてある。
 *
 * - **親の畳みから導いた読み替えが、無関係な行を殺していた**（`tag_profiles`）。
 *   親と主キーを共有する1:1の子は、親が畳まれると子の主キーそのものが動くので、
 *   古い id への削除を動いた先へ読み替える（`resolveMovedId`）。だが親の記録が
 *   言っているのは「親の id が動いた」ことだけで、「古い id に在った子が今この id に
 *   在る」はこちら側の推測である。動いた先の席を**別の子がもともと持っていた**とき
 *   その推測は外れ、しかも行を持っていない端末は、誰にも伝わらないローカルの墓標を
 *   現在時刻で立てて**あとから届く本物の行を永久に拒んだ**
 *   （→ 親の帳簿から導いた読み替えは、その行が手元に在るときだけ採る。`sync/entries.ts`）
 * - **畳む向きが端末どうしで食い違ったまま追いつけない形**（`accounts`）は、
 *   **解かずに報告する**ことにした。決着（同着は生き残る id の辞書順）は全端末で同じ
 *   答えになるが、負けた向きを先に刻んでしまった端末は、その id の墓標を自分では
 *   取り消せない（取り消すと古い `DELETE` エントリが現在時刻を名乗って他端末の
 *   生きた行を消す）。どちらへ寄せてもどこかで書かれたものが消えるので、
 *   `Stalemate on <表>:<id>` として報告する（理由は
 *   `conflict/merged-delete.ts` の `describeContestedFoldDirection`）
 *
 * **`_id_merge` を判断に使わないこと。** 同期では渡らないローカル索引なので、
 * 判断に混ぜると端末ごとに答えが変わる。この罠は実際に何度も踏んでいる。
 * 判断材料は全端末へ渡るもの（`_tombstone`、`_changelog`、行の中身）だけにする。
 *
 * ## シードは外してある
 *
 * 以前は上の族が塞がっていなかったためシードを固定していたが、いまは
 * `{ numRuns: 200 }` のまま**シードなしで**走らせている（塞いだあと5回連続で通ることを
 * 確かめた）。**落ちたら、主張を緩めるのではなく反例を書き下して直すこと。**
 * 反例（`Counterexample:` の行）は `fold-crossing-deletion.test.ts` や
 * `sync-full-merge-convergence.test.ts` のように決定的な形へ書き下してから直す。
 *
 * **このファイルは単独で走らせること** —— ファイルDBと作業ディレクトリを使うので、
 * 他のテストと同時に走らせると互いのDBを消し合って偽の失敗が出る。
 */
import { describe, it, expect, afterAll } from 'vitest'
import fc from 'fast-check'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const fixture = createSyncFixture('test-data-convergence')

afterAll(fixture.cleanup)

/** 同じ瞬間でも書き手によって書式が違う、という現実をそのまま持ち込む。 */
function render(ms: number, style: number): string {
  const iso = new Date(ms).toISOString()
  return style === 0 ? iso : iso.replace('T', ' ').replace('.000Z', '')
}

const BASE = Date.UTC(2026, 0, 1)

/** 時刻の種類は絞る。同着（＝どちらも勝てない）を濃く出すため。 */
const atArb = fc
  .tuple(fc.constantFrom(0, 1000, 2000), fc.constantFrom(0, 1))
  .map(([delta, style]) => render(BASE + delta, style))

/** 比べる表。`posts` は使わないので入れない（空の表を比べても何も分からない）。 */
const WATCHED_TABLES = [
  'users',
  'decisions',
  'tags',
  'tag_notes',
  'tag_profiles',
  'accounts',
]

type Op =
  | { kind: 'upsertUser'; id: string; name: string; at: string }
  | { kind: 'deleteUser'; id: string }
  | {
      kind: 'upsertDecision'
      id: string
      cellKey: string
      value: string
      at: string
    }
  | { kind: 'deleteDecision'; id: string }
  | { kind: 'upsertTag'; id: string; name: string; at: string }
  | { kind: 'deleteTag'; id: string }
  | {
      kind: 'upsertTagNote'
      id: string
      tagId: string
      tagName: string
      body: string
      at: string
    }
  | { kind: 'deleteTagNote'; id: string }
  | {
      kind: 'upsertTagProfile'
      tagId: string
      tagName: string
      memo: string
      at: string
    }
  | { kind: 'deleteTagProfile'; tagId: string }
  | {
      kind: 'upsertAccount'
      id: string
      username: string
      email: string
      at: string
    }
  | { kind: 'deleteAccount'; id: string }
  /** changelog の頭を削って隙間を作る（＝相手をフルマージへ落とす） */
  | { kind: 'pruneChangelog' }

/**
 * 操作は狭い名前空間から引く。idやユニークキーの種類を絞るほど、
 * 衝突（同じ行への同時更新、別idの同じユニークキー＝畳み）が濃く出る。
 *
 * id の種類とユニークキーの種類は**わざとずらしてある**（id は3種、キーは2種）。
 * 同数にすると「id とキーが1対1に対応する」使い方に寄ってしまい、畳みが起きにくい。
 */
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('upsertUser' as const),
    id: fc.constantFrom('u1', 'u2', 'u3'),
    name: fc.constantFrom('Alice', 'Bob', 'Carol'),
    at: atArb,
  }),
  fc.record({
    kind: fc.constant('deleteUser' as const),
    id: fc.constantFrom('u1', 'u2', 'u3'),
  }),
  fc.record({
    kind: fc.constant('upsertDecision' as const),
    id: fc.constantFrom('d1', 'd2', 'd3'),
    cellKey: fc.constantFrom('c1', 'c2'),
    value: fc.constantFrom('yes', 'no'),
    at: atArb,
  }),
  fc.record({
    kind: fc.constant('deleteDecision' as const),
    id: fc.constantFrom('d1', 'd2', 'd3'),
  }),
  fc.record({
    kind: fc.constant('upsertTag' as const),
    id: fc.constantFrom('g1', 'g2', 'g3'),
    name: fc.constantFrom('t1', 't2'),
    at: atArb,
  }),
  // 子を持つ親の削除（`ON DELETE CASCADE` で子ごと消える）
  fc.record({
    kind: fc.constant('deleteTag' as const),
    id: fc.constantFrom('g1', 'g2', 'g3'),
  }),
  fc.record({
    kind: fc.constant('upsertTagNote' as const),
    id: fc.constantFrom('n1', 'n2', 'n3'),
    tagId: fc.constantFrom('g1', 'g2', 'g3'),
    tagName: fc.constantFrom('t1', 't2'),
    body: fc.constantFrom('note-x', 'note-y'),
    at: atArb,
  }),
  fc.record({
    kind: fc.constant('deleteTagNote' as const),
    id: fc.constantFrom('n1', 'n2', 'n3'),
  }),
  // 親と主キーを共有する1:1の子。親が畳まれると子のidそのものが動く
  fc.record({
    kind: fc.constant('upsertTagProfile' as const),
    tagId: fc.constantFrom('g1', 'g2', 'g3'),
    tagName: fc.constantFrom('t1', 't2'),
    memo: fc.constantFrom('memo-x', 'memo-y'),
    at: atArb,
  }),
  fc.record({
    kind: fc.constant('deleteTagProfile' as const),
    tagId: fc.constantFrom('g1', 'g2', 'g3'),
  }),
  // ユニークが2本ある表。1回の書き込みが索引ごとに別々の相手へぶつかる
  fc.record({
    kind: fc.constant('upsertAccount' as const),
    id: fc.constantFrom('a1', 'a2', 'a3'),
    username: fc.constantFrom('uA', 'uB'),
    email: fc.constantFrom('eA', 'eB'),
    at: atArb,
  }),
  fc.record({
    kind: fc.constant('deleteAccount' as const),
    id: fc.constantFrom('a1', 'a2', 'a3'),
  }),
  fc.record({ kind: fc.constant('pruneChangelog' as const) })
)

/** ローカルの制約違反は「その端末では起きなかった」ことにする（下記 {@link applyOp}）。 */
function tolerateConstraint(error: unknown): void {
  const code = (error as { code?: string }).code ?? ''
  if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
}

/**
 * 子を作る前に親を用意する。
 *
 * 親が居ないまま子を入れると外部キー違反で**必ず**落ち、`tag_notes` /
 * `tag_profiles` の操作がほぼ全部「何も起きなかった」に潰れる（＝子を持つ親を
 * 畳む形が踏めない）。名前は畳みが起きる狭い名前空間から引くので、親の用意そのものが
 * ユニーク衝突で失敗することもある。そのときは子も作らない。
 *
 * @returns 親が居るか（居なければ子は作れない）
 */
function ensureTag(
  db: Database.Database,
  tagId: string,
  tagName: string,
  at: string
): boolean {
  try {
    db.prepare(
      `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(tagId, tagName, at)
  } catch (error) {
    tolerateConstraint(error)
  }
  return db.prepare(`SELECT 1 FROM tags WHERE id = ?`).get(tagId) !== undefined
}

/**
 * 1つの操作をローカルDBへ当てる。
 *
 * ローカルのユニーク制約に当たった場合は**その端末では起きなかった**ことにする
 * （アプリ側がそう振る舞う）。同期の畳みは、別々の端末が別々のidで同じ
 * ユニークキーを作ったときに起きるので、この形でも十分に踏める。
 */
function applyOp(client: Client, op: Op): void {
  const db = client.db
  try {
    switch (op.kind) {
      case 'upsertUser':
        db.prepare(
          `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt`
        ).run(op.id, op.name, op.at)
        break
      case 'deleteUser':
        db.prepare(`DELETE FROM users WHERE id = ?`).run(op.id)
        break
      case 'upsertDecision':
        db.prepare(
          `INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET cellKey = excluded.cellKey, value = excluded.value, updatedAt = excluded.updatedAt`
        ).run(op.id, op.cellKey, op.value, op.at)
        break
      case 'deleteDecision':
        db.prepare(`DELETE FROM decisions WHERE id = ?`).run(op.id)
        break
      case 'upsertTag':
        db.prepare(
          `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt`
        ).run(op.id, op.name, op.at)
        break
      case 'deleteTag':
        db.prepare(`DELETE FROM tags WHERE id = ?`).run(op.id)
        break
      case 'upsertTagNote':
        if (!ensureTag(db, op.tagId, op.tagName, op.at)) break
        db.prepare(
          `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET tagId = excluded.tagId, body = excluded.body, updatedAt = excluded.updatedAt`
        ).run(op.id, op.tagId, op.body, op.at)
        break
      case 'deleteTagNote':
        db.prepare(`DELETE FROM tag_notes WHERE id = ?`).run(op.id)
        break
      case 'upsertTagProfile':
        if (!ensureTag(db, op.tagId, op.tagName, op.at)) break
        db.prepare(
          `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET memo = excluded.memo, updatedAt = excluded.updatedAt`
        ).run(op.tagId, op.memo, op.at)
        break
      case 'deleteTagProfile':
        db.prepare(`DELETE FROM tag_profiles WHERE id = ?`).run(op.tagId)
        break
      case 'upsertAccount':
        db.prepare(
          `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET username = excluded.username, email = excluded.email, updatedAt = excluded.updatedAt`
        ).run(op.id, op.username, op.email, op.at)
        break
      case 'deleteAccount':
        db.prepare(`DELETE FROM accounts WHERE id = ?`).run(op.id)
        break
      case 'pruneChangelog':
        pruneChangelog(client)
        break
    }
  } catch (error) {
    tolerateConstraint(error)
  }
}

/** 1端末ぶんの持ち物。 */
type Client = {
  id: string
  db: Database.Database
  config: ReturnType<typeof fixture.makeConfig>
  /** 他の端末が「この端末をどこまで読んだか」を引くためのDB（自分以外） */
  peers: Client[]
}

/**
 * この端末の changelog の頭を削り、**まだ誰も読んでいない位置まで**巻き込む。
 *
 * 既読ぶん（相手の `lastSeenId` まで）だけを消しても隙間にはならない
 * （`hasChangelogGap` の境界は `minId === lastSeenId + 1`）。相手が次に読むはずだった
 * 1件を巻き込むところまで消して、はじめて相手はフルマージへ落ちる。
 * 誰の読み位置を基準にするかは**いちばん遅れている相手**で決める（そこを消せば
 * 全員にとって隙間になる）。
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

/**
 * 比較のために、同期対象の中身だけを取り出す（帳簿や changelog は端末ごとに違ってよい）。
 *
 * 時刻列は**時刻として**正規化して持つ。同じ瞬間でも書式は端末ごとに違い
 * （ISO-T と旧版のスペース形式）、LWWは同着の行を書き換えないので、字面は
 * 揃わないまま残る。これは中身の食い違いではないので、ここでは差と数えない。
 */
function snapshot(db: Database.Database): Map<string, Record<string, unknown>> {
  const toJulian = db.prepare(`SELECT julianday(?) AS j`)
  const rows = new Map<string, Record<string, unknown>>()
  for (const table of WATCHED_TABLES) {
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all() as Record<string, unknown>[]) {
      const normalized = { ...row }
      const raw = normalized.updatedAt
      normalized.updatedAt =
        (toJulian.get(String(raw)) as { j: number | null }).j ?? String(raw)
      rows.set(`${table}:${String(row.id)}`, normalized)
    }
  }
  return rows
}

/**
 * 2つのスナップショットの食い違いを、行のキー（`表:id`）で挙げる。
 */
function differingKeys(
  a: Map<string, Record<string, unknown>>,
  b: Map<string, Record<string, unknown>>
): string[] {
  const keys = new Set([...a.keys(), ...b.keys()])
  return [...keys]
    .filter((key) => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)))
    .sort()
}

/** 全端末の総当たりで食い違っている行のキーを挙げる。 */
function allDifferingKeys(clients: Client[]): string[] {
  const snapshots = clients.map((client) => snapshot(client.db))
  const keys = new Set<string>()
  for (let i = 0; i < snapshots.length; i += 1) {
    for (let j = i + 1; j < snapshots.length; j += 1) {
      for (const key of differingKeys(snapshots[i], snapshots[j])) {
        keys.add(key)
      }
    }
  }
  return [...keys].sort()
}

const CLIENT_IDS = ['client-a', 'client-b', 'client-c']

/**
 * 1ラウンドぶんの計画（端末ごとの操作列）。
 *
 * ラウンドに分けるのが要点である。全部の操作を先に当ててから同期すると、
 * 「同期で届いた相手の判断のあとに、こちらがさらに編集する」形——畳みの主張と
 * 削除の主張がすれ違う形——が出ない。
 */
const roundArb = fc.array(fc.array(opArb, { maxLength: 4 }), {
  minLength: CLIENT_IDS.length,
  maxLength: CLIENT_IDS.length,
})

describe('3端末の収束（性質）', () => {
  it('どんな操作列でも、往復すれば全端末の中身は一致する', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(roundArb, { minLength: 1, maxLength: 3 }),
        async (rounds) => {
          fixture.prepare()
          const clients: Client[] = CLIENT_IDS.map((id) => {
            const { db, dbPath } = fixture.createClientDb(id)
            return {
              id,
              db,
              config: fixture.makeConfig(dbPath, id),
              peers: [],
            }
          })
          for (const client of clients) {
            client.peers = clients.filter((other) => other !== client)
          }

          const warnings: string[] = []
          const syncAll = async (): Promise<void> => {
            for (const client of clients) {
              warnings.push(
                ...(await performSync(client.db, client.config, TABLES))
                  .warnings
              )
            }
          }

          try {
            for (const round of rounds) {
              round.forEach((ops, index) => {
                for (const op of ops) applyOp(clients[index], op)
              })
              await syncAll()
            }

            // 押し出しが pull より先なので、片道1回では相手の変更は届かない。
            // 端末が3台あると「AがBの判断を取り込み、それをCが受け取る」まで
            // 数えるので、2台より多く回す必要がある。状態が動かなくなるまで回す。
            for (let round = 0; round < 6; round += 1) {
              if (allDifferingKeys(clients).length === 0) break
              await syncAll()
            }

            // 残った食い違いは**膠着として報告されていること**。
            // 同じ時刻で中身が違う行はライブラリには解けない（どちらを採っても
            // 片方の編集を消す）ので、解かずに知らせるのが設計上の答えである。
            // 黙って食い違ったまま残るなら、それは不具合。
            for (const key of allDifferingKeys(clients)) {
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
                      (client) =>
                        `${client.id}: ${JSON.stringify(
                          snapshot(client.db).get(key)
                        )}`
                    )
                    .join('\n') +
                  `\nwarnings: ${JSON.stringify(warnings)}`
              ).toBe(true)
            }
          } finally {
            for (const client of clients) client.db.close()
            fixture.cleanup()
          }
        }
      ),
      // 試す数は 200（手元で25〜35秒）。**シードは固定しない** —— 毎回違う操作列を
      // 試させるのがこのテストの値打ちで、固定すると同じ200本しか踏まなくなる。
      // 落ちたら、反例（`Counterexample:` の行）を決定的な形へ書き下してから直すこと
      // （冒頭の「シードは外してある」を参照）。
      { numRuns: 200 }
    )
  }, 300000)
})
