/**
 * `src/rows/derive.ts` と、参照実装 `tools/explore/oracles/rows-d1.ts` の
 * 突き合わせ（段階1 の完了条件1）。
 *
 * **入力は乱数で作らない。** 手で選んだ「1つの id に起こりうること」の一覧を
 * 表ごとに用意し、その**直積**を全部通す。乱数だと、通った回数は増えても
 * 何を通したかが分からず、失敗したときに同じ入力を作り直せない。
 *
 * 突き合わせるのは、置く行・隠れた行（と勝者）・置かない行・死んだ id と、
 * 置く行の中身。参照実装は索引の字句解析を**使わず**、候補どうしを一時 DB へ
 * 入れ直してかぶりを見る別の筋なので、両者が一致すれば「索引の読み取りで
 * 勝者を引く」筋が正しく書けていることになる。
 */
import { RowsSchema, derive } from '../src/rows/derive'
import { RowVersion, SqlValue } from '../src/rows/versions'
import {
  OracleSchema,
  Version,
  derive as oracleDerive,
} from '../tools/explore/oracles/rows-d1'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:01.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

/* ------------------------------------------------------------------ *
 * スキーマ
 * ------------------------------------------------------------------ */

const FAMILY_TABLES = [
  {
    name: 'tags',
    ddl: `CREATE TABLE tags (
            id        TEXT PRIMARY KEY NOT NULL,
            name      TEXT NOT NULL UNIQUE,
            updatedAt TEXT NOT NULL
          )`,
  },
  {
    name: 'tag_notes',
    ddl: `CREATE TABLE tag_notes (
            id        TEXT PRIMARY KEY NOT NULL,
            tagId     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            body      TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )`,
  },
  {
    name: 'tag_profiles',
    ddl: `CREATE TABLE tag_profiles (
            id        TEXT PRIMARY KEY NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            memo      TEXT NOT NULL UNIQUE,
            updatedAt TEXT NOT NULL
          )`,
  },
]

/** 照合順序つきの UNIQUE と、部分索引を持つ表（穴4・穴9）。 */
const PEOPLE_TABLES = [
  {
    name: 'people',
    ddl: `CREATE TABLE people (
            id        TEXT PRIMARY KEY NOT NULL,
            handle    TEXT NOT NULL COLLATE NOCASE,
            slot      INTEGER NOT NULL,
            live      INTEGER NOT NULL,
            updatedAt TEXT NOT NULL
          )`,
    indexes: [
      'CREATE UNIQUE INDEX i_handle ON people (handle)',
      'CREATE UNIQUE INDEX i_slot ON people (slot) WHERE live = 1',
    ],
  },
]

const FAMILY: RowsSchema = { tables: FAMILY_TABLES }
const PEOPLE: RowsSchema = { tables: PEOPLE_TABLES }
const FAMILY_ORACLE: OracleSchema = { tables: FAMILY_TABLES }
const PEOPLE_ORACLE: OracleSchema = { tables: PEOPLE_TABLES }

/* ------------------------------------------------------------------ *
 * 版を短く書く
 * ------------------------------------------------------------------ */

function row(
  table: string,
  id: SqlValue,
  content: Record<string, SqlValue>,
  lamport: number,
  instance: string,
  ts?: SqlValue
): RowVersion {
  return {
    table,
    id,
    kind: 'row',
    ts: ts === undefined ? (content.updatedAt ?? null) : ts,
    lamport,
    instance,
    content,
  }
}

function del(
  table: string,
  id: SqlValue,
  ts: SqlValue,
  lamport: number,
  instance: string
): RowVersion {
  return { table, id, kind: 'delete', ts, lamport, instance }
}

/* ------------------------------------------------------------------ *
 * 「1つの id に起こりうること」の一覧
 * ------------------------------------------------------------------ */

/** タグ1つ（親）に起こりうること。 */
function tagOptions(id: string): RowVersion[][] {
  const options: RowVersion[][] = [[]]
  for (const name of ['t1', 't2']) {
    for (const ts of [T0, T1, T2]) {
      options.push([
        row('tags', id, { id, name, updatedAt: ts }, ts === T0 ? 1 : 2, 'a'),
      ])
    }
  }
  options.push([del('tags', id, T1, 3, 'b')])
  // 消してから作り直す（削除の版の方が強い / 弱い の両方）
  options.push([
    row('tags', id, { id, name: 't1', updatedAt: T2 }, 1, 'a'),
    del('tags', id, T2, 2, 'a'),
  ])
  options.push([
    del('tags', id, T0, 1, 'a'),
    row('tags', id, { id, name: 't1', updatedAt: T0 }, 2, 'a'),
  ])
  // 順序用の時刻が NULL（群0）と、数値（群1）—— 値の種類が混ざる形
  options.push([
    row('tags', id, { id, name: 't1', updatedAt: T1 }, 1, 'a', null),
  ])
  options.push([
    row('tags', id, { id, name: 't2', updatedAt: T1 }, 1, 'a', 4102444800000),
  ])
  // NOT NULL に反する候補（置かない行）
  options.push([row('tags', id, { id, name: null, updatedAt: T1 }, 1, 'a')])
  return options
}

