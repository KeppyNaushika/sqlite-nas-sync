/**
 * 相手の写しの段取り（`src/sync/rows-sync.ts` の `openPeerCopies`）。
 *
 * 見るのは3つ:
 *
 * 1. NAS から読むのはいつも1つずつ（同時に何本も読まない）
 * 2. ある相手の整合性検査を待っている間に、次の相手を写す（写しと検査が重なる）
 * 3. 途中で止めても、写しかけ・検査待ちの写しを残さない
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { openPeerCopies } from '../src/sync/rows-sync'
import {
  SyncWorker,
  WorkerAnswers,
  WorkerOutcome,
  WorkerTask,
} from '../src/worker-host'

const testDir = path.join(__dirname, 'test-data-peer-copies')
const nasDir = path.join(testDir, 'nas')
const isolatedTmp = path.join(testDir, 'tmp')
let savedTmpDir: string | undefined

/** 写しの出入り。`fs.promises.copyFile` を数える。 */
const copies = { started: [] as string[], inFlight: 0, maxInFlight: 0 }
const realCopyFile = fs.promises.copyFile
fs.promises.copyFile = async function counted(
  source: fs.PathLike,
  destination: fs.PathLike,
  mode?: number
): Promise<void> {
  copies.started.push(path.basename(String(source)))
  copies.inFlight += 1
  copies.maxInFlight = Math.max(copies.maxInFlight, copies.inFlight)
  try {
    // 写しに時間がかかる NAS を模す（同時に走っていれば、ここで重なる）
    await new Promise((resolve) => setTimeout(resolve, 5))
    await realCopyFile(source, destination, mode)
  } finally {
    copies.inFlight -= 1
  }
}

/**
 * 検査を手で進める偽のワーカー。届いた検査を `checks` に積み、`release` で答える。
 * 答えは `{ done: false }`（呼んだスレッドで検査し直す）にして、検査そのものは本物にする。
 */
function manualWorker(): SyncWorker & {
  checks: string[]
  release: () => void
} {
  const waiting: (() => void)[] = []
  const checks: string[] = []
  return {
    checks,
    release: () => {
      for (const resolve of waiting.splice(0)) resolve()
    },
    run<K extends WorkerTask['kind']>(
      task: Extract<WorkerTask, { kind: K }>
    ): Promise<WorkerOutcome<WorkerAnswers[K]>> {
      checks.push(task.dbPath)
      return new Promise((resolve) => {
        waiting.push(() => resolve({ done: false }))
      })
    },
    endSync: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
}

/** NAS 上に相手の写しを置く。 */
function peerCopy(name: string): string {
  const file = path.join(nasDir, name)
  const db = new Database(file)
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)
  db.prepare(`INSERT INTO t VALUES (?)`).run(name)
  db.close()
  return file
}

/** 条件が立つまで待つ（イベントループを回しながら）。 */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(condition()).toBe(true)
}

/** 手元に残っている写しの一時ファイル。 */
function leftovers(): string[] {
  const dir = path.join(isolatedTmp, 'sqlite-nas-sync')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.startsWith('remote-'))
}

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(nasDir, { recursive: true })
  fs.mkdirSync(isolatedTmp, { recursive: true })
  // 一時コピーをこの試験の中に閉じ込める（`os.tmpdir()` は毎回 TMPDIR を見る）
  savedTmpDir = process.env.TMPDIR
  process.env.TMPDIR = isolatedTmp
  copies.started = []
  copies.inFlight = 0
  copies.maxInFlight = 0
})

afterEach(() => {
  if (savedTmpDir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = savedTmpDir
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('openPeerCopies', () => {
  it('1人ずつ順に写し、検査を待つ間に次を写す。開いた手は渡した並びで返る', async () => {
    const files = ['a.sqlite', 'b.sqlite', 'c.sqlite'].map(peerCopy)
    const worker = manualWorker()
    const opening = openPeerCopies([files[0], null, files[1], files[2]], worker)

    // a の検査が届いた時点で、b はもう写し始めている
    await until(() => worker.checks.length >= 1)
    await until(() => copies.started.length >= 2)
    expect(copies.started.slice(0, 2)).toEqual(['a.sqlite', 'b.sqlite'])
    // 検査を待たせたままでも、写しは最後まで進む
    await until(() => worker.checks.length === 3)
    expect(copies.started).toEqual(['a.sqlite', 'b.sqlite', 'c.sqlite'])
    expect(copies.maxInFlight).toBe(1)

    worker.release()
    const handles = await Promise.all(opening.handles)
    try {
      expect(handles[1]).toBeNull()
      expect(
        handles.map((handle) =>
          handle === null
            ? null
            : handle.db.prepare(`SELECT id FROM t`).pluck().get()
        )
      ).toEqual(['a.sqlite', null, 'b.sqlite', 'c.sqlite'])
    } finally {
      for (const handle of handles) handle?.cleanup()
    }
    expect(leftovers()).toEqual([])
  })

  it('止めたら、まだ写し始めていない相手は写さず、写しかけの写しも残さない', async () => {
    const files = ['a.sqlite', 'b.sqlite', 'c.sqlite'].map(peerCopy)
    const worker = manualWorker()
    const opening = openPeerCopies(files, worker)
    await until(() => copies.started.length >= 1)
    opening.stop()
    worker.release()
    // 待っている間に届いた検査にも答える
    const releasing = setInterval(() => worker.release(), 1)
    try {
      const handles = await Promise.all(opening.handles)
      for (const handle of handles) handle?.cleanup()
      // 止める前に写し始めていたものだけが写る
      expect(copies.started).toEqual(['a.sqlite'])
      expect(handles.filter((handle) => handle !== null)).toHaveLength(1)
    } finally {
      clearInterval(releasing)
    }
    expect(leftovers()).toEqual([])
  })

  it('写せない相手は null にして、続く相手は写す', async () => {
    const good = peerCopy('good.sqlite')
    const worker = manualWorker()
    const releasing = setInterval(() => worker.release(), 1)
    try {
      const opening = openPeerCopies(
        [path.join(nasDir, 'missing.sqlite'), good],
        worker
      )
      const handles = await Promise.all(opening.handles)
      for (const handle of handles) handle?.cleanup()
      expect(handles[0]).toBeNull()
      expect(handles[1]).not.toBeNull()
    } finally {
      clearInterval(releasing)
    }
    expect(leftovers()).toEqual([])
  })
})
