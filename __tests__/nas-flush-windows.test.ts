/**
 * 写しを記憶装置へ書き出すとき、Windows で `EPERM` にならないこと。
 *
 * Windows の `FlushFileBuffers` は書き込みの権限を持つハンドルでなければ `ERROR_ACCESS_DENIED` を返し、
 * Node はそれを `EPERM: operation not permitted, fdatasync` として投げる。macOS と Linux では
 * 読み取り専用のハンドルでも通るので、そのままでは開発機でも CI でも見えない。
 *
 * そこで `fs.promises.open` を差し替え、**読み取り専用で開いたハンドルの `datasync` を Windows と同じく
 * `EPERM` にする**。0.21.0〜0.22.0 は `open(…, 'r')` で開いていたので、Windows のクライアントは
 * 写しを置くたびに必ず失敗し、NAS へ1行も届けられなかった。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { copyToNas } from '../src/nas'

// `vi.mock` は import より前へ巻き上げられるので、差し替えが読む値も巻き上げる
const flushes = vi.hoisted(() => ({ readOnly: 0, writable: 0 }))

/** Windows の `CreateFile` の権限に倣う。`r` だけが書き込みの権限を持たない */
function isReadOnly(flags: unknown): boolean {
  return flags === undefined || flags === 'r' || flags === 'rs' || flags === 0
}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      open: async (...args: Parameters<typeof actual.promises.open>) => {
        const handle = await actual.promises.open(...args)
        if (!isReadOnly(args[1])) {
          const datasync = handle.datasync.bind(handle)
          handle.datasync = async () => {
            flushes.writable += 1
            return datasync()
          }
          return handle
        }
        handle.datasync = async () => {
          flushes.readOnly += 1
          throw Object.assign(
            new Error('EPERM: operation not permitted, fdatasync'),
            {
              code: 'EPERM',
              syscall: 'fdatasync',
            }
          )
        }
        return handle
      },
    },
  }
})

describe('写しの書き出し（Windows のハンドルの権限）', () => {
  const testDir = path.join(__dirname, 'test-data-nas-flush-windows')
  const nasDir = path.join(testDir, 'nas')
  let savedTmpDir: string | undefined

  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(nasDir, { recursive: true })
    savedTmpDir = process.env.TMPDIR
    process.env.TMPDIR = path.join(testDir, 'tmp')
    flushes.readOnly = 0
    flushes.writable = 0
  })

  afterEach(() => {
    if (savedTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmpDir
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('書き込みのできるハンドルで書き出し、NAS に写しを置ける', async () => {
    const db = new Database(path.join(testDir, 'local.sqlite'))
    db.exec(`CREATE TABLE _sync_meta (key TEXT PRIMARY KEY, value TEXT)`)
    try {
      await copyToNas(db, nasDir, 'me', [])
    } finally {
      db.close()
    }
    expect(fs.existsSync(path.join(nasDir, 'client-me.sqlite'))).toBe(true)
    // 書き出しを通ったこと自体も見る。通らなくなっても緑になってはいけない
    expect(flushes.writable).toBeGreaterThan(0)
    expect(flushes.readOnly).toBe(0)
  })
})