/** 普通の子1つに起こりうること。 */
function noteOptions(): RowVersion[][] {
  const options: RowVersion[][] = [[]]
  for (const tagId of ['g1', 'g2', 'g9']) {
    for (const ts of [T0, T2]) {
      options.push([
        row(
          'tag_notes',
          'n1',
          { id: 'n1', tagId, body: 'b1', updatedAt: ts },
          1,
          'b'
        ),
      ])
    }
  }
  options.push([del('tag_notes', 'n1', T1, 1, 'b')])
  options.push([
    row(
      'tag_notes',
      'n1',
      { id: 'n1', tagId: 'g1', body: null, updatedAt: T1 },
      1,
      'b'
    ),
  ])
  return options
}

/**
 * 1:1 の子1つに起こりうること（真の id が親の id を兼ねる）。
 *
 * `memo` に UNIQUE があるので、**表示上の主キーでかぶる相手と、UNIQUE でかぶる
 * 相手が別の行になる**形がここで出る。SQLite はそのとき
 * `SQLITE_CONSTRAINT_UNIQUE` しか返さないので、勝者を主キーで引き直せているかが
 * 試される（穴3 の訂正）
 */
function profileOptions(): RowVersion[][] {
  const options: RowVersion[][] = [[]]
  for (const id of ['g1', 'g2', 'g9']) {
    for (const memo of ['m1', 'm2']) {
      for (const ts of [T0, T2]) {
        options.push([
          row('tag_profiles', id, { id, memo, updatedAt: ts }, 2, 'c'),
        ])
      }
    }
  }
  options.push([del('tag_profiles', 'g1', T1, 1, 'c')])
  return options
}

/** タグ1つに起こりうること（1:1 の席の取り合いを見る回で使う、短い一覧）。 */
function tagSmallOptions(id: string): RowVersion[][] {
  return [
    [],
    [row('tags', id, { id, name: 't1', updatedAt: T2 }, 2, 'a')],
    [row('tags', id, { id, name: 't1', updatedAt: T0 }, 1, 'a')],
    [row('tags', id, { id, name: 't2', updatedAt: T1 }, 1, 'a')],
  ]
}

/**
 * 1:1 の子を id ごとに1つずつ置く（同じ回に3つ並べて、席の取り合いを起こす）。
 *
 * 強さは `ts` で決めておく（`g3` が最強、次に `g1`、`g2` が最弱）。こうすると
 * 「`g2` の表示上の主キーは `g1`（読み替え）、`memo` は `g3` とかぶる」という、
 * **主キーで当たる相手と UNIQUE で当たる相手が別の行になる**形が出る。
 */
function profileOneOptions(id: string, ts: string): RowVersion[][] {
  const options: RowVersion[][] = [[]]
  for (const memo of ['m1', 'm2']) {
    options.push([row('tag_profiles', id, { id, memo, updatedAt: ts }, 2, 'c')])
  }
  options.push([del('tag_profiles', id, T0, 1, 'c')])
  return options
}

/** 人1人に起こりうること（NOCASE の UNIQUE と、部分索引の席）。 */
function personOptions(id: string): RowVersion[][] {
  const options: RowVersion[][] = [[]]
  for (const handle of ['Ann', 'ann']) {
    for (const slot of [1, 2]) {
      for (const live of [0, 1]) {
        options.push([
          row(
            'people',
            id,
            { id, handle, slot, live, updatedAt: id === 'p1' ? T2 : T0 },
            id === 'p1' ? 3 : 1,
            'a'
          ),
        ])
      }
    }
  }
  options.push([del('people', id, T1, 2, 'b')])
  options.push([
    row(
      'people',
      id,
      { id, handle: 'Bob', slot: 1, live: 1, updatedAt: T1 },
      1,
      'a'
    ),
  ])
  options.push([
    row(
      'people',
      id,
      { id, handle: 'Bob', slot: 2, live: 0, updatedAt: T1 },
      4,
      'a'
    ),
  ])
  return options
}

/* ------------------------------------------------------------------ *
 * 突き合わせ
 * ------------------------------------------------------------------ */

