/**
 * 3つのクライアントが同じ状態へ収束することを、無作為な操作列で確かめる。
 *
 * 同期の正しさは、どのクライアントでどの順に取り込んでも同じ答えに落ち着くことに尽きる。
 * 個別の筋書きを1本ずつ書いても、順序の組み合わせは手では並べきれない。
 * ここでは操作列そのものを fast-check に作らせ、**結果の一致だけ**を主張する。
 *
 * クライアントは3つにしてある。
 * 2つだと相手は1人しかおらず、あるクライアントで統合した結果を3人目が別の変更とともに持ち込む形が出ない。
 *
 * わざと多く起こしているもの:
 *
 * - **同じ時刻と書式違い。** 時刻は少ない種類から引き、書式も ISO-T と旧版のスペース形式を混ぜる。
 *   同じ時刻の変更は付則1 の `_sns_lamport` と `_sns_instance` で決まるので、そこを多く通らせる。
 * - **統合。** 別の主キーで同じ `UNIQUE` の値を作ると統合が起きる。
 *   `decisions.cellKey`・`tags.name`・`accounts` の2本の `UNIQUE` を、それぞれ2〜3種類しかない値から引くので、別の主キーで同じ値が頻繁に生まれる。
 *   さらに `tag_notes` と `tag_profiles` を足して、子行を持つ親行が統合される形を作る。
 *   `tag_notes` は列で親行を指す子行で、`tag_profiles` は親行と主キーを共有する子行である。
 * - **フルマージ。** `_changelog` に隙間があると `hasChangelogGap` が真になり、フルマージに切り替わる。
 *   操作列に `_changelog` の先頭を消す操作を混ぜて、差分同期とフルマージの両方を通らせる。
 * - **削除。** 各表に削除を用意し、操作をラウンドに分けて間に同期を挟む。
 *   これで、統合と削除が別々のクライアントから並行して届く順序が出る。
 *
 * ## 旧方式でこのテストが見つけた不具合
 *
 * ここから「シードは外してある」の前までは、0.19 までの旧方式の記録である。
 * 旧方式は、相手の `_changelog` を LWW で取り込み、`UNIQUE` の衝突を「畳み」として行ごとに解いていた。
 * どれも旧方式では修正済みだった。
 * 各項目の「→」の後ろは旧方式での修正で、そこに挙げた関数とファイルは、案A への移行で経路ごと消えた。
 * 当時の決定的な試験の多くも、旧方式の仕組みを直接試すものだったので、案A への移行で消した。
 * 案A でも意味のある筋書きは、全クライアントの一致を確かめる回帰試験として次のファイルに残してある。
 *
 * - `child-before-parent.test.ts`
 * - `shared-primary-key.test.ts`
 * - `merge-winner-changes.test.ts`
 * - `write-after-full-merge.test.ts`
 * - `fk-missing-parent.test.ts`
 *
 * どれも、旧方式で黙って食い違ったまま残った形だった。
 *
 * - `deduplicateEntries` が、同じ行なら最後の id を採っていた。
 *   `mergeChangelog` が取り込んだ相手のエントリを元の `changedAt` のまま新しい id で書くので、id 順と時刻順が食い違い、削除が古い INSERT に隠れて届かなかった。
 *   → 旧方式での修正: 時刻で選び、同じ時刻なら相手の現在の中身と合う方を採った。`sync/state.ts`。
 * - 逆向きで同じ時刻の畳みの主張が互いを打ち消して振動した。
 *   → 旧方式での修正: 同じ時刻なら生き残る id の辞書順で決めた。`conflict/ledger.ts`。
 * - 消えた親を指す子が素通しで入り、COMMIT 時の外部キー違反で取り込みが毎回巻き戻った。
 *   → 旧方式での修正: `ON DELETE` に従った。`conflict/remap.ts`。
 * - アプリケーションが削除より古い時刻で書いた行が、書いたクライアントだけに残り続けた。
 *   畳まれて消えた id へ書き直した行も同じ形だった。
 *   → 旧方式での修正: `sync/self-check.ts`。
 * - 畳み先が畳みのあとに消されていると、片方は削除済みの id を復活させ、片方は届かない勝者を待ち続けた。
 *   → 旧方式での修正: 一群の削除をこの行の削除として扱った。`sync/entries.ts`。
 * - 畳みで子の id が動いた行が、フルマージ中はトリガーが外れていて `_changelog` に載らず、フルマージしたクライアントにだけ残った。
 *   → 旧方式での修正: 手で載せた。`conflict/fold-changelog.ts`。
 * - こちらのバージョンが新しいので採らなかったことを、相手へ伝えていなかった。
 *   相手はこちらのエントリを読み終えているので、古いバージョンを持ったまま直らなかった。
 *   → 旧方式での修正: 採らなかった側が自分のバージョンを名乗り直した。`sync/entries.ts`。
 * - 畳みで id が動いた 1:1 の子が、古い id への削除で消えなかった。
 *   → 旧方式での修正: 主キーが外部キーを兼ねる表に限り、削除の id を動いた先へ読み替えた。`sync/entries.ts`。
 * - 畳まれた id が新しいバージョンで作り直されたのに、同じ取り込みで届いたその子だけが畳み先へ読み替えられ、勝者の行を上書きした。
 *   → 旧方式での修正: 読み替えてよいかを、取り込み元の作り直しも見て決めた。`conflict/remap.ts`。
 *
 * ### 畳みと削除が並行して届く族
 *
 * - 親の畳みから導いた読み替えが、無関係な行を消していた。
 *   親と主キーを共有する 1:1 の子は、親が畳まれると子の主キーも動いたので、古い id への削除を動いた先へ読み替えていた。
 *   動いた先に別の子がもともとあったときはその推測が外れ、行を持っていないクライアントは現在時刻の墓標を立てて、あとから届く行を拒み続けた。
 *   → 旧方式での修正: 親の帳簿から導いた読み替えは、その行が手元にあるときだけ採った。`sync/entries.ts`。
 * - 畳む向きがクライアントどうしで食い違ったまま追いつけなかった。
 *   負けた向きを先に記録したクライアントでは、その id の墓標が勝ち残る行の到着を止めた。
 *   → 旧方式での修正: 墓標の取り消しを公開事実として載せた。`conflict/tombstone.ts` の `isTombstoneRevoked`。
 *
 * ### 親と主キーを共有する 1:1 の子の族
 *
 * `tag_profiles` の族は3回に1回くらいしか当たらなかったので、5回連続で通ったことで直ったと誤認されていた。
 *
 * - 子だけが親と逆向きに畳まれ、`UNIQUE constraint failed: tag_profiles.id` の例外で取り込みが止まった。
 *   子の畳みの主張の時刻は子の行のバージョンで、親の畳みの時刻と無関係に並んだ。
 *   → 旧方式での修正: この形の表の向きを親の帳簿で決めた。`conflict/ledger.ts` の `readIdentityOwnerVerdict`。
 * - 読み替えて別の id を消したのに、その削除を公開していなかった。
 *   → 旧方式での修正: 手で載せた。`sync/entries.ts` の `applyTombstoneDelete`。
 * - 写されただけの削除を、相手で最後に起きたこととして採っていた。
 *   → 旧方式での修正: 相手の現在の中身と合う方を先に採った。`sync/state.ts`。
 * - 畳まれた id がそのあと削除でも消えているとき、削除より古い時刻で書き直した行の扱いがクライアントごとに食い違った。
 *   書いたクライアントは `_id_merge.mergedAt` とだけ比べ、相手は現在時刻の墓標で拒んだ。
 *   → 旧方式での修正: 2つの主張の両方と比べた。`sync/self-check.ts`。
 *
 * ### 親の作り直しと、主張の配達
 *
 * どちらも当たりは5回に1回ほどだった。
 *
 * - 親の id が作り直されたのに、写された子の畳みが効いたままで、子だけが1台から消えた。
 *   → 旧方式での修正: `conflict/identity.ts` の `isIdentityFoldOverruled`。
 * - 決着したのに、勝ち残る行と新しい主張が相手へ届かなかった。
 *   → 旧方式での修正: 主張と一緒に届いた勝者行を採る `takeFoldWinnerRow` と、公開済みかを時刻も見て決める `recordMergeWithoutLocalRow`。
 *
 * ### 届く順と、削除の配達
 *
 * どちらも当たりは4%ほどだった。
 *
 * - 子が親より先に届き、そのあと親が畳まれると、外部キー違反で取り込みが止まり続けた。
 *   → 旧方式での修正: 畳みを受け入れた id を指す子を勝者へ移した。`conflict/fold.ts` の `repointChildrenOfFoldedAwayId`。
 * - ある id が消えたことを1台だけが知っているとき、その id へ書かれた行が書いたクライアントに残り続けた。
 *   → 旧方式での修正: 採らなかった側が削除を名乗り直した。`sync/entries.ts` の `advertiseLocalDeath`。
 *
 * ### `UNIQUE` の値の入れ替わりと、子の再配達
 *
 * 当たりは3%ほどだった。
 *
 * - フルマージで主キーごと読み替えて入れた子が公開されず、フルマージしたクライアントにだけ残った。
 *   → 旧方式での修正: `conflict/fold-changelog.ts` の `publishRemappedIdentity`。
 * - 親の作り直しで子の畳みを断ったクライアントが、子を名乗り直さなかった。
 *   → 旧方式での修正: `sync/entries.ts` の `applyTombstoneDelete` で `advertiseLocalRow` を呼んだ。
 *
 * ## シードは外してある
 *
 * `{ numRuns: 200 }` のまま、シードを固定せずに走らせている。
 * 当たりが5回に1回の族があったので、5回連続で通っただけでは直った証拠にならない。
 * **落ちたら、主張を緩めるのではなく反例を書き下して直すこと。**
 * 反例は `Counterexample:` の行にある。
 * `child-before-parent.test.ts` のように決定的な形へ書き下してから直す。
 *
 * **このファイルは単独で走らせること。**
 * ファイル DB と作業ディレクトリを使うので、他のテストと同時に走らせると互いの DB を消し合って偽の失敗が出る。
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

/** 時刻の種類は絞る。同じ時刻の変更を多く出すためである。 */
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
  /** `_changelog` の先頭を消して隙間を作り、相手をフルマージへ切り替えさせる */
  | { kind: 'pruneChangelog' }

