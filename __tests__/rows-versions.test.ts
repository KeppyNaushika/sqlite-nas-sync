/**
 * 版の順序（`src/rows/versions.ts`）の試験。設計書 §1.2 と、段階1 の完了条件2・3。
 *
 * 見るのは3つ。
 *
 * 1. **ISO 8601 の字形の判定**が、`'now'` のような「評価するたびに変わる値」を
 *    群3 に入れないこと（完了条件3）
 * 2. **順序が全前順序であること**（完了条件2・判定11）。同着があるので**半順序では
 *    ない** —— 反対称は成り立たない。確かめるのは反射・完全性・推移・同着の推移
 * 3. トリガーが使う引き上げの SQL（`maxTsSql`。§1.2.1 の `NEWTS`）が、3つの値の**最大**になっていること
 *
 * 値は「アプリの時刻列」「`_sns_rows_*._sns_ts`」「`_tombstone._sns_ts`」の
 * **3つの置き場所から取り直す**。同じ字面でも、列の照合順序と型親和性が違えば
 * 読み出される値の種類が変わる（`TEXT COLLATE NOCASE` の列に入れた数値は文字列になる）。
 */
import Database from 'better-sqlite3'
import { maxTsSql } from '../src/rows/triggers'
import { SqlValue, TIME_GROUP, ValueOrdering } from '../src/rows/versions'

/** 試験に使う「生の値」。境目にあるものを並べる。 */
const RAW_VALUES: SqlValue[] = [
  null,
  0,
  1,
  -1,
  1.5,
  4102444800000,
  4102444800001,
  'now',
  '12:00',
  '123',
  '2460676.5',
  '2026-13-01',
  '2026-01-01 ',
  'ABC',
  'abc',
  '2026-01-01',
  '2026-02-30',
  '2026-01-01 00:00:00',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.0001Z',
  '2026-01-01T00:00:00.0002Z',
  '2026-01-01T09:00:00+09:00',
  '2026-01-01T24:00:00',
  Buffer.from('abc', 'utf8'),
  Buffer.from('ABC', 'utf8'),
]

/**
 * 値を3つの置き場所へ入れて読み直す。
 *
 * - `app.updatedAt`: アプリの時刻列。**`COLLATE NOCASE` の TEXT** にしてある
 *   （順序の計算が照合順序に引きずられないことを見るため。設計書 §1.2.3 の穴4）
 * - `_sns_rows_app._sns_ts`: **型名を書かない**列（値の種類がそのまま残る。穴1）
 * - `_tombstone._sns_ts`: 同上
 */
