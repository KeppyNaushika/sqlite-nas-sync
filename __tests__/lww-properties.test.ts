/**
 * LWW（Last-Write-Wins）の物差しが満たすべき**性質**を、無作為な入力で確かめる。
 *
 * ここまでのテストは「見つかった不具合ごとに1本」という積み上げで書かれてきた。
 * それだと、まだ誰も踏んでいない入力の組み合わせ（同じ瞬間 × 違う書式 × 同着決着、
 * のような交点）が空白のまま残る。この形式なら、性質を1つ書けば入力の組み合わせは
 * fast-check が探す。
 *
 * ここで確かめる性質はどれも「2端末が同じ答えに達する」ための前提である。
 * - 三分律: 「新しい」「古い」「同時刻」のちょうど1つが成り立つ
 * - 反対称・全域: 2つの行のうち、勝つのはちょうど一方
 * - 推移性: 3つ以上の行が絡んでも順序が一貫する（勝者の選び方が畳み込む順に依らない）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fc from 'fast-check'
import Database from 'better-sqlite3'
import {
  isLaterTimestamp,
  isSameTimestamp,
  isPreferredOverRival,
} from '../src/conflict/timestamp'

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
        const results = [
          isLaterTimestamp(db, a, b),
          isLaterTimestamp(db, b, a),
          isSameTimestamp(db, a, b),
        ]
        expect(results.filter(Boolean)).toHaveLength(1)
      }),
      { numRuns: 300 }
    )
  })

  it('同じ瞬間なら、書式が違っても「同時刻」と答える', () => {
    fc.assert(
      fc.property(sameInstantPairArb, ([a, b]) => {
        expect(isSameTimestamp(db, a, b)).toBe(true)
        expect(isLaterTimestamp(db, a, b)).toBe(false)
        expect(isLaterTimestamp(db, b, a)).toBe(false)
      }),
      { numRuns: 300 }
    )
  })

  it('同時刻の判定は対称', () => {
    fc.assert(
      fc.property(anyPairArb, ([a, b]) => {
        expect(isSameTimestamp(db, a, b)).toBe(isSameTimestamp(db, b, a))
      }),
      { numRuns: 300 }
    )
  })
})

/** 行を1つ作る。 */
function row(id: string, timestamp: string): Record<string, unknown> {
  return { id, updatedAt: timestamp }
}

const idArb = fc.string({ minLength: 1, maxLength: 6 })

describe('勝ち負けの決め方（性質）', () => {
  it('反対称かつ全域: 別idの2行なら、勝つのはちょうど一方', () => {
    // 差は 0 を厚めに引く。**同着こそが危ない**（時刻で決まらないぶんを端末ごとに
    // 違う向きで決めると、互いに相手を勝たせて収束しなくなる）ので、無作為な2つの
    // 瞬間に任せると滅多に踏まない交点を、意図して濃く踏ませる。
    const deltaArb = fc.constantFrom(0, 0, 0, 1000, -1000, 86400000)
    fc.assert(
      fc.property(
        idArb,
        idArb,
        instantArb,
        styleArb,
        deltaArb,
        styleArb,
        (idA, idB, msA, styleA, delta, styleB) => {
          fc.pre(idA !== idB)
          const a = row(idA, render(msA, styleA))
          const b = row(idB, render(msA + delta, styleB))
          const aWins = isPreferredOverRival(db, a, b, 'updatedAt', 'id')
          const bWins = isPreferredOverRival(db, b, a, 'updatedAt', 'id')
          // 端末ごとに row と rival が入れ替わって呼ばれる。ここが両方 false や
          // 両方 true になると、2端末が別々の行を残して収束しない。
          expect(aWins).not.toBe(bWins)
        }
      ),
      { numRuns: 400 }
    )
  })

  it('同じ瞬間を違う書式で書いても、勝つのは主キーの小さい方（端末に依らない）', () => {
    fc.assert(
      fc.property(
        idArb,
        idArb,
        instantArb,
        styleArb,
        styleArb,
        (idA, idB, ms, styleA, styleB) => {
          fc.pre(idA !== idB)
          const a = row(idA, render(ms, styleA))
          const b = row(idB, render(ms, styleB))
          expect(isPreferredOverRival(db, a, b, 'updatedAt', 'id')).toBe(
            idA < idB
          )
        }
      ),
      { numRuns: 400 }
    )
  })

  it('推移性: a>b かつ b>c なら a>c', () => {
    const rowArb = fc
      .tuple(idArb, instantArb, styleArb)
      .map(([id, ms, style]) => row(id, render(ms, style)))
    fc.assert(
      fc.property(rowArb, rowArb, rowArb, (a, b, c) => {
        fc.pre(a.id !== b.id && b.id !== c.id && a.id !== c.id)
        const pref = (x: Record<string, unknown>, y: Record<string, unknown>) =>
          isPreferredOverRival(db, x, y, 'updatedAt', 'id')
        fc.pre(pref(a, b) && pref(b, c))
        expect(pref(a, c)).toBe(true)
      }),
      { numRuns: 400 }
    )
  })

  it('時刻列が無いときは、主キーの辞書順だけで決まる', () => {
    fc.assert(
      fc.property(idArb, idArb, (idA, idB) => {
        fc.pre(idA !== idB)
        const a = row(idA, 'ignored')
        const b = row(idB, 'ignored')
        expect(isPreferredOverRival(db, a, b, null, 'id')).toBe(idA < idB)
      }),
      { numRuns: 200 }
    )
  })
})
