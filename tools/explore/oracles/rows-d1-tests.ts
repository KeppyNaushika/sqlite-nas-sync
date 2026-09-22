/**
 * 参照実装 `rows-d1` そのものの試験（設計書 docs/rows-table-design.md §8.3）。
 *
 * **参照実装は判定の物差しなので、物差しが狂っていれば検査全部が無意味になる。**
 * そこで、手で作った版の集合に対する期待値を**表**にして並べる。表の行を読めば
 * 「この入力ならこの見え方」が分かり、設計書の §1・§2 と1対1で照らし合わせられる。
 *
 * 含めてある形（課題の最低線）: かぶり・隠れた行・削除・cascade で消えた子・
 * 置かない行（NOT NULL / CHECK）・読み替え・1:1 の表。ほかに、版の順序（同着・値の種類・
 * 補題A・補題B）と、**並べ替えで答えが変わらないこと**も見る。
 *
 * `__tests__/` に置かないのは、検査器を vitest の枠に入れない約束（tools/tsconfig.json の
 * 冒頭）による。`npm run explore -- --unit-tests` と、探索の起動時に必ず走る。
 *
 * @module tools/explore/oracles/rows-d1-tests
 */
import { checkPlacementsAreReal } from '../judgments'
import {
  Derived,
  OracleSchema,
  SqlValue,
  Version,
  derive,
  expectedView,
} from './rows-d1'

/* ------------------------------------------------------------------ *
 * 試験に使うスキーマ
 * ------------------------------------------------------------------ */

