/**
 * 旧方式の DB から案A へ移す（`src/rows/migrate.ts`）。
 * 設計書 `docs/rows-table-design.md` §3.9。
 *
 * ここで見るのは4つ:
 *
 * - **写し替えが正しいこと**（版の3列・アプリの表に居る id の墓標・`_changelog` を刈らない）
 * - **列の増減に追従すること**（トリガーの作り直し・全行の書き直し・落とせない列）
 * - **途中で落ちたら何も起きないこと**（1トランザクション）
 * - **移行した2端末が食い違わないこと**（`_sns_ts` に時刻列の値を入れる効き目）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { setupLegacyChangelog } from './helpers/legacy-changelog'
import { importFromPeer } from '../src/rows/import'
import { SNS_META_KEYS, readSnsMeta } from '../src/rows/meta'
import {
  constantDefaultSql,
  migrateToRows,
  needsRowsMigration,
} from '../src/rows/migrate'
import { rowsTableName } from '../src/rows/schema'
import { rowsTriggerNames } from '../src/rows/triggers'
import { rebuildOnce } from '../src/rows/rebuild'
import { clearRebuildingFlag } from '../src/rows/restore-detect'

const NOTES = `CREATE TABLE notes (
  id        TEXT PRIMARY KEY NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT,
  updatedAt TEXT
)`

type Row = Record<string, unknown>

let workDir: string
const open: Database.Database[] = []

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sns-migrate-'))
})

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close()
    } catch {
      /* 既に閉じている */
    }
  }
  rmSync(workDir, { recursive: true, force: true })
})

