#!/usr/bin/env node
/**
 * NAS の同期ディレクトリで、同期が行うファイル操作の時間を測る。
 *
 * 測るもの:
 *   1. ディレクトリの一覧と `stat` の時間
 *   2. 各端末の写し `client-*.sqlite` を手元の一時ディレクトリへコピーする時間
 *   3. 手元へコピーした写しの `PRAGMA integrity_check` の時間
 *   4. NAS へ書く時間。大きさを変えた `write` + `fsync`、`copyFileSync`、
 *      better-sqlite3 の `backup()`、それぞれのあとの `rename` と `unlink`
 *   5. 小さいファイルの作成・`stat`・削除の時間
 *
 * NAS 上の `client-*.sqlite` は読むだけで、SQLite で直接開かない。
 * NAS へ書くのは `sns-measure-` で始まる名前のファイルだけで、終わったら消す。
 * 結果は標準出力と、ホームディレクトリの `sns-measure-<日時>.json` に書く。
 * 結果に含めるのはファイル名・大きさ・時間だけで、DB の中身は含めない。
 *
 * 使い方:
 *   node tools/measure-nas-io.cjs <同期ディレクトリ> [--repeat N] [--no-write]
 *
 * Node.js の無い端末では、better-sqlite3 を同梱した Electron アプリの実行ファイルを
 * Node.js として動かす。better-sqlite3 はアプリの resources から探す。
 *   Windows (PowerShell):
 *     $env:ELECTRON_RUN_AS_NODE=1; & "<アプリ>.exe" measure-nas-io.cjs "<同期ディレクトリ>"
 *   macOS:
 *     ELECTRON_RUN_AS_NODE=1 "<アプリ>.app/Contents/MacOS/<実行ファイル>" \
 *       measure-nas-io.cjs "<同期ディレクトリ>"
 *
 * 測っている間は、この端末のアプリを閉じておく。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const PREFIX = 'sns-measure-'
const CLIENT_FILE = /^client-(.+)\.sqlite$/

function parseArgs(argv) {
  const args = { dir: null, repeat: 3, write: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repeat') args.repeat = Number(argv[++i])
    else if (arg === '--no-write') args.write = false
    else if (args.dir === null) args.dir = arg
    else throw new Error(`不明な引数: ${arg}`)
  }
  if (args.dir === null) {
    throw new Error(
      '使い方: measure-nas-io.cjs <同期ディレクトリ> [--repeat N] [--no-write]'
    )
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1) {
    throw new Error('--repeat には1以上の整数を渡す')
  }
  return args
}

/** better-sqlite3 を、通常の解決、Electron アプリの resources の順に探す。 */
function loadSqlite() {
  const exeDir = path.dirname(process.execPath)
  const resourceDirs = [
    process.resourcesPath,
    path.join(exeDir, 'resources'),
    path.join(exeDir, '..', 'Resources'),
  ].filter((dir) => typeof dir === 'string')
  const candidates = ['better-sqlite3']
  for (const dir of resourceDirs) {
    candidates.push(
      path.join(dir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')
    )
    candidates.push(path.join(dir, 'node_modules', 'better-sqlite3'))
  }
  const errors = []
  for (const candidate of candidates) {
    try {
      return { Database: require(candidate), from: candidate }
    } catch (error) {
      errors.push(`${candidate}: ${error.message.split('\n')[0]}`)
    }
  }
  return { Database: null, from: null, errors }
}

function now() {
  return process.hrtime.bigint()
}

function msSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e6
}

/** 同期的な処理の時間をミリ秒で返す。 */
function time(fn) {
  const start = now()
  const value = fn()
  return { ms: msSince(start), value }
}

async function timeAsync(fn) {
  const start = now()
  const value = await fn()
  return { ms: msSince(start), value }
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(sorted[Math.floor((sorted.length - 1) / 2)]),
    max: round(sorted[sorted.length - 1]),
    total: round(sum),
  }
}

function round(value) {
  return Math.round(value * 10) / 10
}

function mib(bytes) {
  return round(bytes / 1024 / 1024)
}

function mibPerSec(bytes, ms) {
  return ms > 0 ? round(bytes / 1024 / 1024 / (ms / 1000)) : null
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file)
  } catch {
    // 無ければよい
  }
}

