/**
 * **取り込めなかった相手のカーソルは進めない** —— 相手1人ぶんの失敗の扱い。
 *
 * 相手が開けない、スキーマの版が違う、途中で例外が出る。どれも「その相手ぶんだけ
 * 諦めて次へ進む」のが約束だが、諦め方を間違えると症状が出ない形で壊れる:
 *
 * - `_sync_state` のカーソルだけ進めてしまうと、取り込めなかった差分は**二度と
 *   提供されない**（しかも警告だけ残って成功したように見える）
 * - フルマージの途中で失敗したときに巻き戻さないと、changelog が膨張したまま
 *   ギャップが再検出され続ける
 * - フルマージはトリガーを外して走るので、失敗経路で戻し忘れると**それ以降の
 *   ローカル変更が changelog に載らなくなる**（他端末へ二度と伝わらない）
 *
 * どれも例外にならないので、形で固定して残す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupChangelog, writeSchemaVersion } from '../src/setup'
import { pullFullMerge, pullNormal } from '../src/sync/pull'
import { getSyncState } from '../src/sync/state'
import { SyncConfig, SyncResult, TableConfig } from '../src/types'

const testDir = path.join(__dirname, 'test-data-sync-pull-failures')

const TABLES: TableConfig[] = [{ name: 'users' }]

/** ファイルDBを作る（フルマージはトリガーを付け外しするので、実ファイルで確かめる） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true })
  return new Database(path.join(testDir, `${name}.sqlite`))
}

function createSyncDb(name: string): Database.Database {
  const db = createDb(name)
  db.exec(`
    CREATE TABLE users (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `)
  setupChangelog(db, TABLES, 'id')
  return db
}

function emptyResult(): SyncResult {
  return {
    clientsSynced: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    conflictsResolved: 0,
    folds: [],
    warnings: [],
    skippedRemotes: [],
    hadChangelogGap: false,
  }
}

function makeConfig(schemaVersion?: string): SyncConfig {
  return {
    dbPath: path.join(testDir, 'local.sqlite'),
    nasPath: path.join(testDir, 'nas'),
    clientId: 'local',
    primaryKey: 'id',
    changelogRetentionDays: 7,
    schemaVersion,
  }
}

/** トリガーが生きているか（フルマージの `finally` が効いたか）を行数で確かめる */
function changelogCount(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM _changelog`).get() as { n: number }
  ).n
}

let localDb: Database.Database
let remoteDb: Database.Database | null = null

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
  localDb = createSyncDb('local')
})

afterEach(() => {
  if (remoteDb && remoteDb.open) remoteDb.close()
  remoteDb = null
  if (localDb && localDb.open) localDb.close()
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('開けなかった相手は、警告だけ残してカーソルを進めない', () => {
  it('ファイルが無い相手（差分経路）', () => {
    const result = emptyResult()

    pullNormal(
      localDb,
      [{ clientId: 'ghost', filePath: path.join(testDir, 'missing.sqlite') }],
      makeConfig(),
      TABLES,
      'id',
      result
    )

    expect(result.warnings).toContain('Failed to open remote database: ghost')
    expect(result.clientsSynced).toBe(0)
    // 次回やり直せること。ここを進めると ghost の差分は二度と提供されない
    expect(getSyncState(localDb, 'ghost').lastSeenId).toBe(0)
  })

  it('中身が壊れている相手（差分経路）', () => {
    // NAS上のファイルは他端末の書き込み途中を掴むことがある。整合性が取れない
    // コピーをそのまま読むと、でたらめな行を取り込みかねない
    const brokenPath = path.join(testDir, 'broken.sqlite')
    fs.writeFileSync(brokenPath, 'this is not a database')

    const result = emptyResult()
    pullNormal(
      localDb,
      [{ clientId: 'broken', filePath: brokenPath }],
      makeConfig(),
      TABLES,
      'id',
      result
    )

    expect(result.warnings).toContain('Failed to open remote database: broken')
    expect(result.clientsSynced).toBe(0)
    expect(getSyncState(localDb, 'broken').lastSeenId).toBe(0)
  })

  it('ファイルが無い相手（フルマージ経路）でもトリガーは戻る', () => {
    const result = emptyResult()

    pullFullMerge(
      localDb,
      [{ clientId: 'ghost', filePath: path.join(testDir, 'missing.sqlite') }],
      makeConfig(),
      TABLES,
      'id',
      7,
      result
    )

    expect(result.warnings).toContain('Failed to open remote database: ghost')
    expect(result.clientsSynced).toBe(0)
    expect(getSyncState(localDb, 'ghost').lastSeenId).toBe(0)

    // フルマージはトリガーを外して入る。戻し忘れると、これ以降の
    // ローカル変更が changelog に載らず、他端末へ二度と伝わらない
    const before = changelogCount(localDb)
    localDb
      .prepare(
        `INSERT INTO users VALUES ('u1', 'a', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    expect(changelogCount(localDb)).toBe(before + 1)
  })
})

