/**
 * 見え方の計算（`src/rows/derive.ts`）の試験。設計書 §1.3〜§1.7 と、段階1 の
 * 完了条件4・5。
 *
 * 手で作った入力に対する期待値を**表**にして並べる。表の行を読めば
 * 「この入力ならこの見え方」が分かり、設計書の §1 と1対1で照らし合わせられる。
 */
import Database from 'better-sqlite3'
import { RowsSchema, derive } from '../src/rows/derive'
import { RowVersion, SqlValue } from '../src/rows/versions'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:01.000Z'
const T2 = '2026-01-01T00:00:02.000Z'

/** 親（UNIQUE 1本）＋ 普通の子（CASCADE）＋ 1:1 の子（主キーが外部キー）。 */
const FAMILY: RowsSchema = {
  tables: [
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
              memo      TEXT NOT NULL,
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/** 行に閉じた制約（NOT NULL・CHECK）と `ON DELETE SET NULL` を見るための表。 */
const GUARDED: RowsSchema = {
  tables: [
    {
      name: 'tags',
      ddl: `CREATE TABLE tags (
              id        TEXT PRIMARY KEY NOT NULL,
              name      TEXT NOT NULL UNIQUE,
              updatedAt TEXT NOT NULL
            )`,
    },
    {
      name: 'items',
      ddl: `CREATE TABLE items (
              id        TEXT PRIMARY KEY NOT NULL,
              tagId     TEXT REFERENCES tags(id) ON DELETE SET NULL,
              label     TEXT NOT NULL CHECK (length(label) > 0),
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/** 親 → 子 → 孫 の3段（すべて `ON DELETE CASCADE`）。原則4 の連鎖を見る。 */
const CHAIN: RowsSchema = {
  tables: [
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
      name: 'note_marks',
      ddl: `CREATE TABLE note_marks (
              id        TEXT PRIMARY KEY NOT NULL,
              noteId    TEXT NOT NULL REFERENCES tag_notes(id) ON DELETE CASCADE,
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/**
 * 自己参照の外部キーを持つ表（`ON DELETE CASCADE`）。親子が同じ表に入る。
 * `name` の UNIQUE は、隠れた親を指す子の読み替えを見るためにある。
 */
const TREE: RowsSchema = {
  tables: [
    {
      name: 'tree',
      ddl: `CREATE TABLE tree (
              id        TEXT PRIMARY KEY NOT NULL,
              up        TEXT REFERENCES tree(id) ON DELETE CASCADE,
              name      TEXT UNIQUE,
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/** 自己参照の外部キーが `ON DELETE SET NULL` の表。 */
const TREE_SET_NULL: RowsSchema = {
  tables: [
    {
      name: 'tree',
      ddl: `CREATE TABLE tree (
              id        TEXT PRIMARY KEY NOT NULL,
              up        TEXT REFERENCES tree(id) ON DELETE SET NULL,
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/** 自己参照の外部キーが `ON DELETE SET DEFAULT` の表。既定値は根の `root` を指す。 */
const TREE_SET_DEFAULT: RowsSchema = {
  tables: [
    {
      name: 'tree',
      ddl: `CREATE TABLE tree (
              id        TEXT PRIMARY KEY NOT NULL,
              up        TEXT DEFAULT 'root' REFERENCES tree(id) ON DELETE SET DEFAULT,
              updatedAt TEXT NOT NULL
            )`,
    },
  ],
}

/** 自己参照の表の行の版（`name` は既定で NULL）。 */
function node(
  id: string,
  up: string | null,
  lamport: number,
  name: string | null = null
): RowVersion {
  return row('tree', id, { id, up, name, updatedAt: T0 }, lamport, 'a')
}

/** 行の版。`ts` は既定で `content.updatedAt`（引き上げが要らない場合）。 */
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
  instance: string
): RowVersion {
  return { table, id, kind: 'delete', ts, lamport, instance }
}

/**
 * 結果を1行1候補の文字列にする（期待値の表はこの形で書く）。
 *
 * - `置く id=… name=…`: 置く行（表示値つき）
 * - `隠れ→g1`: 隠れた行（勝者の真の id）
 * - `置かない`: 置かない行（版は残る）
 * - `親削除→<表>:<id>`: 親が削除されているので置かない行と、原因になった削除（原則4。版は残る）
 * - `死`: 削除の版が `Max`
 */
export function summarize(
  derived: ReturnType<typeof derive>,
  schema: RowsSchema
): string[] {
  const lines: string[] = []
  for (const table of schema.tables) {
    for (const [key, result] of derived.candidates.get(table.name) ?? []) {
      const shown = Object.entries(result.display)
        .map(([column, value]) => `${column}=${String(value)}`)
        .join(' ')
      if (result.placement === 'placed') {
        lines.push(`${table.name}:${key} 置く ${shown}`)
      } else if (result.placement === 'hidden') {
        lines.push(
          `${table.name}:${key} 隠れ→${result.winner ?? '（勝者なし）'}`
        )
      } else if (result.placement === 'parentDeleted') {
        lines.push(
          `${table.name}:${key} 親削除→${result.cause?.table}:${result.cause?.key}`
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

type Case = {
  name: string
  schema: RowsSchema
  versions: RowVersion[]
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
    expect: [`tags:g1 置く id=g1 name=t2 updatedAt=${T1}`],
  },
  {
    name: '§1.2.5 同着は L で決まる',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 9, 'a'),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 3, 'b'),
    ],
    expect: [`tags:g1 置く id=g1 name=t1 updatedAt=${T0}`],
  },
  {
    name: '§1.2.5 L も同着なら iid で決まる',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 4, 'a'),
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 4, 'b'),
    ],
    expect: [`tags:g1 置く id=g1 name=t2 updatedAt=${T0}`],
  },
  {
    name: '§1.2.3 数値の時刻は ISO の文字列より弱い',
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
    expect: [`tags:g1 置く id=g1 name=t2 updatedAt=${T0}`],
  },
  {
    name: "§1.2.3 'now' は群2（julianday が読めても群3 にしない）",
    schema: FAMILY,
    versions: [
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
    expect: [`tags:g1 置く id=g1 name=t2 updatedAt=${T0}`],
  },
  {
    name: '§1.5〜1.6 かぶり —— 弱い方が隠れた行になり、勝者は強い方',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'a'),
      row('tags', 'g2', { id: 'g2', name: 't1', updatedAt: T0 }, 1, 'b'),
    ],
    expect: [`tags:g1 置く id=g1 name=t1 updatedAt=${T1}`, 'tags:g2 隠れ→g1'],
  },
  {
    name: '§1.3 削除の版が Max なら、その id は死ぬ',
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
    expect: [`tags:g1 置く id=g1 name=t1 updatedAt=${T1}`],
  },
  {
    name: '§5 消してから同じ id で作り直す（補題A。引き上げ）',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'a'),
      del('tags', 'g1', T1, 2, 'a'),
      // アプリが古い時刻列（T0）で書き直しても、_sns_ts は手元の Max（T1）へ引き上がる
      row('tags', 'g1', { id: 'g1', name: 't2', updatedAt: T0 }, 3, 'a', T1),
    ],
    expect: [`tags:g1 置く id=g1 name=t2 updatedAt=${T0}`],
  },
  {
    name: '§1.4 表示 —— 隠れた親を指す子は、勝者の主キーで表示される',
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
      `tags:g1 置く id=g1 name=t1 updatedAt=${T1}`,
      'tags:g2 隠れ→g1',
      `tag_notes:n2 置く id=n2 tagId=g1 body=b1 updatedAt=${T0}`,
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
    name: '§1.4 1:1 の表 —— 子の主キーも勝者の主キーで表示される',
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
      `tags:g1 置く id=g1 name=t1 updatedAt=${T1}`,
      'tags:g2 隠れ→g1',
      `tag_profiles:g2 置く id=g1 memo=m1 updatedAt=${T0}`,
    ],
  },
  {
    name: '§1.4〜1.6 1:1 の表で、表示する主キーが先客とかぶる',
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
      `tags:g1 置く id=g1 name=t1 updatedAt=${T2}`,
      'tags:g2 隠れ→g1',
      `tag_profiles:g1 置く id=g1 memo=m1 updatedAt=${T2}`,
      'tag_profiles:g2 隠れ→g1',
    ],
  },
  {
    name: '§1.4 置かない行（NOT NULL）',
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
    name: '§1.4 置かない行（CHECK）',
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
    expect: [`items:i3 置く id=i3 tagId=null label=x updatedAt=${T0}`],
  },
  {
    name: '訂正: 主キーが NULL の候補は置かない行（id を捏造しない）',
    schema: FAMILY,
    versions: [
      row('tags', 'g1', { id: null, name: 't1', updatedAt: T0 }, 1, 'a'),
    ],
    expect: ['tags:g1 置かない'],
  },
  {
    name: '原則4: 親が削除されていれば、あとから届いた子も時刻によらず入らない（版は残る）',
    schema: FAMILY,
    versions: [
      del('tags', 'g1', T1, 2, 'a'),
      // 削除より新しい時刻で書かれた子。それでも入らない
      row(
        'tag_notes',
        'n1',
        { id: 'n1', tagId: 'g1', body: 'b1', updatedAt: T2 },
        3,
        'b'
      ),
    ],
    expect: ['tags:g1 死', 'tag_notes:n1 親削除→tags:g1'],
  },
  {
    name: '原則4: 親がまだ届いていないだけなら、置かない行のまま（版は残る）',
    schema: FAMILY,
    versions: [
      row(
        'tag_notes',
        'n1',
        { id: 'n1', tagId: 'g1', body: 'b1', updatedAt: T0 },
        1,
        'a'
      ),
    ],
    expect: ['tag_notes:n1 置かない'],
  },
  {
    name: '原則4: 1:1 の子は NULL にできないので入らない',
    schema: FAMILY,
    versions: [
      del('tags', 'g1', T1, 2, 'a'),
      row(
        'tag_profiles',
        'g1',
        { id: 'g1', memo: 'm1', updatedAt: T2 },
        3,
        'b'
      ),
    ],
    expect: ['tags:g1 死', 'tag_profiles:g1 親削除→tags:g1'],
  },
  {
    name: '原則4: ON DELETE SET NULL の子は列を NULL にした形で入る',
    schema: GUARDED,
    versions: [
      del('tags', 'g1', T1, 2, 'a'),
      row(
        'items',
        'i1',
        { id: 'i1', tagId: 'g1', label: 'L', updatedAt: T2 },
        3,
        'b'
      ),
    ],
    expect: [
      'tags:g1 死',
      `items:i1 置く id=i1 tagId=null label=L updatedAt=${T2}`,
    ],
  },
  {
    name: '原則4: 孫まで連鎖する。原因はどちらも大元の削除',
    schema: CHAIN,
    versions: [
      del('tags', 'g1', T1, 2, 'a'),
      row(
        'tag_notes',
        'n1',
        { id: 'n1', tagId: 'g1', body: 'b1', updatedAt: T2 },
        3,
        'b'
      ),
      row(
        'note_marks',
        'm1',
        { id: 'm1', noteId: 'n1', updatedAt: T2 },
        4,
        'b'
      ),
    ],
    expect: [
      'tags:g1 死',
      'tag_notes:n1 親削除→tags:g1',
      'note_marks:m1 親削除→tags:g1',
    ],
  },
  {
    name: '原則4: 親が同じ主キーで書き直され、書き直しが削除に勝てば、子は元の形で入る',
    schema: CHAIN,
    versions: [
      del('tags', 'g1', T1, 2, 'a'),
      // 書き直しは削除の時刻まで単調化され、_sns_lamport で勝つ
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T0 }, 3, 'a', T1),
      row(
        'tag_notes',
        'n1',
        { id: 'n1', tagId: 'g1', body: 'b1', updatedAt: T0 },
        1,
        'b'
      ),
      row(
        'note_marks',
        'm1',
        { id: 'm1', noteId: 'n1', updatedAt: T0 },
        2,
        'b'
      ),
    ],
    expect: [
      `tags:g1 置く id=g1 name=t1 updatedAt=${T0}`,
      `tag_notes:n1 置く id=n1 tagId=g1 body=b1 updatedAt=${T0}`,
      `note_marks:m1 置く id=m1 noteId=n1 updatedAt=${T0}`,
    ],
  },
  {
    name: '原則4: 書き直しが削除に負ければ、親は削除されたままで子は入らない',
    schema: FAMILY,
    versions: [
      del('tags', 'g1', T2, 2, 'a'),
      row('tags', 'g1', { id: 'g1', name: 't1', updatedAt: T1 }, 1, 'b'),
      row(
        'tag_notes',
        'n1',
        { id: 'n1', tagId: 'g1', body: 'b1', updatedAt: T1 },
        2,
        'b'
      ),
    ],
    expect: ['tags:g1 死', 'tag_notes:n1 親削除→tags:g1'],
  },
  {
    name: '自己参照: 同じ表の親と子がどちらも置かれる',
    schema: TREE,
    versions: [node('t1', null, 1), node('t2', 't1', 2)],
    expect: [
      `tree:t1 置く id=t1 up=null name=null updatedAt=${T0}`,
      `tree:t2 置く id=t2 up=t1 name=null updatedAt=${T0}`,
    ],
  },
  {
    name: '自己参照: 深さ4の木は、子が親より強く並んでも全部置かれる',
    schema: TREE,
    // 強い順は d → c → b → a で、葉が根より先に来る
    versions: [
      node('a', null, 1),
      node('b', 'a', 2),
      node('c', 'b', 3),
      node('d', 'c', 4),
    ],
    expect: [
      `tree:a 置く id=a up=null name=null updatedAt=${T0}`,
      `tree:b 置く id=b up=a name=null updatedAt=${T0}`,
      `tree:c 置く id=c up=b name=null updatedAt=${T0}`,
      `tree:d 置く id=d up=c name=null updatedAt=${T0}`,
    ],
  },
  {
    name: '自己参照 原則4: 親が削除されていれば、子と孫は大元の削除を原因に置かない',
    schema: TREE,
    versions: [
      del('tree', 'a', T1, 5, 'a'),
      node('b', 'a', 2),
      node('c', 'b', 3),
    ],
    expect: ['tree:a 死', 'tree:b 親削除→tree:a', 'tree:c 親削除→tree:a'],
  },
  {
    name: '自己参照: 親が届いていなければ、子も孫も置かない',
    schema: TREE,
    versions: [node('b', 'a', 2), node('c', 'b', 3)],
    expect: ['tree:b 置かない', 'tree:c 置かない'],
  },
  {
    name: '自己参照 原則4: 隠れた親を指す子は、勝者の子になる',
    schema: TREE,
    versions: [
      node('p1', null, 5, 'same'),
      node('p2', null, 1, 'same'),
      node('c', 'p2', 3),
    ],
    expect: [
      `tree:p1 置く id=p1 up=null name=same updatedAt=${T0}`,
      'tree:p2 隠れ→p1',
      `tree:c 置く id=c up=p1 name=null updatedAt=${T0}`,
    ],
  },
  {
    name: '自己参照: 輪になった行は置かず、輪に繋がる子も置かない（設計書 §6.5 の8）',
    schema: TREE,
    versions: [
      node('a', 'b', 1),
      node('b', 'a', 2),
      node('s', 's', 3),
      node('c', 'a', 4),
      node('r', null, 5),
    ],
    expect: [
      'tree:a 置かない',
      'tree:b 置かない',
      'tree:s 置かない',
      'tree:c 置かない',
      `tree:r 置く id=r up=null name=null updatedAt=${T0}`,
    ],
  },
  {
    name: '自己参照 原則4: SET NULL なら、親が削除された子は列を NULL にして置く',
    schema: TREE_SET_NULL,
    versions: [
      del('tree', 'a', T1, 5, 'a'),
      row('tree', 'b', { id: 'b', up: 'a', updatedAt: T0 }, 2, 'a'),
      row('tree', 'c', { id: 'c', up: 'b', updatedAt: T0 }, 3, 'a'),
    ],
    expect: [
      'tree:a 死',
      `tree:b 置く id=b up=null updatedAt=${T0}`,
      `tree:c 置く id=c up=b updatedAt=${T0}`,
    ],
  },
  {
    name: '自己参照 原則4: SET DEFAULT なら、親が削除された子は既定値の指す行の子として置く',
    schema: TREE_SET_DEFAULT,
    // 強い順は b → root で、既定値の指す root が子より後に並ぶ
    versions: [
      row('tree', 'root', { id: 'root', up: null, updatedAt: T0 }, 1, 'a'),
      del('tree', 'a', T1, 5, 'a'),
      row('tree', 'b', { id: 'b', up: 'a', updatedAt: T0 }, 2, 'a'),
    ],
    expect: [
      `tree:root 置く id=root up=null updatedAt=${T0}`,
      'tree:a 死',
      `tree:b 置く id=b up=root updatedAt=${T0}`,
    ],
  },
]