/**
 * 操作は少ない種類の値から引く。
 * 主キーと `UNIQUE` の値の種類を絞るほど、同じ行への並行な変更と、別の主キーでの同じ `UNIQUE` の値が多く出る。
 * 後者が統合である。
 *
 * 主キーは3種類、`UNIQUE` の値は2種類で、**わざと数をずらしてある。**
 * 同じ数にすると、主キーと値が1対1に対応する使い方に寄ってしまい、統合が起きにくい。
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
  // 親行と主キーを共有する 1:1 の子行。
  // 親行が統合されると、子行はユーザーテーブルで統合先の親の主キーで表示される。
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

/** ローカルの制約違反は、そのクライアントでは何も起きなかったことにする。{@link applyOp} を参照。 */
function tolerateConstraint(error: unknown): void {
  const code = (error as { code?: string }).code ?? ''
  if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
}

/**
 * 子を作る前に親を用意する。
 *
 * 親行が無いまま子行を入れると外部キー違反で必ず失敗し、`tag_notes` と `tag_profiles` の操作がほぼ全部何も起こさなくなる。
 * そうなると、子行を持つ親行が統合される形が出ない。
 * 名前は統合が起きる少ない種類の値から引くので、親行の用意そのものが `UNIQUE` の違反で失敗することもある。
 * そのときは子行も作らない。
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
 * ローカルの `UNIQUE` 制約に当たった場合は、そのクライアントでは何も起きなかったことにする。
 * アプリケーションがそう振る舞うことを写している。
 * 統合は、別々のクライアントが別々の主キーで同じ `UNIQUE` の値を作ったときに起きるので、この形でも十分に起きる。
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
 * 比較のために、同期するユーザーテーブルの中身だけを取り出す。
 * 内部テーブルはクライアントごとに違ってよい。
 *
 * 時刻列は書いたままの字面で比べる。
 * 同じ瞬間を別の書式で書いた2つの変更も、付則1 の順序で1つのバージョンに決まり、全クライアントにそのバージョンの字面が入る。
 * 字面が揃わなければ、それは本当の食い違いである。
 */