describe('スキーマの版が違う相手は、取り込まずに記録して飛ばす', () => {
  /** 版が違う相手のDBを作る（`users` に1行入れておく） */
  function createMismatchedRemote(
    name: string,
    remoteVersion: string | null
  ): string {
    remoteDb = createSyncDb(name)
    if (remoteVersion !== null) writeSchemaVersion(remoteDb, remoteVersion)
    remoteDb
      .prepare(
        `INSERT INTO users VALUES ('r1', 'remote', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    const filePath = path.join(testDir, `${name}.sqlite`)
    remoteDb.close()
    remoteDb = null
    return filePath
  }

  it('差分経路: 1行も取り込まず、カーソルも進めない', () => {
    const filePath = createMismatchedRemote('old-version', 'v1')
    const result = emptyResult()

    pullNormal(
      localDb,
      [{ clientId: 'old', filePath }],
      makeConfig('v2'),
      TABLES,
      'id',
      result
    )

    expect(result.skippedRemotes).toEqual([
      { clientId: 'old', remoteVersion: 'v1', localVersion: 'v2' },
    ])
    // 後方互換のため warnings にも文字列を残す約束がある
    expect(result.warnings).toContain(
      'Skipping client old: schema version mismatch (local=v2, remote=v1)'
    )
    expect(result.clientsSynced).toBe(0)
    expect(result.inserted).toBe(0)
    expect(localDb.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({
      n: 0,
    })
    // 版が揃ったときに取り込み直せるよう、カーソルは進めない
    expect(getSyncState(localDb, 'old').lastSeenId).toBe(0)
  })

  it('版を書いていない相手は `remote=unknown` と報告する', () => {
    const filePath = createMismatchedRemote('no-version', null)
    const result = emptyResult()

    pullNormal(
      localDb,
      [{ clientId: 'silent', filePath }],
      makeConfig('v2'),
      TABLES,
      'id',
      result
    )

    expect(result.skippedRemotes).toEqual([
      { clientId: 'silent', remoteVersion: null, localVersion: 'v2' },
    ])
    expect(result.warnings).toContain(
      'Skipping client silent: schema version mismatch (local=v2, remote=unknown)'
    )
  })

  it('同じ相手を2度見ても、記録と警告は1件ずつ', () => {
    const filePath = createMismatchedRemote('twice', 'v1')
    const result = emptyResult()
    const config = makeConfig('v2')

    // `SyncResult` は1回の sync のあいだ持ち回される。同じ相手のスキップが
    // 重なって積み上がると、利用者が「何人飛ばしたか」を数えられなくなる
    pullNormal(
      localDb,
      [{ clientId: 'twice', filePath }],
      config,
      TABLES,
      'id',
      result
    )
    pullNormal(
      localDb,
      [{ clientId: 'twice', filePath }],
      config,
      TABLES,
      'id',
      result
    )

    expect(result.skippedRemotes).toHaveLength(1)
    expect(
      result.warnings.filter((warning) =>
        warning.includes('Skipping client twice')
      )
    ).toHaveLength(1)
  })

  it('フルマージ経路でも取り込まず、トリガーは戻る', () => {
    const filePath = createMismatchedRemote('old-full', 'v1')
    const result = emptyResult()

    pullFullMerge(
      localDb,
      [{ clientId: 'old', filePath }],
      makeConfig('v2'),
      TABLES,
      'id',
      7,
      result
    )

    expect(result.skippedRemotes).toHaveLength(1)
    expect(result.clientsSynced).toBe(0)
    expect(localDb.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({
      n: 0,
    })
    expect(getSyncState(localDb, 'old').lastSeenId).toBe(0)

    const before = changelogCount(localDb)
    localDb
      .prepare(
        `INSERT INTO users VALUES ('u1', 'a', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    expect(changelogCount(localDb)).toBe(before + 1)
  })

  it('版が揃っている相手はフルマージで取り込む（飛ばす条件が広すぎないこと）', () => {
    // 飛ばす側だけを固定すると、条件を書き間違えて**全員飛ばす**ようになっても
    // 気づけない（警告だけ出て、同期は静かに止まる）。揃っている相手が
    // 通ることまで見て、はじめて条件の形が決まる
    const filePath = createMismatchedRemote('same-version', 'v2')
    const result = emptyResult()

    pullFullMerge(
      localDb,
      [{ clientId: 'peer', filePath }],
      makeConfig('v2'),
      TABLES,
      'id',
      7,
      result
    )

    expect(result.skippedRemotes).toEqual([])
    expect(result.clientsSynced).toBe(1)
    expect(localDb.prepare(`SELECT id FROM users`).all()).toEqual([
      { id: 'r1' },
    ])
    // 取り込めたぶんはカーソルが進む（次回は差分経路で足りる）
    expect(getSyncState(localDb, 'peer').lastSeenId).toBeGreaterThan(0)
  })
})

describe('差分の適用が途中で失敗したら、その相手ぶんは丸ごと巻き戻る', () => {
  it('1件でも入らない差分があれば、同じ相手の他の差分も残さずカーソルも進めない', () => {
    // 相手のスキーマには無い制約がこちらにある形（`CHECK` を後から足した端末など）。
    // 取り込みの途中で必ず落ちる差分が混ざる
    localDb.close()
    localDb = createDb('local-with-check')
    localDb.exec(`
      CREATE TABLE users (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL CHECK (name <> 'forbidden'),
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(localDb, TABLES, 'id')

    remoteDb = createSyncDb('remote-with-bad-row')
    remoteDb
      .prepare(
        `INSERT INTO users VALUES ('r1', 'ok', '2026-06-01T00:00:00.000Z')`
      )
      .run()
    remoteDb
      .prepare(
        `INSERT INTO users VALUES ('r2', 'forbidden', '2026-06-02T00:00:00.000Z')`
      )
      .run()
    const filePath = path.join(testDir, 'remote-with-bad-row.sqlite')
    const maxId = (
      remoteDb.prepare(`SELECT MAX(id) AS m FROM _changelog`).get() as {
        m: number
      }
    ).m
    expect(maxId).toBeGreaterThan(0)
    remoteDb.close()
    remoteDb = null

    const result = emptyResult()
    pullNormal(
      localDb,
      [{ clientId: 'partial', filePath }],
      makeConfig(),
      TABLES,
      'id',
      result
    )

    expect(
      result.warnings.some((warning) =>
        warning.startsWith('Sync failed for client partial:')
      )
    ).toBe(true)
    expect(result.clientsSynced).toBe(0)

    // 適用と `lastSeenId` の更新は1つのトランザクション。入った行だけ残ると、
    // カーソルが進まないまま二重適用の種になる
    expect(localDb.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({
      n: 0,
    })
    expect(getSyncState(localDb, 'partial').lastSeenId).toBe(0)
  })
})

describe('フルマージが途中で失敗したら、その相手ぶんは丸ごと巻き戻る', () => {
  it('同期用でないDBが相手として現れても、取り込みかけの行を残さない', () => {
    // `client-*.sqlite` の名前で同期用でないDBが置かれた形（`_changelog` が無い）。
    // データの突き合わせまでは進み、changelog の複製で落ちる
    remoteDb = createDb('not-a-sync-db')
    remoteDb.exec(`
      CREATE TABLE users (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    remoteDb
      .prepare(
        `INSERT INTO users VALUES ('r1', 'remote', '2026-06-01T00:00:00.000Z')`
      )
      .run()
    const filePath = path.join(testDir, 'not-a-sync-db.sqlite')
    remoteDb.close()
    remoteDb = null

    const result = emptyResult()
    pullFullMerge(
      localDb,
      [{ clientId: 'stranger', filePath }],
      makeConfig(),
      TABLES,
      'id',
      7,
      result
    )

    expect(
      result.warnings.some((warning) =>
        warning.startsWith('Full merge failed for client stranger:')
      )
    ).toBe(true)
    expect(result.clientsSynced).toBe(0)

    // 巻き戻っていること。`performFullMergeData` はこの行を入れた**あと**に
    // 落ちるので、トランザクションが効いていなければ半端な行が残る
    expect(localDb.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({
      n: 0,
    })
    // カーソルが進むと、同じギャップがもう検出されず取り込み直せなくなる
    expect(getSyncState(localDb, 'stranger').lastSeenId).toBe(0)

    // 失敗経路でもトリガーは戻る
    const before = changelogCount(localDb)
    localDb
      .prepare(
        `INSERT INTO users VALUES ('u1', 'a', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    expect(changelogCount(localDb)).toBe(before + 1)
  })
})