describe('derive —— 手で作った入力の表（設計書 §1）', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const actual = summarize(
        derive(testCase.versions, testCase.schema),
        testCase.schema
      )
      expect(actual).toEqual([...testCase.expect].sort())
    })
  }

  it('版の並べ替えと重複で答えが変わらない（補題C）', () => {
    for (const testCase of CASES) {
      const base = summarize(
        derive(testCase.versions, testCase.schema),
        testCase.schema
      )
      const reversed = [...testCase.versions].reverse()
      const twice = [...testCase.versions, ...testCase.versions]
      for (const order of [reversed, twice]) {
        expect([
          testCase.name,
          summarize(derive(order, testCase.schema), testCase.schema),
        ]).toEqual([testCase.name, base])
      }
    }
  })
})

describe('derive —— かぶりの勝者（完了条件4）', () => {
  it('部分索引では、述語も引く条件に加える（穴9）', () => {
    // 索引に載るのは `live = 1` の行だけ。`live = 0` の g2 は名前がかぶっていても
    // 索引の対象外なので、勝者にはなりえない。述語を落とすと、いちばん強い g2 が
    // 勝者に選ばれてしまう
    const schema: RowsSchema = {
      tables: [
        {
          name: 'tags',
          ddl: `CREATE TABLE tags (
                  id        TEXT PRIMARY KEY NOT NULL,
                  name      TEXT NOT NULL,
                  live      INTEGER NOT NULL,
                  updatedAt TEXT NOT NULL
                )`,
          indexes: [
            'CREATE UNIQUE INDEX i_live_name ON tags (name) WHERE live = 1',
          ],
        },
      ],
    }
    const derived = derive(
      [
        row(
          'tags',
          'g2',
          { id: 'g2', name: 't1', live: 0, updatedAt: T2 },
          1,
          'a'
        ),
        row(
          'tags',
          'g1',
          { id: 'g1', name: 't1', live: 1, updatedAt: T1 },
          1,
          'a'
        ),
        row(
          'tags',
          'g3',
          { id: 'g3', name: 't1', live: 1, updatedAt: T0 },
          1,
          'a'
        ),
      ],
      schema
    )
    const candidates = derived.candidates.get('tags')
    expect(candidates?.get('g2')?.placement).toBe('placed')
    expect(candidates?.get('g1')?.placement).toBe('placed')
    expect(candidates?.get('g3')?.placement).toBe('hidden')
    expect(candidates?.get('g3')?.winner).toBe('g1')
  })

  it('主キーと UNIQUE の両方に当たる候補では、主キーで引けた行が勝者（穴3の訂正）', () => {
    // SQLite は両方に当たっても `SQLITE_CONSTRAINT_UNIQUE` しか返さない（確認済み）。
    // エラーの種別で分岐すると、主キーの席を占めている行とは別の行を勝者にしてしまう。
    // 1:1 の表では、表示する主キーが勝者の主キーになって別の候補と重なるので、この形が実際に起きる
    const schema: RowsSchema = {
      tables: [
        {
          name: 'tags',
          ddl: `CREATE TABLE tags (
                  id        TEXT PRIMARY KEY NOT NULL,
                  name      TEXT NOT NULL UNIQUE,
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
      ],
    }
    const derived = derive(
      [
        row('tags', 'g1', { id: 'g1', name: 'n1', updatedAt: T2 }, 1, 'a'),
        row('tags', 'g2', { id: 'g2', name: 'n1', updatedAt: T0 }, 1, 'a'),
        row('tags', 'g3', { id: 'g3', name: 'n3', updatedAt: T2 }, 1, 'a'),
        // 強い順に p_g3（memo=m1）→ p_g1（memo=m2）→ p_g2（memo=m1、表示上の主キーは g1）
        row(
          'tag_profiles',
          'g3',
          { id: 'g3', memo: 'm1', updatedAt: T2 },
          3,
          'a'
        ),
        row(
          'tag_profiles',
          'g1',
          { id: 'g1', memo: 'm2', updatedAt: T1 },
          2,
          'a'
        ),
        row(
          'tag_profiles',
          'g2',
          { id: 'g2', memo: 'm1', updatedAt: T0 },
          1,
          'a'
        ),
      ],
      schema
    )
    expect(derived.candidates.get('tags')?.get('g2')?.placement).toBe('hidden')
    const hidden = derived.candidates.get('tag_profiles')?.get('g2')
    expect(hidden?.placement).toBe('hidden')
    // 表示上の主キー g1 の席を占めているのは p_g1。UNIQUE でかぶる p_g3 ではない
    expect(hidden?.winner).toBe('g1')
  })
})

describe('derive —— 生成列（設計書 §3.2）', () => {
  it('生成列は版に載せず、置く行には SQLite が計算した値が出る', () => {
    // 生成列は `PRAGMA table_info` には現れない。`table_xinfo` の `hidden` が
    // 2（VIRTUAL）/ 3（STORED）で見分ける。書くと SQLite に断られるので、
    // INSERT の列からも外す
    const schema: RowsSchema = {
      tables: [
        {
          name: 'tags',
          ddl: `CREATE TABLE tags (
                  id        TEXT PRIMARY KEY NOT NULL,
                  first     TEXT NOT NULL,
                  last      TEXT NOT NULL,
                  full      TEXT GENERATED ALWAYS AS (first || ' ' || last) VIRTUAL,
                  stored    TEXT GENERATED ALWAYS AS (upper(first)) STORED,
                  updatedAt TEXT NOT NULL
                )`,
          indexes: ['CREATE UNIQUE INDEX i_full ON tags (full)'],
        },
      ],
    }
    const derived = derive(
      [
        row(
          'tags',
          'g1',
          { id: 'g1', first: 'a', last: 'b', updatedAt: T2 },
          2,
          'a'
        ),
        // 生成列の値が g1 とかぶる（式索引ではなく、生成列への UNIQUE）
        row(
          'tags',
          'g2',
          { id: 'g2', first: 'a', last: 'b', updatedAt: T0 },
          1,
          'a'
        ),
      ],
      schema
    )
    expect(derived.candidates.get('tags')?.get('g1')?.placement).toBe('placed')
    expect(derived.candidates.get('tags')?.get('g2')?.placement).toBe('hidden')
    expect(derived.candidates.get('tags')?.get('g2')?.winner).toBe('g1')
    const placed = derived.rows.get('tags') ?? []
    expect(placed).toHaveLength(1)
    expect(placed[0].full).toBe('a b')
    expect(placed[0].stored).toBe('A')
  })
})

describe('derive —— 白紙のリスト以外のエラー（完了条件5）', () => {
  it('SQLITE_FULL では置かない行にせず、例外になる', () => {
    const schema: RowsSchema = {
      tables: [
        {
          name: 'tags',
          ddl: `CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL, name TEXT, updatedAt TEXT)`,
        },
      ],
    }
    const versions = Array.from({ length: 400 }, (_, at) =>
      row(
        'tags',
        `g${at}`,
        { id: `g${at}`, name: `n${at}`, updatedAt: T0 },
        at + 1,
        'a'
      )
    )
    expect(() =>
      derive(versions, schema, {
        prepareJudgeDatabase: (db: Database.Database) => {
          // いま使っている頁で打ち止めにする。次に頁が要る INSERT は
          // `SQLITE_FULL`（database or disk is full）で落ちる
          const [{ page_count: pages }] = db.pragma('page_count') as {
            page_count: number
          }[]
          db.pragma(`max_page_count = ${Number(pages)}`)
        },
      })
    ).toThrow(/disk is full/)
  })

  it('白紙のリストのエラー（CHECK）は、置かない行になって作り直しは続く', () => {
    const derived = derive(
      [
        row(
          'items',
          'i1',
          { id: 'i1', tagId: null, label: '', updatedAt: T0 },
          1,
          'a'
        ),
        row(
          'items',
          'i2',
          { id: 'i2', tagId: null, label: 'x', updatedAt: T0 },
          1,
          'a'
        ),
      ],
      GUARDED
    )
    expect(derived.candidates.get('items')?.get('i1')?.placement).toBe(
      'unplaceable'
    )
    expect(derived.candidates.get('items')?.get('i2')?.placement).toBe('placed')
  })
})
