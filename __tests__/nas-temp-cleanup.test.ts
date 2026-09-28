/**
 * 一時領域の後片付け —— リモートDBのローカルコピーを残さないこと。
 *
 * 取り込みは相手のDBを一時領域へコピーして読む。**この後片付けが漏れると
 * 静かにディスクを食い潰す**（実測: テスト全件で残骸 5,994 個、長く回した環境では
 * 60GB超まで育ってディスクが満杯になった）。壊れても例外が出ない種類の不具合なので、
 * 「残骸が0個」をここで固定する。
 *
 * 特に注意すべきは**副ファイル**。同期対象のDBはWALモードなので、読み取り専用で
 * 開いても SQLite は `-wal` / `-shm` を作る。しかも読み取り専用接続はWALの
 * チェックポイントができないため `close()` しても副ファイルは残る。
 * 本体だけ `unlink` していたのが、上の残骸の正体だった。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { openRemoteDbViaLocalCopy, sweepStaleRemoteCopies } from '../src/nas'
import { performSync } from '../src/sync'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const { prepare, cleanup, testDir, createClientDb, makeConfig } =
  createSyncFixture('test-data-nas-temp')

/** `remote-*` の一時コピー（本体・副ファイルとも）を列挙する。 */
function listRemnants(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.startsWith('remote-'))
}

/**
 * 存在しないPIDを1つ見つける。
 *
 * 「死んだプロセスの残骸」を作るために必要。決め打ちの数値を使うと、
 * たまたまその番号のプロセスが動いていたときにテストが揺れる。
 */
function findDeadPid(): number {
  for (let pid = 99999; pid > 30000; pid--) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('使われていないPIDが見つからなかった')
}