/** 親（UNIQUE 1本）＋ 普通の子（外部キー CASCADE）＋ 1:1 の子（主キーが外部キー）。 */
const FAMILY: OracleSchema = {
  tables: [
    {
      name: 'tags',
      ddl: `CREATE TABLE tags (
              id        TEXT PRIMARY KEY,
              name      TEXT NOT NULL UNIQUE,
              updatedAt TEXT NOT NULL
            )`,
    },
    {
      name: 'tag_notes',
      ddl: `CREATE TABLE tag_notes (
              id        TEXT PRIMARY KEY,
              tagId     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
              body      TEXT NOT NULL,
              updatedAt TEXT NOT NULL
            )`,
    },
    {
      name: 'tag_profiles',
      ddl: `CREATE TABLE tag_profiles (
              id        TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
              memo      TEXT NOT NULL,
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/** 行に閉じた制約（NOT NULL・CHECK）と、`ON DELETE SET NULL` を見るための表。 */
const GUARDED: OracleSchema = {
  tables: [
    {
      name: 'tags',
      ddl: `CREATE TABLE tags (
              id        TEXT PRIMARY KEY,
              name      TEXT NOT NULL UNIQUE,
              updatedAt TEXT NOT NULL
            )`,
    },
    {
      name: 'items',
      ddl: `CREATE TABLE items (
              id        TEXT PRIMARY KEY,
              tagId     TEXT REFERENCES tags(id) ON DELETE SET NULL,
              label     TEXT NOT NULL CHECK (length(label) > 0),
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/** 照合順序が索引ごとに効くこと（かぶりの判定を JS でやると外れる形）。 */
const NOCASE: OracleSchema = {
  tables: [
    {
      name: 'people',
      ddl: `CREATE TABLE people (
              id        TEXT PRIMARY KEY,
              handle    TEXT NOT NULL UNIQUE COLLATE NOCASE,
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/* ------------------------------------------------------------------ *
 * 版を短く書くための道具
 * ------------------------------------------------------------------ */

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:01.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

/** 行の版。`ts` は既定で `content.updatedAt`（`_sns_ts` の引き上げが要らない場合）。 */
function row(
  table: string,
  id: SqlValue,
  content: Record<string, SqlValue>,
  lamport: number,
  instance: string,
  ts?: SqlValue
): Version {
  return {
    table,
    id,
    kind: 'row',
    ts: ts ?? content.updatedAt ?? null,
    lamport,
    instance,
    content,
  }
}

/** 削除の版。 */
function del(
  table: string,
  id: SqlValue,
  ts: SqlValue,
  lamport: number,
  instance: string,
  mergedInto?: SqlValue
): Version {
  const version: Version = {
    table,
    id,
    kind: 'delete',
    ts,
    lamport,
    instance,
  }
  return mergedInto === undefined ? version : { ...version, mergedInto }
}

/**
 * 結果を1行1候補の文字列にする。**期待値の表はこの形で書く。**
 *
 * - `置く id=… name=…`: 置く行（表示値つき）
 * - `隠れ→g1`: 隠れた行（勝者の真の id）
 * - `置かない`: 置かない行
 * - `死`: 削除の版が `Max`
 */
function summarize(derived: Derived, schema: OracleSchema): string[] {
  const lines: string[] = []
  for (const table of schema.tables) {
    const candidates = derived.candidates.get(table.name)
    for (const [key, result] of candidates ?? []) {
      const shown = Object.entries(result.display)
        .map(([column, value]) => `${column}=${String(value)}`)
        .join(' ')
      if (result.placement === 'placed') {
        lines.push(`${table.name}:${key} 置く ${shown}`)
      } else if (result.placement === 'hidden') {
        lines.push(
          `${table.name}:${key} 隠れ→${result.winner ?? '（勝者なし）'}`
        )
      } else {
        lines.push(`${table.name}:${key} 置かない`)
      }
    }
    for (const key of derived.dead.get(table.name) ?? []) {
      lines.push(`${table.name}:${key} 死`)
    }
  }
  return lines.sort()
}

/* ------------------------------------------------------------------ *
 * 期待値の表
 * ------------------------------------------------------------------ */

type Case = {
  /** 何を確かめる行か（設計書の節を添える） */
  name: string
  schema: OracleSchema
  versions: Version[]
  /** {@link summarize} の形の期待値（順不同。中で並べ替える） */
  expect: string[]
}

const CASES: Case[] = [
  {
    name: '§1.2.5 単純な LWW —— 強い版の中身が出る',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 1, 'a'),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T1 }, 2, 'a'),
    ],
    expect: ['tags:g1 置く id=g1 name=t2 updatedAt=' + T1],
  },
  {
    name: '§1.2.5 同着は L で決まる（ts が同じ）',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 9, 'a'),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 3, 'b'),
    ],
    expect: ['tags:g1 置く id=g1 name=t1 updatedAt=' + T0],
  },
  {
    name: '§1.2.5 L も同着なら iid で決まる',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 4, 'a'),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 4, 'b'),
    ],
    expect: ['tags:g1 置く id=g1 name=t2 updatedAt=' + T0],
  },
  {
    name: '§1.2.3 時刻の値の種類 —— 数値は読める文字列より弱い',
    schema: FAMILY,
    versions: [
      row(
        'tags',
        'g1',
        { id: 'g1', name: 't1', updatedAt: 4102444800000 },
        9,
        'a',
        4102444800000
      ),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 1, 'b'),
    ],
    expect: ['tags:g1 置く id=g1 name=t2 updatedAt=' + T0],
  },
  {
    name: '§1.2.3 書式違いの同じ瞬間は同着（julianday で比べる）',
    schema: FAMILY,
    versions: [
      row(
        'tags',
        'g1',
        { id: 'g1', name: 't1', updatedAt: '2026-01-01 00:00:00' },
        1,
        'a',
        '2026-01-01 00:00:00'
      ),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 2, 'b'),
    ],
    // 同着なので L の大きい方（2）が勝つ
    expect: ['tags:g1 置く id=g1 name=t2 updatedAt=' + T0],
  },
  {
    name: '§1.2.3 ISO 8601 の字形でない文字列は群2（julianday が読めても群3 にしない）',
    schema: FAMILY,
    versions: [
      // 'now' は julianday が値を返すが、評価のたびに変わるので群2（ISO の文字列より弱い）
      row(
        'tags',
        'g1',
        { id: 'g1', name: 't1', updatedAt: 'now' },
        9,
        'a',
        'now'
      ),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 1, 'b'),
    ],
    expect: ['tags:g1 置く id=g1 name=t2 updatedAt=' + T0],
  },
  {
    name: '§1.2.3 日付として読めない文字列も群2',
    schema: FAMILY,
    versions: [
      row(
        'tags',
        'g1',
        { id: 'g1', name: 't1', updatedAt: '2026-13-01' },
        9,
        'a',
        '2026-13-01'
      ),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 1, 'b'),
    ],
    expect: ['tags:g1 置く id=g1 name=t2 updatedAt=' + T0],
  },
  {
    name: '§1.5〜1.6 かぶり —— 弱い方が隠れた行になり、勝者は強い方',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'a'),
      row('tags', 'g2', { id: 'g2', name: 't1', updatedAt: T0 }, 1, 'b'),
    ],
    expect: ['tags:g1 置く id=g1 name=t1 updatedAt=' + T1, 'tags:g2 隠れ→g1'],
  },
  {
    name: '§1.5 照合順序は索引の宣言どおり（NOCASE でかぶる）',
    schema: NOCASE,
    versions: [
      row('people', 'p1', { id: 'p1', handle: 'Ann', updatedAt: T1 }, 1, 'a'),
      row('people', 'p2', { id: 'p2', handle: 'ann', updatedAt: T0 }, 1, 'b'),
    ],
    expect: [
      'people:p1 置く id=p1 handle=Ann updatedAt=' + T1,
      'people:p2 隠れ→p1',
    ],
  },
  {
    name: '§2.1 削除 —— 削除の版が Max なら、その id は死ぬ',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 1, 'a'),
      del('tags', 'g1', T0, 2, 'a'),
    ],
    expect: ['tags:g1 死'],
  },
  {
    name: '§1.2.5 系 削除より新しい ts の版は候補に戻る',
    schema: FAMILY,
    versions: [
      del('tags', 'g1', T0, 2, 'a'),
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'b'),
    ],
    expect: ['tags:g1 置く id=g1 name=t1 updatedAt=' + T1],
  },
  {
    name: '§2.4(4) 消してから同じ id で作り直す（補題A。_sns_ts の引き上げ）',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'a'),
      del('tags', 'g1', T1, 2, 'a'),
      // アプリが古い時刻列（T0）で書き直しても、_sns_ts は手元の Max（T1）へ引き上がる
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 3, 'a', T1),
    ],
    expect: ['tags:g1 置く id=g1 name=t2 updatedAt=' + T0],
  },
  {
    name: '§2.2 cascade で消えた子は、親が生きていても戻らない',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 1, 'a'),
      row(
        'tag_notes',
        'n1',
        { id: 'n1', tagId: 'g1', body: 'b1', updatedAt: T0 },
        2,
        'a'
      ),
      del('tag_notes', 'n1', T0, 3, 'a'),
    ],
    expect: ['tags:g1 置く id=g1 name=t1 updatedAt=' + T0, 'tag_notes:n1 死'],
  },
  {
    name: '§1.4 読み替え —— 隠れた親を指す子は、勝者の主キーへ付け替わる',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'a'),
      row('tags', 'g2', { id: 'g2', name: 't1', updatedAt: T0 }, 1, 'b'),
      row(
        'tag_notes',
        'n2',
        { id: 'n2', tagId: 'g2', body: 'b1', updatedAt: T0 },
        2,
        'b'
      ),
    ],
    expect: [
      'tags:g1 置く id=g1 name=t1 updatedAt=' + T1,
      'tags:g2 隠れ→g1',
      'tag_notes:n2 置く id=n2 tagId=g1 body=b1 updatedAt=' + T0,
    ],
  },
  {
    name: '§1.4 親が置かれていない（CASCADE）子は、置かない行',
    schema: FAMILY,
    versions: [
      row(
        'tag_notes',
        'n3',
        { id: 'n3', tagId: 'g9', body: 'b1', updatedAt: T0 },
        1,
        'a'
      ),
    ],
    expect: ['tag_notes:n3 置かない'],
  },
  {
    name: '§1.4 1:1 の表 —— 表示上の主キーも読み替える',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'a'),
      row('tags', 'g2', { id: 'g2', name: 't1', updatedAt: T0 }, 1, 'b'),
      row(
        'tag_profiles',
        'g2',
        { id: 'g2', memo: 'm1', updatedAt: T0 },
        2,
        'b'
      ),
    ],
    expect: [
      'tags:g1 置く id=g1 name=t1 updatedAt=' + T1,
      'tags:g2 隠れ→g1',
      'tag_profiles:g2 置く id=g1 memo=m1 updatedAt=' + T0,
    ],
  },
  {
    name: '§1.4〜1.6 1:1 の表で、読み替えた主キーが先客とかぶる',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T2 }, 1, 'a'),
      row('tags', 'g2', { id: 'g2', name: 't1', updatedAt: T0 }, 1, 'b'),
      row(
        'tag_profiles',
        'g1',
        { id: 'g1', memo: 'm1', updatedAt: T2 },
        2,
        'a'
      ),
      row(
        'tag_profiles',
        'g2',
        { id: 'g2', memo: 'm2', updatedAt: T0 },
        2,
        'b'
      ),
    ],
    expect: [
      'tags:g1 置く id=g1 name=t1 updatedAt=' + T2,
      'tags:g2 隠れ→g1',
      'tag_profiles:g1 置く id=g1 memo=m1 updatedAt=' + T2,
      'tag_profiles:g2 隠れ→g1',
    ],
  },
  {
    name: '§1.4 置かない行（NOT NULL）—— 列が NULL の候補は表に出ない',
    schema: GUARDED,
    versions: [
      row(
        'items',
        'i1',
        { id: 'i1', tagId: null, label: null, updatedAt: T0 },
        1,
        'a'
      ),
    ],
    expect: ['items:i1 置かない'],
  },
  {
    name: '§1.4 置かない行（CHECK）—— CHECK に落ちる候補は表に出ない',
    schema: GUARDED,
    versions: [
      row(
        'items',
        'i2',
        { id: 'i2', tagId: null, label: '', updatedAt: T0 },
        1,
        'a'
      ),
    ],
    expect: ['items:i2 置かない'],
  },
  {
    name: '§1.4 ON DELETE SET NULL —— 親が置かれていなければ外部キーは NULL',
    schema: GUARDED,
    versions: [
      row(
        'items',
        'i3',
        { id: 'i3', tagId: 'g9', label: 'x', updatedAt: T0 },
        1,
        'a'
      ),
    ],
    expect: ['items:i3 置く id=i3 tagId=null label=x updatedAt=' + T0],
  },
  {
    name: '§1.6 死んだ id が mergedInto を持つと、Res はその先をたどる',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'a'),
      del('tags', 'g2', T0, 1, 'b', 'g1'),
      row(
        'tag_notes',
        'n4',
        { id: 'n4', tagId: 'g2', body: 'b1', updatedAt: T0 },
        2,
        'b'
      ),
    ],
    expect: [
      'tags:g1 置く id=g1 name=t1 updatedAt=' + T1,
      'tags:g2 死',
      'tag_notes:n4 置く id=n4 tagId=g1 body=b1 updatedAt=' + T0,
    ],
  },
]

/* ------------------------------------------------------------------ *
 * 走らせる
 * ------------------------------------------------------------------ */

/** 版の並びを、決まった形で混ぜ直す（乱数を使わない。同じ入力なら同じ並び）。 */
function shuffled(versions: Version[]): Version[][] {
  const reversed = [...versions].reverse()
  const rotated = [...versions.slice(1), ...versions.slice(0, 1)]
  return [reversed, rotated]
}

/**
 * 参照実装そのものの試験。
 *
 * @returns 失敗の説明（空なら全部通った）
 */
export function runRowsD1Tests(): string[] {
  const failures: string[] = []
  for (const testCase of CASES) {
    let actual: string[]
    try {
      actual = summarize(
        derive(testCase.versions, testCase.schema),
        testCase.schema
      )
    } catch (error) {
      failures.push(`${testCase.name}: 例外 ${String(error)}`)
      continue
    }
    const expected = [...testCase.expect].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `${testCase.name}\n    期待: ${JSON.stringify(expected)}\n    実際: ${JSON.stringify(actual)}`
      )
      continue
    }
    // 並べ替えで答えが変わらないこと（Max は可換・結合的・冪等。設計書 補題C）
    for (const order of shuffled(testCase.versions)) {
      const again = summarize(derive(order, testCase.schema), testCase.schema)
      if (JSON.stringify(again) !== JSON.stringify(actual)) {
        failures.push(
          `${testCase.name}: 版の並べ替えで答えが変わった\n    ${JSON.stringify(actual)}\n    ${JSON.stringify(again)}`
        )
      }
    }
    // 同じ版を2回渡しても変わらないこと（冪等）
    const twice = summarize(
      derive([...testCase.versions, ...testCase.versions], testCase.schema),
      testCase.schema
    )
    if (JSON.stringify(twice) !== JSON.stringify(actual)) {
      failures.push(`${testCase.name}: 同じ版を重ねて渡すと答えが変わった`)
    }
  }
  failures.push(...propertyChecks())
  return failures
}

/**
 * 性質の検査（設計書 §8.3 の「性質（かぶらない・極大・外部キー・NOT NULL・CHECK）」）。
 *
 * 期待値の表とは別に、**どの入力でも成り立つべきこと**を、上の表の全事例について見る。
 * 見え方の JSON を本物の SQLite の表へ流し込み、宣言された制約を全部満たすかどうかで判定する
 * （かぶらない・NOT NULL・CHECK は SQLite が、外部キーは `PRAGMA foreign_key_check` が見る）。
 */
function propertyChecks(): string[] {
  const failures: string[] = []
  for (const testCase of CASES) {
    const derived = derive(testCase.versions, testCase.schema)
    const problem = placeableIntoRealTable(derived, testCase.schema)
    if (problem !== null) failures.push(`${testCase.name}: ${problem}`)
    // 判定13（置かない行・隠れた行の逆向きの検査。tools/explore/judgments.ts）
    for (const line of checkPlacementsAreReal(derived, testCase.schema)) {
      failures.push(`${testCase.name}: ${line}`)
    }
    // 見え方の JSON が壊れていないこと（検査器がそのまま文字列で比べる）
    const view = expectedView(testCase.versions, testCase.schema)
    if (!view.startsWith('[')) {
      failures.push(`${testCase.name}: 見え方の JSON が配列になっていない`)
    }
  }
  return failures
}

/** 置く行を本物の表へ入れ直し、宣言された制約を全部満たすか見る。 */
function placeableIntoRealTable(
  derived: Derived,
  schema: OracleSchema
): string | null {
  // ここだけ better-sqlite3 を直に使う（参照実装の外側の検査なので、実装とは別経路）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    for (const table of schema.tables) {
      db.exec(table.ddl)
      for (const index of table.indexes ?? []) db.exec(index)
    }
    for (const table of schema.tables) {
      for (const row of derived.rows.get(table.name) ?? []) {
        const columns = Object.keys(row)
        try {
          db.prepare(
            `INSERT INTO "${table.name}" (${columns.map((c) => `"${c}"`).join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`
          ).run(...columns.map((column) => row[column] as never))
        } catch (error) {
          return `置く行が本物の表に入らない（${table.name}）: ${String(error)}`
        }
      }
    }
    const broken = db.pragma('foreign_key_check') as unknown[]
    if (broken.length > 0) {
      return `置く行が外部キーを満たさない: ${JSON.stringify(broken)}`
    }
    return null
  } finally {
    db.close()
  }
}
