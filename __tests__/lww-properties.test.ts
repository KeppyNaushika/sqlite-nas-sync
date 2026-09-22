/**
 * 時刻の物差し（{@link compareTimestamps}）が満たすべき**性質**を、
 * 無作為な入力で確かめる。
 *
 * ここまでのテストは「見つかった不具合ごとに1本」という積み上げで書かれてきた。
 * それだと、まだ誰も踏んでいない入力の組み合わせ（同じ瞬間 × 違う書式、のような
 * 交点）が空白のまま残る。この形式なら、性質を1つ書けば入力の組み合わせは
 * fast-check が探す。
 *
 * ここで確かめる性質はどれも「2端末が同じ答えに達する」ための前提である。
 * - 三分律: 「後」「前」「同時刻」のちょうど1つが成り立つ
 * - 反対称: 引数を入れ替えると符号だけが反転する
 * - 推移性: 3つ以上が絡んでも順序が一貫する
 * - 書式に依らない: 同じ瞬間なら、どの書式で書かれていても同時刻と答える
 *
 * **行どうしの勝ち負け**（反対称・全域・同着の決着）の性質は、案A では
 * `src/rows/versions.ts` の版の順序が持っている。そちらは
 * `__tests__/rows-versions.test.ts` の「順序が全前順序であること」で
 * 反射・完全性・推移・同着の推移まで確かめてある。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fc from 'fast-check'
import Database from 'better-sqlite3'
import { compareTimestamps } from '../src/sync/timestamp'

let db: Database.Database
beforeAll(() => {
  db = new Database(':memory:')
})
afterAll(() => {
  db.close()
})

/** 秒精度の瞬間（この精度なら、下のどの書式でも同じ瞬間を表せる）。 */
const instantArb = fc
  .integer({
    min: Date.UTC(2020, 0, 1) / 1000,
    max: Date.UTC(2030, 0, 1) / 1000,
  })
  .map((seconds) => seconds * 1000)

/**
 * 同じ瞬間の、書き手ごとに違う書式。
 *
 * 実際に混在する: `updatedAt` はアプリが書くISO-T形式、0.19.0 以前の
 * `_tombstone.deletedAt` / `_changelog.changedAt` は `datetime('now')` の
 * 秒精度スペース形式。
 */
function render(ms: number, style: number): string {
  const iso = new Date(ms).toISOString() // 2026-05-02T02:19:56.000Z
  switch (style) {
    case 0:
      return iso
    case 1:
      return iso.replace('Z', '+00:00')
    case 2:
      return iso.replace('T', ' ').replace('.000Z', '')
    default:
      return iso.replace('.000Z', 'Z')
  }
}

const styleArb = fc.integer({ min: 0, max: 3 })

/** 同じ瞬間を、無作為な2つの書式で書いたもの。 */
const sameInstantPairArb = fc
  .tuple(instantArb, styleArb, styleArb)
  .map(([ms, s1, s2]) => [render(ms, s1), render(ms, s2)] as const)

/** それぞれ無作為な瞬間・無作為な書式で書いたもの。 */
const anyPairArb = fc
  .tuple(instantArb, styleArb, instantArb, styleArb)
  .map(([m1, s1, m2, s2]) => [render(m1, s1), render(m2, s2)] as const)

describe('時刻の比較（性質）', () => {
  it('三分律: 「aが後」「bが後」「同時刻」のちょうど1つが成り立つ', () => {
    fc.assert(
      fc.property(anyPairArb, ([a, b]) => {
        // ここで渡すのはどれも `julianday()` が読める書式なので、
        // 「比べられない」（null）は出てはいけない
        const order = compareTimestamps(db, a, b)
        expect(order).not.toBeNull()
        const results = [order! > 0, order! < 0, order === 0]
        expect(results.filter(Boolean)).toHaveLength(1)
      }),
      { numRuns: 300 }
    )
  })

  it('同じ瞬間なら、書式が違っても「同時刻」と答える', () => {
    // 字面では揃わない（同日でも ' '(0x20) < 'T'(0x54)）。ここが字面比較へ
    // 落ちると、同じ瞬間の2行に前後が付いて端末ごとに違う側が勝つ。
    fc.assert(
      fc.property(sameInstantPairArb, ([a, b]) => {
        expect(compareTimestamps(db, a, b)).toBe(0)
      }),
      { numRuns: 300 }
    )
  })

  it('反対称: 入れ替えると符号だけが反転する', () => {
    // この関数は**端末ごとに a と b が入れ替わって**呼ばれる。両向きとも同じ
    // 符号を返すと、2端末が互いに相手を勝たせて収束しなくなる。
    fc.assert(
      fc.property(anyPairArb, ([a, b]) => {
        // 符号どうしを足して 0 を見る。`-0` と `+0` を区別する `toBe` に
        // 同時刻（0）を渡すと、`-0 !== +0` で落ちてしまう
        const forward = compareTimestamps(db, a, b)
        const backward = compareTimestamps(db, b, a)
        expect(forward).not.toBeNull()
        expect(backward).not.toBeNull()
        expect(Math.sign(forward!) + Math.sign(backward!)).toBe(0)
      }),
      { numRuns: 300 }
    )
  })

  it('推移性: a>b かつ b>c なら a>c', () => {
    const stampArb = fc
      .tuple(instantArb, styleArb)
      .map(([ms, style]) => render(ms, style))
    fc.assert(
      fc.property(stampArb, stampArb, stampArb, (a, b, c) => {
        fc.pre(
          compareTimestamps(db, a, b)! > 0 && compareTimestamps(db, b, c)! > 0
        )
        expect(compareTimestamps(db, a, c)).toBeGreaterThan(0)
      }),
      { numRuns: 400 }
    )
  })

  it('時刻として読めない値は「比べられない」と答える（字面へ落ちない）', () => {
    // 読めない値どうしの字面順には意味が無い。決着の付け方は場面ごとに違うので、
    // ここで勝手に決めずに null を返し、呼び出し元（`deduplicateEntries` は
    // `_changelog.id` で決める）へ渡すこと。
    expect(
      compareTimestamps(db, 'not-a-time', '2026-01-01T00:00:00.000Z')
    ).toBe(null)
    expect(compareTimestamps(db, 'zzz', 'aaa')).toBe(null)
  })
})
