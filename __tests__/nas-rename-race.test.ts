/**
 * 同じ clientId の取り合いで、NAS の一時ファイルを置く前に別の端末に持っていかれたとき。
 *
 * 2台が同じ clientId で同時に写しを置くと、2台とも `client-<id>.sqlite.tmp` へ書いて `rename` する。
 * 先に `rename` した側がその一時ファイルを置いてしまうので、後の側の `rename` は `ENOENT` になる。
 * その例外は、何が起きたか分かるものでなければならない。
 *
 * `rename` の直前に、同じ一時ファイルを別の端末が置いた状態を `fs.promises.rename` の差し替えで作る。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { copyToNas } from '../src/nas'

// `vi.mock` は import より前へ巻き上げられるので、差し替えが読む値も巻き上げる
const race = vi.hoisted(() => ({ armed: false }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      rename: async (from: string, to: string): Promise<void> => {
        if (race.armed && from.endsWith('.tmp')) {
          race.armed = false
          // 同じ clientId の別の端末が、先に同じ一時ファイルを置いた
          await actual.promises.rename(from, to)
        }
        await actual.promises.rename(from, to)
      },
    },
  }
})

describe('同じ clientId の取り合い', () => {
  const testDir = path.join(__dirname, 'test-data-nas-rename-race')
  const nasDir = path.join(testDir, 'nas')
  let savedTmpDir: string | undefined

  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(nasDir, { recursive: true })
    savedTmpDir = process.env.TMPDIR
    process.env.TMPDIR = path.join(testDir, 'tmp')
  })

  afterEach(() => {
    race.armed = false
    if (savedTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmpDir
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('一時ファイルを置く前に持っていかれたら、取り合いだと分かる例外にする', async () => {
    const db = new Database(path.join(testDir, 'local.sqlite'))
    db.exec(`CREATE TABLE _sync_meta (key TEXT PRIMARY KEY, value TEXT)`)
    race.armed = true
    try {
      await expect(copyToNas(db, nasDir, 'me', [])).rejects.toThrow(
        /client-me\.sqlite\.tmp.*同じ clientId/
      )
    } finally {
      db.close()
    }
  })
})