function valuesFromEveryPlace(): { place: string; value: SqlValue }[] {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE app (seq INTEGER PRIMARY KEY, updatedAt TEXT COLLATE NOCASE);
      CREATE TABLE rows_app (seq INTEGER PRIMARY KEY, "_sns_ts");
      CREATE TABLE tombstone (seq INTEGER PRIMARY KEY, "_sns_ts");
    `)
    const places: [string, string, string][] = [
      ['アプリの時刻列', 'app', 'updatedAt'],
      ['_sns_rows_*', 'rows_app', '_sns_ts'],
      ['_tombstone', 'tombstone', '_sns_ts'],
    ]
    const taken: { place: string; value: SqlValue }[] = []
    for (const [place, table, column] of places) {
      const insert = db.prepare(
        `INSERT INTO ${table} (seq, "${column}") VALUES (?, ?)`
      )
      RAW_VALUES.forEach((value, seq) => insert.run(seq, value as never))
      const rows = db
        .prepare(`SELECT "${column}" AS value FROM ${table} ORDER BY seq`)
        .all() as { value: SqlValue }[]
      for (const row of rows) taken.push({ place, value: row.value })
    }
    return taken
  } finally {
    db.close()
  }
}

describe('src/rows/versions —— 時刻の値の種類（設計書 §1.2.3）', () => {
  const values = new ValueOrdering()
  afterAll(() => values.close())

  it('完了条件3: 評価のたびに変わる値・時刻でない値は群2 に落ちる', () => {
    for (const text of ['now', '12:00', '123', '2460676.5', '2026-13-01']) {
      expect([text, values.timeGroup(text)]).toEqual([text, TIME_GROUP.text])
    }
  })

  it('完了条件3: ISO 8601 の各書式は群3 に入る', () => {
    for (const text of [
      '2026-01-01',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01 00:00:00',
      '2026-01-01T09:00:00+09:00',
      '2026-01-01T09:00+09:00',
      '2026-01-01T00:00',
      '2026-01-01T00:00:00',
    ]) {
      expect([text, values.timeGroup(text)]).toEqual([text, TIME_GROUP.isoText])
    }
  })

  it('存在しない日付は群3 に入る（julianday が翌月として読む。決定的なので許す）', () => {
    expect(values.timeGroup('2026-02-30')).toBe(TIME_GROUP.isoText)
    expect(values.timeGroup('2026-04-31')).toBe(TIME_GROUP.isoText)
    // 24時は翌日として読まれる
    expect(values.timeGroup('2026-01-01T24:00:00')).toBe(TIME_GROUP.isoText)
    // 末尾に空白があると字形に合わないので群2
    expect(values.timeGroup('2026-01-01 ')).toBe(TIME_GROUP.text)
  })

  it('群の強さは NULL ＜ 数値 ＜ ISO でない文字列 ＜ ISO の文字列 ＜ BLOB', () => {
    const ladder: SqlValue[] = [
      null,
      4102444800000,
      'zzz',
      '2026-01-01',
      Buffer.from('', 'utf8'),
    ]
    for (let at = 0; at + 1 < ladder.length; at += 1) {
      expect(values.compareTs(ladder[at], ladder[at + 1])).toBeLessThan(0)
    }
  })

  it('群2・群4 は COLLATE BINARY で比べる（NOCASE の列に入れても前後が付く）', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE t (seq INTEGER PRIMARY KEY, v TEXT COLLATE NOCASE)`)
      db.prepare(`INSERT INTO t VALUES (1, 'ABC'), (2, 'abc')`).run()
      const [upper, lower] = (
        db.prepare(`SELECT v FROM t ORDER BY seq`).all() as { v: string }[]
      ).map((row) => row.v)
      // 素の比較では NOCASE で同着になる値。COLLATE BINARY なら 'ABC' < 'abc'
      expect(values.compareTs(upper, lower)).toBeLessThan(0)
      expect(
        values.compareTs(Buffer.from('ABC', 'utf8'), Buffer.from('abc', 'utf8'))
      ).toBeLessThan(0)
    } finally {
      db.close()
    }
  })

  it('群3 の同着は、秒の小数がミリ秒までしか効かない', () => {
    expect(
      values.compareTs('2026-01-01T00:00:00.0001Z', '2026-01-01T00:00:00.0002Z')
    ).toBe(0)
    expect(
      values.compareTs('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z')
    ).toBeLessThan(0)
  })

  it('2^53 を超える整数どうしが同着にならない', () => {
    const db = new Database(':memory:')
    try {
      db.defaultSafeIntegers(true)
      db.exec(`CREATE TABLE t (seq INTEGER PRIMARY KEY, v)`)
      db.prepare(
        `INSERT INTO t VALUES (1, 9007199254740993), (2, 9007199254740992)`
      ).run()
      const [big, small] = (
        db.prepare(`SELECT v FROM t ORDER BY seq`).all() as { v: bigint }[]
      ).map((row) => row.v)
      expect(values.compareTs(big, small)).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})

describe('src/rows/versions —— 順序が全前順序であること（完了条件2・判定11）', () => {
  const values = new ValueOrdering()
  const taken = valuesFromEveryPlace()
  const size = taken.length
  /** 総当たりの比較を先に表にしておく（`compareTs` は SQLite へ尋ねるので遅い） */
  const matrix: number[][] = taken.map((left) =>
    taken.map((right) => Math.sign(values.compareTs(left.value, right.value)))
  )
  afterAll(() => values.close())

  const label = (at: number): string =>
    `${taken[at].place}:${String(taken[at].value)}`

  it(`3つの置き場所から ${size} 個の値を取っている`, () => {
    expect(size).toBe(RAW_VALUES.length * 3)
  })

  it('反射（どの値も自分とは同着）', () => {
    for (let a = 0; a < size; a += 1) {
      expect([label(a), matrix[a][a]]).toEqual([label(a), 0])
    }
  })

  it('完全性（どの2つも比べられ、向きが逆になる）', () => {
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b < size; b += 1) {
        // 向きが逆なら和は 0。両向きとも「強い」と答える（＝和が 2）ような
        // 破れをここで捕まえる
        expect([label(a), label(b), matrix[a][b] + matrix[b][a]]).toEqual([
          label(a),
          label(b),
          0,
        ])
      }
    }
  })

  it('推移（a ≼ b かつ b ≼ c なら a ≼ c）', () => {
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b < size; b += 1) {
        if (matrix[a][b] > 0) continue
        for (let c = 0; c < size; c += 1) {
          if (matrix[b][c] > 0) continue
          if (matrix[a][c] > 0) {
            throw new Error(
              `推移が破れた: ${label(a)} ≼ ${label(b)} ≼ ${label(c)} なのに ${label(a)} ≻ ${label(c)}`
            )
          }
        }
      }
    }
  })

  it('同着の推移（a = b かつ b = c なら a = c）', () => {
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b < size; b += 1) {
        if (matrix[a][b] !== 0) continue
        for (let c = 0; c < size; c += 1) {
          if (matrix[b][c] !== 0) continue
          if (matrix[a][c] !== 0) {
            throw new Error(
              `同着が推移しない: ${label(a)} = ${label(b)} = ${label(c)} なのに ${label(a)} ≠ ${label(c)}`
            )
          }
        }
      }
    }
  })

  it('トリガーの引き上げ（maxTsSql）は3つの値の最大になる（項の順に依らない）', () => {
    // トリガーは `_sns_ts` を `maxTsSql` の SQL で決める。
    // その SQL の答えが、JS の順序（compareTs）で見て3つとも以上であることを見る
    const db = new Database(':memory:')
    db.defaultSafeIntegers(true)
    const statement = db.prepare(`SELECT ${maxTsSql(['?', '?', '?'])} AS v`)
    const raiseTs = (x: SqlValue, y: SqlValue, z: SqlValue): SqlValue =>
      (statement.get(x as never, y as never, z as never) as { v: SqlValue }).v
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b < size; b += 1) {
        for (let c = 0; c < size; c += 1) {
          if ((a + b * 7 + c * 13) % 17 !== 0) continue // 総当たりは重いので間引く
          const raised = raiseTs(taken[a].value, taken[b].value, taken[c].value)
          for (const at of [a, b, c]) {
            if (values.compareTs(raised, taken[at].value) < 0) {
              db.close()
              throw new Error(
                `引き上げが最大になっていない: ${label(a)} / ${label(b)} / ${label(c)} → ${String(raised)}`
              )
            }
          }
        }
      }
    }
    db.close()
  })
})

