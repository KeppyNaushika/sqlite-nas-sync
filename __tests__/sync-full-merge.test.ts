/**
 * フルマージ —— changelog に隙間があって差分では追いつけないときの経路。
 *
 * 保持期間を超えて同期しなかった端末が復帰する場面で、リモートの全レコードを
 * LWW で突き合わせ、`_tombstone` の削除を適用し、changelog を複製する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { performSync } from '../src/sync'
import { copyToNas } from '../src/nas'
import {
  cleanupChangelog,
  getMaxChangelogId,
  readChangelogPrunedThroughId,
} from '../src/changelog'
import { createSyncFixture, TABLES } from './helpers/sync-fixtures'

const { prepare, cleanup, createClientDb, makeConfig, nasDir } =
  createSyncFixture('test-data-sync-full')

describe('フルマージ（ギャップ検出時）', () => {
  beforeEach(prepare)
  afterEach(cleanup)

  it('tombstoneによりzombieレコードが削除される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    // Aがレコードを作成して同期
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Bが同期してu1を取得
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    expect(
      dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get()
    ).toBeTruthy()

    // Aがu1を削除して同期（tombstoneが作成される）
    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Aのchangelogを全削除（7日経過をシミュレート）
    dbA.exec(`DELETE FROM _changelog`)
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    // Bが復帰して同期（changelogギャップ → フルマージ）
    const resultB = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(resultB.hadChangelogGap).toBe(true)

    // tombstoneによりu1がBから削除される
    const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get()
    expect(user).toBeUndefined()

    dbB.close()
  })

  it('フルマージ中にchangelogが汚染されない', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    // Aがレコードを複数作成して同期
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u2', 'Bob', '2024-01-02T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Bが同期
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Aのchangelogを全削除（7日経過シミュレート）
    dbA.exec(`DELETE FROM _changelog`)
    // Aが新しいレコードを追加
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u3', 'Charlie', '2024-01-10T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    // Bのchangelogエントリ数を記録（フルマージ前）
    const beforeCount = (
      dbB.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any
    ).cnt

    // Bが復帰して同期（ギャップ → フルマージ）
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // フルマージ後のchangelogエントリ数
    // トリガーOFFなのでデータマージ分は増えない
    // heartbeatの1件 + changelogマージ分のみ
    const afterCount = (
      dbB.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any
    ).cnt

    // u1, u2の既存レコードのマージではchangelogが増えないことを確認
    // （全レコード分のINSERT/UPDATEエントリが生成されていないこと）
    // Aのchangelogマージ分 + heartbeat分のみ
    expect(afterCount).toBeLessThan(beforeCount + 10)

    dbB.close()
  })

  it('フルマージ後にheartbeatが更新されchangelogが延命する', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Aのchangelogを全削除（7日経過シミュレート）
    dbA.exec(`DELETE FROM _changelog`)
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    // Bが復帰（フルマージ）
    const resultB = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(resultB.hadChangelogGap).toBe(true)

    // heartbeatがchangelogに記録されている
    const heartbeatEntries = dbB
      .prepare(`SELECT * FROM _changelog WHERE tableName = '_heartbeat'`)
      .all()
    expect(heartbeatEntries.length).toBeGreaterThanOrEqual(1)

    dbB.close()
  })

  it('フルマージでリモートのchangelogがマージされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Aがchangelogの古い部分を削除しつつ新しい変更を追加
    dbA.exec(`DELETE FROM _changelog`)
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u2', 'Bob', '2024-01-10T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    // Bが復帰（フルマージ）
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Bのchangelogにu2のエントリがある（Aのchangelogからマージされた）
    const u2Entries = dbB
      .prepare(`SELECT * FROM _changelog WHERE recordId = 'u2'`)
      .all()
    expect(u2Entries.length).toBeGreaterThanOrEqual(1)

    // u2のデータもマージされている
    const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u2'`).get() as any
    expect(user.name).toBe('Bob')

    dbB.close()
  })

  it('pull-firstによりstaleデータがNASに拡散しない', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    // Aがレコードを作成して同期
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Bが同期
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Aがu1を削除して同期
    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Aのchangelogを全削除（7日経過シミュレート）
    dbA.exec(`DELETE FROM _changelog`)
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    // Bが復帰（フルマージ）
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Cが参加して同期 — Bの汚染がCに伝播しないことを確認
    const { db: dbC, dbPath: pathC } = createClientDb('client-c')
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES)

    // CにはAからの削除が反映されている（u1が存在しない）
    // BのNASコピーからu1が復活しないことが重要
    const userInC = dbC.prepare(`SELECT * FROM users WHERE id = 'u1'`).get()
    expect(userInC).toBeUndefined()

    dbB.close()
    dbC.close()
  })

  it('tombstoneのLWW: 削除後に再作成されたレコードは保持される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    // Aがレコード作成 → 同期
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Bが同期
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // Aがu1を削除
    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // Aのchangelogを全削除（7日経過シミュレート）
    dbA.exec(`DELETE FROM _changelog`)

    // Aがu1を再作成（削除より新しいupdatedAt）。
    //
    // **削除の時刻は固定値ではない。** DELETEトリガは `_tombstone.deletedAt` に
    // **現在時刻**を刻むので、ここに過去の固定値（`2024-06-01` など）を書くと
    // 作り直しの方が古くなり、LWW としては削除が勝つのが正しい答えになる
    // （＝このテストの意図する形にならない）。**相対と固定を混ぜないこと。**
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice Reborn', '2099-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    // Bが復帰（フルマージ）
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // tombstone.deletedAt < u1.updatedAt なので、u1は保持される
    const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get() as any
    expect(user).toBeTruthy()
    expect(user.name).toBe('Alice Reborn')

    dbB.close()
  })

  it('フルマージ後に gap が解消され、次回 sync で再フルマージが起きない', async () => {
    // クライアントAで複数エントリを作りつつ、古いものは cleanup される状況を作る
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // クライアントB初回sync（lastSeenId が記録される）
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    dbB.close()

    // Aで追加変更
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u2', 'Bob', '2024-01-02T00:00:00Z')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u3', 'Carol', '2024-01-03T00:00:00Z')

    // Aの changelog から、**Bがまだ読んでいないエントリ**を消して gap を作る。
    // 既読ぶん（`lastSeenId` まで）だけを消しても隙間にはならない
    // （`hasChangelogGap` の境界は `minId === lastSeenId + 1`）ので、
    // Bが次に読むはずだった1件を巻き込むところまで消す。
    const seenByB = new Database(pathB, { readonly: true })
    const { lastSeenId } = seenByB
      .prepare(`SELECT lastSeenId FROM _sync_state WHERE remoteClientId = ?`)
      .get('client-a') as { lastSeenId: number }
    seenByB.close()
    dbA.prepare(`DELETE FROM _changelog WHERE id <= ?`).run(lastSeenId + 1)

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    // クライアントB再開 → gap 検出されてフルマージが走る
    const dbB2 = new Database(pathB)
    const result1 = await performSync(
      dbB2,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(result1.hadChangelogGap).toBe(true)

    // 直後にもう一度 sync → 今度は gap 検出されないはず（lastSeenId が正しく更新されているため）
    const result2 = await performSync(
      dbB2,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(result2.hadChangelogGap).toBe(false)

    // さらにもう一度 → 同じく gap 無し
    const result3 = await performSync(
      dbB2,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(result3.hadChangelogGap).toBe(false)

    dbB2.close()
  })

  it('掃除が開けた穴の向こうの変更も、中継した端末から届く', async () => {
    // 本体。A の変更が「B の掃除で消えたエントリ」に入っていても、A が共有から
    // 居なくなった後で C に届くこと。
    //
    // ここが壊れると症状はこうなる: C は B の残っているぶんだけを読んでカーソルを
    // 進めるので、穴に入っていた行の変更は**二度と差分経路に現れない**。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    // A が行を作る
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // A の changelog を全部消して隙間を作る（保持期間の経過をシミュレート）。
    // B は初回同期なので、この状態を読むとフルマージ経路に入り、
    // A の changelog（とデータ）を取り込む。
    dbA.exec(`DELETE FROM _changelog`)
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u2', 'Bob', '2024-01-05T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    const resultB = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(resultB.hadChangelogGap).toBe(true)
    // 取り込んだエントリは**元の changedAt のまま、新しく採番したid**で入る。
    // ここで id順と時刻順がねじれる。
    expect(
      dbB.prepare(`SELECT * FROM users WHERE id = 'u2'`).get()
    ).toBeTruthy()

    // B が掃除する。ねじれた古いエントリを保持期間の外へ押し出しておく
    // （フルマージで取り込んだぶんが後から古くなる形）。
    dbB
      .prepare(
        `UPDATE _changelog SET changedAt = '2020-01-01T00:00:00.000Z'
          WHERE recordId IN ('u1', 'u2')`
      )
      .run()
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    expect(readChangelogPrunedThroughId(dbB)).toBeGreaterThan(0)

    // **共有へ載る姿は1回ぶん遅れる。** `performSync` は通常フローでは pull の前に
    // 自分をコピーするので、掃除の結果が共有に現れるのは次の同期である。
    // もう一度回して、掃除済みの姿（＝穴と掃除済み位置の記録）を共有へ載せる。
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // A を共有から外す（もう誰も A 本人からは読めない）
    dbA.close()
    fs.rmSync(path.join(nasDir, 'client-client-a.sqlite'))

    // C が B を読む。B の changelog には穴が開いているので C はフルマージへ落ち、
    // 穴に入っていた行も B の実データから受け取れる。
    // ここで隙間を見落とすと、C は残っているぶん（heartbeat だけ）を読んで
    // カーソルを進め、u1 / u2 の変更は**二度と差分経路に現れない**。
    const { db: dbC, dbPath: pathC } = createClientDb('client-c')
    const resultC = await performSync(
      dbC,
      makeConfig(pathC, 'client-c'),
      TABLES
    )
    expect(resultC.hadChangelogGap).toBe(true)

    const u1 = dbC.prepare(`SELECT * FROM users WHERE id = 'u1'`).get() as any
    const u2 = dbC.prepare(`SELECT * FROM users WHERE id = 'u2'`).get() as any
    expect(u1?.name).toBe('Alice')
    expect(u2?.name).toBe('Bob')

    dbB.close()
    dbC.close()
  })

  it('掃除済みの位置を持つ相手でも、再フルマージのループが起きない', async () => {
    // 危険3の形。相手の changelog が全部消えていると `MAX(id) = 0` なので、
    // カーソルを `MAX(id)` だけで進めると `prunedThroughId > lastSeenId` が
    // 真のままになり、**毎回フルマージを繰り返す**（全件突き合わせなので重い）。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)

    // A の changelog を「掃除で」全部消す（記録が残る形）。
    // heartbeat のぶんも含めて期限切れにしてから掃除する。
    dbA
      .prepare(`UPDATE _changelog SET changedAt = '2020-01-01T00:00:00.000Z'`)
      .run()
    expect(cleanupChangelog(dbA, 7)).toBeGreaterThan(0)
    const prunedThroughId = readChangelogPrunedThroughId(dbA)
    expect(prunedThroughId).toBeGreaterThan(0)
    expect(getMaxChangelogId(dbA)).toBe(0)

    // 掃除後の姿を NAS へ置く。**heartbeat を回さない**ため、
    // `performSync` を通さず直接コピーする（通すと changelog に1件載って
    // `MAX(id) > 0` になり、この形が作れない）。
    await copyToNas(dbA, nasDir, 'client-a')
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')
    const result1 = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(result1.hadChangelogGap).toBe(true)

    const result2 = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(result2.hadChangelogGap).toBe(false)

    const result3 = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    )
    expect(result3.hadChangelogGap).toBe(false)

    dbB.close()
  })

  it('NAS上のリモートファイルが読み取り中に書き換わっても sync が安全に進む', async () => {
    // ローカルコピー経由で開いているため、書き換えの影響を受けない
    const { db: dbA, dbPath: pathA } = createClientDb('client-a')
    dbA
      .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
      .run('u1', 'Alice', '2024-01-01T00:00:00Z')
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES)
    dbA.close()

    const { db: dbB, dbPath: pathB } = createClientDb('client-b')

    // Bがsyncしている最中にAのNASファイルが書き換わるシミュレーション:
    // syncが終わってから書き換えて、もう一度syncしても問題ないことを確認
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)

    // NAS上のAファイルを別プロセスが置き換えたと想定して上書き
    const dbA2 = new Database(pathA)
    dbA2
      .prepare(`UPDATE users SET name = ?, updatedAt = ? WHERE id = ?`)
      .run('Alice2', '2024-01-03T00:00:00Z', 'u1')
    await performSync(dbA2, makeConfig(pathA, 'client-a'), TABLES)
    dbA2.close()

    // Bが再同期 → 新しい値が取れる
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES)
    expect(
      result.warnings.filter((w) => w.includes('Sync failed')).length
    ).toBe(0)

    const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get() as any
    expect(user.name).toBe('Alice2')

    dbB.close()
  })
})