function snapshot(db: Database.Database): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>()
  for (const table of WATCHED_TABLES) {
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all() as Record<string, unknown>[]) {
      rows.set(`${table}:${String(row.id)}`, { ...row })
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
 * 同期で届いた相手の変更のあとに、こちらがさらに編集する形が出ない。
 * 統合と削除が別々のクライアントから並行して届く形も、そこから生まれる。
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

            // 1回の `performSync` は自分の写しを上げてから相手の写しを読むので、1周では届かない変更がある。
            // クライアントが3つあると、A が B の変更を取り込み、それを C が受け取るまで数周かかる。
            // 中身が一致するか、決めた回数に達するまで回す。
            for (let round = 0; round < 6; round += 1) {
              if (allDifferingKeys(clients).length === 0) break
              await syncAll()
            }

            // 食い違いは1件も許さない。
            // 同じ時刻で中身が違う行も、付則1 により `_sns_instance` で1つに決まる。
            const differing = allDifferingKeys(clients)
            expect(
              differing,
              `クライアントどうしで中身が食い違っている\n` +
                differing
                  .map((key) =>
                    clients
                      .map(
                        (client) =>
                          `${key} ${client.id}: ${JSON.stringify(
                            snapshot(client.db).get(key)
                          )}`
                      )
                      .join('\n')
                  )
                  .join('\n') +
                `\nwarnings: ${JSON.stringify(warnings)}`
            ).toEqual([])
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
