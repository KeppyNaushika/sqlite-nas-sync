/**
 * 作り直しの計算の範囲（`src/rows/rebuild-plan.ts`、設計書 `docs/rows-table-design.md` §3.7）。
 *
 * 計算するのは、適用する表とその祖先だけである。
 * ここでは、同期する表を全部計算した計画と、範囲を絞った計画が、適用する表について完全に一致することを確かめる。
 * 全部を計算した計画は、`targets` に同期する表の全部を渡して作る。
 * このとき適用する表が全部になるので、祖先を辿った範囲も全部になる。
 *
 * スキーマには次のものを入れる。
 *
 * - 外部キーの鎖（`roots` → `groups` → `items`）
 * - 自己参照の外部キーと `SET DEFAULT`（`tree`）
 * - 主キーが親を指す 1:1 の表（`profiles`）
 * - UNIQUE の重なりで隠れた行（`roots.name` が `COLLATE NOCASE` の UNIQUE）
 * - 削除された親と、その子と孫
 * - 同期しない表を指す外部キーと、同期しない表をはさんだ先の同期する表（`notes` → `memos` → `roots`）
 * - 外部キーの親の表の名前を、宣言と違う大文字と小文字で書いた表（`tags` → `ROOTS`）
 * - どの表ともつながらない表（`labels`）
 */
import Database from 'better-sqlite3'
import { importFromPeer } from '../src/rows/import'
import { RebuildPlan, computeRebuildPlan } from '../src/rows/rebuild-plan'
import { createRowsTables } from '../src/rows/schema'
import { createRowsTriggers } from '../src/rows/triggers'

const STATEMENTS = [
  `CREATE TABLE roots (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     updatedAt TEXT)`,
  `CREATE TABLE groups (
     id TEXT PRIMARY KEY NOT NULL,
     rootId TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
     code TEXT NOT NULL,
     updatedAt TEXT,
     UNIQUE (rootId, code))`,
  `CREATE TABLE items (
     id TEXT PRIMARY KEY NOT NULL,
     groupId TEXT REFERENCES groups(id) ON DELETE SET NULL,
     body TEXT,
     updatedAt TEXT)`,
  `CREATE TABLE tree (
     id TEXT PRIMARY KEY NOT NULL,
     parentId TEXT REFERENCES tree(id) ON DELETE CASCADE,
     rootId TEXT DEFAULT 'r0' REFERENCES roots(id) ON DELETE SET DEFAULT,
     updatedAt TEXT)`,
  `CREATE TABLE profiles (
     id TEXT PRIMARY KEY NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
     bio TEXT,
     updatedAt TEXT)`,
  // 同期しない表
  `CREATE TABLE memos (
     id TEXT PRIMARY KEY NOT NULL,
     rootId TEXT REFERENCES roots(id))`,
  `CREATE TABLE notes (
     id TEXT PRIMARY KEY NOT NULL,
     memoId TEXT REFERENCES memos(id) ON DELETE CASCADE,
     updatedAt TEXT)`,
  `CREATE TABLE tags (
     id TEXT PRIMARY KEY NOT NULL,
     rootId TEXT REFERENCES ROOTS(id) ON DELETE CASCADE,
     updatedAt TEXT)`,
  `CREATE TABLE labels (
     id INTEGER PRIMARY KEY,
     label TEXT UNIQUE,
     updatedAt TEXT)`,
]

const TABLES = [
  'roots',
  'groups',
  'items',
  'tree',
  'profiles',
  'notes',
  'tags',
  'labels',
]

