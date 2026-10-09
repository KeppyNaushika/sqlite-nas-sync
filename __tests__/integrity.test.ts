/**
 * 写しの整合性検査とワーカーの窓口 —— 呼んだスレッドを止めずに、答えはワーカーの事情で変えないこと。
 *
 * 相手の写しを読むたびに、NAS から手元へ写して `integrity_check` で全部を読む。
 * これを同期で行っていたので、Electron の主プロセスでは相手の数 × 写しの大きさ
 * だけ画面が止まった（N100 の Windows で 6台 × 5 MB に約 0.18 秒、29台で約 0.83 秒。
 * 実際の NAS ではその何倍も）。写しは `fs.promises.copyFile`、検査はワーカーへ移した。
 *
 * **ワーカーが答えを返さなければ、呼んだスレッドでやり直す。** 検査を黙って飛ばすと、
 * 読みかけの壊れた写しを取り込む入口になる。逆に、ワーカーの側の事情（ネイティブ
 * アドオンを読み込めない、など）を「写しが壊れている」と読むと、全員の写しを毎回
 * 読めなくなる。どちらも、答えを呼んだスレッドの結果で決めることで防ぐ。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { checkIntegrity } from '../src/integrity'
import { createSyncWorker } from '../src/worker-host'
import { openRemoteDbViaLocalCopy } from '../src/nas'

const WORKER_BUILD = 'sync-worker-test'
const build = join(process.cwd(), 'node_modules', '.cache', WORKER_BUILD)
const dir = join(process.cwd(), 'test-data-integrity')
const tmpDir = join(dir, 'tmp')
let workerPath = ''

beforeAll(() => {
  // ワーカーは組み上げた JS からしか起動できない（`rows-rebuild.test.ts` と同じ手順）
  execFileSync(
    'npx',
    [
      'tsc',
      '--ignoreConfig',
      'src/worker.ts',
      'src/worker-host.ts',
      '--outDir',
      build,
      '--module',
      'node16',
      '--moduleResolution',
      'node16',
      '--target',
      'ES2020',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: process.cwd(), stdio: 'pipe' }
  )
  workerPath = join(build, 'worker.js')
}, 60000)

afterAll(() => {
  fs.rmSync(build, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 行の入った健全な DB を作る。 */