/** 旧方式の DB を1つ作る（`_changelog` / `_tombstone` / `_id_merge` がある形）。 */
function legacyDb(
  statements: string[] = [NOTES],
  tables: string[] = ['notes']
): Database.Database {
  const db = new Database(':memory:')
  open.push(db)
  db.pragma('foreign_keys = ON')
  for (const statement of statements) db.exec(statement)
  setupLegacyChangelog(
    db,
    tables.map((name) => ({ name })),
    'id'
  )
  db.prepare(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('schemaVersion', 'app1')`
  ).run()
  return db
}

function rowsOf(db: Database.Database, table: string): Row[] {
  return db
    .prepare(
      `SELECT * FROM ${JSON.stringify(rowsTableName(table))} ORDER BY "id"`
    )
    .all() as Row[]
}

function tombstonesOf(db: Database.Database): Row[] {
  return db
    .prepare(`SELECT * FROM _tombstone ORDER BY tableName, recordId`)
    .all() as Row[]
}

function triggerNamesOf(db: Database.Database): Set<string> {
  return new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
        .all() as { name: string }[]
    ).map((row) => row.name)
  )
}

/* ================================================================== *
 * 旧方式から移す（§3.9 の1〜7）
 * ================================================================== */

describe('旧方式の DB を案A へ移す', () => {
  it('アプリの表の中身が、時刻列の値を版として `_sns_rows_*` に入る', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', NULL, '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO notes VALUES ('n2', 'に', 'ほん', '2026-02-02')`
    ).run()

    expect(needsRowsMigration(db)).toBe(true)
    const result = migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })

    expect(result.from).toBe('legacy')
    const rows = rowsOf(db, 'notes')
    expect(rows.map((row) => row.id)).toEqual(['n1', 'n2'])
    // §3.9 の C: `_sns_ts` は時刻列の値、lamport は 0、端末は自分
    expect(rows[0]._sns_ts).toBe('2026-01-01')
    expect(rows[1]._sns_ts).toBe('2026-02-02')
    expect(rows.every((row) => row._sns_lamport === 0)).toBe(true)
    expect(rows.every((row) => row._sns_instance === 'iid-a')).toBe(true)
    expect(needsRowsMigration(db)).toBe(false)
  })

  it('旧方式の `_heartbeat` は、表もトリガーも撤去される', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', NULL, '2026-01-01')`
    ).run()
    // 旧版の DB には表とトリガー2本が在る
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name LIKE '%heartbeat%' ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: '_changelog_after_insert__heartbeat' },
      { name: '_changelog_after_update__heartbeat' },
      { name: '_heartbeat' },
      { name: 'sqlite_autoindex__heartbeat_1' },
    ])

    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })

    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%heartbeat%'`)
        .all()
    ).toEqual([])

    // 撤去したあとも、表の付け替え（`ALTER TABLE … RENAME`）が通る
    expect(() =>
      migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a2' })
    ).not.toThrow()
  })

  it('時刻列が無い表では `_sns_ts` が NULL になる', () => {
    const db = legacyDb(
      [`CREATE TABLE plain (id TEXT PRIMARY KEY NOT NULL, v TEXT)`],
      ['plain']
    )
    db.prepare(`INSERT INTO plain VALUES ('p1', 'あ')`).run()
    migrateToRows(db, { tables: ['plain'], instanceId: 'iid-a' })
    expect(rowsOf(db, 'plain')[0]._sns_ts).toBeNull()
  })

  it('`_tombstone` と `_changelog` を作り直し、版の3列を足す', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', NULL, '2026-01-01')`
    ).run()
    db.prepare(`DELETE FROM notes WHERE id = 'n1'`).run()
    const changelogBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM _changelog`).get() as { n: number }
    ).n
    expect(changelogBefore).toBeGreaterThan(0)

    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })

    const tombstones = tombstonesOf(db)
    expect(tombstones).toHaveLength(1)
    // 残す墓標の `_sns_ts` は旧 `deletedAt`（削除を実行した時刻。原則2）
    expect(tombstones[0]._sns_ts).toBe(tombstones[0].deletedAt)
    expect(tombstones[0]._sns_lamport).toBe(0)
    expect(tombstones[0]._sns_instance).toBe('iid-a')
    // 旧「畳み」の事実は捨てる
    const columns = (
      db.prepare(`PRAGMA table_info(_tombstone)`).all() as { name: string }[]
    ).map((row) => row.name)
    expect(columns).toEqual([
      'tableName',
      'recordId',
      'deletedAt',
      '_sns_ts',
      '_sns_lamport',
      '_sns_instance',
    ])
    expect(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE name = '_id_merge'`).get()
    ).toBeUndefined()
    // §3.9 の G: `_changelog` は刈らない（id もそのまま）
    const after = db.prepare(`SELECT id FROM _changelog ORDER BY id`).all() as {
      id: number
    }[]
    expect(after).toHaveLength(changelogBefore)
    expect(after[0].id).toBe(1)
  })

  it('残す墓標の `_sns_ts` は、旧 `deletedAt` が ISO 8601 の文字列のときだけそれを使う（原則2）', () => {
    const db = legacyDb(
      [NOTES, `CREATE TABLE plain (id TEXT PRIMARY KEY NOT NULL, v TEXT)`],
      ['notes', 'plain']
    )
    const insert = db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt) VALUES (?, ?, ?)`
    )
    insert.run('notes', 'iso-t', '2026-03-01T12:00:00.000Z')
    // 0.19.0 以前の `datetime('now')` の形も ISO 8601 として読む
    insert.run('notes', 'iso-space', '2026-03-01 12:00:00')
    insert.run('notes', 'not-iso', 'yesterday')
    // 時刻列の無い表では、トリガーと同じく削除の版にも時刻を与えない
    insert.run('plain', 'p1', '2026-03-01T12:00:00.000Z')
    // 同期しない表の墓標も同じ規則で写す
    insert.run('other', 'o1', '2026-03-01T12:00:00.000Z')

    migrateToRows(db, { tables: ['notes', 'plain'], instanceId: 'iid-a' })

    const ts = Object.fromEntries(
      tombstonesOf(db).map((row) => [
        `${String(row.tableName)}/${String(row.recordId)}`,
        row._sns_ts,
      ])
    )
    expect(ts).toEqual({
      'notes/iso-t': '2026-03-01T12:00:00.000Z',
      'notes/iso-space': '2026-03-01 12:00:00',
      'notes/not-iso': null,
      'other/o1': '2026-03-01T12:00:00.000Z',
      'plain/p1': null,
    })
  })

  it('移した墓標は、削除より古い時刻の行の版に負けない（原則2）', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('notes', 'gone', '2026-03-01T12:00:00.000Z')`
    ).run()
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })
    // 別の端末から、削除より前の時刻の編集が届いた形（NULL の墓標なら編集が勝つ）
    db.prepare(
      `INSERT INTO _sns_rows_notes
         (id, title, body, updatedAt, _sns_ts, _sns_lamport, _sns_instance)
       VALUES ('gone', 'old', NULL, '2026-02-01T00:00:00.000Z',
               '2026-02-01T00:00:00.000Z', 5, 'iid-b')`
    ).run()
    const outcome = rebuildOnce(db, { tables: ['notes'] })
    expect(outcome.status).toBe('applied')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notes`).get()).toEqual({
      n: 0,
    })
  })

  it('旧 `_tombstone` の畳みの列（mergedInto / revokedAt）は写さない', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto, revokedAt)
       VALUES ('notes', 'lost', '2026-01-01', 'winner', NULL)`
    ).run()
    db.prepare(
      `INSERT INTO _id_merge (tableName, losingId, winningId) VALUES ('notes', 'lost', 'winner')`
    ).run()
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })
    const kept = tombstonesOf(db)
    expect(kept).toHaveLength(1)
    expect(kept[0].recordId).toBe('lost')
    expect(Object.keys(kept[0])).not.toContain('mergedInto')
  })

  it('アプリの表に同じ id がある墓標は消す（§3.9 の3）', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', NULL, '2026-01-01')`
    ).run()
    // 表名の綴りをわざとずらし、正規化を通っていることも見る
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('NOTES', 'n1', '2025-12-31')`
    ).run()
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('Notes', 'gone', '2025-12-31')`
    ).run()

    const result = migrateToRows(db, {
      tables: ['notes'],
      instanceId: 'iid-a',
    })

    const kept = tombstonesOf(db)
    expect(kept.map((row) => row.recordId)).toEqual(['gone'])
    // 綴りは畳んだものへ揃う
    expect(kept[0].tableName).toBe('notes')
    expect(result.tables[0].droppedTombstones).toBe(1)
    // 残したままだと、版の鍵が完全一致して削除が勝ち、最初の作り直しで行が消える
    const outcome = rebuildOnce(db, { tables: ['notes'] })
    expect(outcome.status).toBe('applied')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notes`).get()).toEqual({
      n: 1,
    })
  })

  it('同期しない表の墓標はそのまま残す', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('other', 'x1', '2025-12-31')`
    ).run()
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })
    expect(tombstonesOf(db).map((row) => row.tableName)).toEqual(['other'])
  })

  it('旧トリガーを落とし、案A の4本を作り、補助の表と鍵を揃える', () => {
    const db = legacyDb()
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })

    const triggers = triggerNamesOf(db)
    for (const name of rowsTriggerNames('notes'))
      expect(triggers.has(name)).toBe(true)
    expect(triggers.has('_changelog_after_insert_notes')).toBe(false)
    expect(triggers.has('_changelog_after_delete_notes')).toBe(false)

    expect(db.prepare(`SELECT * FROM _sns_clock`).get()).toMatchObject({
      onlyRow: 0,
      lamport: 0,
      instanceId: 'iid-a',
      importTick: 0,
    })
    expect(
      db.prepare(`SELECT tick FROM _sns_tick WHERE tableName = 'notes'`).get()
    ).toEqual({ tick: 0 })
    expect(db.prepare(`SELECT tableName FROM _sns_dirty`).all()).toEqual([
      { tableName: 'notes' },
    ])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM _sync_state`).get()).toEqual({
      n: 0,
    })

    // §3.1 の鍵の名前（H）
    expect(readSnsMeta(db, SNS_META_KEYS.instanceId)).toBe('iid-a')
    expect(readSnsMeta(db, SNS_META_KEYS.generation)).toBe('0')
    expect(readSnsMeta(db, SNS_META_KEYS.lastInstance)).toBe('iid-a')
    expect(readSnsMeta(db, SNS_META_KEYS.lastLamport)).toBe('0')
    // §3.8 の形式の欄
    expect(readSnsMeta(db, 'schemaVersion')).toBe('app1;sns-format=rows1')
  })

  it('`_sns_rebuilding` の残りを clearRebuildingFlag で消してから移すと、書き込みが版になる（§3.10 の I）', () => {
    const db = legacyDb()
    db.exec(
      `CREATE TABLE _sns_rebuilding (onlyRow INTEGER PRIMARY KEY CHECK (onlyRow = 0), startedAt TEXT)`
    )
    db.prepare(`INSERT INTO _sns_rebuilding VALUES (0, '2026-01-01')`).run()

    // `setupSync` と同期の段階0 と同じ順（旗を消してから移す）
    expect(clearRebuildingFlag(db)).toBe(true)
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM _sns_rebuilding`).get()
    ).toEqual({ n: 0 })

    // 旗が残っていたら、このあとの書き込みは1つも事実にならない
    db.prepare(
      `INSERT INTO notes VALUES ('n9', 'く', NULL, '2026-03-03')`
    ).run()
    expect(rowsOf(db, 'notes')).toHaveLength(1)
  })

  it('移行のあと、トリガー → 取り込み → 作り直しの経路が通る（段階2・3）', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', NULL, '2026-01-01')`
    ).run()
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })

    // トリガー: アプリの書き込みが事実になる
    db.prepare(
      `UPDATE notes SET title = 'いち改', updatedAt = '2026-05-05' WHERE id = 'n1'`
    ).run()
    expect(rowsOf(db, 'notes')[0]).toMatchObject({
      title: 'いち改',
      _sns_ts: '2026-05-05',
    })
    expect(
      (
        db.prepare(`SELECT lamport FROM _sns_clock`).get() as {
          lamport: number
        }
      ).lamport
    ).toBeGreaterThan(0)

    // 取り込み: 相手の強い版が入る
    const peer = legacyDb()
    peer
      .prepare(`INSERT INTO notes VALUES ('n2', 'に', NULL, '2026-06-06')`)
      .run()
    migrateToRows(peer, { tables: ['notes'], instanceId: 'iid-b' })
    const imported = importFromPeer(db, peer, { tables: ['notes'] })
    expect(imported.status).toBe('imported')
    expect(rowsOf(db, 'notes').map((row) => row.id)).toEqual(['n1', 'n2'])

    // 作り直し: アプリの表が `_sns_rows_*` の姿に揃う
    const outcome = rebuildOnce(db, { tables: ['notes'] })
    expect(outcome.status).toBe('applied')
    expect(db.prepare(`SELECT id FROM notes ORDER BY id`).all()).toEqual([
      { id: 'n1' },
      { id: 'n2' },
    ])
  })

  it('2端末がそれぞれ移行したあと、新しい時刻の側が勝つ（§3.9 の C の効き目）', () => {
    const a = legacyDb()
    a.prepare(
      `INSERT INTO notes VALUES ('n1', '古い', NULL, '2026-01-01')`
    ).run()
    migrateToRows(a, { tables: ['notes'], instanceId: 'iid-a' })

    const b = legacyDb()
    b.prepare(
      `INSERT INTO notes VALUES ('n1', '新しい', NULL, '2026-09-09')`
    ).run()
    migrateToRows(b, { tables: ['notes'], instanceId: 'iid-b' })

    // どちらの向きに取り込んでも、時刻の新しい側が勝つ（乱数で決まらない）
    importFromPeer(a, b, { tables: ['notes'] })
    importFromPeer(b, a, { tables: ['notes'] })
    expect(rowsOf(a, 'notes')[0].title).toBe('新しい')
    expect(rowsOf(b, 'notes')[0].title).toBe('新しい')
    rebuildOnce(a, { tables: ['notes'] })
    rebuildOnce(b, { tables: ['notes'] })
    expect(a.prepare(`SELECT title FROM notes`).get()).toEqual({
      title: '新しい',
    })
    expect(b.prepare(`SELECT title FROM notes`).get()).toEqual({
      title: '新しい',
    })
  })
})

