/**
 * 案A の表とトリガー（`src/rows/schema.ts`・`src/rows/triggers.ts`）の試験。
 * 設計書 `docs/rows-table-design.md` §3.1〜§3.5。
 *
 * ここで見るのは「アプリの接続でアプリの表に起きた変化が、原因によらず
 * すべて事実になること」（§2.2 の R0）と、その裏側の3つ:
 *
 * - **アプリの書き込みを壊さないこと**（`ON DELETE SET NULL` の親の削除が成功する）
 * - **黙って値を失わないこと**（書かなかった列・取り込みの直後の窓）
 * - **作り直しの最中は何も事実にしないこと**（番人）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { checkRowsPreconditions } from '../src/setup/rows-preflight'
import {
  RowsTableSpec,
  createRowsTables,
  ensureClockRow,
  rowsTableName,
} from '../src/rows/schema'
import { createRowsTriggers, rowsTriggerNames } from '../src/rows/triggers'

const INSTANCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/** 表を作り、案A の表とトリガーを載せた DB を1つ開く。 */
function open(
  statements: string[],
  tables: RowsTableSpec[] | string[],
  instanceId = INSTANCE
): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const statement of statements) db.exec(statement)
  const specs = (tables as (RowsTableSpec | string)[]).map((table) =>
    typeof table === 'string' ? { name: table } : table
  )
  createRowsTables(db, specs, instanceId)
  createRowsTriggers(db, specs)
  return db
}

type Row = Record<string, unknown>

function rowsOf(db: Database.Database, table: string): Row[] {
  return db
    .prepare(`SELECT * FROM "${rowsTableName(table)}" ORDER BY rowid`)
    .all() as Row[]
}

function tombstonesOf(db: Database.Database, table: string): Row[] {
  return db
    .prepare(`SELECT * FROM _tombstone WHERE tableName = ? ORDER BY recordId`)
    .all(table) as Row[]
}

function lamportOf(db: Database.Database): number {
  return (
    db.prepare(`SELECT lamport FROM _sns_clock`).get() as { lamport: number }
  ).lamport
}

function tickOf(db: Database.Database, table: string): number {
  const row = db
    .prepare(`SELECT tick FROM _sns_tick WHERE tableName = ?`)
    .get(table) as { tick: number } | undefined
  return row?.tick ?? 0
}

