import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'

/**
 * `SyncInstance.close()` の検査。
 *
 * 閉じたことは、WAL ファイルが消えることで確かめる。SQLite は WAL モードの DB への
 * 最後の接続が閉じるときにチェックポイントを取り、`-wal` を消す。`setupSync` が開いた
 * 接続が残っている限り `-wal` は残るので、閉じ忘れはここで露見する。
 */
describe('SyncInstance.close', () => {
  let testDir: string
  let dbPath: string
  let nasDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-close-'))
    dbPath = path.join(testDir, 'local.sqlite')
    nasDir = path.join(testDir, 'nas')
    const db = new Database(dbPath)
    db.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updatedAt TEXT NOT NULL)`
    )
    db.close()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  const open = () =>
    setupSync({ dbPath, nasPath: nasDir, clientId: 'client-a', intervalMs: 50 })

  it('setupSync が開いた接続を閉じる', async () => {
    const sync = open()
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true)

    await sync.close()

    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
  })

  it('閉じたあとの syncNow と start は例外を投げ、2回目の close は何もしない', async () => {
    const sync = open()
    await sync.close()

    await expect(sync.syncNow()).rejects.toThrow('Sync instance is closed')
    expect(() => sync.start()).toThrow('Sync instance is closed')
    await expect(sync.close()).resolves.toBeUndefined()
  })

  it('定期syncを止める', async () => {
    const sync = open()
    sync.start()
    expect(sync.getStatus().isRunning).toBe(true)

    await sync.close()

    expect(sync.getStatus().isRunning).toBe(false)
  })

  it('同期の実行中に呼ぶと、その同期が終わってから閉じる', async () => {
    const sync = open()
    const running = sync.syncNow()

    await sync.close()

    // 閉じる前に同期は終わっている（途中で接続を閉じていれば、この同期は例外で終わる）
    await expect(running).resolves.toBeDefined()
    expect(sync.getStatus().isSyncing).toBe(false)
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
  })
})
