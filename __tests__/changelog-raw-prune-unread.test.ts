/**
 * 相手の `_changelog` から、まだ誰も読んでいない行が掃除を経由せずに消えた形。
 *
 * 網羅検査が見つけた反例（2端末・遷移2回）を `performSync` で決定的に再現する:
 *
 * 1. a が同期する。NAS 上の a の写しには、まだ何も載っていない
 * 2. a が g1 を書く（写しを作ったあとなので、写しには載らない）。a の `_changelog` は id 1 の1件
 * 3. a の `_changelog` の頭を直に消す（`DELETE`。`_changelog_prune` は進まない）
 * 4. b が同期する。a の写し（g1 を含まない）を初回としてフルマージで読み、読み位置は 0 になる
 * 5. a が同期する。写しには g1 の版が載るが、`_changelog` は空で `prunedThroughId` も 0
 * 6. b が同期する。読み位置 0・`_changelog` が空・`prunedThroughId` 0 は、
 *    「一度も書いていない相手」と同じ形に見えるので、隙間なしと判断して g1 を取り込まない
 *
 * 以前は読み位置が 0 の相手を常にフルマージで読んでいたので、6 で拾えていた。
 * いまは `sqlite_sequence`（`_changelog` が最後に振った id）を見て、振られたのに残っていない
 * id があれば隙間とする。a は id 1 を振っているので、6 の b はフルマージに落ちて g1 を受け取る。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import {
  cleanupChangelog,
  getMaxChangelogId,
  readChangelogPrunedThroughId,
} from '../src/changelog'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const { prepare, cleanup, createClientDb, makeConfig } = createSyncFixture(
  'test-data-changelog-raw-prune-unread'
)

function lastSeenIdOf(db: Database.Database, remoteClientId: string): unknown {
  return db
    .prepare(`SELECT lastSeenId FROM _sync_state WHERE remoteClientId = ?`)
    .get(remoteClientId)
}

function userNames(db: Database.Database): unknown[] {
  return db.prepare(`SELECT id, name FROM users ORDER BY id`).all()
}

describe('読まれる前に直に消えた changelog の行', () => {
  beforeEach(prepare)
  afterEach(cleanup)

  it('写しを作った直後に書いた行の changelog が直に消えても、相手へ届く', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const configA = makeConfig(pathA, 'client-a')
    const configB = makeConfig(pathB, 'client-b')

    // 1. a の写しには何も載っていない
    await performSync(dbA, configA, TABLES)

    // 2. 写しのあとで g1 を書く
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('g1', 'Alice', '2026-01-01T00:00:00.000Z')
    expect(getMaxChangelogId(dbA)).toBe(1)

    // 3. 誰もまだ a を読んでいないので、読み位置 0 の1つ先（id 1）まで直に消す
    dbA.prepare(`DELETE FROM _changelog WHERE id <= 1`).run()
    expect(getMaxChangelogId(dbA)).toBe(0)
    expect(readChangelogPrunedThroughId(dbA)).toBe(0)

    // 4. b は g1 を含まない写しを読む
    await performSync(dbB, configB, TABLES)
    expect(userNames(dbB)).toEqual([])
    expect(lastSeenIdOf(dbB, 'client-a')).toEqual({ lastSeenId: 0 })

    // 5. a の写しに g1 が載る
    await performSync(dbA, configA, TABLES)

    // 6. b は隙間に気づいてフルマージで読む
    const result = await performSync(dbB, configB, TABLES)
    expect(result.hadChangelogGap).toBe(true)
    expect(userNames(dbB)).toEqual([{ id: 'g1', name: 'Alice' }])
    // 読み位置は a が振った最後の id まで進む
    expect(lastSeenIdOf(dbB, 'client-a')).toEqual({ lastSeenId: 1 })

    // そのあとは同じ相手を読むたびにフルマージを繰り返さない
    const again = await performSync(dbB, configB, TABLES)
    expect(again.hadChangelogGap).toBe(false)
    const third = await performSync(dbB, configB, TABLES)
    expect(third.hadChangelogGap).toBe(false)
    expect(userNames(dbB)).toEqual([{ id: 'g1', name: 'Alice' }])

    dbA.close()
    dbB.close()
  })

  it('同じ手順をライブラリの掃除で行っても、掃除済みの位置から隙間と分かる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const configA = makeConfig(pathA, 'client-a')
    const configB = makeConfig(pathB, 'client-b')

    await performSync(dbA, configA, TABLES)
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('g1', 'Alice', '2026-01-01T00:00:00.000Z')
    // 保持期間の外へ押し出してから掃除する。こちらは `_changelog_prune` を進める
    dbA
      .prepare(`UPDATE _changelog SET changedAt = '2020-01-01T00:00:00.000Z'`)
      .run()
    expect(cleanupChangelog(dbA, 7)).toBe(1)
    expect(readChangelogPrunedThroughId(dbA)).toBe(1)

    await performSync(dbB, configB, TABLES)
    await performSync(dbA, configA, TABLES)
    const result = await performSync(dbB, configB, TABLES)
    expect(result.hadChangelogGap).toBe(true)
    expect(userNames(dbB)).toEqual([{ id: 'g1', name: 'Alice' }])
    const again = await performSync(dbB, configB, TABLES)
    expect(again.hadChangelogGap).toBe(false)

    dbA.close()
    dbB.close()
  })
})