function openClient(instance: string): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const statement of STATEMENTS) db.exec(statement)
  const specs = TABLES.map((name) => ({ name }))
  createRowsTables(db, specs, instance)
  createRowsTriggers(db, specs)
  // 取り込みは、相手の `schemaVersion` が同じときだけ読む
  db.exec(`CREATE TABLE _sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.prepare(
    `INSERT INTO _sync_meta (key, value) VALUES ('schemaVersion', ?)`
  ).run('app1;sns-format=rows1')
  return db
}

function run(db: Database.Database, sql: string): void {
  db.exec(sql)
}

/**
 * 2台で書いて、片方へ取り込む。
 *
 * - `r1` と `r2` は `name` が大文字と小文字だけ違うので、弱い `r1` が隠れた行になる。
 *   `r1` を指す子は `r2` を指す。`profiles` の `r1` は表示上の主キーが `r2` になる
 * - `r3` は手元が消し、相手がその子と孫を作る
 * - `r0` は `tree` の `SET DEFAULT` の行き先
 */
function prepare(): { mine: Database.Database; peer: Database.Database } {
  const mine = openClient('aaaa')
  const peer = openClient('bbbb')
  for (const db of [mine, peer]) {
    run(
      db,
      `INSERT INTO roots VALUES ('r0', 'zero', '2026-01-01');
       INSERT INTO roots VALUES ('r3', 'three', '2026-01-01');
       INSERT INTO memos VALUES ('m1', 'r0');`
    )
  }
  run(
    mine,
    `INSERT INTO roots VALUES ('r1', 'Alpha', '2026-01-02');
     INSERT INTO groups VALUES ('g1', 'r1', 'x', '2026-01-02');
     INSERT INTO items VALUES ('i1', 'g1', 'mine', '2026-01-02');
     INSERT INTO tree VALUES ('t1', NULL, 'r1', '2026-01-02');
     INSERT INTO tree VALUES ('t2', 't1', 'r1', '2026-01-02');
     INSERT INTO labels VALUES (1, 'same', '2026-01-02');
     INSERT INTO notes VALUES ('n1', 'm1', '2026-01-02');
     INSERT INTO tags VALUES ('a1', 'r1', '2026-01-02');
     INSERT INTO profiles VALUES ('r1', 'shown as r2', '2026-01-04');
     DELETE FROM roots WHERE id = 'r3';`
  )
  run(
    peer,
    `INSERT INTO roots VALUES ('r2', 'alpha', '2026-01-03');
     INSERT INTO profiles VALUES ('r2', 'hidden parent', '2026-01-03');
     INSERT INTO profiles VALUES ('r3', 'deleted parent', '2026-01-03');
     INSERT INTO groups VALUES ('g2', 'r2', 'x', '2026-01-03');
     INSERT INTO groups VALUES ('g3', 'r3', 'y', '2026-01-03');
     INSERT INTO items VALUES ('i2', 'g2', 'peer', '2026-01-03');
     INSERT INTO items VALUES ('i3', 'g3', 'orphan', '2026-01-03');
     INSERT INTO tree VALUES ('t3', NULL, 'r3', '2026-01-03');
     INSERT INTO tree VALUES ('t4', 't3', 'r2', '2026-01-03');
     INSERT INTO labels VALUES (2, 'same', '2026-01-03');
     INSERT INTO tags VALUES ('a3', 'r3', '2026-01-03');`
  )
  importFromPeer(mine, peer, { tables: TABLES })
  return { mine, peer }
}

/** 計画のうち、`names` の表の分だけを残す。token はそのまま。 */
function only(plan: RebuildPlan, names: readonly string[]): RebuildPlan {
  const keep = new Set(names)
  return {
    token: plan.token,
    apply: plan.apply.filter((table) => keep.has(table.name)),
    shown: plan.shown.filter((row) => keep.has(row.table)),
    hidden: plan.hidden.filter((row) => keep.has(row.table)),
    unplaceable: plan.unplaceable.filter((row) => keep.has(row.table)),
  }
}

describe('作り直しの計算の範囲 —— 適用する表とその祖先だけを計算する（§3.7）', () => {
  it('全部を計算した計画と、適用する表について一致する', () => {
    const { mine, peer } = prepare()
    try {
      const full = computeRebuildPlan(mine, { tables: TABLES, targets: TABLES })
      // 場面が揃っていることを先に確かめる
      expect(full.hidden.map((row) => [row.table, row.trueId])).toEqual([
        ['roots', 'r1'],
        ['groups', 'g1'],
        ['profiles', 'r2'],
        ['labels', '1'],
      ])
      expect(
        full.unplaceable.map((row) => [row.table, row.trueId, row.causeId])
      ).toEqual([
        ['groups', 'g3', 'r3'],
        ['profiles', 'r3', 'r3'],
      ])
      expect(full.shown).toEqual([
        { table: 'profiles', trueId: 'r1', shownId: 'r2' },
      ])

      const seeds: (string[] | undefined)[] = [
        undefined,
        ...TABLES.map((table) => [table]),
        ['items', 'labels'],
        ['tree', 'notes'],
      ]
      for (const seed of seeds) {
        const narrow = computeRebuildPlan(mine, {
          tables: TABLES,
          targets: seed,
        })
        const names = narrow.apply.map((table) => table.name)
        expect([seed, narrow]).toStrictEqual([seed, only(full, names)])
      }
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('対象から外した祖先も計算して、子の表の答えを変えない', () => {
    const { mine, peer } = prepare()
    try {
      // `excluded` は適用する表を減らすだけなので、外さずに全部を計算した計画と比べる
      const full = computeRebuildPlan(mine, { tables: TABLES, targets: TABLES })
      const narrow = computeRebuildPlan(mine, {
        tables: TABLES,
        targets: ['items'],
        excluded: ['roots', 'groups'],
      })
      expect(narrow.apply.map((table) => table.name)).toEqual(['items'])
      expect(narrow).toStrictEqual(only(full, ['items']))
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('子孫は適用する表に入り、祖先は入らない', () => {
    const { mine, peer } = prepare()
    try {
      const plan = computeRebuildPlan(mine, {
        tables: TABLES,
        targets: ['groups'],
      })
      expect(plan.apply.map((table) => table.name)).toEqual(['groups', 'items'])
      // token は同期する表の全部で取る
      expect(Object.keys(plan.token.ticks)).toEqual(TABLES)
    } finally {
      mine.close()
      peer.close()
    }
  })
})