function makeDb(name: string, rows: number): string {
  const file = join(dir, name)
  const db = new Database(file)
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)`)
  db.exec(`CREATE INDEX t_body ON t(body)`)
  const insert = db.prepare(`INSERT INTO t VALUES (?, ?)`)
  db.transaction(() => {
    for (const n of Array.from({ length: rows }, (_, i) => i)) {
      insert.run(`id-${n}`, `本文 ${n} `.repeat(8))
    }
  })()
  db.close()
  return file
}

/**
 * 索引の葉ページの中身だけを書き潰す。開けるし表も読めるが、`integrity_check`
 * だけが気づく形。ヘッダを壊すと開いた時点で落ちるので、検査の経路を通らない。
 * （`sqlite_master` を書き換える手は、better-sqlite3 の既定の防御で断られる）
 */
function corruptIndex(file: string): void {
  const bytes = fs.readFileSync(file)
  const pageSize = bytes.readUInt16BE(16)
  // 1ページ目はファイルのヘッダ（100 バイト）を持つので飛ばす
  const pages = Array.from(
    { length: bytes.length / pageSize },
    (_, i) => i
  ).slice(1)
  // 0x0a = 索引の葉ページ
  const leaf = pages.find((page) => bytes[page * pageSize] === 0x0a)
  if (leaf === undefined) throw new Error('索引の葉ページが見つからなかった')
  // ページの見出し（先頭 8 バイトとセルの位置の並び）は残し、後半のセルの中身を潰す
  bytes.fill(0x7f, leaf * pageSize + pageSize / 2, (leaf + 1) * pageSize - 4)
  fs.writeFileSync(file, bytes)
}

/**
 * 偽のワーカーを書く。届いた仕事を `log` へ1行ずつ書き、`answer` の答えを返す。
 * 起動したときも `start` と書く。
 */
function fakeWorker(
  name: string,
  answer: string
): { path: string; log: string } {
  const path = join(dir, name)
  const log = join(dir, `${name}.log`)
  fs.writeFileSync(
    path,
    `const { parentPort } = require('node:worker_threads')
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, 'start\\n')
parentPort.on('message', (request) => {
  fs.appendFileSync(${JSON.stringify(log)}, request.task.kind + '\\n')
  parentPort.postMessage({ id: request.id, ...${answer} })
})
`
  )
  return { path, log }
}

/** 偽のワーカーの記録（行の並び）。 */
function linesOf(log: string): string[] {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
}

describe('checkIntegrity —— ワーカーで検査し、答えが返らなければ呼んだスレッドで検査する', () => {
  it('ワーカーで検査し、健全なら ok、壊れていればそれを返す', async () => {
    const good = makeDb('good.sqlite', 2000)
    const bad = makeDb('bad.sqlite', 2000)
    corruptIndex(bad)
    const worker = createSyncWorker({ workerPath })
    try {
      // ワーカーが答えている（呼んだスレッドへ落ちていない）ことも見る
      expect(
        await worker.run({ kind: 'integrity-check', dbPath: good })
      ).toEqual({ done: true, value: 'ok' })
      expect(await checkIntegrity(bad, worker)).not.toBe('ok')
      // 壊れた写しのあとも、同じワーカーで検査を続けられる
      expect(
        await worker.run({ kind: 'integrity-check', dbPath: good })
      ).toEqual({ done: true, value: 'ok' })
    } finally {
      await worker.close()
    }
  })

  it('ワーカーの入口が無ければ、呼んだスレッドで検査する（飛ばさない）', async () => {
    const bad = makeDb('bad.sqlite', 2000)
    corruptIndex(bad)
    const worker = createSyncWorker({
      workerPath: join(dir, 'no-such-worker.js'),
    })
    try {
      expect(await checkIntegrity(bad, worker)).not.toBe('ok')
    } finally {
      await worker.close()
    }
  })

  it('ワーカーが起動直後に落ちても、呼んだスレッドで検査する（飛ばさない）', async () => {
    const crashing = join(dir, 'crash-worker.js')
    fs.writeFileSync(crashing, `throw new Error('起動に失敗')\n`)
    const good = makeDb('good.sqlite', 10)
    const bad = makeDb('bad.sqlite', 2000)
    corruptIndex(bad)
    const worker = createSyncWorker({ workerPath: crashing })
    try {
      expect(await checkIntegrity(bad, worker)).not.toBe('ok')
      expect(await checkIntegrity(good, worker)).toBe('ok')
    } finally {
      await worker.close()
    }
  })

  it('ワーカーの中の SQLite 以外の例外は「壊れている」ではない。呼んだスレッドで検査し、ワーカーはもう使わない', async () => {
    // ネイティブアドオンをワーカーで読み込めない環境（Electron の束ね方など）を模す。
    // better-sqlite3 はアドオンを `new Database()` の中で読み込むので、例外は仕事ごとに出る
    const fake = fakeWorker(
      'no-addon-worker.js',
      `{ ok: false, message: 'Could not locate the bindings file', sqlite: false }`
    )
    const good = makeDb('good.sqlite', 10)
    const bad = makeDb('bad.sqlite', 2000)
    corruptIndex(bad)
    const worker = createSyncWorker({ workerPath: fake.path })
    try {
      expect(await checkIntegrity(good, worker)).toBe('ok')
      expect(await checkIntegrity(bad, worker)).not.toBe('ok')
      expect(await checkIntegrity(good, worker)).toBe('ok')
      // ワーカーへ届いたのは最初の1件だけ（以後は起動し直しもしない）
      expect(linesOf(fake.log)).toEqual(['start', 'integrity-check'])
    } finally {
      await worker.close()
    }
  })

  it('ワーカーの中の SQLite の例外（写しが DB でない）は、呼んだスレッドの答えに従い、ワーカーは使い続ける', async () => {
    const notDb = join(dir, 'not-a-db.sqlite')
    fs.writeFileSync(notDb, 'これは SQLite のファイルではない'.repeat(200))
    const good = makeDb('good.sqlite', 10)
    const worker = createSyncWorker({ workerPath })
    try {
      // 呼んだスレッドで検査し直しても開けないので、例外になる（`openLocalCopy` は null を返す）
      await expect(checkIntegrity(notDb, worker)).rejects.toThrow()
      expect(
        await worker.run({ kind: 'integrity-check', dbPath: good })
      ).toEqual({ done: true, value: 'ok' })
    } finally {
      await worker.close()
    }
  })

  it('検査の自己検査: 壊し方が integrity_check に見える形になっている', () => {
    const bad = makeDb('bad.sqlite', 2000)
    corruptIndex(bad)
    const db = new Database(bad, { readonly: true })
    try {
      // 開けて表も読める（＝検査の経路まで届く）が、検査は気づく
      expect(db.prepare(`SELECT count(*) AS n FROM t`).get()).toEqual({
        n: 2000,
      })
      expect(db.pragma('integrity_check', { simple: true })).not.toBe('ok')
    } finally {
      db.close()
    }
  })
})

describe('createSyncWorker —— ワーカーの寿命', () => {
  it('同期をまたいで使い回し、使わなかった同期の終わりに止める', async () => {
    const fake = fakeWorker('counting-worker.js', `{ ok: true, value: 'ok' }`)
    const worker = createSyncWorker({ workerPath: fake.path })
    const db = join(dir, 'any.sqlite')
    try {
      // 1回目の同期: 起動して使う
      await worker.run({ kind: 'integrity-check', dbPath: db })
      await worker.endSync()
      // 2回目の同期: 使い回す（起動し直さない）
      await worker.run({ kind: 'integrity-check', dbPath: db })
      await worker.endSync()
      expect(linesOf(fake.log)).toEqual([
        'start',
        'integrity-check',
        'integrity-check',
      ])
      // 3回目の同期: 使わなかったので、終わりに止める
      await worker.endSync()
      // 4回目の同期: また使うときに起こし直す
      await worker.run({ kind: 'integrity-check', dbPath: db })
      expect(linesOf(fake.log)).toEqual([
        'start',
        'integrity-check',
        'integrity-check',
        'start',
        'integrity-check',
      ])
    } finally {
      await worker.close()
    }
  })

  it('閉じたあとは呼んだスレッドで行う（ワーカーを起こし直さない）', async () => {
    const good = makeDb('good.sqlite', 10)
    const worker = createSyncWorker({ workerPath })
    await worker.close()
    expect(await worker.run({ kind: 'integrity-check', dbPath: good })).toEqual(
      { done: false }
    )
    expect(await checkIntegrity(good, worker)).toBe('ok')
  })

  it('forceMainThread ならワーカーを使わない', async () => {
    const fake = fakeWorker('unused-worker.js', `{ ok: true, value: 'ok' }`)
    const worker = createSyncWorker({
      workerPath: fake.path,
      forceMainThread: true,
    })
    try {
      expect(
        await worker.run({ kind: 'integrity-check', dbPath: 'x' })
      ).toEqual({ done: false })
      expect(linesOf(fake.log)).toEqual([])
    } finally {
      await worker.close()
    }
  })

  it('閉じなくても、答えを待ち終えたらプロセスは終われる（待っている間は終わらない）', () => {
    const good = makeDb('good.sqlite', 2000)
    const script = `
      const { createSyncWorker } = require(${JSON.stringify(join(build, 'worker-host.js'))})
      const worker = createSyncWorker({ workerPath: ${JSON.stringify(workerPath)} })
      const task = { kind: 'integrity-check', dbPath: ${JSON.stringify(good)} }
      // 2件目は、1件目の答えでワーカーを手放した（unref）あとに頼む
      worker.run(task)
        .then(() => worker.run(task))
        .then((outcome) => console.log(JSON.stringify(outcome)))
    `
    // 終われなければ timeout で例外になる
    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 20000,
    })
    expect(JSON.parse(output.trim())).toEqual({ done: true, value: 'ok' })
  }, 30000)
})

describe('openRemoteDbViaLocalCopy —— 呼んだスレッドを止めない', () => {
  it('写しと検査のあいだにイベントループが回る', async () => {
    const src = makeDb('peer.sqlite', 60000)
    const worker = createSyncWorker({ workerPath })
    let ticks = 0
    let running = true
    const spin = (): void => {
      if (!running) return
      ticks += 1
      setImmediate(spin)
    }
    try {
      setImmediate(spin)
      const handle = await openRemoteDbViaLocalCopy(src, tmpDir, worker)
      running = false
      expect(handle).not.toBeNull()
      handle!.cleanup()
      // 同期で写して検査していたころは、終わるまで1度も回らなかった
      expect(ticks).toBeGreaterThan(1)
    } finally {
      running = false
      await worker.close()
    }
  })

  it('開いた写しはロックを持ち続ける（文ごとにロックを出し入れしない）', async () => {
    const src = makeDb('peer.sqlite', 10)
    const handle = await openRemoteDbViaLocalCopy(src, tmpDir)
    try {
      expect(handle).not.toBeNull()
      expect(handle!.db.pragma('locking_mode', { simple: true })).toBe(
        'exclusive'
      )
    } finally {
      handle?.cleanup()
    }
    // 閉じたあとは一時ファイルを消せている（ロックが残っていない）
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.startsWith('remote-'))
    ).toEqual([])
  })

  it('壊れた写しは、ワーカーで検査しても null を返して一時ファイルを残さない', async () => {
    const bad = makeDb('bad.sqlite', 2000)
    corruptIndex(bad)
    const worker = createSyncWorker({ workerPath })
    try {
      expect(await openRemoteDbViaLocalCopy(bad, tmpDir, worker)).toBeNull()
      expect(
        fs.readdirSync(tmpDir).filter((f) => f.startsWith('remote-'))
      ).toEqual([])
    } finally {
      await worker.close()
    }
  })
})
