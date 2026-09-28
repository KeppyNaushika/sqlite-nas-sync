/**
 * 案A の取り込み（`src/rows/import.ts`）の試験。設計書
 * `docs/rows-table-design.md` §4.3。
 *
 * ここで見るのは4つ:
 *
 * - **強い版だけを採り、負けた側の行を同じトランザクションで消すこと**
 * - **受け取った版をそのまま格納すること**（中継に要る）
 * - **事実を作らないこと**（lamport・`_tombstone`・`_changelog` が
 *   取り込み由来以外で増えない）
 * - **相手の形が違っても例外にせず、読める分だけ読むこと**
 */
import Database from 'better-sqlite3'
import {
  ROWS_FORMAT,
  collectPeerKeys,
  importFromPeer,
  readSnsFormat,
} from '../src/rows/import'
import { RowsTableSpec, createRowsTables } from '../src/rows/schema'
import { createRowsTriggers } from '../src/rows/triggers'

const NOTES = `CREATE TABLE notes (
  id        TEXT PRIMARY KEY NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT,
  updatedAt TEXT
)`

type Row = Record<string, unknown>

/** 案A の仕掛けを載せた端末を1つ開く。 */
function openClient(
  instance: string,
  options: {
    statements?: string[]
    tables?: (RowsTableSpec | string)[]
    format?: string | null
  } = {}
): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const statement of options.statements ?? [NOTES]) db.exec(statement)
  const specs = (options.tables ?? ['notes']).map((table) =>
    typeof table === 'string' ? { name: table } : table
  )
  createRowsTables(db, specs, instance)
  createRowsTriggers(db, specs)
  db.exec(`CREATE TABLE IF NOT EXISTS _sync_meta (
             key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  const format = options.format === undefined ? ROWS_FORMAT : options.format
  db.prepare(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('schemaVersion', ?)`
  ).run(format === null ? 'app1' : `app1;sns-format=${format}`)
  return db
}

function rowsOf(db: Database.Database, table = 'notes'): Row[] {
  return db
    .prepare(`SELECT * FROM "_sns_rows_${table}" ORDER BY id`)
    .all() as Row[]
}

function tombstonesOf(db: Database.Database): Row[] {
  return db
    .prepare(`SELECT * FROM _tombstone ORDER BY tableName, recordId`)
    .all() as Row[]
}