/* ================================================================== *
 * 誰も読まない内部の列の撤去
 * ================================================================== */

describe('誰も読まない内部の列を落とす', () => {
  function columnsOf(db: Database.Database, table: string): string[] {
    return (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((row) => row.name)
  }

  /**
   * 0.20.0 の形の DB を作る。案A へ移したあと、0.20.0 が作っていた列を手で足す
   * （`_tombstone.revokedAt` はさらに前の版が足していた列）。
   */
  function version020Db(): Database.Database {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', 'ほん', '2026-01-01')`
    ).run()
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })
    db.exec(`ALTER TABLE _tombstone ADD COLUMN mergedInto TEXT`)
    db.exec(`ALTER TABLE _tombstone ADD COLUMN revokedAt TEXT`)
    db.exec(`ALTER TABLE _sns_unplaceable ADD COLUMN reasonKind TEXT`)
    db.exec(
      `ALTER TABLE _sns_unplaceable ADD COLUMN noticedAt TEXT NOT NULL DEFAULT '2026-01-01'`
    )
    db.exec(
      `ALTER TABLE _changelog_prune ADD COLUMN prunedAt TEXT NOT NULL DEFAULT '2026-01-01'`
    )
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('notes', 'gone', '2026-01-02', 'n1')`
    ).run()
    db.prepare(
      `INSERT INTO _sns_unplaceable (tableName, trueId, reasonKind, reason)
       VALUES ('notes', 'x1', 'constraint', 'CHECK')`
    ).run()
    db.prepare(
      `INSERT INTO _changelog_prune (onlyRow, prunedThroughId) VALUES (0, 7)
       ON CONFLICT (onlyRow) DO UPDATE SET prunedThroughId = 7`
    ).run()
    db.exec(`ALTER TABLE _sync_state ADD COLUMN lastSyncedAt TEXT`)
    db.prepare(
      `INSERT OR REPLACE INTO _sync_state (remoteClientId, lastSeenId, lastSyncedAt)
       VALUES ('peer', 5, '2026-01-03')`
    ).run()
    return db
  }

  it('0.20.0 の形の DB から、使わない列が消え、中身は残る', () => {
    const db = version020Db()
    expect(columnsOf(db, '_tombstone')).toContain('mergedInto')

    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a2' })

    expect(columnsOf(db, '_tombstone')).not.toContain('mergedInto')
    expect(columnsOf(db, '_tombstone')).not.toContain('revokedAt')
    // 親の削除の原因の2列は足される（0.20.0 の DB には無い）
    expect(columnsOf(db, '_sns_unplaceable')).toEqual([
      'tableName',
      'trueId',
      'reason',
      'causeTable',
      'causeId',
    ])
    expect(columnsOf(db, '_changelog_prune')).toEqual([
      'onlyRow',
      'prunedThroughId',
    ])
    // 行はそのまま残る
    expect(tombstonesOf(db).map((row) => row.recordId)).toEqual(['gone'])
    expect(db.prepare(`SELECT * FROM _sns_unplaceable`).all()).toEqual([
      {
        tableName: 'notes',
        trueId: 'x1',
        reason: 'CHECK',
        causeTable: null,
        causeId: null,
      },
    ])
    expect(db.prepare(`SELECT * FROM _changelog_prune`).all()).toEqual([
      { onlyRow: 0, prunedThroughId: 7 },
    ])
    // `_sync_state` は移行が毎回空にする（手順7。移行のあとはフルマージさせる）ので、列だけ見る
    expect(columnsOf(db, '_sync_state')).toEqual([
      'remoteClientId',
      'lastSeenId',
    ])
    // 落としたあともトリガーが墓標を書ける
    db.prepare(`DELETE FROM notes WHERE id = 'n1'`).run()
    expect(tombstonesOf(db).map((row) => row.recordId)).toEqual(['gone', 'n1'])
  })

  it('二度走らせても落ちない（列が無ければ何もしない）', () => {
    const db = version020Db()
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a2' })
    expect(() =>
      migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a3' })
    ).not.toThrow()
    // 親の削除の原因の2列は足される（0.20.0 の DB には無い）
    expect(columnsOf(db, '_sns_unplaceable')).toEqual([
      'tableName',
      'trueId',
      'reason',
      'causeTable',
      'causeId',
    ])
  })

  it('旧方式の DB からも落とす（`_heartbeat` のトリガーを先に落とすので通る）', () => {
    const db = legacyDb()
    // 旧方式の `_changelog_prune` は `prunedAt` を持ち、`_heartbeat` のトリガーもある
    expect(columnsOf(db, '_changelog_prune')).toContain('prunedAt')
    expect(triggerNamesOf(db).has('_changelog_after_insert__heartbeat')).toBe(
      true
    )
    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a' })
    expect(columnsOf(db, '_changelog_prune')).toEqual([
      'onlyRow',
      'prunedThroughId',
    ])
  })
})

/* ================================================================== *
 * 列の増減（§3.9 の D・E）
 * ================================================================== */

describe('列の増減へ追従する', () => {
  /** 既に案A へ移した DB を1つ作る。 */
  function migrated(instanceId = 'iid-a'): Database.Database {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', 'ほん', '2026-01-01')`
    ).run()
    migrateToRows(db, { tables: ['notes'], instanceId })
    return db
  }

  it('列が増えたら、トリガーを作り直し、全行を新しい版で書き直す', () => {
    const db = migrated()
    const before = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE name = '_sns_after_insert_notes'`
      )
      .get() as { sql: string }
    db.exec(`ALTER TABLE notes ADD COLUMN tag TEXT`)
    db.prepare(`UPDATE notes SET tag = 'あか'`).run()

    const result = migrateToRows(db, {
      tables: ['notes'],
      instanceId: 'iid-a2',
    })
    expect(result.from).toBe('refresh')
    expect(result.tables[0].addedColumns).toEqual(['tag'])
    expect(result.tables[0].rewritten).toBe(true)

    const rows = rowsOf(db, 'notes')
    expect(rows[0].tag).toBe('あか')
    // §3.9 の E: lamport は進み、端末は自分になる
    expect(rows[0]._sns_lamport).toBeGreaterThan(0)
    expect(rows[0]._sns_instance).toBe('iid-a2')
    // §1.2.1 の3項の最大（時刻列の値がいちばん強い）
    expect(rows[0]._sns_ts).toBe('2026-01-01')

    const after = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE name = '_sns_after_insert_notes'`
      )
      .get() as { sql: string }
    expect(after.sql).not.toBe(before.sql)
    expect(after.sql).toContain('"tag"')

    // 作り直しても、アプリが書いた値が既定値へ戻らない
    rebuildOnce(db, { tables: ['notes'] })
    expect(db.prepare(`SELECT tag FROM notes`).get()).toEqual({ tag: 'あか' })
  })

  it('列が減ったら `_sns_rows_*` からも落とし、アプリの INSERT が通る', () => {
    const db = migrated()
    // 素の `DROP COLUMN` は、トリガーが `NEW.body` を参照しているので SQLite が断る。
    // README の制限事項はこれを前提に、表を作り直す方法を案内している
    expect(() => db.exec(`ALTER TABLE notes DROP COLUMN body`)).toThrow(
      /error in trigger .* after drop column/
    )
    // アプリが表を作り直して列を落とす
    db.exec(`CREATE TABLE notes_new (
      id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, updatedAt TEXT)`)
    db.exec(`INSERT INTO notes_new SELECT id, title, updatedAt FROM notes`)
    db.exec(`DROP TABLE notes`)
    db.exec(`ALTER TABLE notes_new RENAME TO notes`)

    const result = migrateToRows(db, {
      tables: ['notes'],
      instanceId: 'iid-a2',
    })
    expect(result.tables[0].removedColumns).toEqual(['body'])
    expect(result.tables[0].rewritten).toBe(true)
    expect(Object.keys(rowsOf(db, 'notes')[0])).not.toContain('body')

    // 落とさないと `has no column named body` で落ちる
    db.prepare(
      `INSERT INTO notes (id, title, updatedAt) VALUES ('n2', 'に', '2026-02-02')`
    ).run()
    expect(rowsOf(db, 'notes')).toHaveLength(2)
  })

  it('増えた列の既定値が定数なら、アプリの表に居ない行にもその定数を入れる', () => {
    const db = migrated()
    // アプリの表に居ない行（隠れた行・置かない行に相当）を1つ置く
    db.prepare(
      `INSERT INTO ${JSON.stringify(rowsTableName('notes'))}
         ("id", "title", "body", "updatedAt", "_sns_ts", "_sns_lamport", "_sns_instance")
       VALUES ('hidden', 'かくれ', NULL, '2026-01-01', '2026-01-01', 0, 'iid-a')`
    ).run()
    db.exec(`ALTER TABLE notes ADD COLUMN tag TEXT NOT NULL DEFAULT 'みどり'`)

    migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a2' })
    const rows = rowsOf(db, 'notes')
    expect(rows.map((row) => row.tag)).toEqual(['みどり', 'みどり'])
  })

  it('増えた列が NOT NULL で既定値が定数でなく、埋め直せない行があれば例外', () => {
    const db = migrated()
    db.prepare(
      `INSERT INTO ${JSON.stringify(rowsTableName('notes'))}
         ("id", "title", "body", "updatedAt", "_sns_ts", "_sns_lamport", "_sns_instance")
       VALUES ('hidden', 'かくれ', NULL, '2026-01-01', '2026-01-01', 0, 'iid-a')`
    ).run()
    // `ALTER TABLE ADD COLUMN` は定数でない既定値を受け取らないので、表を組み直す
    db.exec(`
      CREATE TABLE notes_new (
        id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, body TEXT, updatedAt TEXT,
        seen TEXT NOT NULL DEFAULT (datetime('now'))
      )`)
    db.exec(
      `INSERT INTO notes_new (id, title, body, updatedAt) SELECT id, title, body, updatedAt FROM notes`
    )
    db.exec(`DROP TABLE notes`)
    db.exec(`ALTER TABLE notes_new RENAME TO notes`)

    expect(() =>
      migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a2' })
    ).toThrow(/NOT NULL/)
    // 1トランザクションなので、列は足されていない
    expect(Object.keys(rowsOf(db, 'notes')[0])).not.toContain('seen')
  })

  it('埋め直せない行が無ければ、定数でない既定値でも警告だけで通す', () => {
    const db = migrated()
    db.exec(`
      CREATE TABLE notes_new (
        id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, body TEXT, updatedAt TEXT,
        seen TEXT NOT NULL DEFAULT (datetime('now'))
      )`)
    db.exec(
      `INSERT INTO notes_new (id, title, body, updatedAt) SELECT id, title, body, updatedAt FROM notes`
    )
    db.exec(`DROP TABLE notes`)
    db.exec(`ALTER TABLE notes_new RENAME TO notes`)

    const result = migrateToRows(db, {
      tables: ['notes'],
      instanceId: 'iid-a2',
    })
    expect(result.warnings.join('\n')).toContain('seen')
    expect(rowsOf(db, 'notes')[0].seen).not.toBeNull()
  })

  it('主キーの列名が変わったら例外（`_sns_rows_*` の主キーは落とせない）', () => {
    const db = migrated()
    db.exec(`ALTER TABLE notes RENAME COLUMN id TO noteId`)
    expect(() =>
      migrateToRows(db, { tables: ['notes'], instanceId: 'iid-a2' })
    ).toThrow(/主キーの列名/)
  })

  it('列が変わっていなければ書き直さない（版はそのまま）', () => {
    const db = migrated()
    const before = rowsOf(db, 'notes')[0]
    const result = migrateToRows(db, {
      tables: ['notes'],
      instanceId: 'iid-a2',
    })
    expect(result.tables[0].rewritten).toBe(false)
    expect(rowsOf(db, 'notes')[0]).toEqual(before)
  })
})

