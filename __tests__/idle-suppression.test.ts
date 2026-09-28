/**
 * 無駄な転送の抑制（`src/sync/idle.ts`）。
 *
 * 見るのは4つ:
 *
 * 1. 1回の同期で、相手の写しを手元へ写すのは**相手1人につき1回だけ**
 * 2. 変わっていなければ、上げない・写さない
 * 3. 変われば、上げる・写す（起動直後・版の変化・相手の書き直し）
 * 4. 抑制しても**最終的な収束は変わらない**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupSync } from '../src/index'
import { SyncConfig, SyncInstance, SyncTransfers } from '../src/types'
import { FORCE_EVERY } from '../src/sync/idle'
import { performSync } from '../src/sync'
import { createRebuildState } from '../src/rows/rebuild'

/** 手元へ写した回数を数える（写した直後の `query_only = ON` を数える）。 */
const copyCounter = { copies: 0 }
type PragmaHost = { name: string }
const dbProto = Database.prototype as unknown as {
  pragma: (source: string, options?: unknown) => unknown
}
const realPragma = dbProto.pragma
dbProto.pragma = function counted(
  this: PragmaHost,
  source: string,
  options?: unknown
): unknown {
  if (source === 'query_only = ON' && /remote-.*\.sqlite$/.test(this.name)) {
    copyCounter.copies += 1
  }
  return realPragma.call(this, source, options)
}

