import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import {
  copyToNas,
  ensureDirectory,
  listRemoteClients,
  openRemoteDb,
  openRemoteDbViaLocalCopy,
} from '../src/nas'

describe('openRemoteDbViaLocalCopy', () => {
  const testDir = path.join(__dirname, 'test-data-nas')
  const tmpDir = path.join(testDir, 'tmp')
  const srcPath = path.join(testDir, 'remote.sqlite')

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
    const db = new Database(srcPath)
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`)
    db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run('a', 'hello')
    db.close()
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  it('リモートDBファイルをローカルtmpにコピーしてから開く', () => {
    const handle = openRemoteDbViaLocalCopy(srcPath, tmpDir)
    expect(handle).not.toBeNull()
    const row = handle!.db.prepare(`SELECT v FROM t WHERE id = ?`).get('a') as {
      v: string
    }
    expect(row.v).toBe('hello')

    // tmp ファイルが実際に作られていること
    const tmpFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('remote-'))
    expect(tmpFiles.length).toBe(1)

    handle!.cleanup()
    // cleanup 後に tmp ファイルが消えていること
    const tmpAfter = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('remote-'))
    expect(tmpAfter.length).toBe(0)
  })

  it('読み取り中にオリジナルが置き換わってもローカルコピーは影響を受けない', () => {
    const handle = openRemoteDbViaLocalCopy(srcPath, tmpDir)
    expect(handle).not.toBeNull()

    // オリジナルを書き換え
    const orig = new Database(srcPath)
    orig.prepare(`UPDATE t SET v = ? WHERE id = ?`).run('changed', 'a')
    orig.close()

    // ハンドルから読んだ値は元のまま
    const row = handle!.db.prepare(`SELECT v FROM t WHERE id = ?`).get('a') as {
      v: string
    }
    expect(row.v).toBe('hello')

    handle!.cleanup()
  })

  it('存在しないファイルを開こうとすると null を返す', () => {
    const handle = openRemoteDbViaLocalCopy(
      path.join(testDir, 'does-not-exist.sqlite'),
      tmpDir
    )
    expect(handle).toBeNull()
  })

  it('破損ファイルを開こうとすると null を返し、tmp も残らない', () => {
    const badPath = path.join(testDir, 'bad.sqlite')
    fs.writeFileSync(badPath, 'this is not a sqlite database')

    const handle = openRemoteDbViaLocalCopy(badPath, tmpDir)
    expect(handle).toBeNull()

    // tmp ディレクトリに残骸が無いこと
    if (fs.existsSync(tmpDir)) {
      const tmpFiles = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('remote-'))
      expect(tmpFiles.length).toBe(0)
    }
  })

  it('tmpDir を省略すると os.tmpdir() 配下を使う', () => {
    const handle = openRemoteDbViaLocalCopy(srcPath)
    expect(handle).not.toBeNull()

    const expectedDir = path.join(os.tmpdir(), 'sqlite-nas-sync')
    expect(fs.existsSync(expectedDir)).toBe(true)

    handle!.cleanup()
  })

  it('並行して複数開いても tmp ファイル名が衝突しない', () => {
    const handles = Array.from({ length: 5 }, () =>
      openRemoteDbViaLocalCopy(srcPath, tmpDir)
    )
    for (const h of handles) {
      expect(h).not.toBeNull()
    }
    const tmpFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('remote-'))
    expect(tmpFiles.length).toBe(5)

    for (const h of handles) {
      h!.cleanup()
    }
  })
})

/**
 * NASは「いつでも読み書きできる場所」ではない。
 *
 * 共有が外れている、権限が無い、途中まで書かれたファイルが転がっている——
 * 同期ライブラリで最も現実に起きる系統がここに集まる。
 * 落ちてよい場面と、落ちずに続けるべき場面を、ここで分ける。
 */
describe('NASが思いどおりでないとき', () => {
  const testDir = path.join(__dirname, 'test-data-nas-failure')

  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // 読み取り専用にしたディレクトリが残っていると次が消せないので、戻してから消す
    for (const entry of fs.existsSync(testDir) ? fs.readdirSync(testDir) : []) {
      const target = path.join(testDir, entry)
      try {
        fs.chmodSync(target, 0o755)
      } catch {
        /* 消せるならそれでよい */
      }
    }
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('listRemoteClients', () => {
    it('NASディレクトリごと無ければ空配列（例外にしない）', () => {
      // 共有が外れている状態。同期を諦める理由にはならないので、
      // 「相手がいない」として静かに続ける。
      const clients = listRemoteClients(path.join(testDir, 'no-such-nas'), 'me')
      expect(clients).toEqual([])
    })

    it('自分自身のファイルと、無関係なファイルを除く', () => {
      const nasDir = path.join(testDir, 'nas')
      fs.mkdirSync(nasDir)
      for (const name of [
        'client-me.sqlite',
        'client-other.sqlite',
        'client-third.sqlite',
        'notes.txt',
        'client-broken.sqlite.tmp',
      ]) {
        fs.writeFileSync(path.join(nasDir, name), '')
      }

      const clients = listRemoteClients(nasDir, 'me')
      expect(clients.map((client) => client.clientId).sort()).toEqual([
        'other',
        'third',
      ])
    })

    it('書き込み途中の .tmp は相手として数えない', () => {
      // copyToNas は `.tmp` へ書いてから rename する。その最中を覗いても、
      // 中途半端なファイルを開きにいかないこと。
      const nasDir = path.join(testDir, 'nas')
      fs.mkdirSync(nasDir)
      fs.writeFileSync(path.join(nasDir, 'client-a.sqlite.tmp'), '')

      expect(listRemoteClients(nasDir, 'me')).toEqual([])
    })

    it('空のNASディレクトリなら空配列', () => {
      const nasDir = path.join(testDir, 'nas')
      fs.mkdirSync(nasDir)
      expect(listRemoteClients(nasDir, 'me')).toEqual([])
    })
  })

  describe('copyToNas', () => {
    it('NASディレクトリが無ければ作ってから置く', () => {
      const db = new Database(path.join(testDir, 'local.sqlite'))
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)
      const nasDir = path.join(testDir, 'nas', 'deep', 'path')

      return copyToNas(db, nasDir, 'me').then(() => {
        expect(fs.existsSync(path.join(nasDir, 'client-me.sqlite'))).toBe(true)
        // 一時ファイルは rename 済みで残らない
        expect(
          fs.readdirSync(nasDir).filter((name) => name.endsWith('.tmp'))
        ).toEqual([])
        db.close()
      })
    })

    // root で走らせると chmod が効かない（何でも書けてしまう）ので、その場合は飛ばす。
    const asRoot =
      typeof process.getuid === 'function' && process.getuid() === 0
    it.skipIf(asRoot)(
      '書き込めない場所なら例外を投げる（黙って成功しない）',
      async () => {
        const db = new Database(path.join(testDir, 'local2.sqlite'))
        db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)
        const nasDir = path.join(testDir, 'readonly-nas')
        fs.mkdirSync(nasDir)
        fs.chmodSync(nasDir, 0o500) // 読めるが書けない

        // 押し出しに失敗したことは呼び出し元が知らねばならない。
        // ここを握り潰すと「同期したつもり」で相手に何も届かない状態になる。
        await expect(copyToNas(db, nasDir, 'me')).rejects.toThrow()

        fs.chmodSync(nasDir, 0o755)
        db.close()
      }
    )

    it('置いたファイルは、そのまま開いて読める', async () => {
      const db = new Database(path.join(testDir, 'local3.sqlite'))
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`)
      db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run('a', 'hello')
      const nasDir = path.join(testDir, 'nas3')

      await copyToNas(db, nasDir, 'me')
      db.close()

      const handle = openRemoteDbViaLocalCopy(
        path.join(nasDir, 'client-me.sqlite'),
        path.join(testDir, 'tmp3')
      )
      expect(handle).not.toBeNull()
      const row = handle!.db
        .prepare(`SELECT v FROM t WHERE id = ?`)
        .get('a') as {
        v: string
      }
      expect(row.v).toBe('hello')
      handle!.cleanup()
    })
  })

  describe('openRemoteDbViaLocalCopy', () => {
    it('tmpDir を作れない場所でも例外にせず null を返す', () => {
      // 一時領域が用意できないのは、同期を止める理由にはなるが、
      // 呼び出し元を落とす理由にはならない（他の相手とは同期を続ける）。
      const srcPath = path.join(testDir, 'src.sqlite')
      const db = new Database(srcPath)
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)
      db.close()

      const blocker = path.join(testDir, 'blocker')
      fs.writeFileSync(blocker, '') // ディレクトリを作れない場所（ファイルが居座る）

      const handle = openRemoteDbViaLocalCopy(
        srcPath,
        path.join(blocker, 'tmp')
      )
      expect(handle).toBeNull()
    })

    it('中身が途中までのSQLiteファイルは null を返す', () => {
      // rename 前の .tmp を覗いた、コピーが途中で切れた、といった形。
      const srcPath = path.join(testDir, 'truncated.sqlite')
      const db = new Database(srcPath)
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`)
      for (let i = 0; i < 200; i += 1) {
        db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run(
          `id-${i}`,
          'x'.repeat(200)
        )
      }
      db.close()

      const full = fs.readFileSync(srcPath)
      const truncatedPath = path.join(testDir, 'half.sqlite')
      // ヘッダは正しいまま、後ろを落とす（integrity_check で弾かれる形）
      fs.writeFileSync(
        truncatedPath,
        full.subarray(0, Math.floor(full.length / 2))
      )

      const handle = openRemoteDbViaLocalCopy(
        truncatedPath,
        path.join(testDir, 'tmp-truncated')
      )
      expect(handle).toBeNull()
    })
  })

  describe('ensureDirectory', () => {
    it('既にあるディレクトリでも例外にしない（冪等）', () => {
      const dir = path.join(testDir, 'a', 'b', 'c')
      ensureDirectory(dir)
      expect(() => ensureDirectory(dir)).not.toThrow()
      expect(fs.existsSync(dir)).toBe(true)
    })
  })

  describe('openRemoteDb（旧API）', () => {
    it('存在しないファイルなら null', () => {
      expect(openRemoteDb(path.join(testDir, 'none.sqlite'))).toBeNull()
    })

    it('壊れたファイルなら null', () => {
      const badPath = path.join(testDir, 'bad.sqlite')
      fs.writeFileSync(badPath, 'not a database')
      expect(openRemoteDb(badPath)).toBeNull()
    })

    it('健全なファイルなら読み取り専用で開ける', () => {
      const okPath = path.join(testDir, 'ok.sqlite')
      const db = new Database(okPath)
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)
      db.close()

      const remote = openRemoteDb(okPath)
      expect(remote).not.toBeNull()
      expect(() =>
        remote!.prepare(`INSERT INTO t (id) VALUES (?)`).run('x')
      ).toThrow()
      remote!.close()
    })
  })
})
