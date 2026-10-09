/**
 * 外部での複製・復元・書き換えの検出（`src/rows/restore-detect.ts`）。
 * 設計書 `docs/rows-table-design.md` §3.10。
 *
 * ここで見るのは2つである。
 *
 * - **見つけること**: 復元・巻き戻り・写しの取り合い・仕掛けの欠け
 * - **見つけすぎないこと**: 普通の再起動と初回起動で何も言わないこと。
 *   誤検出する検出は、利用者が警告を読まなくなるぶん、無いより悪い
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { copyToNas } from '../src/nas'
import { setupLegacyChangelog } from './helpers/legacy-changelog'
import { migrateToRows } from '../src/rows/migrate'
import { SNS_META_KEYS, writeSnsMeta } from '../src/rows/meta'
import { rowsTableName } from '../src/rows/schema'
import { rowsTriggerNames } from '../src/rows/triggers'
import {
  checkCopyOwnership,
  checkRestoreBeforeImport,
  checkRowsMachinery,
  clearRebuildingFlag,
  markBeforeCopy,
  selfCopyPath,
} from '../src/rows/restore-detect'

const NOTES = `CREATE TABLE notes (
  id        TEXT PRIMARY KEY NOT NULL,
  title     TEXT NOT NULL,
  updatedAt TEXT
)`

const CLIENT = 'terminal-a'

let workDir: string
let nasPath: string
let tmpDir: string
const open: Database.Database[] = []

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sns-restore-'))
  nasPath = join(workDir, 'nas')
  tmpDir = join(workDir, 'tmp')
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

/** 案A へ移し終えたローカル DB を1つ開く。 */
function openLocal(file: string, instanceId: string): Database.Database {
  const db = new Database(file)
  open.push(db)
  db.pragma('journal_mode = WAL')
  const fresh =
    db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes'`
      )
      .get() === undefined
  if (fresh) {
    db.exec(NOTES)
    setupLegacyChangelog(db, [{ name: 'notes' }], 'id')
  }
  migrateToRows(db, { tables: ['notes'], instanceId })
  return db
}

const location = (): { nasPath: string; clientId: string; tmpDir: string } => ({
  nasPath,
  clientId: CLIENT,
  tmpDir,
})

/** 写しを書く（印を付けてから `copyToNas`）。 */
async function publish(db: Database.Database): Promise<void> {
  markBeforeCopy(db)
  await copyToNas(db, nasPath, CLIENT, ['notes'])
}

/* ================================================================== *
 * 復元・巻き戻り（§3.10）
 * ================================================================== */