/** 値を、どちらの実装から来ても同じ字面になる形にする（`bigint` と `number` の差を消す）。 */
function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Buffer.isBuffer(value)) return `blob:${value.toString('hex')}`
  if (typeof value === 'bigint') return `num:${value.toString()}`
  if (typeof value === 'number') {
    return `num:${Number.isInteger(value) ? value.toFixed(0) : String(value)}`
  }
  return `text:${String(value)}`
}

/** 結果を、どちらの実装でも同じ形になる1行1候補の文字列にする。 */
function summarize(
  derived: {
    candidates: Map<
      string,
      Map<
        string,
        {
          placement: string
          winner?: string
          display: Record<string, unknown>
        }
      >
    >
    rows: Map<string, Record<string, unknown>[]>
    dead: Map<string, Set<string>>
  },
  tables: { name: string }[]
): string[] {
  const lines: string[] = []
  for (const table of tables) {
    for (const [key, result] of derived.candidates.get(table.name) ?? []) {
      const shown = Object.keys(result.display)
        .sort()
        .map((column) => `${column}=${normalizeValue(result.display[column])}`)
        .join(' ')
      lines.push(
        `${table.name}:${key} ${result.placement} 勝者=${result.winner ?? '-'} ${shown}`
      )
    }
    for (const key of derived.dead.get(table.name) ?? []) {
      lines.push(`${table.name}:${key} 死`)
    }
    for (const placed of derived.rows.get(table.name) ?? []) {
      const shown = Object.keys(placed)
        .sort()
        .map((column) => `${column}=${normalizeValue(placed[column])}`)
        .join(' ')
      lines.push(`${table.name} 行 ${shown}`)
    }
  }
  return lines.sort()
}

/** 直積を回す（乱数を使わない）。 */
function* product<T>(lists: T[][]): Generator<T[]> {
  const counters = lists.map(() => 0)
  for (;;) {
    yield counters.map((at, index) => lists[index][at])
    let at = lists.length - 1
    while (at >= 0) {
      counters[at] += 1
      if (counters[at] < lists[at].length) break
      counters[at] = 0
      at -= 1
    }
    if (at < 0) return
  }
}

describe('derive と参照実装 rows-d1 の突き合わせ（完了条件1）', () => {
  const runs: {
    name: string
    schema: RowsSchema
    oracle: OracleSchema
    lists: RowVersion[][][]
  }[] = [
    {
      name: '親・普通の子・1:1 の子',
      schema: FAMILY,
      oracle: FAMILY_ORACLE,
      lists: [
        tagOptions('g1'),
        tagOptions('g2'),
        noteOptions(),
        profileOptions(),
      ],
    },
    {
      name: '1:1 の表で、表示上の主キーと UNIQUE が別の行に当たる',
      schema: FAMILY,
      oracle: FAMILY_ORACLE,
      lists: [
        // `g3` は必ず置かれる親（`g3` の 1:1 の子が「主キーでは当たらないが
        // UNIQUE では当たる、より強い行」になる）
        [[row('tags', 'g3', { id: 'g3', name: 't3', updatedAt: T1 }, 1, 'a')]],
        tagSmallOptions('g1'),
        tagSmallOptions('g2'),
        profileOneOptions('g3', T2),
        profileOneOptions('g1', T1),
        profileOneOptions('g2', T0),
      ],
    },
    {
      name: 'NOCASE の UNIQUE と部分索引',
      schema: PEOPLE,
      oracle: PEOPLE_ORACLE,
      lists: [personOptions('p1'), personOptions('p2'), personOptions('p3')],
    },
  ]

  const total = runs.reduce(
    (sum, run) => sum + run.lists.reduce((size, list) => size * list.length, 1),
    0
  )

  it(`組み合わせが1万件を超えている（${total}件）`, () => {
    expect(total).toBeGreaterThanOrEqual(10000)
  })

  it('全ての組み合わせで食い違いが無い', { timeout: 300000 }, () => {
    let checked = 0
    const failures: string[] = []
    for (const run of runs) {
      for (const picked of product(run.lists)) {
        const versions = picked.flat()
        checked += 1
        const mine = summarize(derive(versions, run.schema), run.schema.tables)
        const theirs = summarize(
          oracleDerive(versions as Version[], run.oracle),
          run.oracle.tables
        )
        if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
          failures.push(
            `${run.name}\n  入力: ${JSON.stringify(versions)}\n  実装: ${JSON.stringify(mine)}\n  参照: ${JSON.stringify(theirs)}`
          )
          if (failures.length >= 3) break
        }
      }
      if (failures.length >= 3) break
    }
    expect(checked).toBe(total)
    expect(failures).toEqual([])
  })
})
