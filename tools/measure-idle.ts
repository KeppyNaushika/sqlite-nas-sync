/**
 * 無駄な転送の抑制を**測る**。
 *
 * 3端末・共有の NAS ディレクトリを一時領域に作り、
 *
 * 1. 数行を書いて、行き渡るまで同期する（準備）
 * 2. **何も変えずに** N 回ずつ同期する（測定）
 *
 * を `suppressIdleSync` の入り切りで行い、コピーの回数・転送量・所要時間を比べる。
 * 最後に、両方の端末の中身が一致していることも確かめる（抑制しても収束は変わらない）。
 *
 * 使い方: `tsc -p tools/tsconfig.json && node node_modules/.cache/explore/tools/measure-idle.js`
 *
 * @module tools/measure-idle
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import type { SyncInstance, SyncTransfers } from '../src/types'

const ROUNDS = 20
const CLIENTS = ['a', 'b', 'c']

type Totals = SyncTransfers & { ms: number }

function emptyTotals(): Totals {
  return {
    uploads: 0,
    uploadsSkipped: 0,
    peerReads: 0,
    peerReadsSkipped: 0,
    selfReads: 0,
    bytes: 0,
    ms: 0,
  }
}

function add(total: Totals, transfers: SyncTransfers | undefined): void {
  if (transfers === undefined) return
  total.uploads += transfers.uploads
  total.uploadsSkipped += transfers.uploadsSkipped
  total.peerReads += transfers.peerReads
  total.peerReadsSkipped += transfers.peerReadsSkipped
  total.selfReads += transfers.selfReads
  total.bytes += transfers.bytes
}

function makeDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE notes (
      id        TEXT PRIMARY KEY NOT NULL,
      body      TEXT,
      updatedAt TEXT NOT NULL
    )
  `)
  db.close()
}

async function measure(
  root: string,
  suppress: boolean
): Promise<{ totals: Totals; digests: string[] }> {
  const dir = path.join(root, suppress ? 'on' : 'off')
  const nasPath = path.join(dir, 'nas')
  fs.mkdirSync(nasPath, { recursive: true })

  const instances: SyncInstance[] = []
  const paths: string[] = []
  for (const id of CLIENTS) {
    const dbPath = path.join(dir, `client-${id}.sqlite`)
    paths.push(dbPath)
    makeDb(dbPath)
    instances.push(
      setupSync({
        dbPath,
        nasPath,
        clientId: id,
        schemaVersion: 'measure-1',
        suppressIdleSync: suppress,
      })
    )
  }

  // 準備: 端末ごとに1行書いて、行き渡るまで回す
  CLIENTS.forEach((id, index) => {
    const db = new Database(paths[index])
    db.prepare(`INSERT INTO notes (id, body, updatedAt) VALUES (?, ?, ?)`).run(
      `n-${id}`,
      `from ${id}`,
      '2026-09-01T00:00:00.000Z'
    )
    db.close()
  })
  for (let round = 0; round < 4; round += 1) {
    for (const instance of instances) await instance.syncNow()
  }

  // 測定: 何も変えずに ROUNDS 回
  const totals = emptyTotals()
  const started = process.hrtime.bigint()
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const instance of instances) {
      const result = await instance.syncNow()
      add(totals, result.transfers)
    }
  }
  totals.ms = Number(process.hrtime.bigint() - started) / 1e6

  const digests = paths.map((dbPath) => {
    const db = new Database(dbPath, { readonly: true })
    const rows = db
      .prepare(`SELECT id, body, updatedAt FROM notes ORDER BY id`)
      .all()
    db.close()
    return JSON.stringify(rows)
  })
  return { totals, digests }
}

function show(name: string, totals: Totals): void {
  const mb = (totals.bytes / 1024 / 1024).toFixed(1)
  // eslint-disable-next-line no-console
  console.log(
    `${name}: 上げ ${String(totals.uploads)}（省いた ${String(totals.uploadsSkipped)}）` +
      ` / 相手を写した ${String(totals.peerReads)}（省いた ${String(totals.peerReadsSkipped)}）` +
      ` / 自分を写した ${String(totals.selfReads)}` +
      ` / 転送 ${mb} MB / ${totals.ms.toFixed(0)} ms`
  )
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-measure-'))
  // 一時コピーもこの下に閉じ込める（終わったら丸ごと消す）
  process.env.TMPDIR = path.join(root, 'tmp')
  fs.mkdirSync(process.env.TMPDIR, { recursive: true })
  try {
    const off = await measure(root, false)
    const on = await measure(root, true)
    // eslint-disable-next-line no-console
    console.log(
      `\n${String(CLIENTS.length)}端末・変更なしで ${String(ROUNDS)} 巡（同期 ${String(
        ROUNDS * CLIENTS.length
      )} 回）`
    )
    show('抑制なし', off.totals)
    show('抑制あり', on.totals)
    const same = JSON.stringify(off.digests) === JSON.stringify(on.digests)
    // eslint-disable-next-line no-console
    console.log(`中身の一致: ${same ? 'はい' : 'いいえ'}`)
    if (!same) process.exitCode = 1
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main()