describe('復元・巻き戻り', () => {
  it('初回起動（写しが無い）では何も言わない', async () => {
    const db = openLocal(join(workDir, 'local.sqlite'), 'iid-1')
    const report = await checkRestoreBeforeImport(db, location())
    expect(report.copyMissing).toBe(true)
    expect(report.restored).toBe(false)
    expect(report.issues).toEqual([])
  })

  it('普通の再起動では何も言わない', async () => {
    const file = join(workDir, 'local.sqlite')
    const first = openLocal(file, 'iid-1')
    first.prepare(`INSERT INTO notes VALUES ('n1', 'いち', '2026-01-01')`).run()
    await publish(first)
    first.close()

    // `instanceId` は起動のたびに変わる。それだけでは復元ではない
    const second = openLocal(file, 'iid-2')
    const report = await checkRestoreBeforeImport(second, location())
    expect(report.restored).toBe(false)
    expect(report.issues).toEqual([])
    expect(report.copyLastLamport).not.toBeNull()
    expect(report.localLamport).toBeGreaterThanOrEqual(report.copyLastLamport!)
  })

  it('バックアップから戻した DB は、lamport が写しより後ろなので見つかる', async () => {
    const file = join(workDir, 'local.sqlite')
    const db = openLocal(file, 'iid-1')
    db.prepare(`INSERT INTO notes VALUES ('n1', 'いち', '2026-01-01')`).run()
    db.close()
    // ここで取ったバックアップ（lamport が小さい）
    const backup = join(workDir, 'backup.sqlite')
    copyFileSync(file, backup)

    const again = new Database(file)
    open.push(again)
    again
      .prepare(
        `UPDATE notes SET title = 'いち改', updatedAt = '2026-02-02' WHERE id = 'n1'`
      )
      .run()
    again.prepare(`INSERT INTO notes VALUES ('n2', 'に', '2026-03-03')`).run()
    await publish(again)
    again.close()

    // バックアップで上書きする（＝復元）。**副ファイルも消す** ——
    // 新しい `-wal` が残ったまま古い本体を置くと、中身が混ざる
    rmSync(`${file}-wal`, { force: true })
    rmSync(`${file}-shm`, { force: true })
    copyFileSync(backup, file)
    const restored = new Database(file)
    open.push(restored)
    const report = await checkRestoreBeforeImport(restored, location())
    expect(report.restored).toBe(true)
    expect(report.issues.map((issue) => issue.kind)).toContain(
      'lamport-behind-copy'
    )
    expect(report.localLamport!).toBeLessThan(report.copyLastLamport!)
  })

  it('`sns.generation` が写しより小さいときも見つかる', async () => {
    const file = join(workDir, 'local.sqlite')
    const db = openLocal(file, 'iid-1')
    db.prepare(`INSERT INTO notes VALUES ('n1', 'いち', '2026-01-01')`).run()
    await publish(db)
    await publish(db)
    // lamport は据え置きのまま generation だけ巻き戻った形
    writeSnsMeta(db, SNS_META_KEYS.generation, 0)
    const report = await checkRestoreBeforeImport(db, location())
    expect(report.restored).toBe(true)
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      'generation-behind-copy',
    ])
  })

  it('取り込みが lamport を引き上げると証拠が消えるので、判定は取り込みより前', async () => {
    const file = join(workDir, 'local.sqlite')
    const db = openLocal(file, 'iid-1')
    db.prepare(`INSERT INTO notes VALUES ('n1', 'いち', '2026-01-01')`).run()
    await publish(db)
    const copyLamport = (
      db.prepare(`SELECT lamport FROM _sns_clock`).get() as { lamport: number }
    ).lamport
    // 巻き戻った手元を作る
    db.prepare(`UPDATE _sns_clock SET lamport = 0`).run()
    expect((await checkRestoreBeforeImport(db, location())).restored).toBe(true)
    // 取り込みが lamport を引き上げたあとでは、同じ DB でも言えなくなる
    db.prepare(`UPDATE _sns_clock SET lamport = ?`).run(copyLamport + 10)
    expect((await checkRestoreBeforeImport(db, location())).restored).toBe(
      false
    )
  })

  it('写しが読めないときは、復元とは言わずに知らせるだけ', async () => {
    const db = openLocal(join(workDir, 'local.sqlite'), 'iid-1')
    const path = selfCopyPath(location())
    rmSync(nasPath, { recursive: true, force: true })
    mkdirSync(nasPath, { recursive: true })
    writeFileSync(path, 'これは SQLite の DB ではない')
    const report = await checkRestoreBeforeImport(db, location())
    expect(report.restored).toBe(false)
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      'copy-unreadable',
    ])
  })
})

/* ================================================================== *
 * 写しの取り合い（§3.10）
 * ================================================================== */

describe('写しの取り合い', () => {
  it('自分が書いた直後の写しは、自分のものだと分かる', async () => {
    const db = openLocal(join(workDir, 'local.sqlite'), 'iid-1')
    await publish(db)
    const report = await checkCopyOwnership(db, location())
    expect(report.taken).toBe(false)
    expect(report.copyInstanceId).toBe('iid-1')
  })

  it('同じファイル名へ別の端末が書いていれば止める', async () => {
    const mine = openLocal(join(workDir, 'local.sqlite'), 'iid-1')
    await publish(mine)
    // 別の端末が、同じクライアント id を名乗って上書きした
    const other = openLocal(join(workDir, 'other.sqlite'), 'iid-other')
    await copyToNas(other, nasPath, CLIENT, ['notes'])

    const report = await checkCopyOwnership(mine, location())
    expect(report.taken).toBe(true)
    expect(report.copyInstanceId).toBe('iid-other')
    expect(report.message).toContain('同期を止めた')
  })

  it('写しがまだ無ければ何も言わない（初回起動）', async () => {
    const db = openLocal(join(workDir, 'local.sqlite'), 'iid-1')
    expect((await checkCopyOwnership(db, location())).taken).toBe(false)
  })
})

