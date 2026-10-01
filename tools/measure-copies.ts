/**
 * 1回の同期で「ファイルを丸ごと写した回数」を数える（無駄な転送の抑制の前後比較）。
 *
 * {@link module:tools/measure-idle} と違って、**新しい API を一切使わない**。
 * 手元へ写した写しを開いた回数（写しを開くたびに1回呼ばれる `pragma('query_only = ON')`）と、
 * 同期のたびに NAS 上の自分の写しが置き換わったか（inode と更新時刻）を数えるだけなので、
 * 抑制を入れる**前**の版でもそのまま走る。
 * これで「1回の同期で相手を2回写していた」を実測で比べられる。
 *
 * 使い方: `tsc -p tools/tsconfig.json && node node_modules/.cache/explore/tools/measure-copies.js`
 *
 * @module tools/measure-copies
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'

const ROUNDS = 10
const CLIENTS = ['a', 'b', 'c']

const counter = { copies: 0, copiedBytes: 0, uploads: 0, uploadedBytes: 0 }

// 手元へ写した回数は、**写したものを開いた回数**で数える。
// `openRemoteDbViaLocalCopy` は写した直後に必ず `pragma('query_only = ON')` を
// 呼ぶので、そこを1つ数える（`fs` の属性は Node 24 では差し替えられない）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbProto = (Database as any).prototype as {
  pragma: (source: string, options?: unknown) => unknown
  name: string
}
const realPragma = dbProto.pragma
dbProto.pragma = function patched(
  this: { name: string },
  source: string,
  options?: unknown
): unknown {
  if (source === 'query_only = ON' && /remote-.*\.sqlite$/.test(this.name)) {
    counter.copies += 1
    try {
      counter.copiedBytes += fs.statSync(this.name).size
    } catch {
      /* 数えられなくても続ける */
    }
  }
  return realPragma.call(this, source, options)
}

/** NAS 上の写しの素性。置き換わると inode か更新時刻が変わる。 */
function stampOf(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    return `${String(stat.ino)}:${String(stat.mtimeMs)}`
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-copies-'))
  process.env.TMPDIR = path.join(root, 'tmp')
  fs.mkdirSync(process.env.TMPDIR, { recursive: true })
  const nasPath = path.join(root, 'nas')
  fs.mkdirSync(nasPath, { recursive: true })
  try {
    const instances = CLIENTS.map((id) => {
      const dbPath = path.join(root, `client-${id}.sqlite`)
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE notes (
          id        TEXT PRIMARY KEY NOT NULL,
          body      TEXT,
          updatedAt TEXT NOT NULL
        )
      `)
      db.prepare(
        `INSERT INTO notes (id, body, updatedAt) VALUES (?, ?, ?)`
      ).run(`n-${id}`, `from ${id}`, '2026-09-01T00:00:00.000Z')
      db.close()
      return setupSync({
        dbPath,
        nasPath,
        clientId: id,
        schemaVersion: 'measure-1',
        // 抑制を入れる**前**の版でも走らせたいので、既定では触らない。
        // `SNS_SUPPRESS=0` で切ると「1回の写しにしただけ」の効きが測れる
        ...(process.env.SNS_SUPPRESS === undefined
          ? {}
          : { suppressIdleSync: process.env.SNS_SUPPRESS !== '0' }),
      })
    })

    // 行き渡らせる（ここは数えない）
    for (let round = 0; round < 4; round += 1) {
      for (const instance of instances) await instance.syncNow()
    }

    counter.copies = 0
    counter.copiedBytes = 0
    counter.uploads = 0
    counter.uploadedBytes = 0
    const started = process.hrtime.bigint()
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const [index, instance] of instances.entries()) {
        const own = path.join(nasPath, `client-${CLIENTS[index]}.sqlite`)
        const before = stampOf(own)
        await instance.syncNow()
        if (stampOf(own) !== before) {
          counter.uploads += 1
          counter.uploadedBytes += fs.statSync(own).size
        }
      }
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const syncs = ROUNDS * CLIENTS.length
    const mb = (counter.copiedBytes + counter.uploadedBytes) / 1024 / 1024
    // eslint-disable-next-line no-console
    console.log(
      `\n変更なしの同期 ${String(syncs)} 回（3端末・${String(ROUNDS)} 巡）\n` +
        `  手元へ写した回数: ${String(counter.copies)}（1回あたり ${(counter.copies / syncs).toFixed(2)}）\n` +
        `  NAS へ上げた回数: ${String(counter.uploads)}（1回あたり ${(counter.uploads / syncs).toFixed(2)}）\n` +
        `  転送量の合計: ${mb.toFixed(1)} MB\n` +
        `  所要時間: ${ms.toFixed(0)} ms`
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main()