describe('src/rows/versions —— 版の順序（設計書 §1.2.5）', () => {
  const values = new ValueOrdering()
  afterAll(() => values.close())

  const version = (
    ts: SqlValue,
    lamport: number,
    instance: string,
    kind: 'row' | 'delete' = 'row'
  ) => ({ table: 't', id: 'k', kind, ts, lamport, instance })

  it('(_sns_ts, L, iid) の辞書順で決まる', () => {
    const t0 = '2026-01-01T00:00:00.000Z'
    const t1 = '2026-01-01T00:00:01.000Z'
    expect(
      values.compareVersions(version(t0, 9, 'a'), version(t1, 1, 'a'))
    ).toBeLessThan(0)
    expect(
      values.compareVersions(version(t0, 1, 'a'), version(t0, 2, 'a'))
    ).toBeLessThan(0)
    expect(
      values.compareVersions(version(t0, 1, 'a'), version(t0, 1, 'b'))
    ).toBeLessThan(0)
  })

  it('3つ組が同じなら種類によらず同着（付則1 と SQL の strongerSql と同じ）', () => {
    const t0 = '2026-01-01T00:00:00.000Z'
    expect(
      values.compareVersions(version(t0, 1, 'a'), version(t0, 1, 'a', 'delete'))
    ).toBe(0)
  })

  it('真の id の正規形は CAST(x AS TEXT) と同じ', () => {
    // JS の number は、整数でも SQLite には REAL として渡る。整数の id は
    // `bigint`（＝ `defaultSafeIntegers(true)` の接続から読んだ姿）で渡すこと
    expect(values.idKey(5n)).toBe('5')
    expect(values.idKey(5)).toBe('5.0')
    expect(values.idKey('5')).toBe('5')
    expect(values.idKey(null)).toBe('null')
    expect(values.idKey(Buffer.from('ab', 'utf8'))).toBe('ab')
  })
})
