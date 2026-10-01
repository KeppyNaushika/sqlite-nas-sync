/**
 * NAS の写しを1つ作るときの、時間・スレッドが続けて止まる最長・手元の一時領域の最大を測る。
 *
 * 測るのは `copyToNas` だけで、取り込みと作り直しは含めない。
 * DB は3種類で、初回に作業ディレクトリへ作り、以後は使い回す。
 *
 * | DB | 中身 |
 * | --- | --- |
 * | `rows-100mb` / `rows-500mb` | 同期する表1つに、本文 600 バイトの行を DB がその大きさになるまで入れる |
 * | `tables-200` | 列10個の同期する表200個に、20行ずつ入れる。トリガーの SQL が大きい |
 *
 * - 止まる最長は `perf_hooks.monitorEventLoopDelay` の最大値である
 * - 一時領域は、別のスレッドが `os.tmpdir()/sqlite-nas-sync` の大きさを 10 ms ごとに見た最大値である
 *
 * 使い方: `tsc -p tools/tsconfig.json && node node_modules/.cache/explore/tools/measure-publish.js <作業ディレクトリ>`
 *
 * @module tools/measure-publish
 */
import * as fs from 'fs'
import * as path from 'path'
import { monitorEventLoopDelay } from 'perf_hooks'
import { Worker } from 'worker_threads'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { copyToNas } from '../src/nas'

const BODY = 'x'.repeat(600)
const AT = '2026-09-01T00:00:00.000Z'

interface Case {
  name: string
  runs: number
  create: (dbPath: string, nasPath: string) => void
  tables: string[]
}

const CASES: Case[] = [
  rowsCase('rows-100mb', 100, 5),
  rowsCase('rows-500mb', 500, 3),
  {
    name: 'tables-200',
    runs: 10,
    tables: tableNames(),
    create: (dbPath, nasPath) => {
      const db = new Database(dbPath)
      const columns = Array.from(
        { length: 7 },
        (_, index) => `c${String(index)} TEXT`
      ).join(', ')
      for (const table of tableNames()) {
        db.exec(
          `CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, ${columns}, body TEXT, updatedAt TEXT NOT NULL)`
        )
      }
      db.close()
      setupSync({ dbPath, nasPath, clientId: 'm', schemaVersion: '1' })
      const app = new Database(dbPath)
      app.transaction(() => {
        for (const table of tableNames()) {
          const insert = app.prepare(
            `INSERT INTO ${table} (id, body, updatedAt) VALUES (?, ?, ?)`
          )
          for (let row = 0; row < 20; row += 1) {
            insert.run(`r${String(row)}`, BODY, AT)
          }
        }
      })()
      app.pragma('wal_checkpoint(TRUNCATE)')
      app.close()
    },
  },
]

function tableNames(): string[] {
  return Array.from(
    { length: 200 },
    (_, index) => `t${String(index).padStart(3, '0')}`
  )
}

function rowsCase(name: string, megabytes: number, runs: number): Case {
  return {
    name,
    runs,
    tables: ['notes'],
    create: (dbPath, nasPath) => {
      const db = new Database(dbPath)
      db.exec(
        `CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT, updatedAt TEXT NOT NULL)`
      )
      db.close()
      setupSync({ dbPath, nasPath, clientId: 'm', schemaVersion: '1' })
      const app = new Database(dbPath)
      const insert = app.prepare(
        `INSERT INTO notes (id, body, updatedAt) VALUES (?, ?, ?)`
      )
      let next = 0
      const target = megabytes * 1024 * 1024
      while (fileBytes(dbPath) < target) {
        app.transaction(() => {
          for (let row = 0; row < 10_000; row += 1) {
            insert.run(`n${String(next)}`, BODY, AT)
            next += 1
          }
        })()
        app.pragma('wal_checkpoint(TRUNCATE)')
      }
      app.close()
    },
  }
}

function fileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

/** 一時領域の大きさを別のスレッドで見張る。`stop()` が最大値を返す。 */
function watchDirectory(dir: string): { stop: () => Promise<number> } {
  const flag = new Int32Array(new SharedArrayBuffer(4))
  const worker = new Worker(
    `
    const fs = require('fs')
    const path = require('path')
    const { workerData, parentPort } = require('worker_threads')
    const { dir, flag } = workerData
    const pause = new Int32Array(new SharedArrayBuffer(4))
    let peak = 0
    while (Atomics.load(flag, 0) === 0) {
      let total = 0
      let names = []
      try { names = fs.readdirSync(dir) } catch {}
      for (const name of names) {
        try { total += fs.statSync(path.join(dir, name)).size } catch {}
      }
      if (total > peak) peak = total
      Atomics.wait(pause, 0, 0, 10)
    }
    parentPort.postMessage(peak)
    `,
    { eval: true, workerData: { dir, flag } }
  )
  const done = new Promise<number>((resolve) =>
    worker.once('message', (peak: number) => resolve(peak))
  )
  return {
    stop: async () => {
      Atomics.store(flag, 0, 1)
      const peak = await done
      await worker.terminate()
      return peak
    },
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure(work: string, entry: Case): Promise<void> {
  const dir = path.join(work, entry.name)
  const dbPath = path.join(dir, 'local.sqlite')
  if (!fs.existsSync(path.join(dir, 'ready'))) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    entry.create(dbPath, path.join(dir, 'setup-nas'))
    fs.writeFileSync(path.join(dir, 'ready'), '')
  }
  const nasPath = path.join(dir, 'nas')
  const tmpDir = path.join(work, 'tmp')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  process.env.TMPDIR = tmpDir

  const db = new Database(dbPath)
  db.prepare(`SELECT COUNT(*) FROM sqlite_master`).get()
  const triggerBytes = (
    db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(sql)), 0) AS n FROM sqlite_master WHERE type = 'trigger'`
      )
      .get() as { n: number }
  ).n
  const times: number[] = []
  let block = 0
  let peak = 0
  for (let run = 0; run < entry.runs; run += 1) {
    const histogram = monitorEventLoopDelay({ resolution: 1 })
    const watcher = watchDirectory(path.join(tmpDir, 'sqlite-nas-sync'))
    histogram.enable()
    const started = process.hrtime.bigint()
    await copyToNas(db, nasPath, 'm', entry.tables)
    times.push(Number(process.hrtime.bigint() - started) / 1e6)
    // 止まった時間は、止まったあとに最初に動いたタイマーが記録する。すぐに止めると、
    // `copyToNas` の最後の区切りが記録されない
    await new Promise((resolve) => setTimeout(resolve, 5))
    histogram.disable()
    block = Math.max(block, histogram.max / 1e6)
    peak = Math.max(peak, await watcher.stop())
  }
  db.close()
  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2)
  // eslint-disable-next-line no-console
  console.log(
    `${entry.name}: DB ${mb(fileBytes(dbPath))} MB（トリガーの SQL ${mb(triggerBytes)} MB）、` +
      `写し ${mb(fileBytes(path.join(nasPath, 'client-m.sqlite')))} MB、` +
      `時間の中央値 ${median(times).toFixed(0)} ms（${times.map((t) => t.toFixed(0)).join(' / ')}）、` +
      `続けて止まる最長 ${block.toFixed(1)} ms、一時領域の最大 ${mb(peak)} MB`
  )
}

async function main(): Promise<void> {
  const work = process.argv[2]
  if (work === undefined) {
    throw new Error('作業ディレクトリを渡す')
  }
  const only = process.argv[3]
  for (const entry of CASES) {
    if (only !== undefined && entry.name !== only) continue
    await measure(path.resolve(work), entry)
  }
}

void main()