function dirtyTables(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT tableName FROM _sns_dirty ORDER BY tableName`).all() as {
      tableName: string
    }[]
  ).map((row) => row.tableName)
}

/** 素直な1表。時刻列は `updatedAt`、NOT NULL の列を1つ持つ。 */
const NOTES = `CREATE TABLE notes (
  id        TEXT PRIMARY KEY NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT,
  updatedAt TEXT
)`

/* ================================================================== *
 * 表を作る（§3.1・§3.2）
 * ================================================================== */

describe('createRowsTables —— 表の形（§3.1・§3.2）', () => {
  it('_sns_rows_<表> は UNIQUE も NOT NULL も写さず、版の3列を足す', () => {
    const db = open(
      [
        `CREATE TABLE t (
           id   TEXT PRIMARY KEY NOT NULL,
           code TEXT NOT NULL UNIQUE,
           n    INTEGER DEFAULT 7 CHECK (n >= 0),
           updatedAt TEXT
         )`,
      ],
      ['t']
    )
    try {
      const columns = db.pragma(`table_info(_sns_rows_t)`) as {
        name: string
        type: string
        notnull: number
        pk: number
        dflt_value: unknown
      }[]
      expect(columns.map((c) => c.name)).toEqual([
        'id',
        'code',
        'n',
        'updatedAt',
        '_sns_ts',
        '_sns_lamport',
        '_sns_instance',
      ])
      // アプリ側の NOT NULL・DEFAULT は写らない
      expect(columns.find((c) => c.name === 'code')?.notnull).toBe(0)
      expect(columns.find((c) => c.name === 'n')?.dflt_value).toBe(null)
      // 主キーだけは写す
      expect(columns.find((c) => c.name === 'id')?.pk).toBe(1)
      // UNIQUE も CHECK も無い
      const list = db.pragma(`index_list(_sns_rows_t)`) as { origin: string }[]
      expect(list.filter((index) => index.origin === 'u')).toEqual([])
      // `_sns_ts` は型名なし（値の種類をそのまま保つため）
      expect(columns.find((c) => c.name === '_sns_ts')?.type).toBe('')
      expect(columns.find((c) => c.name === '_sns_lamport')?.notnull).toBe(1)
    } finally {
      db.close()
    }
  })

  it('生成列は _sns_rows_<表> に写さない（§3.1 の軽微18）', () => {
    const db = open(
      [
        `CREATE TABLE t (
           id TEXT PRIMARY KEY NOT NULL,
           a  INTEGER,
           b  INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL,
           c  INTEGER GENERATED ALWAYS AS (a + 1) STORED,
           updatedAt TEXT
         )`,
      ],
      ['t']
    )
    try {
      const names = (
        db.pragma(`table_info(_sns_rows_t)`) as { name: string }[]
      ).map((column) => column.name)
      expect(names).not.toContain('b')
      expect(names).not.toContain('c')
      db.prepare(
        `INSERT INTO t (id, a, updatedAt) VALUES ('1', 2, '2026-01-01')`
      ).run()
      expect(rowsOf(db, 't')).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('_tombstone の _sns_ts は型名なしで足される（ensureTombstoneColumn は使えない）', () => {
    const db = open([NOTES], ['notes'])
    try {
      const columns = db.pragma(`table_info(_tombstone)`) as {
        name: string
        type: string
      }[]
      expect(columns.find((c) => c.name === '_sns_ts')?.type).toBe('')
      expect(columns.find((c) => c.name === '_sns_lamport')?.type).toBe(
        'INTEGER'
      )
      expect(columns.find((c) => c.name === '_sns_instance')?.type).toBe('TEXT')
    } finally {
      db.close()
    }
  })

  it('_sns_shown は (tableName, trueId) が主キーで、(tableName, shownId) が UNIQUE', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(`INSERT INTO _sns_shown VALUES ('notes','A','B')`).run()
      expect(() =>
        db.prepare(`INSERT INTO _sns_shown VALUES ('notes','A','C')`).run()
      ).toThrow(/PRIMARYKEY|UNIQUE/)
      expect(() =>
        db.prepare(`INSERT INTO _sns_shown VALUES ('notes','X','B')`).run()
      ).toThrow(/UNIQUE/)
    } finally {
      db.close()
    }
  })

  it('補助の表がぜんぶ在り、4本のトリガーが付く', () => {
    const db = open([NOTES], ['notes'])
    try {
      const names = new Set(
        (
          db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all() as { name: string }[]
        ).map((row) => row.name)
      )
      for (const table of [
        '_sns_rows_notes',
        '_sns_clock',
        '_sns_tick',
        '_sns_dirty',
        '_sns_shown',
        '_sns_hidden',
        '_sns_unplaceable',
        '_sns_rebuilding',
        '_tombstone',
      ]) {
        expect(names).toContain(table)
      }
      const triggers = new Set(
        (
          db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
            .all() as { name: string }[]
        ).map((row) => row.name)
      )
      expect([...rowsTriggerNames('notes')].every((n) => triggers.has(n))).toBe(
        true
      )
      expect(triggers.size).toBe(4)
    } finally {
      db.close()
    }
  })

  it('二度作っても DB は動かない（冪等）', () => {
    const db = open([NOTES], ['notes'])
    try {
      const before = db
        .prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`)
        .all()
      createRowsTables(db, [{ name: 'notes' }], INSTANCE)
      createRowsTriggers(db, [{ name: 'notes' }])
      const after = db
        .prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`)
        .all()
      expect(after).toEqual(before)
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 素直な書き込み（§3.4.2・§3.4.3・§3.4.4）
 * ================================================================== */

describe('トリガー —— 作成・更新・削除', () => {
  it('INSERT が行の版を1つ作り、lamport と tick を進める', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1', 'title', 'body', '2026-01-01T00:00:00.000Z')`
      ).run()
      const rows = rowsOf(db, 'notes')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: 'n1',
        title: 'title',
        body: 'body',
        _sns_ts: '2026-01-01T00:00:00.000Z',
        _sns_lamport: 1,
        _sns_instance: INSTANCE,
      })
      expect(lamportOf(db)).toBe(1)
      expect(tickOf(db, 'notes')).toBe(1)
      expect(dirtyTables(db)).toEqual(['notes'])
      expect(
        db
          .prepare(`SELECT tableName, recordId, operation FROM _changelog`)
          .all()
      ).toEqual([{ tableName: 'notes', recordId: 'n1', operation: 'INSERT' }])
    } finally {
      db.close()
    }
  })

  it('全列の更新が版を進める', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `UPDATE notes SET title='A', body='B', updatedAt='2026-01-02T00:00:00.000Z' WHERE id='n1'`
      ).run()
      expect(rowsOf(db, 'notes')[0]).toMatchObject({
        title: 'A',
        body: 'B',
        _sns_ts: '2026-01-02T00:00:00.000Z',
        _sns_lamport: 2,
      })
    } finally {
      db.close()
    }
  })

  it('一部の列だけの更新でも、書かなかった列は引き継がれる（必須2）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`UPDATE notes SET title='A' WHERE id='n1'`).run()
      expect(rowsOf(db, 'notes')[0]).toMatchObject({
        title: 'A',
        body: 'b',
        _sns_ts: '2026-01-01T00:00:00.000Z',
        _sns_lamport: 2,
      })
    } finally {
      db.close()
    }
  })

  it('時刻の列を進めない更新でも、lamport で前後が付く（§1.2.4）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`UPDATE notes SET title='A' WHERE id='n1'`).run()
      db.prepare(`UPDATE notes SET title='AA' WHERE id='n1'`).run()
      const row = rowsOf(db, 'notes')[0]
      expect(row._sns_ts).toBe('2026-01-01T00:00:00.000Z')
      expect(row._sns_lamport).toBe(3)
      expect(row.title).toBe('AA')
    } finally {
      db.close()
    }
  })

  it('時刻の列を戻す更新でも、順序用の時刻は下がらない（引き上げ）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-06-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `UPDATE notes SET updatedAt='2026-01-01T00:00:00.000Z' WHERE id='n1'`
      ).run()
      expect(rowsOf(db, 'notes')[0]._sns_ts).toBe('2026-06-01T00:00:00.000Z')
      // アプリの表そのものは書いたとおり
      expect(
        (db.prepare(`SELECT updatedAt FROM notes`).get() as Row).updatedAt
      ).toBe('2026-01-01T00:00:00.000Z')
    } finally {
      db.close()
    }
  })

  it('DELETE が削除の版を作り、行の版を落とす', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      expect(rowsOf(db, 'notes')).toEqual([])
      const graves = tombstonesOf(db, 'notes')
      expect(graves).toHaveLength(1)
      expect(graves[0]).toMatchObject({
        recordId: 'n1',
        _sns_lamport: 2,
        _sns_instance: INSTANCE,
      })
      // 原則2: 順序に使うのは削除を実行した時刻。消した行の updatedAt ではない
      expect(graves[0]._sns_ts).toBe(graves[0].deletedAt)
      expect(graves[0]._sns_ts).not.toBe('2026-01-01T00:00:00.000Z')
    } finally {
      db.close()
    }
  })

  it('消してすぐ同じ id で作り直すと、作り直しが勝つ（§2.3 の場面4・必須3）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-06-01T00:00:00.000Z')`
      ).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      // 古い時刻で作り直しても、順序用の時刻は墓標から引き上げられる
      db.prepare(
        `INSERT INTO notes VALUES ('n1','z','y','2026-01-01T00:00:00.000Z')`
      ).run()
      const row = rowsOf(db, 'notes')[0]
      const grave = tombstonesOf(db, 'notes')[0]
      expect(row._sns_ts).toBe(grave._sns_ts)
      // 同着の時刻なので lamport で決まる。行の版のほうが後
      expect(Number(row._sns_lamport)).toBeGreaterThan(
        Number(grave._sns_lamport)
      )
    } finally {
      db.close()
    }
  })

  it('墓標は弱い版で上書きされない（ON CONFLICT … WHERE STRONGER）', () => {
    const db = open([NOTES], ['notes'])
    try {
      // 大きく未来の時刻で作って消す。削除を実行した時刻よりも強い墓標になる
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2099-06-01T00:00:00.000Z')`
      ).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      const strong = tombstonesOf(db, 'notes')[0]
      expect(strong._sns_ts).toBe('2099-06-01T00:00:00.000Z')
      // 手で弱い版を作って（取り込みの真似）、そのあとアプリが同じ id を作って消す
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2020-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      const after = tombstonesOf(db, 'notes')[0]
      expect(after._sns_ts).toBe(strong._sns_ts)
      expect(Number(after._sns_lamport)).toBeGreaterThan(
        Number(strong._sns_lamport)
      )
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 統合した行の DELETE（原則3）
 * ================================================================== */