/* ================================================================== *
 * 仕掛けの欠け（§3.10）
 * ================================================================== */

describe('仕掛けの欠け', () => {
  function fresh(): Database.Database {
    return openLocal(join(workDir, 'local.sqlite'), 'iid-1')
  }

  it('移行の直後は何も欠けていない', () => {
    const report = checkRowsMachinery(fresh(), ['notes'])
    expect(report.issues).toEqual([])
    expect(report.needsRepair).toBe(false)
  })

  it('トリガーが消えた DB を見つける', () => {
    const db = fresh()
    db.exec(`DROP TRIGGER ${JSON.stringify(rowsTriggerNames('notes')[0])}`)
    const report = checkRowsMachinery(db, ['notes'])
    expect(report.needsRepair).toBe(true)
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      'missing-trigger',
    ])
    expect(report.issues[0].name).toBe(rowsTriggerNames('notes')[0])
  })

  it('`_sns_clock` の行が無い DB を見つける', () => {
    const db = fresh()
    db.prepare(`DELETE FROM _sns_clock`).run()
    const report = checkRowsMachinery(db, ['notes'])
    expect(report.issues.map((issue) => issue.kind)).toContain(
      'missing-clock-row'
    )
    // この形では、アプリの書き込みそのものが落ちて気づける（§3.2）
    expect(() =>
      db.prepare(`INSERT INTO notes VALUES ('n1', 'いち', '2026-01-01')`).run()
    ).toThrow(/NOT NULL/)
  })

  it('`_sns_tick` の行が足りない DB を見つける', () => {
    const db = fresh()
    db.prepare(`DELETE FROM _sns_tick WHERE tableName = 'notes'`).run()
    expect(
      checkRowsMachinery(db, ['notes']).issues.map((issue) => issue.kind)
    ).toEqual(['missing-tick-row'])
  })

  it('`_sns_rows_*` が無い DB を見つける', () => {
    const db = fresh()
    db.exec(`DROP TRIGGER ${JSON.stringify(rowsTriggerNames('notes')[0])}`)
    db.exec(`DROP TRIGGER ${JSON.stringify(rowsTriggerNames('notes')[1])}`)
    db.exec(`DROP TRIGGER ${JSON.stringify(rowsTriggerNames('notes')[2])}`)
    db.exec(`DROP TRIGGER ${JSON.stringify(rowsTriggerNames('notes')[3])}`)
    db.exec(`DROP TABLE ${JSON.stringify(rowsTableName('notes'))}`)
    expect(
      checkRowsMachinery(db, ['notes']).issues.map((issue) => issue.kind)
    ).toContain('missing-rows-table')
  })

  it('`_sns_rebuilding` が残った DB を見つけて、消せる', () => {
    const db = fresh()
    db.prepare(`INSERT INTO _sns_rebuilding (onlyRow) VALUES (0)`).run()
    const report = checkRowsMachinery(db, ['notes'])
    expect(report.rebuildingLeftover).toBe(true)
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      'rebuilding-leftover',
    ])

    // 残っている間、アプリの書き込みは1つも事実にならない
    db.prepare(`INSERT INTO notes VALUES ('n1', 'いち', '2026-01-01')`).run()
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${JSON.stringify(rowsTableName('notes'))}`
        )
        .get()
    ).toEqual({ n: 0 })

    expect(clearRebuildingFlag(db)).toBe(true)
    expect(clearRebuildingFlag(db)).toBe(false)
    expect(checkRowsMachinery(db, ['notes']).issues).toEqual([])
    db.prepare(`INSERT INTO notes VALUES ('n2', 'に', '2026-02-02')`).run()
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${JSON.stringify(rowsTableName('notes'))}`
        )
        .get()
    ).toEqual({ n: 1 })
  })

  it('表名の綴りが違っても、畳んでから見る', () => {
    const db = fresh()
    expect(checkRowsMachinery(db, ['NOTES']).issues).toEqual([])
  })
})