/* ================================================================== *
 * 途中で落ちたとき（§3.9 の1トランザクション）
 * ================================================================== */

describe('途中で落ちたとき', () => {
  it('移行の途中で落ちたら、DB は旧方式のまま元へ戻る', () => {
    const db = legacyDb()
    db.prepare(
      `INSERT INTO notes VALUES ('n1', 'いち', NULL, '2026-01-01')`
    ).run()
    db.prepare(`DELETE FROM notes WHERE id = 'n1'`).run()
    const changelogBefore = db
      .prepare(`SELECT * FROM _changelog ORDER BY id`)
      .all()
    const tombstoneBefore = db.prepare(`SELECT * FROM _tombstone`).all()

    // 主キーの列名を変えて例外にする（移行の後半で落ちる形を作る）
    expect(() =>
      migrateToRows(db, { tables: ['notes', 'missing'], instanceId: 'iid-a' })
    ).toThrow()

    expect(needsRowsMigration(db)).toBe(true)
    expect(db.prepare(`SELECT * FROM _changelog ORDER BY id`).all()).toEqual(
      changelogBefore
    )
    expect(db.prepare(`SELECT * FROM _tombstone`).all()).toEqual(
      tombstoneBefore
    )
    // 旧トリガーも `_id_merge` も残っている
    expect(triggerNamesOf(db).has('_changelog_after_insert_notes')).toBe(true)
    expect(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE name = '_id_merge'`).get()
    ).toBeDefined()
    expect(
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`)
        .get(rowsTableName('notes'))
    ).toBeUndefined()
  })

  it('COMMIT のあと・NAS への写しの前に落ちても、次の起動が正しく続ける', () => {
    const file = join(workDir, 'local.sqlite')
    const first = new Database(file)
    open.push(first)
    first.exec(NOTES)
    setupLegacyChangelog(first, [{ name: 'notes' }], 'id')
    first
      .prepare(`INSERT INTO notes VALUES ('n1', 'いち', NULL, '2026-01-01')`)
      .run()
    migrateToRows(first, { tables: ['notes'], instanceId: 'iid-a' })
    const rowsAfterMigration = rowsOf(first, 'notes')
    // ここで落ちた（写しは書いていない）
    first.close()

    const second = new Database(file)
    open.push(second)
    expect(needsRowsMigration(second)).toBe(false)
    // 次の起動は `refresh` として通り、事実を作り直さない
    const result = migrateToRows(second, {
      tables: ['notes'],
      instanceId: 'iid-a2',
    })
    expect(result.from).toBe('refresh')
    expect(result.tables[0].rewritten).toBe(false)
    expect(rowsOf(second, 'notes')).toEqual(rowsAfterMigration)
    // `instanceId` だけは作り直す（§3.2）
    expect(readSnsMeta(second, SNS_META_KEYS.instanceId)).toBe('iid-a2')
    expect(db2Instance(second)).toBe('iid-a2')
  })
})

function db2Instance(db: Database.Database): string {
  return (
    db.prepare(`SELECT instanceId FROM _sns_clock`).get() as {
      instanceId: string
    }
  ).instanceId
}

/* ================================================================== *
 * 既定値が定数か
 * ================================================================== */

describe('既定値が定数か', () => {
  it('定数の字面だけを返す', () => {
    expect(constantDefaultSql(`0`)).toBe('0')
    expect(constantDefaultSql(`(0)`)).toBe('0')
    expect(constantDefaultSql(`'あ'`)).toBe(`'あ'`)
    expect(constantDefaultSql(`NULL`)).toBe('NULL')
    expect(constantDefaultSql(`X'00ff'`)).toBe(`X'00ff'`)
    expect(constantDefaultSql(`-1.5e3`)).toBe('-1.5e3')
  })

  it('評価のたびに変わるものは定数ではない', () => {
    expect(constantDefaultSql(`CURRENT_TIMESTAMP`)).toBeNull()
    expect(constantDefaultSql(`(datetime('now'))`)).toBeNull()
    expect(constantDefaultSql(null)).toBeNull()
  })
})