describe('openRemoteDbViaLocalCopy の後片付け', () => {
  const dir = path.join(__dirname, 'test-data-nas-temp-unit')
  const tmpDir = path.join(dir, 'tmp')
  const srcPath = path.join(dir, 'remote.sqlite')

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    // 同期するDBは必ずWALモードである。`setupSync` と `setupRowsLedgers` がそう設定する。
    // WALでないDBで試すと副ファイルが生まれず、この不具合を見逃す。
    const db = new Database(srcPath)
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`)
    db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run('a', 'hello')
    db.close()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('cleanup() が -wal / -shm も消す', () => {
    const handle = openRemoteDbViaLocalCopy(srcPath, tmpDir)
    expect(handle).not.toBeNull()

    // 読むと副ファイルが作られる（作られない環境ならこの検査は無意味になるので、
    // 「確かに作られている」ことを先に押さえる）
    handle!.db.prepare(`SELECT v FROM t WHERE id = ?`).get('a')
    const during = listRemnants(tmpDir)
    expect(during.some((f) => f.endsWith('-wal'))).toBe(true)
    expect(during.some((f) => f.endsWith('-shm'))).toBe(true)

    handle!.cleanup()

    // 本体も副ファイルも残らないこと
    expect(listRemnants(tmpDir)).toEqual([])
  })

  it('整合性NGで null を返すときも副ファイルを残さない', () => {
    const badPath = path.join(dir, 'bad.sqlite')
    // SQLiteのヘッダだけ本物に見せかけた壊れたファイル。
    // コピーは成功し、オープンか integrity_check で落ちる経路を通す。
    const good = fs.readFileSync(srcPath)
    const broken = Buffer.from(good)
    broken.fill(0x5a, 200, Math.min(broken.length, 4000))
    fs.writeFileSync(badPath, broken)

    expect(openRemoteDbViaLocalCopy(badPath, tmpDir)).toBeNull()
    expect(listRemnants(tmpDir)).toEqual([])
  })
})

describe('performSync 後の一時領域', () => {
  // `performSync` 経由では `os.tmpdir()` 配下が使われる。os.tmpdir() は呼ぶたびに
  // TMPDIR を見るので、環境変数を差し替えるだけで隔離できる
  // （このためだけに設定項目を増やすのは、利用者に無関係な旋盤を渡すことになる）。
  let savedTmpDir: string | undefined
  let isolatedTmp: string

  beforeEach(() => {
    prepare()
    isolatedTmp = path.join(testDir, 'ostmp')
    fs.mkdirSync(isolatedTmp, { recursive: true })
    savedTmpDir = process.env.TMPDIR
    process.env.TMPDIR = isolatedTmp
  })

  afterEach(() => {
    if (savedTmpDir === undefined) {
      delete process.env.TMPDIR
    } else {
      process.env.TMPDIR = savedTmpDir
    }
    cleanup()
  })

  /** 差し替えた TMPDIR 配下の一時コピー置き場。 */
  function copyDir(): string {
    return path.join(os.tmpdir(), 'sqlite-nas-sync')
  }

  it('通常経路を通したあと残骸が0個', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    // Bは「相手を開いて取り込む」側。ここで一時コピーが作られる。
    const resultB = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    // **案A（段階5）で期待値が変わった。** 一度も読んでいない相手
    // （`lastSeenId === 0`）は必ずフルマージで読む —— 相手の `_changelog` は
    // 通知の索引でしかなく、移行や掃除で短くなるので、初回に差分だけを読むと
    // 相手の行が届かないことがある（3端末の性質テストが踏んだ）。
    // 2回目からは通常の差分に戻る。ここで見たいのは一時領域の後片付けなので、
    // **どちらの経路も通したうえで**残骸が0であることを見る。
    expect(resultB.hadChangelogGap).toBe(true)
    expect(
      dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get()
    ).toBeTruthy()

    // もう1往復して、同期を繰り返しても溜まらないことを見る
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    const againB = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    // 2回目は通常の差分経路
    expect(againB.hadChangelogGap).toBe(false)

    expect(listRemnants(copyDir())).toEqual([])

    dbA.close()
    dbB.close()
  })

  it('フルマージ経路を通したあと残骸が0個', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Bが一度取り込んで、Aに対するカーソルを進めておく
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Aが書き足してから、Aのchangelogを消して隙間を作る（保持期間超過の再現）。
    // Bがまだ読んでいない u2 のエントリまで消えている —— これが隙間の形。
    // 読み終えたぶんだけを消しても隙間ではない
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u2', 'Bob', '2024-01-02T00:00:00Z')
    dbA.exec(`DELETE FROM _changelog`)
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    const resultB = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(resultB.hadChangelogGap).toBe(true)

    expect(listRemnants(copyDir())).toEqual([])

    dbA.close()
    dbB.close()
  })
})

describe('sweepStaleRemoteCopies（起きたついでの残骸回収）', () => {
  const dir = path.join(__dirname, 'test-data-nas-sweep')

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** `remote-<pid>-<時刻>-<乱数>.sqlite` と副ファイルを作る。 */
  function makeCopy(pid: number | string, suffix = 'dead'): string {
    const name = `remote-${pid}-1700000000000-${suffix}.sqlite`
    for (const ext of ['', '-wal', '-shm']) {
      fs.writeFileSync(path.join(dir, `${name}${ext}`), 'x')
    }
    return name
  }

  it('死んだPIDの残骸は副ファイルごと消す', () => {
    const name = makeCopy(findDeadPid(), 'aabbccdd')

    expect(sweepStaleRemoteCopies(dir)).toBe(1)
    expect(fs.existsSync(path.join(dir, name))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${name}-wal`))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${name}-shm`))).toBe(false)
  })

  it('生きているPIDの残骸は消さない', () => {
    // 自分自身。同期の最中に自分の一時コピーを消すと、読んでいるDBが足元から消える。
    const mine = makeCopy(process.pid, 'aabbccdd')
    // 他プロセス（PID 1 は常に居る。root所有なので `kill(1, 0)` は EPERM になる ——
    // 「触れない」を「居ない」と読み替えると、他ユーザーが使用中のコピーを消してしまう）。
    const others = makeCopy(1, 'eeff0011')

    expect(sweepStaleRemoteCopies(dir)).toBe(0)
    expect(fs.existsSync(path.join(dir, mine))).toBe(true)
    expect(fs.existsSync(path.join(dir, others))).toBe(true)
  })

  it('PIDが読めない名前は、古いものだけ消す', () => {
    const odd = 'remote-unknown-shape.sqlite'
    fs.writeFileSync(path.join(dir, odd), 'x')

    // 出来たばかりなら、誰かが使っている最中かもしれないので触らない
    expect(sweepStaleRemoteCopies(dir, 60_000)).toBe(0)
    expect(fs.existsSync(path.join(dir, odd))).toBe(true)

    // 十分に古ければ残骸と見なす
    const old = Date.now() - 2 * 60 * 60 * 1000
    fs.utimesSync(path.join(dir, odd), old / 1000, old / 1000)
    expect(sweepStaleRemoteCopies(dir, 60 * 60 * 1000)).toBe(1)
    expect(fs.existsSync(path.join(dir, odd))).toBe(false)
  })

  it('関係ないファイルには触らない', () => {
    const keep = ['client-a.sqlite', 'something.txt', 'remote.sqlite']
    for (const f of keep) fs.writeFileSync(path.join(dir, f), 'x')

    expect(sweepStaleRemoteCopies(dir, 0)).toBe(0)
    for (const f of keep) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true)
    }
  })

  it('ディレクトリが無くても例外にしない', () => {
    expect(sweepStaleRemoteCopies(path.join(dir, 'nope'))).toBe(0)
  })
})
