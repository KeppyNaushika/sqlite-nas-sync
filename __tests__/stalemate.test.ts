/**
 * **解けないものは、解けないと報告する** —— 膠着（どちらも勝てない食い違い）の言葉づかい。
 *
 * ライブラリはこの食い違いを解けない。どちらが正しいかはドメインの意味で決まるので、
 * 勝手に片方を選べば必ずどちらかの編集が消える。だから報告するしかないのだが、
 * ここで**黙る条件を広げすぎると**、収束しない食い違いが誰にも知らされないまま残る。
 * 逆に狭すぎると、設定のずれだけで中身の違う行の数だけ警告が出て読めなくなる。
 *
 * その境目を形で固定する。
 */
import { describe, it, expect } from 'vitest'
import {
  describeStalemate,
  isSameStoredValue,
  STALEMATE_COLUMNS_SHOWN,
} from '../src/conflict/stalemate'

const AT = '2026-01-15T00:00:00.000Z'

describe('膠着として報告するかどうかは、時刻列が引けたかで決める', () => {
  it('時刻列がその表に無ければ報告しない（膠着ではなく設定のずれ）', () => {
    // 明示 `tables:` 設定で `timestampColumn` を実在しない列にすると、両側とも
    // `''` を読んで「同時刻」と判定され、**中身が違う行の数だけ**警告が出る。
    // それは膠着ではないので黙る
    const message = describeStalemate(
      'tags',
      't1',
      AT,
      { id: 't1', name: 'remote' },
      { id: 't1', name: 'local' },
      ['id', 'name'],
      'modifiedAt'
    )

    expect(message).toBeNull()
  })

  it('時刻列が在って両側とも NULL のまま中身が違えば、本物の膠着として報告する', () => {
    // 黙る条件を「値が空か」で見ると、時刻列が NULL を許す表のこの形まで
    // 一緒に握り潰す。**収束しない食い違いが誰にも知らされないまま残る**
    const message = describeStalemate(
      'tags',
      't1',
      '',
      { id: 't1', name: 'remote', updatedAt: null },
      { id: 't1', name: 'local', updatedAt: null },
      ['id', 'name', 'updatedAt'],
      'updatedAt'
    )

    expect(message).not.toBeNull()
    expect(message).toContain('tags:t1')
    expect(message).toContain('name')
    // 時刻列そのものは「違う列」として挙げない（比較から外してある）
    expect(message).not.toContain('updatedAt')
  })

  it('中身まで同じなら報告することは無い', () => {
    const message = describeStalemate(
      'tags',
      't1',
      AT,
      { id: 't1', name: 'same', updatedAt: AT },
      { id: 't1', name: 'same', updatedAt: AT },
      ['id', 'name', 'updatedAt'],
      'updatedAt'
    )

    expect(message).toBeNull()
  })

  it('時刻列の綴りの大小は畳んで引く', () => {
    // 列名の大小が揃うとは限らない。字面で引くと、実在する時刻列を
    // 「無い」と読んで本物の膠着を黙らせる
    const message = describeStalemate(
      'tags',
      't1',
      AT,
      { id: 't1', name: 'remote', UPDATEDAT: AT },
      { id: 't1', name: 'local', UPDATEDAT: AT },
      ['id', 'name', 'UPDATEDAT'],
      'updatedAt'
    )

    expect(message).not.toBeNull()
    expect(message).toContain('name')
  })

  it('違う列が多いときは先頭数列だけ挙げて残りは件数へ畳む', () => {
    const columns = [
      'id',
      'updatedAt',
      ...Array.from({ length: 8 }, (_, i) => `c${i}`),
    ]
    const record: Record<string, unknown> = { id: 't1', updatedAt: AT }
    const localRecord: Record<string, unknown> = { id: 't1', updatedAt: AT }
    for (let i = 0; i < 8; i++) {
      record[`c${i}`] = 'remote'
      localRecord[`c${i}`] = 'local'
    }

    const message = describeStalemate(
      'tags',
      't1',
      AT,
      record,
      localRecord,
      columns,
      'updatedAt'
    )

    // 人が最初に見るのは「どの行か」と「どのあたりが違うか」。全列を並べても読めない
    expect(message).toContain('c0, c1, c2, c3, c4 and 3 more')
    expect(STALEMATE_COLUMNS_SHOWN).toBe(5)
    // 決着の付け方（片方の行に触れば時刻が動く）まで言うのが報告の役目
    expect(message).toContain('Edit the row on one side')
  })
})

describe('2つの列の値が「同じものが入っている」と言えるか', () => {
  it('片方だけが空なら違う', () => {
    // ローカルと取り込み元で、同じ列に片方だけ値が入っている形。ここを
    // 「同じ」と読むと、消える編集があるのに膠着として報告されない
    expect(isSameStoredValue(null, 'x')).toBe(false)
    expect(isSameStoredValue('x', null)).toBe(false)
    expect(isSameStoredValue(undefined, 0)).toBe(false)
    expect(isSameStoredValue(0, undefined)).toBe(false)
  })

  it('どちらも空なら同じ（NULL と「列が無い」を区別しない）', () => {
    expect(isSameStoredValue(null, null)).toBe(true)
    expect(isSameStoredValue(null, undefined)).toBe(true)
    expect(isSameStoredValue(undefined, undefined)).toBe(true)
  })

  it('SQLiteの値ごとの型差（数値 1 と文字列 "1"）は同じものとして扱う', () => {
    // 列の型宣言に関係なく値ごとに型を持つため、同じ列に混在しうる。
    // 参照比較のままだと、実は同じ値の行を「違う」と報告し続ける
    expect(isSameStoredValue(1, '1')).toBe(true)
    expect(isSameStoredValue(1, 2)).toBe(false)
  })

  it('BLOB は中身で比べる（別インスタンスの Buffer になるため）', () => {
    expect(
      isSameStoredValue(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))
    ).toBe(true)
    expect(
      isSameStoredValue(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))
    ).toBe(false)
  })

  it('BLOB が片側にしか無いときは違うと答える', () => {
    // Buffer と文字列の比較へ落ちる形。`String(Buffer)` は中身を文字列化するので、
    // 偶然一致することはあっても、違う中身を同じと読むことはない
    expect(isSameStoredValue(Buffer.from('abc'), 'abc')).toBe(true)
    expect(isSameStoredValue(Buffer.from('abc'), 'abd')).toBe(false)
  })

  it('膠着の判定は BLOB 列でも効く', () => {
    // 中身が同じ BLOB を参照比較で「違う」と読むと、収束しているのに
    // 膠着だと報告し続けることになる
    const message = describeStalemate(
      'files',
      'f1',
      AT,
      { id: 'f1', blob: Buffer.from([1, 2]), updatedAt: AT },
      { id: 'f1', blob: Buffer.from([1, 2]), updatedAt: AT },
      ['id', 'blob', 'updatedAt'],
      'updatedAt'
    )

    expect(message).toBeNull()
  })
})