describe('統合した行の DELETE', () => {
  /** `UNIQUE` がかぶって n2 が n1 の後ろに隠れている状態を作る。 */
  function withHidden(db: Database.Database): void {
    db.prepare(
      `INSERT INTO notes VALUES ('n1','同じ名前','b','2026-01-01T00:00:00.000Z')`
    ).run()
    // 隠れている側の版を直に置く（アプリの表には現れない）
    db.prepare(
      `INSERT INTO _sns_rows_notes (id, title, body, updatedAt, _sns_ts, _sns_lamport, _sns_instance)
       VALUES ('n2','同じ名前','y','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z',1,'bbbb')`
    ).run()
    db.prepare(`INSERT INTO _sns_hidden VALUES ('notes','n2','n1')`).run()
  }

  it('隠れていた側の主キーにも削除の版が書かれる', () => {
    const db = open([NOTES], ['notes'])
    try {
      withHidden(db)
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      const graves = tombstonesOf(db, 'notes')
      expect(graves.map((row) => row.recordId)).toEqual(['n1', 'n2'])
      // 1回の `DELETE` なので、どちらも同じ実行時刻になる
      expect(graves[1]._sns_ts).toBe(graves[0]._sns_ts)
      expect(graves[1]._sns_ts).toBe(graves[1].deletedAt)
      // 隠れていた側の行の版も落ちる
      expect(rowsOf(db, 'notes')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('隠れていた側の主キーも _changelog で告げる', () => {
    const db = open([NOTES], ['notes'])
    try {
      withHidden(db)
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      const told = db
        .prepare(
          `SELECT DISTINCT recordId FROM _changelog
            WHERE tableName='notes' AND operation='DELETE' ORDER BY recordId`
        )
        .all() as Row[]
      expect(told.map((row) => row.recordId)).toEqual(['n1', 'n2'])
    } finally {
      db.close()
    }
  })

  it('隠れていた側の版のほうが強ければ、削除の版もその強さで書かれる', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','同じ名前','b','2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO _sns_rows_notes (id, title, body, updatedAt, _sns_ts, _sns_lamport, _sns_instance)
         VALUES ('n2','同じ名前','y','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',1,'bbbb')`
      ).run()
      db.prepare(`INSERT INTO _sns_hidden VALUES ('notes','n2','n1')`).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      const graves = tombstonesOf(db, 'notes')
      // n2 の削除の版が n2 の行の版より弱いと、消したはずの行が戻る
      expect(graves[1]).toMatchObject({
        recordId: 'n2',
        _sns_ts: '2099-01-01T00:00:00.000Z',
      })
      expect(rowsOf(db, 'notes')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('勝者のいない隠れた行は巻き込まない', () => {
    const db = open([NOTES], ['notes'])
    try {
      withHidden(db)
      db.prepare(`UPDATE _sns_hidden SET winnerId = NULL`).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      expect(tombstonesOf(db, 'notes').map((row) => row.recordId)).toEqual([
        'n1',
      ])
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 主キーを変える UPDATE（§3.4.1・訂正2）
 * ================================================================== */

describe('主キーを変える UPDATE', () => {
  it('古い真の id の削除の版と、新しい真の id の行の版ができる', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`UPDATE notes SET id='n2' WHERE id='n1'`).run()
      expect(rowsOf(db, 'notes').map((row) => row.id)).toEqual(['n2'])
      expect(tombstonesOf(db, 'notes').map((row) => row.recordId)).toEqual([
        'n1',
      ])
      const operations = (
        db
          .prepare(`SELECT recordId, operation FROM _changelog ORDER BY id`)
          .all() as Row[]
      ).map((row) => `${row.operation}:${row.recordId}`)
      expect(operations).toEqual(['INSERT:n1', 'DELETE:n1', 'UPDATE:n2'])
    } finally {
      db.close()
    }
  })

  it('ON UPDATE CASCADE で動いた子にも、移動の版ができる', () => {
    const db = open(
      [
        `CREATE TABLE p (id TEXT PRIMARY KEY NOT NULL, updatedAt TEXT)`,
        `CREATE TABLE c (id TEXT PRIMARY KEY NOT NULL, pid TEXT REFERENCES p(id) ON UPDATE CASCADE ON DELETE CASCADE, updatedAt TEXT)`,
      ],
      ['p', 'c']
    )
    try {
      db.prepare(`INSERT INTO p VALUES ('p1','2026-01-01')`).run()
      db.prepare(`INSERT INTO c VALUES ('c1','p1','2026-01-01')`).run()
      db.prepare(`UPDATE p SET id='p2' WHERE id='p1'`).run()
      expect(rowsOf(db, 'p').map((row) => row.id)).toEqual(['p2'])
      expect(tombstonesOf(db, 'p').map((row) => row.recordId)).toEqual(['p1'])
      // 子は主キーが変わっていないので「同じ側」のトリガーが動き、pid だけが変わる
      expect(rowsOf(db, 'c')[0]).toMatchObject({ id: 'c1', pid: 'p2' })
      expect(tombstonesOf(db, 'c')).toEqual([])
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 1:1 の表（§1.4・訂正2）
 * ================================================================== */

describe('1:1 の表（_sns_shown を shownId 側から引く）', () => {
  const PROFILE = `CREATE TABLE profile (
    userId TEXT PRIMARY KEY NOT NULL,
    bio    TEXT,
    updatedAt TEXT
  )`

  it('表示している id で書いても、版は真の id で記録される', () => {
    const db = open([PROFILE], ['profile'])
    try {
      db.prepare(`INSERT INTO _sns_shown VALUES ('profile','A','B')`).run()
      db.prepare(`INSERT INTO profile VALUES ('B','hello','2026-01-01')`).run()
      expect(rowsOf(db, 'profile')[0]).toMatchObject({
        userId: 'A',
        bio: 'hello',
      })
      db.prepare(`UPDATE profile SET bio='hi' WHERE userId='B'`).run()
      expect(rowsOf(db, 'profile')[0]).toMatchObject({ userId: 'A', bio: 'hi' })
      db.prepare(`DELETE FROM profile WHERE userId='B'`).run()
      expect(tombstonesOf(db, 'profile').map((row) => row.recordId)).toEqual([
        'A',
      ])
    } finally {
      db.close()
    }
  })

  it('TRUE_ID が同じままの主キーの変更では、削除の版を作らず shownId を書き換える（訂正2）', () => {
    const db = open([PROFILE], ['profile'])
    try {
      db.prepare(`INSERT INTO _sns_shown VALUES ('profile','A','B')`).run()
      db.prepare(`INSERT INTO profile VALUES ('B','hello','2026-01-01')`).run()
      const before = lamportOf(db)
      // 表示していた id を、真の id そのものへ戻す
      db.prepare(`UPDATE profile SET userId='A' WHERE userId='B'`).run()
      expect(tombstonesOf(db, 'profile')).toEqual([])
      expect(rowsOf(db, 'profile').map((row) => row.userId)).toEqual(['A'])
      expect(
        db.prepare(`SELECT shownId FROM _sns_shown WHERE trueId='A'`).get()
      ).toEqual({ shownId: 'A' })
      expect(lamportOf(db)).toBe(before + 1)
    } finally {
      db.close()
    }
  })

  it('TRUE_ID が動く主キーの変更では、削除の版ができる', () => {
    const db = open([PROFILE], ['profile'])
    try {
      db.prepare(`INSERT INTO _sns_shown VALUES ('profile','A','B')`).run()
      db.prepare(`INSERT INTO profile VALUES ('B','hello','2026-01-01')`).run()
      db.prepare(`UPDATE profile SET userId='C' WHERE userId='B'`).run()
      expect(tombstonesOf(db, 'profile').map((row) => row.recordId)).toEqual([
        'A',
      ])
      expect(rowsOf(db, 'profile').map((row) => row.userId)).toEqual(['C'])
    } finally {
      db.close()
    }
  })

  it('整数の主キーでも、_tombstone.recordId は正規形で突き合う（必須7）', () => {
    const db = open(
      [`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, updatedAt TEXT)`],
      ['t']
    )
    try {
      db.prepare(`INSERT INTO t VALUES (5,'a','2026-06-01')`).run()
      db.prepare(`DELETE FROM t WHERE id=5`).run()
      expect(tombstonesOf(db, 't').map((row) => row.recordId)).toEqual(['5'])
      const grave = tombstonesOf(db, 't')[0]
      // '05' という別の id の墓標は、この行とは突き合わない
      db.prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt, _sns_ts, _sns_lamport, _sns_instance)
         VALUES ('t','05','2026-01-01','2099-01-01',1,'zzzz')`
      ).run()
      db.prepare(`INSERT INTO t VALUES (5,'b','2026-01-01')`).run()
      // 引き上げに使われたのは '5' の墓標であって、'05' の 2099 ではない
      expect(rowsOf(db, 't')[0]._sns_ts).toBe(grave._sns_ts)
      expect(rowsOf(db, 't')[0]._sns_ts).not.toBe('2099-01-01')
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 外部キーの動作（§2.2 の R0・§3.4.0 の必須1）
 * ================================================================== */

describe('外部キーの動作', () => {
  const FAMILY = [
    `CREATE TABLE p (id TEXT PRIMARY KEY NOT NULL, updatedAt TEXT)`,
    `CREATE TABLE c (id TEXT PRIMARY KEY NOT NULL, pid TEXT REFERENCES p(id) ON DELETE CASCADE, updatedAt TEXT)`,
    `CREATE TABLE g (id TEXT PRIMARY KEY NOT NULL, cid TEXT REFERENCES c(id) ON DELETE CASCADE, updatedAt TEXT)`,
  ]

  it('cascade で消える子と孫にも、削除の版ができる（R0）', () => {
    const db = open(FAMILY, ['p', 'c', 'g'])
    try {
      db.prepare(`INSERT INTO p VALUES ('p1','2026-01-01')`).run()
      db.prepare(`INSERT INTO c VALUES ('c1','p1','2026-01-01')`).run()
      db.prepare(`INSERT INTO g VALUES ('g1','c1','2026-01-01')`).run()
      db.prepare(`DELETE FROM p WHERE id='p1'`).run()
      expect(tombstonesOf(db, 'p').map((row) => row.recordId)).toEqual(['p1'])
      expect(tombstonesOf(db, 'c').map((row) => row.recordId)).toEqual(['c1'])
      expect(tombstonesOf(db, 'g').map((row) => row.recordId)).toEqual(['g1'])
      expect(rowsOf(db, 'g')).toEqual([])
      expect(dirtyTables(db)).toEqual(['c', 'g', 'p'])
    } finally {
      db.close()
    }
  })

  it('ON DELETE SET NULL の子を持つ親の削除が成功する（必須1）', () => {
    const db = open(
      [
        `CREATE TABLE p (id TEXT PRIMARY KEY NOT NULL, updatedAt TEXT)`,
        `CREATE TABLE c (id TEXT PRIMARY KEY NOT NULL, pid TEXT REFERENCES p(id) ON DELETE SET NULL, updatedAt TEXT)`,
      ],
      ['p', 'c']
    )
    try {
      db.prepare(`INSERT INTO p VALUES ('p1','2026-01-01')`).run()
      db.prepare(`INSERT INTO c VALUES ('c1','p1','2026-01-01')`).run()
      // ここが `INSERT OR IGNORE INTO _sns_dirty` だと SQLITE_CONSTRAINT_PRIMARYKEY で
      // アプリの DELETE ごと失敗する（設計書 §3.4）
      expect(() =>
        db.prepare(`DELETE FROM p WHERE id='p1'`).run()
      ).not.toThrow()
      expect(db.prepare(`SELECT pid FROM c WHERE id='c1'`).get()).toEqual({
        pid: null,
      })
      expect(rowsOf(db, 'c')[0]).toMatchObject({ id: 'c1', pid: null })
      expect(tombstonesOf(db, 'c')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('ON DELETE SET DEFAULT の子も、既定値に落ちた事実になる', () => {
    const db = open(
      [
        `CREATE TABLE p (id TEXT PRIMARY KEY NOT NULL, updatedAt TEXT)`,
        `CREATE TABLE c (
           id  TEXT PRIMARY KEY NOT NULL,
           pid TEXT DEFAULT 'p0' REFERENCES p(id) ON DELETE SET DEFAULT,
           updatedAt TEXT
         )`,
      ],
      ['p', 'c']
    )
    try {
      db.prepare(`INSERT INTO p VALUES ('p0','2026-01-01')`).run()
      db.prepare(`INSERT INTO p VALUES ('p1','2026-01-01')`).run()
      db.prepare(`INSERT INTO c VALUES ('c1','p1','2026-01-01')`).run()
      expect(() =>
        db.prepare(`DELETE FROM p WHERE id='p1'`).run()
      ).not.toThrow()
      expect(rowsOf(db, 'c')[0]).toMatchObject({ id: 'c1', pid: 'p0' })
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * いろいろな書き方（§2.2 の R0）
 * ================================================================== */

describe('書き方のいろいろ', () => {
  it('INSERT OR REPLACE が消した行も事実になる', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-06-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT OR REPLACE INTO notes VALUES ('n1','z',NULL,'2026-01-01T00:00:00.000Z')`
      ).run()
      // 消えた行の墓標は残るが、あとの行の版のほうが強い（補題A）
      const row = rowsOf(db, 'notes')[0]
      const grave = tombstonesOf(db, 'notes')[0]
      expect(row).toMatchObject({ title: 'z', body: null })
      expect(row._sns_ts).toBe(grave._sns_ts)
      expect(Number(row._sns_lamport)).toBeGreaterThan(
        Number(grave._sns_lamport)
      )
    } finally {
      db.close()
    }
  })

  it('INSERT OR REPLACE のとき、本体の ON CONFLICT … WHERE は守られる（§3.4.0）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2099-01-01T00:00:00.000Z')`
      ).run()
      const strong = rowsOf(db, 'notes')[0]
      // 弱い版（時刻が古い）で置き換えようとしても、`_sns_ts` は下がらない
      db.prepare(
        `INSERT OR REPLACE INTO notes VALUES ('n1','z','y','2000-01-01T00:00:00.000Z')`
      ).run()
      expect(rowsOf(db, 'notes')[0]._sns_ts).toBe(strong._sns_ts)
    } finally {
      db.close()
    }
  })

  it('upsert（ON CONFLICT DO UPDATE）が版を進める', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO notes VALUES ('n1','z','y','2026-02-01T00:00:00.000Z')
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, updatedAt = excluded.updatedAt`
      ).run()
      expect(rowsOf(db, 'notes')[0]).toMatchObject({
        title: 'z',
        body: 'b',
        _sns_ts: '2026-02-01T00:00:00.000Z',
      })
      expect(tombstonesOf(db, 'notes')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('UPDATE OR REPLACE が消した行も事実になる', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(`INSERT INTO notes VALUES ('n1','a','b','2026-01-01')`).run()
      db.prepare(`INSERT INTO notes VALUES ('n2','c','d','2026-01-01')`).run()
      db.prepare(`UPDATE OR REPLACE notes SET id='n1' WHERE id='n2'`).run()
      expect(db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({
        n: 1,
      })
      expect(rowsOf(db, 'notes').map((row) => row.id)).toEqual(['n1'])
      // 置き換えで消えた 'n1' と、移動元の 'n2' の両方が墓標に載る
      expect(
        tombstonesOf(db, 'notes')
          .map((row) => row.recordId)
          .sort()
      ).toEqual(['n1', 'n2'])
    } finally {
      db.close()
    }
  })

  it('WHERE の無い DELETE でもトリガーが発火する（truncate 最適化に食われない）', () => {
    const db = open([NOTES], ['notes'])
    try {
      for (const id of ['n1', 'n2', 'n3']) {
        db.prepare(`INSERT INTO notes VALUES (?, 'a', 'b', '2026-01-01')`).run(
          id
        )
      }
      db.prepare(`DELETE FROM notes`).run()
      expect(rowsOf(db, 'notes')).toEqual([])
      expect(tombstonesOf(db, 'notes').map((row) => row.recordId)).toEqual([
        'n1',
        'n2',
        'n3',
      ])
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 取り込みの直後の窓（§3.4.3 の必須2・§3.4.4 の必須3）
 * ================================================================== */

describe('取り込みの直後（_sns_rows_* に行が無い窓）', () => {
  it('一部の列だけの UPDATE で、書かなかった NOT NULL の列が NULL にならない（必須2）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      // 取り込みが負けた側の行を消した状態を作る
      db.prepare(`DELETE FROM _sns_rows_notes WHERE id='n1'`).run()
      db.prepare(`UPDATE notes SET body='B' WHERE id='n1'`).run()
      expect(rowsOf(db, 'notes')[0]).toMatchObject({
        id: 'n1',
        title: 'a',
        body: 'B',
      })
    } finally {
      db.close()
    }
  })

  it('同じ窓の DELETE で、強い削除の版が弱い版に上書きされない（必須3）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      // 取り込みが強い削除の版を受け取り、負けた行の版を消した状態
      db.prepare(`DELETE FROM _sns_rows_notes WHERE id='n1'`).run()
      // 削除を実行した時刻より強い墓標にしておく。弱い値に落ちたら分かる
      db.prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt, _sns_ts, _sns_lamport, _sns_instance)
         VALUES ('notes','n1','2099-09-01','2099-09-01T00:00:00.000Z',9,'zzzz')`
      ).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      const grave = tombstonesOf(db, 'notes')[0]
      // `COALESCE` で書くと OLD.updatedAt（2026-01-01）に落ちて Max が後退する
      expect(grave._sns_ts).toBe('2099-09-01T00:00:00.000Z')
    } finally {
      db.close()
    }
  })

  it('_sns_rows_* にも _tombstone にも行が無ければ OLD の時刻列も見る（訂正3）', () => {
    const db = open([NOTES], ['notes'])
    try {
      // OLD の時刻列が削除を実行した時刻より強い場合。弱いほうへ下がらない
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2099-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`DELETE FROM _sns_rows_notes WHERE id='n1'`).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      expect(tombstonesOf(db, 'notes')[0]._sns_ts).toBe(
        '2099-01-01T00:00:00.000Z'
      )
    } finally {
      db.close()
    }
  })

  it('_sns_ts が NULL の行の版があるときは、OLD の時刻列に落ちない（COALESCE との違い）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2099-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `UPDATE _sns_rows_notes SET _sns_ts = NULL WHERE id='n1'`
      ).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      // 行の版はあるので OLD（2099）には落ちない。削除を実行した時刻になる
      const grave = tombstonesOf(db, 'notes')[0]
      expect(grave._sns_ts).not.toBe('2099-01-01T00:00:00.000Z')
      expect(grave._sns_ts).toBe(grave.deletedAt)
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 時刻列は ISO 8601 の文字列だけ（原則2 の前提）
 * ================================================================== */

describe('時刻列に ISO 8601 の文字列でない値は書けない', () => {
  /** ISO 8601 の文字列でない値。数値・ISO でない文字列・NULL・BLOB。 */
  const REJECTED: [string, unknown][] = [
    ['整数', 1700000000000],
    ['実数', 2460676.5],
    ['ISO でない文字列', 'yesterday'],
    ['字形だけ合う文字列', '2026-13-01'],
    ['NULL', null],
    ['BLOB', Buffer.from([1, 2, 3])],
  ]
  /** 通る値。`Z`・`+00:00`（Prisma の既定）・スペース区切り・日付だけ。 */
  const ACCEPTED = [
    '2026-01-01T00:00:00.000Z',
    '2025-12-30T23:56:25.448+00:00',
    '2026-01-01 00:00:01',
    '2026-06-01',
  ]
  const MESSAGE =
    /同期する表 notes の時刻列 updatedAt に ISO-8601 の文字列でない値は書けない。ISO-8601 の文字列（例: 2026-01-01T00:00:00\.000Z）で書くこと/

  it.each(REJECTED)('INSERT で %s を書くと失敗する', (_label, value) => {
    const db = open([NOTES], ['notes'])
    try {
      expect(() =>
        db.prepare(`INSERT INTO notes VALUES ('n1','a','b',?)`).run(value)
      ).toThrow(MESSAGE)
      // AFTER トリガーの ABORT は、アプリの表への書き込みごと取り消す
      expect(db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({
        n: 0,
      })
      expect(rowsOf(db, 'notes')).toEqual([])
      expect(lamportOf(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it.each(REJECTED)(
    'UPDATE で %s を書くと失敗する（主キーが同じ・違う）',
    (_label, value) => {
      const db = open([NOTES], ['notes'])
      try {
        db.prepare(
          `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
        ).run()
        const lamport = lamportOf(db)
        expect(() =>
          db
            .prepare(`UPDATE notes SET title='A', updatedAt=? WHERE id='n1'`)
            .run(value)
        ).toThrow(MESSAGE)
        expect(() =>
          db
            .prepare(`UPDATE notes SET id='n2', updatedAt=? WHERE id='n1'`)
            .run(value)
        ).toThrow(MESSAGE)
        expect(
          db.prepare(`SELECT id, title, updatedAt FROM notes`).all()
        ).toEqual([
          { id: 'n1', title: 'a', updatedAt: '2026-01-01T00:00:00.000Z' },
        ])
        expect(lamportOf(db)).toBe(lamport)
        expect(tombstonesOf(db, 'notes')).toEqual([])
      } finally {
        db.close()
      }
    }
  )

  it.each(ACCEPTED)('%s は INSERT でも UPDATE でも通る', (value) => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(`INSERT INTO notes VALUES ('n1','a','b',?)`).run(value)
      db.prepare(`UPDATE notes SET title='A', updatedAt=? WHERE id='n1'`).run(
        value
      )
      db.prepare(`UPDATE notes SET id='n2', updatedAt=? WHERE id='n1'`).run(
        value
      )
      expect(rowsOf(db, 'notes')).toMatchObject([{ id: 'n2', _sns_ts: value }])
    } finally {
      db.close()
    }
  })

  it('失敗した文より前に同じトランザクションで書いたものは残る（ABORT の意味）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.exec('BEGIN')
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2026-01-01T00:00:00.000Z')`
      ).run()
      expect(() =>
        db
          .prepare(`INSERT INTO notes VALUES ('n2','c','d',1700000000000)`)
          .run()
      ).toThrow(MESSAGE)
      // トランザクションは開いたまま、続けて書ける
      expect(db.inTransaction).toBe(true)
      db.prepare(
        `INSERT INTO notes VALUES ('n3','e','f','2026-01-02T00:00:00.000Z')`
      ).run()
      db.exec('COMMIT')
      expect(db.prepare(`SELECT id FROM notes ORDER BY id`).all()).toEqual([
        { id: 'n1' },
        { id: 'n3' },
      ])
      expect(rowsOf(db, 'notes').map((row) => row.id)).toEqual(['n1', 'n3'])
    } finally {
      db.close()
    }
  })

  it('複数行の INSERT は文ごと取り消される', () => {
    const db = open([NOTES], ['notes'])
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO notes VALUES
               ('n1','a','b','2026-01-01T00:00:00.000Z'),
               ('n2','c','d',NULL)`
          )
          .run()
      ).toThrow(MESSAGE)
      expect(db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({
        n: 0,
      })
      expect(rowsOf(db, 'notes')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('時刻列の名前の大文字小文字が設定と違っても確かめる', () => {
    const db = open(
      [`CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v TEXT, UpdatedAt TEXT)`],
      [{ name: 't', timestampColumn: 'updatedAt' }]
    )
    try {
      expect(() =>
        db.prepare(`INSERT INTO t VALUES ('t1','a',1700000000000)`).run()
      ).toThrow(
        /同期する表 t の時刻列 UpdatedAt に ISO-8601 の文字列でない値は書けない/
      )
    } finally {
      db.close()
    }
  })

  it('時刻列が無い表では確かめない', () => {
    const db = open(
      [`CREATE TABLE plain (id TEXT PRIMARY KEY NOT NULL, v INTEGER)`],
      ['plain']
    )
    try {
      db.prepare(`INSERT INTO plain VALUES ('p1', 1)`).run()
      db.prepare(`UPDATE plain SET v = 2 WHERE id = 'p1'`).run()
      db.prepare(`DELETE FROM plain WHERE id = 'p1'`).run()
      // 行の版の時刻がいつも NULL なので、削除の版も NULL（書き込み順だけで比べる）
      expect(tombstonesOf(db, 'plain')[0]._sns_ts).toBeNull()
    } finally {
      db.close()
    }
  })

  it('削除の版は、行の版の時刻が古くても削除を実行した時刻を使う（原則2）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(
        `INSERT INTO notes VALUES ('n1','a','b','2000-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`DELETE FROM notes WHERE id='n1'`).run()
      const grave = tombstonesOf(db, 'notes')[0]
      expect(grave._sns_ts).toBe(grave.deletedAt)
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 番人（訂正1）
 * ================================================================== */

describe('_sns_rebuilding の番人（訂正1）', () => {
  it('旗が立っているあいだ、どの書き込みも事実にならない', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(`INSERT INTO notes VALUES ('n1','a','b','2026-01-01')`).run()
      const lamport = lamportOf(db)
      const tick = tickOf(db, 'notes')
      db.prepare(`DELETE FROM _sns_dirty`).run()
      db.prepare(`INSERT INTO _sns_rebuilding (onlyRow) VALUES (0)`).run()

      db.prepare(`INSERT INTO notes VALUES ('n2','c','d','2026-01-01')`).run()
      db.prepare(`UPDATE notes SET title='A' WHERE id='n1'`).run()
      db.prepare(`UPDATE notes SET id='n9' WHERE id='n1'`).run()
      db.prepare(`DELETE FROM notes`).run()

      expect(lamportOf(db)).toBe(lamport)
      expect(tickOf(db, 'notes')).toBe(tick)
      expect(tombstonesOf(db, 'notes')).toEqual([])
      expect(dirtyTables(db)).toEqual([])
      // 旗を下ろせばまた事実になる
      db.prepare(`DELETE FROM _sns_rebuilding`).run()
      db.prepare(`INSERT INTO notes VALUES ('n3','e','f','2026-01-01')`).run()
      expect(lamportOf(db)).toBe(lamport + 1)
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * _sns_clock（§3.2）
 * ================================================================== */

describe('_sns_clock', () => {
  it('行が無いとアプリの書き込みが失敗する（§3.2）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(`DELETE FROM _sns_clock`).run()
      expect(() =>
        db.prepare(`INSERT INTO notes VALUES ('n1','a','b','2026-01-01')`).run()
      ).toThrow(/NOT NULL|NOTNULL/)
      expect(db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({
        n: 0,
      })
      // 黙って lamport が 0 から数え直されることは無い
      expect(db.prepare(`SELECT count(*) AS n FROM _sns_clock`).get()).toEqual({
        n: 0,
      })
    } finally {
      db.close()
    }
  })

  it('作成関数は必ず行を作り、instanceId を入れ替える', () => {
    const db = open([NOTES], ['notes'])
    try {
      expect(db.prepare(`SELECT * FROM _sns_clock`).get()).toMatchObject({
        onlyRow: 0,
        lamport: 0,
        instanceId: INSTANCE,
        importTick: 0,
      })
      db.prepare(`INSERT INTO notes VALUES ('n1','a','b','2026-01-01')`).run()
      ensureClockRow(db, 'bbbb')
      // lamport には触らない（不変条件 C）
      expect(db.prepare(`SELECT * FROM _sns_clock`).get()).toMatchObject({
        lamport: 1,
        instanceId: 'bbbb',
      })
    } finally {
      db.close()
    }
  })

  it('_sns_tick はその表の行が無くても作られる（訂正6）', () => {
    const db = open([NOTES], ['notes'])
    try {
      db.prepare(`DELETE FROM _sns_tick`).run()
      db.prepare(`INSERT INTO notes VALUES ('n1','a','b','2026-01-01')`).run()
      expect(tickOf(db, 'notes')).toBe(1)
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 前提の検査（段階1 の関数をここで呼ぶ）
 * ================================================================== */

describe('checkRowsPreconditions —— 段階2 から見る前提', () => {
  it('主キーが NULL の行があれば例外（P1）', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, updatedAt TEXT)`)
      db.prepare(`INSERT INTO t VALUES (NULL,'2026-01-01')`).run()
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /NULL を取れる|主キーが NULL の行がある/
      )
    } finally {
      db.close()
    }
  })

  it('複合主キーの表は例外（P11）', () => {
    const db = new Database(':memory:')
    try {
      db.exec(
        `CREATE TABLE t (a TEXT NOT NULL, b TEXT NOT NULL, updatedAt TEXT, PRIMARY KEY (a, b))`
      )
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /主キーが複合/
      )
    } finally {
      db.close()
    }
  })

  it('決定的でない関数を持つ表は例外（P8）', () => {
    const db = new Database(':memory:')
    try {
      db.exec(
        `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a INTEGER CHECK (a <> abs(random())))`
      )
      expect(() => checkRowsPreconditions(db, [{ name: 't' }])).toThrow(
        /決定的でない関数 random\(\)/
      )
    } finally {
      db.close()
    }
  })

  it('複合主キーの表には、そもそも案A の表を作らせない（P11）', () => {
    const db = new Database(':memory:')
    try {
      db.exec(
        `CREATE TABLE t (a TEXT NOT NULL, b TEXT NOT NULL, updatedAt TEXT, PRIMARY KEY (a, b))`
      )
      expect(() => createRowsTables(db, [{ name: 't' }], INSTANCE)).toThrow(
        /主キーが複合/
      )
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * トリガーの負担（設計書 §7）
 * ================================================================== */

describe('トリガーの負担', () => {
  it('2,000行の INSERT / UPDATE / DELETE を測る', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sns-rows-bench-'))
    const report: string[] = []
    try {
      const measure = (withTriggers: boolean): Record<string, number> => {
        const path = join(directory, `${withTriggers ? 'on' : 'off'}.sqlite`)
        const db = new Database(path)
        try {
          db.pragma('journal_mode = WAL')
          db.pragma('foreign_keys = ON')
          db.exec(NOTES)
          createRowsTables(db, [{ name: 'notes' }], INSTANCE)
          if (withTriggers) createRowsTriggers(db, [{ name: 'notes' }])
          const rows = 2000
          const insert = db.prepare(`INSERT INTO notes VALUES (?, ?, ?, ?)`)
          const update = db.prepare(`UPDATE notes SET title = ? WHERE id = ?`)
          const remove = db.prepare(`DELETE FROM notes WHERE id = ?`)
          const run = (body: () => void): number => {
            const started = performance.now()
            db.transaction(body)()
            return performance.now() - started
          }
          const inserted = run(() => {
            for (let at = 0; at < rows; at += 1) {
              insert.run(
                `n${at}`,
                `t${at}`,
                `b${at}`,
                '2026-01-01T00:00:00.000Z'
              )
            }
          })
          const updated = run(() => {
            for (let at = 0; at < rows; at += 1) update.run(`T${at}`, `n${at}`)
          })
          const deleted = run(() => {
            for (let at = 0; at < rows; at += 1) remove.run(`n${at}`)
          })
          return { inserted, updated, deleted }
        } finally {
          db.close()
        }
      }
      const off = measure(false)
      const on = measure(true)
      for (const key of ['inserted', 'updated', 'deleted'] as const) {
        report.push(
          `${key}: トリガー無し ${off[key].toFixed(1)} ms / 有り ${on[key].toFixed(1)} ms` +
            ` （1行あたり ${((on[key] - off[key]) / 2).toFixed(3)} µs 増）`
        )
      }
      // 測るのが目的なので、落ちる条件は「桁違いに遅くない」ことだけにする
      expect(on.inserted).toBeLessThan(60000)
      expect(on.updated).toBeLessThan(60000)
      expect(on.deleted).toBeLessThan(60000)
      console.log(['トリガーの負担（2,000行）', ...report].join('\n  '))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120000)
})