describe('無駄な転送の抑制', () => {
  const testDir = path.join(__dirname, 'test-data-idle')
  const nasDir = path.join(testDir, 'nas')
  const isolatedTmp = path.join(testDir, 'tmp')
  let savedTmpDir: string | undefined
  /** この試験で作った `SyncInstance`。後片付けで `stop()` を呼ぶ */
  const instances: SyncInstance[] = []

  beforeEach(() => {
    fs.mkdirSync(nasDir, { recursive: true })
    fs.mkdirSync(isolatedTmp, { recursive: true })
    // 一時コピーをこの試験の中に閉じ込める（`os.tmpdir()` は毎回 TMPDIR を見る）
    savedTmpDir = process.env.TMPDIR
    process.env.TMPDIR = isolatedTmp
    copyCounter.copies = 0
  })

  afterEach(() => {
    for (const instance of instances.splice(0)) instance.stop()
    if (savedTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmpDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
  })

  function createDb(clientId: string): string {
    const dir = path.join(testDir, clientId)
    fs.mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, 'local.sqlite')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE notes (
        id        TEXT PRIMARY KEY NOT NULL,
        body      TEXT,
        updatedAt TEXT NOT NULL
      )
    `)
    db.close()
    return dbPath
  }

  /** `setupSync` を呼び、後片付けで止めるために覚えておく。 */
  function setup(config: SyncConfig): SyncInstance {
    const instance = setupSync(config)
    instances.push(instance)
    return instance
  }

  function makeConfig(
    dbPath: string,
    clientId: string,
    suppress?: boolean
  ): SyncConfig {
    return {
      dbPath,
      nasPath: nasDir,
      clientId,
      schemaVersion: 'idle-test-1',
      ...(suppress === undefined ? {} : { suppressIdleSync: suppress }),
    }
  }

  function write(dbPath: string, id: string, body: string, at: string): void {
    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO notes (id, body, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET body = excluded.body,
                                        updatedAt = excluded.updatedAt`
    ).run(id, body, at)
    db.close()
  }

  function rows(dbPath: string): Record<string, unknown>[] {
    const db = new Database(dbPath, { readonly: true })
    const all = db
      .prepare(`SELECT id, body, updatedAt FROM notes ORDER BY id`)
      .all() as Record<string, unknown>[]
    db.close()
    return all
  }

  function transfersOf(value: SyncTransfers | undefined): SyncTransfers {
    if (value === undefined) throw new Error('transfers が載っていない')
    return value
  }

  it('相手の写しを手元へ写すのは、1回の同期で相手1人につき1回だけ', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const pathC = createDb('c')
    const syncA = setup(makeConfig(pathA, 'a', false))
    const syncB = setup(makeConfig(pathB, 'b', false))
    const syncC = setup(makeConfig(pathC, 'c', false))

    write(pathB, 'n-b', 'from b', '2026-09-01T00:00:00.000Z')
    write(pathC, 'n-c', 'from c', '2026-09-01T00:00:00.000Z')
    await syncB.syncNow()
    await syncC.syncNow()

    // 相手2人。**抑制を切っていても**、写すのは2回（以前は事前確認と取り込みで4回）
    copyCounter.copies = 0
    const result = await syncA.syncNow()
    const transfers = transfersOf(result.transfers)
    expect(transfers.peerReads).toBe(2)
    // 自分の写し（復元の判定）を入れても3回まで。取り合いの確認は `stat` で済む
    expect(copyCounter.copies).toBeLessThanOrEqual(3)
    expect(copyCounter.copies).toBe(transfers.peerReads + transfers.selfReads)
  })

  it('起動直後は、変更が無くても必ず上げる・読む', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))
    await syncB.syncNow()

    const first = transfersOf((await syncA.syncNow()).transfers)
    expect(first.uploads).toBe(1)
    expect(first.peerReads).toBe(1)

    // 同じ設定で立ち上げ直したら、また1回目として上げ・読む
    const syncA2 = setup(makeConfig(pathA, 'a'))
    const again = transfersOf((await syncA2.syncNow()).transfers)
    expect(again.uploads).toBe(1)
    expect(again.peerReads).toBe(1)
  })

  it('変更が無ければ、上げない・写さない', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))

    write(pathB, 'n-b', 'from b', '2026-09-01T00:00:00.000Z')
    await syncB.syncNow()
    await syncA.syncNow()
    await syncA.syncNow()

    copyCounter.copies = 0
    const transfers = transfersOf((await syncA.syncNow()).transfers)
    expect(transfers.uploads).toBe(0)
    expect(transfers.uploadsSkipped).toBe(1)
    expect(transfers.peerReads).toBe(0)
    expect(transfers.peerReadsSkipped).toBe(1)
    expect(transfers.selfReads).toBe(0)
    expect(transfers.bytes).toBe(0)
    expect(copyCounter.copies).toBe(0)
    // 相手を数えるのは、写した回と同じ（結果の見え方は変えない）
    expect((await syncA.syncNow()).clientsSynced).toBe(1)
  })

  it('手元が変われば上げる', async () => {
    const pathA = createDb('a')
    const syncA = setup(makeConfig(pathA, 'a'))
    // 1回目は必ず上げる。2回目は何も変わっていないので上げない
    expect(transfersOf((await syncA.syncNow()).transfers).uploads).toBe(1)
    expect(transfersOf((await syncA.syncNow()).transfers).uploads).toBe(0)

    write(pathA, 'n-a', 'from a', '2026-09-01T00:00:00.000Z')
    expect(transfersOf((await syncA.syncNow()).transfers).uploads).toBe(1)
    // 作り直しがアプリの表を入れ替えても、他の端末が読む部分は変わらないので上げ直さない
    expect(transfersOf((await syncA.syncNow()).transfers).uploads).toBe(0)
    expect(transfersOf((await syncA.syncNow()).transfers).uploads).toBe(0)
  })

  it('相手のファイルが変われば写す', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))
    await syncB.syncNow()
    await syncA.syncNow()
    await syncA.syncNow()
    expect(transfersOf((await syncA.syncNow()).transfers).peerReads).toBe(0)

    // B が書いて上げ直すと、A は写す
    write(pathB, 'n-b', 'from b', '2026-09-01T00:00:00.000Z')
    await syncB.syncNow()
    const result = await syncA.syncNow()
    expect(transfersOf(result.transfers).peerReads).toBe(1)
    expect(rows(pathA).map((row) => row.id)).toEqual(['n-b'])
  })

  it('取り込みで手元が変わった回は、その回のうちに上げる（中継が止まらない）', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))
    // 互いを知っている状態にする。B の写しに `_changelog` の行が載っているので、
    // A の読み位置は 0 より先へ進み、次からは隙間なしの経路に入る
    write(pathB, 'n-b0', 'from b', '2026-09-01T00:00:00.000Z')
    await syncB.syncNow()
    await syncA.syncNow()
    await syncA.syncNow()

    // ここからは隙間なしの経路。上げるのは取り込みの**あと**なので、取り込んだ
    // 版と中継の通知はこの回の写しに載る
    write(pathB, 'n-b1', 'from b', '2026-09-02T00:00:00.000Z')
    await syncB.syncNow()
    const importing = await syncA.syncNow()
    expect(importing.hadChangelogGap).toBe(false)
    expect(rows(pathA).map((row) => row.id)).toEqual(['n-b0', 'n-b1'])
    expect(transfersOf(importing.transfers).uploads).toBe(1)
    const copy = new Database(path.join(nasDir, 'client-a.sqlite'), {
      readonly: true,
    })
    const relayed = copy
      .prepare(`SELECT id FROM _sns_rows_notes ORDER BY id`)
      .all() as { id: string }[]
    copy.close()
    expect(relayed.map((row) => row.id)).toEqual(['n-b0', 'n-b1'])

    // 次の回は、もう上げるものが無い
    expect(transfersOf((await syncA.syncNow()).transfers).uploads).toBe(0)
  })

  it('取り込みが Max を変えずに版を格納した回も、上げ直す', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))
    write(pathA, 'x', 'v1', '2026-09-01T00:00:00.000Z')
    await syncA.syncNow()
    await syncB.syncNow()
    expect(rows(pathB).map((row) => row.id)).toEqual(['x'])

    // A と B がそれぞれ x を消す。削除の版の時刻は実行した時刻なので、あとから
    // 消した B の削除の版の方が強い
    const remove = (dbPath: string): void => {
      const db = new Database(dbPath)
      db.prepare(`DELETE FROM notes WHERE id = 'x'`).run()
      db.close()
    }
    remove(pathA)
    await new Promise((resolve) => setTimeout(resolve, 20))
    remove(pathB)

    // A は x を未来の時刻で書き直して上げる。この行の版はどちらの削除の版よりも強い
    write(pathA, 'x', 'v2', '2099-01-01T00:00:00.000Z')
    await syncA.syncNow()
    // B は A の行の版を取り込んで上げる。B の `_tombstone` には B の削除の版が残る
    await syncB.syncNow()

    // A は B の削除の版を取り込む。手元の削除の版より強いので格納するが、
    // 行の版の方が強いので Max は変わらず、通知も書かない
    const quiet = await syncA.syncNow()
    expect(rows(pathA)).toEqual([
      { id: 'x', body: 'v2', updatedAt: '2099-01-01T00:00:00.000Z' },
    ])
    expect(transfersOf(quiet.transfers).uploads).toBe(1)

    const tombstoneOf = (dbPath: string): unknown => {
      const db = new Database(dbPath, { readonly: true })
      const row = db
        .prepare(
          `SELECT _sns_ts, _sns_lamport, _sns_instance FROM _tombstone
            WHERE tableName = 'notes' AND recordId = 'x'`
        )
        .get()
      db.close()
      return row
    }
    expect(tombstoneOf(path.join(nasDir, 'client-a.sqlite'))).toEqual(
      tombstoneOf(pathB)
    )
  })

  it('作り直しが例外で止まっても、取り込んだ版を上げてから投げ直す', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))
    await syncA.syncNow()
    write(pathB, 'n-b', 'from b', '2026-09-01T00:00:00.000Z')
    await syncB.syncNow()

    // A の作り直しを、見送りにならない例外で止める
    const db = new Database(pathA)
    db.pragma('foreign_keys = ON')
    db.pragma('recursive_triggers = ON')
    try {
      await expect(
        performSync(db, makeConfig(pathA, 'a'), [{ name: 'notes' }], {
          rebuild: createRebuildState(),
          forceMainThread: true,
          hooks: {
            beginImmediate: () => {
              throw new Error('作り直しの失敗')
            },
          },
        })
      ).rejects.toThrow('作り直しの失敗')
    } finally {
      db.close()
    }

    // アプリの表には入っていないが、取り込んだ版は A の写しに載っている
    expect(rows(pathA)).toEqual([])
    const copy = new Database(path.join(nasDir, 'client-a.sqlite'), {
      readonly: true,
    })
    const relayed = copy.prepare(`SELECT id FROM _sns_rows_notes`).all()
    copy.close()
    expect(relayed).toEqual([{ id: 'n-b' }])
  })

  it('自分の写しを自分以外が書いたら、上げない回でも気づいて上げ直す', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))
    await syncB.syncNow()
    await syncA.syncNow()
    await syncA.syncNow()
    // 落ち着いた（上げない・写さない）
    expect(transfersOf((await syncA.syncNow()).transfers).uploads).toBe(0)

    // 同じクライアント id を名乗る誰かが `client-a.sqlite` を書いた体にする。
    // 中身は読まず、**素性（inode）だけ**で気づけること
    fs.copyFileSync(
      path.join(nasDir, 'client-b.sqlite'),
      path.join(nasDir, 'client-a.sqlite')
    )
    const transfers = transfersOf((await syncA.syncNow()).transfers)
    expect(transfers.uploads).toBe(1)
    // 自分の写しが自分のものでなくなっているので、復元の判定も読み直す
    expect(transfers.selfReads).toBeGreaterThanOrEqual(1)
  })

  it('印が同じでも、一定回数ごとに必ず読む・上げる', async () => {
    const pathA = createDb('a')
    const pathB = createDb('b')
    const syncA = setup(makeConfig(pathA, 'a'))
    const syncB = setup(makeConfig(pathB, 'b'))
    await syncB.syncNow()

    let uploads = 0
    let peerReads = 0
    // 覚えの `FORCE_EVERY` は 20。20回目までに、1回目以外にもう1回は必ず来る
    for (let round = 0; round < FORCE_EVERY + 1; round += 1) {
      const transfers = transfersOf((await syncA.syncNow()).transfers)
      uploads += transfers.uploads
      peerReads += transfers.peerReads
    }
    expect(uploads).toBeGreaterThanOrEqual(2)
    expect(peerReads).toBeGreaterThanOrEqual(2)
    // それでも、毎回上げていた頃（21回）よりはずっと少ない
    expect(uploads).toBeLessThan(FORCE_EVERY)
    expect(peerReads).toBeLessThan(FORCE_EVERY)
  })

  it('抑制しても、3端末の最終的な中身は抑制なしと同じ', async () => {
    const run = async (suppress: boolean): Promise<string> => {
      fs.rmSync(testDir, { recursive: true, force: true })
      fs.mkdirSync(nasDir, { recursive: true })
      fs.mkdirSync(isolatedTmp, { recursive: true })
      const paths = ['a', 'b', 'c'].map(createDb)
      const syncs = ['a', 'b', 'c'].map((id, index) =>
        setup(makeConfig(paths[index], id, suppress))
      )
      for (let round = 0; round < 3; round += 1) {
        for (let index = 0; index < 3; index += 1) {
          write(
            paths[index],
            `n-${String(index)}-${String(round)}`,
            `r${String(round)}`,
            `2026-09-0${String(round + 1)}T00:00:00.000Z`
          )
          await syncs[index].syncNow()
        }
      }
      // 行き渡らせる
      for (let round = 0; round < 3; round += 1) {
        for (const sync of syncs) await sync.syncNow()
      }
      return JSON.stringify(paths.map(rows))
    }

    const off = await run(false)
    const on = await run(true)
    expect(on).toBe(off)
  })
})