function countOf(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

function lamportOf(db: Database.Database): number {
  return (
    db.prepare(`SELECT lamport FROM _sns_clock`).get() as {
      lamport: number
    }
  ).lamport
}

function importTickOf(db: Database.Database): number {
  return (
    db.prepare(`SELECT importTick FROM _sns_clock`).get() as {
      importTick: number
    }
  ).importTick
}

function dirtyOf(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT tableName FROM _sns_dirty ORDER BY tableName`).all() as {
      tableName: string
    }[]
  ).map((row) => row.tableName)
}

/* ================================================================== *
 * 強い版だけを採る
 * ================================================================== */

describe('取り込み —— 強い版だけを採る（§4.3）', () => {
  it('相手の版が強ければ採り、弱ければ採らない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      mine
        .prepare(`INSERT INTO notes VALUES ('k2', '手元', NULL, '2026-03-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-01')`)
        .run()

      const result = importFromPeer(mine, peer, { tables: ['notes'] })
      expect(result.status).toBe('imported')

      const rows = rowsOf(mine)
      expect(rows.map((row) => [row.id, row.title])).toEqual([
        ['k1', '相手'], // 時刻が新しい相手が勝つ
        ['k2', '手元'], // 時刻が新しい手元が勝つ
      ])
      // 変わったキーだけが通知になる
      expect(result.changed.map((change) => change.key)).toEqual(['k1'])
      expect(result.dirtyTables).toEqual(['notes'])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('相手にしか無い id は、そのまま受け取る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k9', '相手', 'x', '2026-02-01')`)
        .run()
      importFromPeer(mine, peer, { tables: ['notes'] })
      expect(rowsOf(mine).map((row) => row.id)).toEqual(['k9'])
      // **アプリの表には書かない**（作り直しの仕事である）
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM notes`)).toBe(0)
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 負けた側を消す
 * ================================================================== */

describe('取り込み —— 負けた側の行を消す（§4.3）', () => {
  it('相手の削除が強ければ、手元の _sns_rows_* の行を同じ取り込みで消す', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k1'`).run()

      const result = importFromPeer(mine, peer, { tables: ['notes'] })
      expect(rowsOf(mine)).toEqual([])
      expect(tombstonesOf(mine).map((row) => row.recordId)).toEqual(['k1'])
      expect(result.changed).toEqual([
        { table: 'notes', key: 'k1', operation: 'DELETE' },
      ])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('手元の削除の方が強ければ、相手の行は採らない（行は増えない）', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-01-01')`)
        .run()
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-02-01')`)
        .run()
      mine.prepare(`DELETE FROM notes WHERE id = 'k1'`).run()

      const result = importFromPeer(mine, peer, { tables: ['notes'] })
      expect(rowsOf(mine)).toEqual([])
      expect(result.changed).toEqual([])
      expect(dirtyOf(mine)).toEqual(['notes']) // 手元の削除で立った汚れだけ
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 版をそのまま格納する
 * ================================================================== */

describe('取り込み —— 受け取った版をそのまま格納する（§4.3）', () => {
  it('_sns_ts・_sns_lamport・_sns_instance を書き換えない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      // 相手の lamport を進めてから書く（手元とは違う値にする）
      for (let at = 0; at < 5; at += 1) {
        peer
          .prepare(`INSERT INTO notes VALUES (?, 'x', NULL, '2026-02-01')`)
          .run(`fill${String(at)}`)
      }
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      const source = peer
        .prepare(`SELECT * FROM _sns_rows_notes WHERE id = 'k1'`)
        .get() as Row

      importFromPeer(mine, peer, {
        tables: ['notes'],
        keys: [{ table: 'notes', key: 'k1' }],
      })
      const stored = mine
        .prepare(`SELECT * FROM _sns_rows_notes WHERE id = 'k1'`)
        .get() as Row
      expect(stored._sns_ts).toBe(source._sns_ts)
      expect(stored._sns_lamport).toBe(source._sns_lamport)
      expect(stored._sns_instance).toBe('bbbb')
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('削除の版も、相手の3つ組のまま格納する', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k1'`).run()
      const source = peer
        .prepare(`SELECT * FROM _tombstone WHERE recordId = 'k1'`)
        .get() as Row

      importFromPeer(mine, peer, { tables: ['notes'] })
      const stored = mine
        .prepare(`SELECT * FROM _tombstone WHERE recordId = 'k1'`)
        .get() as Row
      expect(stored._sns_ts).toBe(source._sns_ts)
      expect(stored._sns_lamport).toBe(source._sns_lamport)
      expect(stored._sns_instance).toBe('bbbb')
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 事実を作らない
 * ================================================================== */

describe('取り込み —— 事実を作らない（§1.1 の (c)）', () => {
  it('lamport は受け取った版の最大まで引き上げるだけで、越えない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      for (let at = 0; at < 4; at += 1) {
        peer
          .prepare(`INSERT INTO notes VALUES (?, 'x', NULL, '2026-02-01')`)
          .run(`k${String(at)}`)
      }
      const peerLamport = lamportOf(peer)
      const before = lamportOf(mine)
      expect(before).toBeLessThan(peerLamport)

      importFromPeer(mine, peer, { tables: ['notes'] })
      expect(lamportOf(mine)).toBe(peerLamport)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('_tombstone と _changelog は、取り込み由来の分しか増えない', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k2'`).run()
      const changelogBefore = countOf(
        mine,
        `SELECT COUNT(*) AS n FROM _changelog`
      )

      const result = importFromPeer(mine, peer, { tables: ['notes'] })
      // 変わったキーは2つ。それ以上の通知を書かない
      expect(result.changed).toHaveLength(2)
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM _changelog`)).toBe(
        changelogBefore + 2
      )
      // 墓標は相手の主張した1件だけ
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM _tombstone`)).toBe(1)
      // アプリの表は触らない
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM notes`)).toBe(0)
      expect(importTickOf(mine)).toBe(1)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('変わらなかったキーには通知を書かない（2回目の取り込みは空）', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      importFromPeer(mine, peer, { tables: ['notes'] })
      const changelog = countOf(mine, `SELECT COUNT(*) AS n FROM _changelog`)
      const lamport = lamportOf(mine)

      const again = importFromPeer(mine, peer, { tables: ['notes'] })
      expect(again.changed).toEqual([])
      expect(countOf(mine, `SELECT COUNT(*) AS n FROM _changelog`)).toBe(
        changelog
      )
      expect(lamportOf(mine)).toBe(lamport)
      // importTick だけは進む（作り直しの token として要る）
      expect(importTickOf(mine)).toBe(2)
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 途中で落ちたら完全に戻る
 * ================================================================== */

describe('取り込み —— 途中で落ちたら完全に戻る（§4.3）', () => {
  it('通知を書くところで落ちても、版も時計も戻る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer
        .prepare(`INSERT INTO notes VALUES ('k2', '相手', NULL, '2026-02-01')`)
        .run()
      // `_changelog` を落として、通知の書き込みを必ず失敗させる
      mine.exec(`DROP TABLE _changelog`)
      const lamport = lamportOf(mine)

      expect(() => importFromPeer(mine, peer, { tables: ['notes'] })).toThrow()
      expect(rowsOf(mine)).toEqual([])
      expect(lamportOf(mine)).toBe(lamport)
      expect(importTickOf(mine)).toBe(0)
      expect(dirtyOf(mine)).toEqual([])
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 相手の形が違うとき（§4.3 の G）
 * ================================================================== */

describe('取り込み —— 相手の形が違うとき（§4.3 の G）', () => {
  it('sns-format が違う相手は丸ごと見送る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb', { format: 'rows0' })
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      const result = importFromPeer(mine, peer, { tables: ['notes'] })
      expect(result.status).toBe('skipped')
      expect(result.reason).toContain('rows0')
      expect(rowsOf(mine)).toEqual([])
      expect(importTickOf(mine)).toBe(0)
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('sns-format が書かれていない相手も見送る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb', { format: null })
    try {
      expect(readSnsFormat(peer)).toBeNull()
      const result = importFromPeer(mine, peer, { tables: ['notes'] })
      expect(result.status).toBe('skipped')
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('相手に _sns_rows_<t> が無ければ、その表の主張は無いものとして読む', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      mine
        .prepare(`INSERT INTO notes VALUES ('k1', '手元', NULL, '2026-01-01')`)
        .run()
      peer.exec(`DROP TABLE _sns_rows_notes`)
      // 墓標の主張は残っている
      peer
        .prepare(
          `INSERT INTO _tombstone
             (tableName, recordId, deletedAt, _sns_ts, _sns_lamport, _sns_instance)
           VALUES ('notes', 'k2', '2026-02-01', '2026-02-01', 9, 'bbbb')`
        )
        .run()

      expect(collectPeerKeys(peer, ['notes'])).toEqual([
        { table: 'notes', key: 'k2' },
      ])
      const result = importFromPeer(mine, peer, { tables: ['notes'] })
      expect(result.status).toBe('imported')
      // 手元の k1 は消えない（「主張が無い」は削除ではない）
      expect(rowsOf(mine).map((row) => row.id)).toEqual(['k1'])
      expect(tombstonesOf(mine).map((row) => row.recordId)).toEqual(['k2'])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('相手に無い列は自分の既定値、相手にしかない列は無視する', () => {
    const mine = openClient('aaaa', {
      statements: [
        `CREATE TABLE notes (
           id    TEXT PRIMARY KEY NOT NULL,
           title TEXT NOT NULL,
           note  TEXT DEFAULT 'きほん',
           updatedAt TEXT
         )`,
      ],
    })
    const peer = openClient('bbbb', {
      statements: [
        `CREATE TABLE notes (
           id    TEXT PRIMARY KEY NOT NULL,
           title TEXT NOT NULL,
           extra TEXT,
           updatedAt TEXT
         )`,
      ],
    })
    try {
      peer
        .prepare(
          `INSERT INTO notes VALUES ('k1', '相手', '相手だけの列', '2026-02-01')`
        )
        .run()
      importFromPeer(mine, peer, { tables: ['notes'] })
      const stored = mine
        .prepare(`SELECT * FROM _sns_rows_notes WHERE id = 'k1'`)
        .get() as Row
      expect(stored.title).toBe('相手')
      expect(stored.note).toBe('きほん')
      expect(Object.keys(stored)).not.toContain('extra')
    } finally {
      mine.close()
      peer.close()
    }
  })
})

/* ================================================================== *
 * 表の名前の綴り
 * ================================================================== */

describe('取り込み —— 表の名前を sqlite_master の綴りへ畳む', () => {
  it('利用者が違う綴りを渡しても、帳簿には同じ綴りで載る', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      const result = importFromPeer(mine, peer, {
        // 利用者の綴りは `NOTES`。表そのものは `notes`
        tables: ['NOTES'],
        keys: [{ table: 'NOTES', key: 'k1' }],
      })
      expect(result.changed).toEqual([
        { table: 'notes', key: 'k1', operation: 'UPDATE' },
      ])
      expect(dirtyOf(mine)).toEqual(['notes'])
      expect(
        (
          mine.prepare(`SELECT tableName FROM _changelog`).all() as {
            tableName: string
          }[]
        ).map((row) => row.tableName)
      ).toEqual(['notes'])
    } finally {
      mine.close()
      peer.close()
    }
  })

  it('墓標の綴りも畳んだ側で書く', () => {
    const mine = openClient('aaaa')
    const peer = openClient('bbbb')
    try {
      peer
        .prepare(`INSERT INTO notes VALUES ('k1', '相手', NULL, '2026-02-01')`)
        .run()
      peer.prepare(`DELETE FROM notes WHERE id = 'k1'`).run()
      importFromPeer(mine, peer, { tables: ['NOTES'] })
      expect(tombstonesOf(mine).map((row) => row.tableName)).toEqual(['notes'])
    } finally {
      mine.close()
      peer.close()
    }
  })
})