/** `write` + `fsync` で、指定の大きさのファイルを書く。 */
function writeWithFsync(file, buffer) {
  const fd = fs.openSync(file, 'w')
  try {
    let offset = 0
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const syncDir = path.resolve(args.dir)
  if (!fs.statSync(syncDir).isDirectory()) {
    throw new Error(`ディレクトリではない: ${syncDir}`)
  }
  const sqlite = loadSqlite()
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  const tag = `${PREFIX}${process.pid}-${Date.now()}`
  const written = []
  const result = {
    startedAt: new Date().toISOString(),
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
    },
    syncDir,
    localDir,
    repeat: args.repeat,
    sqlite: sqlite.from ?? `読み込めない: ${sqlite.errors.join(' / ')}`,
  }
  const log = (line) => console.log(line)

  try {
    // 1. 一覧と stat
    const listings = []
    let names = []
    for (let i = 0; i < Math.max(args.repeat, 5); i++) {
      const r = time(() => fs.readdirSync(syncDir))
      listings.push(r.ms)
      names = r.value
    }
    const clients = names
      .filter((name) => CLIENT_FILE.test(name))
      .map((name) => {
        const file = path.join(syncDir, name)
        const r = time(() => fs.statSync(file))
        return {
          name,
          bytes: r.value.size,
          mtime: r.value.mtime.toISOString(),
          mtimeMs: r.value.mtimeMs,
          ino: String(r.value.ino),
          statMs: round(r.ms),
        }
      })
    result.listing = {
      entries: names.length,
      readdirMs: summarize(listings),
      otherEntries: names.filter((name) => !CLIENT_FILE.test(name)),
    }
    result.clients = clients
    log(`同期ディレクトリ: ${syncDir}`)
    log(`better-sqlite3: ${result.sqlite}`)
    log(
      `readdir: 中央値 ${result.listing.readdirMs.median} ms、client-*.sqlite ${clients.length} 個`
    )
    log(
      `inode: ${clients.every((c) => c.ino !== '0') ? 'すべて 0 でない' : '0 のファイルがある'}（${clients.map((c) => c.ino).join(', ')}）`
    )
    if (clients.length === 0) throw new Error('client-*.sqlite が無い')

    // 2. NAS から手元へのコピー
    const reads = clients.map(() => [])
    for (let rep = 0; rep < args.repeat; rep++) {
      clients.forEach((client, index) => {
        const dest = path.join(localDir, `${rep}-${client.name}`)
        const r = time(() =>
          fs.copyFileSync(path.join(syncDir, client.name), dest)
        )
        reads[index].push(r.ms)
        if (rep > 0) removeQuietly(dest)
      })
    }
    clients.forEach((client, index) => {
      client.copyToLocalMs = summarize(reads[index])
      client.copyToLocalMiBps = mibPerSec(
        client.bytes,
        client.copyToLocalMs.median
      )
    })
    const readRounds = []
    for (let rep = 0; rep < args.repeat; rep++) {
      readRounds.push(reads.reduce((sum, list) => sum + list[rep], 0))
    }
    result.readAllClients = {
      bytes: clients.reduce((sum, c) => sum + c.bytes, 0),
      msPerRound: summarize(readRounds),
    }
    log('')
    log('NAS → 手元のコピー（1ファイル、中央値）')
    for (const c of clients) {
      log(
        `  ${c.name}  ${mib(c.bytes)} MiB  ${c.copyToLocalMs.median} ms  ${c.copyToLocalMiBps} MiB/s`
      )
    }
    log(
      `  全 ${clients.length} 個を1回ずつ: 中央値 ${result.readAllClients.msPerRound.median} ms（${mib(result.readAllClients.bytes)} MiB）`
    )

    // 3. 手元の写しの integrity_check
    if (sqlite.Database !== null) {
      log('')
      log('手元の写しの integrity_check')
      for (const client of clients) {
        const local = path.join(localDir, `0-${client.name}`)
        const r = time(() => {
          const db = new sqlite.Database(local, { readonly: true })
          try {
            return db.pragma('integrity_check', { simple: true })
          } finally {
            db.close()
          }
        })
        client.integrityCheckMs = round(r.ms)
        client.integrity = r.value
        log(`  ${client.name}  ${client.integrityCheckMs} ms  ${r.value}`)
      }
    }

    // 4. NAS への書き込み
    if (args.write) {
      const largest = clients.reduce((a, b) => (a.bytes >= b.bytes ? a : b))
      const source = path.join(localDir, `0-${largest.name}`)
      const sizes = [1024 * 1024, Math.ceil(largest.bytes / 3), largest.bytes]
      const content = fs.readFileSync(source)
      result.writes = []
      log('')
      log(`NAS への書き込み（元: ${largest.name}、${mib(largest.bytes)} MiB）`)

      const measureWrite = async (label, bytes, write) => {
        const writeMs = []
        const renameMs = []
        const unlinkMs = []
        const inodes = []
        for (let rep = 0; rep < args.repeat; rep++) {
          const tmp = path.join(syncDir, `${tag}-${rep}.sqlite.tmp`)
          const dest = path.join(syncDir, `${tag}-${rep}.sqlite`)
          written.push(tmp, dest, `${tmp}-journal`)
          writeMs.push((await timeAsync(() => write(tmp))).ms)
          const before = fs.statSync(tmp)
          renameMs.push(time(() => fs.renameSync(tmp, dest)).ms)
          const after = fs.statSync(dest)
          inodes.push({
            beforeRename: String(before.ino),
            afterRename: String(after.ino),
            mtimeMs: after.mtimeMs,
          })
          unlinkMs.push(time(() => fs.unlinkSync(dest)).ms)
        }
        const entry = {
          label,
          bytes,
          writeMs: summarize(writeMs),
          renameMs: summarize(renameMs),
          unlinkMs: summarize(unlinkMs),
          inodes,
        }
        entry.writeMiBps = mibPerSec(bytes, entry.writeMs.median)
        result.writes.push(entry)
        log(
          `  ${label.padEnd(28)} ${String(mib(bytes)).padStart(6)} MiB  書く ${entry.writeMs.median} ms（${entry.writeMiBps} MiB/s）  rename ${entry.renameMs.median} ms  unlink ${entry.unlinkMs.median} ms`
        )
      }

      for (const bytes of sizes) {
        const buffer = content.subarray(0, Math.min(bytes, content.length))
        await measureWrite(`write+fsync`, buffer.length, (file) =>
          writeWithFsync(file, buffer)
        )
      }
      await measureWrite('copyFileSync', largest.bytes, (file) =>
        fs.copyFileSync(source, file)
      )
      if (sqlite.Database !== null) {
        const db = new sqlite.Database(source, { readonly: true })
        try {
          await measureWrite('better-sqlite3 backup()', largest.bytes, (file) =>
            db.backup(file)
          )
        } finally {
          db.close()
        }
      }
    }

    // 5. 小さいファイルの作成・stat・削除
    if (args.write) {
      const create = []
      const stat = []
      const remove = []
      for (let i = 0; i < 20; i++) {
        const file = path.join(syncDir, `${tag}-small-${i}`)
        written.push(file)
        create.push(time(() => fs.writeFileSync(file, 'x')).ms)
        stat.push(time(() => fs.statSync(file)).ms)
        remove.push(time(() => fs.unlinkSync(file)).ms)
      }
      result.smallFiles = {
        createMs: summarize(create),
        statMs: summarize(stat),
        unlinkMs: summarize(remove),
      }
      log('')
      log(
        `小さいファイル 20 個: 作成 ${result.smallFiles.createMs.median} ms、stat ${result.smallFiles.statMs.median} ms、削除 ${result.smallFiles.unlinkMs.median} ms（いずれも中央値）`
      )
    }
  } finally {
    for (const file of written) removeQuietly(file)
    fs.rmSync(localDir, { recursive: true, force: true })
    result.finishedAt = new Date().toISOString()
    const stamp = result.startedAt.replace(/[:.]/g, '-')
    const out = path.join(os.homedir(), `${PREFIX}${stamp}.json`)
    fs.writeFileSync(out, JSON.stringify(result, null, 2))
    console.log('')
    console.log(`結果: ${out}`)
  }
}

main().catch((error) => {
  console.error(`失敗: ${error.message}`)
  process.exitCode = 1
})
