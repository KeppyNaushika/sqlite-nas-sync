import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { setupChangelog, computeSchemaHash } from '../src/setup'
import {
  readChangelog,
  getMaxChangelogId,
  hasChangelogGap,
  cleanupChangelog,
  readChangelogPrunedThroughId,
  describeChangelogPruneWall,
} from '../src/changelog'

describe('changelog', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    setupChangelog(db, [{ name: 'users' }], 'id')
  })

  afterEach(() => {
    db.close()
  })

  describe('readChangelog', () => {
    it('sinceId以降のエントリを返す', () => {
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u2', 'Bob', '2024-01-01T00:00:00Z')

      const all = readChangelog(db, 0)
      expect(all).toHaveLength(2)

      const fromSecond = readChangelog(db, all[0].id)
      expect(fromSecond).toHaveLength(1)
      expect(fromSecond[0].recordId).toBe('u2')
    })

    it('新しいエントリがない場合は空配列', () => {
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')

      const maxId = getMaxChangelogId(db)
      const entries = readChangelog(db, maxId)
      expect(entries).toHaveLength(0)
    })
  })

  describe('getMaxChangelogId', () => {
    it('最大IDを返す', () => {
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u2', 'Bob', '2024-01-01T00:00:00Z')

      const maxId = getMaxChangelogId(db)
      expect(maxId).toBe(2)
    })

    it('空の_changelogでは0を返す', () => {
      const maxId = getMaxChangelogId(db)
      expect(maxId).toBe(0)
    })
  })

  describe('hasChangelogGap', () => {
    it('lastSeenId=0の場合はギャップなし', () => {
      expect(hasChangelogGap(db, 0)).toBe(false)
    })

    it('ギャップがない場合はfalse', () => {
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')

      // lastSeenId=0, MIN(id)=1 → ギャップなし
      expect(hasChangelogGap(db, 0)).toBe(false)
    })

    it('エントリが掃除された場合はtrue', () => {
      for (const [id, name] of [
        ['u1', 'Alice'],
        ['u2', 'Bob'],
        ['u3', 'Carol'],
      ]) {
        db.prepare(
          `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
        ).run(id, name, '2024-01-01T00:00:00Z')
      }

      // ID=1,2のエントリを削除（掃除をシミュレート）
      db.prepare(`DELETE FROM _changelog WHERE id <= 2`).run()

      // lastSeenId=1, MIN(id)=3 → 未読の2番が消えている＝ギャップあり
      expect(hasChangelogGap(db, 1)).toBe(true)
    })

    /**
     * 境界は `minId === lastSeenId + 1`。
     *
     * `lastSeenId` は「読み終えた位置」（{@link readChangelog} は `id > ?` で引く）
     * なので、次に読むべき `lastSeenId + 1` が残っていれば間に消えたものは無い。
     * ここを1つずらすと、掃除が既読ぶんだけを消した通常の運用で毎回フルマージに落ちる。
     */
    it('境界: 既読ぶんだけが掃除されたときはギャップなし', () => {
      for (const [id, name] of [
        ['u1', 'Alice'],
        ['u2', 'Bob'],
        ['u3', 'Carol'],
      ]) {
        db.prepare(
          `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
        ).run(id, name, '2024-01-01T00:00:00Z')
      }

      // 既読は1番まで。掃除が1番だけを消した状態
      db.prepare(`DELETE FROM _changelog WHERE id = 1`).run()

      // minId=2 === lastSeenId(1) + 1 → 欠落なし
      expect(hasChangelogGap(db, 1)).toBe(false)
      // 一方、まだ何も読んでいない側から見れば1番が消えている＝ギャップ。
      // ここを「初回同期は常にギャップなし」と特別扱いすると、新しい端末は
      // 相手の保持期間に残っていた窓のぶんしか受け取れない。
      expect(hasChangelogGap(db, 0)).toBe(true)
    })

    it('境界: changelog が空のときは、読み終えた位置を持っているかで分かれる', () => {
      // 空は「掃除で全部消えた」とも「まだ何も起きていない」とも読める。
      // 読み終えた位置を持っているなら前者（全掃除）なので隙間。
      expect(hasChangelogGap(db, 5)).toBe(true)
      // まだ何も読んでいないなら区別が付かない。ここを隙間と呼ぶと、
      // 相手が何かするまで毎回フルマージを繰り返す（相手が1件でも書けば
      // minId > 1 となって上の規則が拾うので、取りこぼしはそこで埋まる）。
      expect(hasChangelogGap(db, 0)).toBe(false)
    })

    /**
     * 掃除を経由しない消え方は、記録に載らないので依然見抜けない。
     *
     * `_changelog_prune` に書くのは {@link cleanupChangelog} だけなので、
     * 利用者やテストが直に打つ `DELETE FROM _changelog`（や、DBファイルの差し替え、
     * `_changelog_prune` を持たない旧版が開けた穴）は記録に現れない。
     * この形は `MIN(id)` の規則が頭の欠けを拾えたときにだけ見つかる。
     * 現状維持の確認として固定しておく。
     */
    it('生の DELETE で開いた途中の穴は、記録に載らないので見抜けない', () => {
      for (const [id, name] of [
        ['u1', 'Alice'],
        ['u2', 'Bob'],
        ['u3', 'Carol'],
      ]) {
        db.prepare(
          `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
        ).run(id, name, '2024-01-01T00:00:00Z')
      }

      // 既読は1番まで。未読の2番が消えた状態
      db.prepare(`DELETE FROM _changelog WHERE id = 2`).run()

      // minId=1、lastSeenId=1 → minId は lastSeenId 以下だが、未読の先頭(2)は
      // 消えている。掃除の記録も無いので、どちらの規則にも当たらない。
      expect(hasChangelogGap(db, 1)).toBe(false)

      // 先頭ごと消えていれば `MIN(id)` の規則が拾う
      db.prepare(`DELETE FROM _changelog WHERE id = 1`).run()
      expect(hasChangelogGap(db, 1)).toBe(true)
    })

    /**
     * 掃除が消したぶんは、`MIN(id)` では見えなくなっても記録から分かる。
     *
     * いちばん効くのは**全部掃除された相手**である。changelog が空のとき、
     * `MIN(id)` の規則は「掃除で全部消えた」と「まだ何も起きていない」を
     * 区別できないので `lastSeenId === 0` を隙間としない。記録があれば
     * 「1番から5番までは在ったが消えた」と分かるので、まだ何も読んでいない
     * 端末に対して正しく隙間と答えられる。
     */
    it('掃除が消したぶんは、記録から見抜ける', () => {
      for (const [id, name] of [
        ['u1', 'Alice'],
        ['u2', 'Bob'],
        ['u3', 'Carol'],
      ]) {
        db.prepare(
          `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
        ).run(id, name, '2024-01-01T00:00:00Z')
      }
      // 全件を保持期間の外へ押し出して掃除する
      db.prepare(
        `UPDATE _changelog SET changedAt = '2020-01-01T00:00:00.000Z'`
      ).run()
      expect(cleanupChangelog(db, 7)).toBe(3)

      // changelog は空。`MIN(id)` の規則だけでは lastSeenId=0 を隙間と呼べないが、
      // 記録（prunedThroughId=3）が「読む前に3件消えた」と言える
      expect(readChangelogPrunedThroughId(db)).toBe(3)
      expect(hasChangelogGap(db, 0)).toBe(true)
      expect(hasChangelogGap(db, 2)).toBe(true)

      // 消えたのが既読ぶんだけなら隙間ではない。ここを「空 かつ lastSeenId>0 なら
      // 隙間」と答えると、フルマージ済みの相手を毎回フルマージし直す
      // （`pullFullMerge` はカーソルを掃除済みの位置まで進める）。
      expect(hasChangelogGap(db, 3)).toBe(false)
    })

    it('相手が旧版（`_changelog_prune` が無い）でも、従来判定に落ちる', () => {
      // 読み取り経路に「無ければ作る」を持ち込むと、読み取り専用で開いた
      // リモートで例外になり、その相手ぶんの取り込みが丸ごと止まる。
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u2', 'Bob', '2024-01-01T00:00:00Z')
      db.exec(`DROP TABLE _changelog_prune`)

      expect(readChangelogPrunedThroughId(db)).toBe(0)
      expect(hasChangelogGap(db, 0)).toBe(false)
      // 従来どおり `MIN(id)` の規則だけで判断する
      db.prepare(`DELETE FROM _changelog WHERE id = 1`).run()
      expect(hasChangelogGap(db, 0)).toBe(true)
    })

    it('読み取り専用で開いたDBでも例外にならない', () => {
      // リモートは `new Database(tmpPath, { readonly: true })` で開かれる。
      // ここで書き込みが混ざると、その相手ぶんの取り込みが丸ごと止まる。
      const filePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-readonly-')),
        'local.sqlite'
      )
      const writable = new Database(filePath)
      writable.exec(
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, updatedAt TEXT NOT NULL)`
      )
      setupChangelog(writable, [{ name: 'users' }], 'id')
      writable
        .prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`)
        .run('u1', 'Alice', '2024-01-01T00:00:00Z')
      writable.close()

      const readonly = new Database(filePath, { readonly: true })
      expect(() => readChangelogPrunedThroughId(readonly)).not.toThrow()
      expect(() => hasChangelogGap(readonly, 0)).not.toThrow()
      expect(hasChangelogGap(readonly, 0)).toBe(false)
      readonly.close()
    })

    it('_changelogが完全に空でlastSeenId>0の場合はtrue', () => {
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')
      db.prepare(`DELETE FROM _changelog`).run()

      expect(hasChangelogGap(db, 5)).toBe(true)
    })
  })

  describe('cleanupChangelog', () => {
    it('古いエントリを削除する', () => {
      // 古い日時のエントリを直接挿入
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'u1', 'INSERT', '2020-01-01T00:00:00Z')

      // 新しいエントリ
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u2', 'Bob', '2024-01-01T00:00:00Z')

      const deleted = cleanupChangelog(db, 7)
      expect(deleted).toBe(1)

      const remaining = readChangelog(db, 0)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].recordId).toBe('u2')
    })

    it('最近のエントリは残す', () => {
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')

      // 今日のエントリは7日以内なので残る
      const deleted = cleanupChangelog(db, 7)
      expect(deleted).toBe(0)

      const remaining = readChangelog(db, 0)
      expect(remaining).toHaveLength(1)
    })

    /**
     * 掃除は**接頭辞しか刈らない**。並びがねじれている場所では、期限切れでも残る。
     *
     * 以前ここは「保持期間ちょうどの前後で分かれる」——時刻だけを見て1行ずつ
     * 消す規則——を固定していた。その規則だと、id順と時刻順がねじれた場所で
     * **若いidを残して大きいidを消す**ことになり、changelog の途中に穴が開く。
     * 穴の向こうの変更は、相手が共有から居なくなると二度と届かない
     * （`hasChangelogGap` は残っている頭を見るので、頭が残っていれば気づけない）。
     *
     * ねじれは机上の話ではない: `mergeChangelog` は取り込んだ相手のエントリを
     * 元の `changedAt` のまま新しく採番したidで書くので、フルマージの直後は
     * 必ずこの形になる。
     *
     * そこで「保持期間を過ぎていない、いちばん小さいid」より前だけを消す。
     * 下の例では期限内の `keep`(id=1) が壁になり、期限切れの `drop`(id=2) も残る。
     */
    it('接頭辞しか刈らないので、ねじれた並びでは古い方が残る', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
         VALUES (?, ?, ?, datetime('now', '-6 days', '-23 hours'))`
      ).run('users', 'keep', 'INSERT')
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
         VALUES (?, ?, ?, datetime('now', '-7 days', '-1 hours'))`
      ).run('users', 'drop', 'INSERT')

      // 期限内の `keep` が id=1 に居るので、1件も刈れない
      expect(cleanupChangelog(db, 7)).toBe(0)
      expect(readChangelog(db, 0).map((entry) => entry.recordId)).toEqual([
        'keep',
        'drop',
      ])
      // 穴を開けていないので、掃除済みの位置も動かない
      expect(readChangelogPrunedThroughId(db)).toBe(0)

      // 壁が期限切れになれば、接頭辞としてまとめて刈れる
      db.prepare(
        `UPDATE _changelog SET changedAt = datetime('now', '-8 days') WHERE recordId = 'keep'`
      ).run()
      expect(cleanupChangelog(db, 7)).toBe(2)
      expect(readChangelog(db, 0)).toHaveLength(0)
    })

    it('ねじれた並びでも、掃除は changelog に穴を開けない', () => {
      // `mergeChangelog` が作る形の再現: 古い `changedAt` を**大きいid**で、
      // その前に新しい `changedAt` の若いidを置く。
      db.prepare(
        `INSERT INTO _changelog (id, tableName, recordId, operation, changedAt)
         VALUES (10, ?, ?, ?, datetime('now', '-1 hours'))`
      ).run('users', 'fresh-low-id', 'INSERT')
      db.prepare(
        `INSERT INTO _changelog (id, tableName, recordId, operation, changedAt)
         VALUES (20, ?, ?, ?, '2020-01-01T00:00:00.000Z')`
      ).run('users', 'stale-high-id', 'INSERT')

      expect(cleanupChangelog(db, 7)).toBe(0)
      // 残った並びが連続していること（20だけが消えて穴になっていない）
      expect(readChangelog(db, 0).map((entry) => entry.id)).toEqual([10, 20])
      expect(readChangelogPrunedThroughId(db)).toBe(0)
      // 20番を読み終えた相手から見て、隙間は無い
      expect(hasChangelogGap(db, 20)).toBe(false)
    })

    it('保持期間0なら、今書いたぶんを残して過去を消す', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
         VALUES (?, ?, ?, datetime('now', '-1 seconds'))`
      ).run('users', 'old', 'INSERT')

      expect(cleanupChangelog(db, 0)).toBe(1)
      expect(readChangelog(db, 0)).toHaveLength(0)
    })

    it('使えない保持期間は既定値として扱う（黙って止まらないこと）', () => {
      // 負値をSQLの綴りへそのまま渡すと `--1 days` になり、julianday() が NULL を
      // 返して**1件も消えない**。設定を間違えたときに掃除が黙って止まり、
      // changelog が際限なく伸びる形になる。NaN も同じ（NULL としてバインドされる）。
      //
      // 0へ丸めるのは選ばない。0は「今より古いものは残さない」という有効な設定で、
      // 間違いの受け皿にすると、書き損じただけで changelog を全部消してしまう。
      //
      // **接頭辞刈りになってからは、均し忘れの被害が逆向きに大きい。** 綴りが
      // `--1 days` になると「期限切れでないエントリ」が1件も見つからず、境目が
      // `MAX(id) + 1` へ落ちて**changelog を全部消す**。どちらに転んでも困るので、
      // 「古い方だけが消える」という正しい答えをここで固定する。
      //
      // 古い方を**小さいid**に置くこと。掃除は接頭辞しか刈らないので、
      // 新しい方が前に居ると壁になって1件も消えない（それは別のテストが見ている）。
      for (const bad of [-1, NaN]) {
        db.prepare(`DELETE FROM _changelog`).run()
        db.prepare(
          `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
           VALUES (?, ?, ?, ?)`
        ).run('users', 'ancient', 'INSERT', '2020-01-01T00:00:00.000Z')
        db.prepare(
          `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
           VALUES (?, ?, ?, datetime('now', '-1 seconds'))`
        ).run('users', 'recent', 'INSERT')

        // 既定値（7日）として振る舞う: 古い方だけ消えて、最近の方は残る
        expect(cleanupChangelog(db, bad), String(bad)).toBe(1)
        expect(readChangelog(db, 0).map((entry) => entry.recordId)).toEqual([
          'recent',
        ])
      }
    })

    it('保持期間0は有効な設定として尊重する', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
         VALUES (?, ?, ?, datetime('now', '-1 seconds'))`
      ).run('users', 'old', 'INSERT')

      expect(cleanupChangelog(db, 0)).toBe(1)
    })

    it('時刻として解析できないエントリは消さずに残す', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'broken', 'INSERT', 'not-a-timestamp')

      // julianday() が NULL を返し、比較が偽になる。
      // 消せないものを黙って消すより、残す方が安全側。
      expect(cleanupChangelog(db, 7)).toBe(0)
      expect(readChangelog(db, 0)).toHaveLength(1)
    })

    it('旧版のスペース書式でも、時刻として比べて消す', () => {
      // 0.19.0 以前は datetime('now') の秒精度スペース形式で書かれていた。
      // 文字列比較のままだと ' '(0x20) < 'T'(0x54) で常に古く見え、
      // 逆に新しい書式と混ざると比較が壊れる。
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'old-space', 'INSERT', '2020-01-01 00:00:00')
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
         VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))`
      ).run('users', 'new-space', 'INSERT')

      expect(cleanupChangelog(db, 7)).toBe(1)
      expect(readChangelog(db, 0).map((entry) => entry.recordId)).toEqual([
        'new-space',
      ])
    })

    it('消した行の最大idを記録する', () => {
      // 「1件でも消したら MAX(id) へ」と書くと、既読ぶんだけを消した通常の運用で
      // 全端末が毎回フルマージに落ちる。記録するのは**実際に消した行の最大id**。
      for (const [recordId, changedAt] of [
        ['old-1', '2020-01-01T00:00:00.000Z'],
        ['old-2', '2020-01-02T00:00:00.000Z'],
      ]) {
        db.prepare(
          `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
        ).run('users', recordId, 'INSERT', changedAt)
      }
      // 残る側（今の時刻）
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')

      expect(cleanupChangelog(db, 7)).toBe(2)
      // 消えたのは id=1,2。残った id=3 まで進めてはいけない
      expect(readChangelogPrunedThroughId(db)).toBe(2)
    })

    it('1件も消さなければ掃除済みの位置は動かない', () => {
      db.prepare(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', 'Alice', '2024-01-01T00:00:00Z')

      expect(cleanupChangelog(db, 7)).toBe(0)
      expect(readChangelogPrunedThroughId(db)).toBe(0)
      // 動いていないので、まだ何も読んでいない相手から見ても隙間ではない
      expect(hasChangelogGap(db, 0)).toBe(false)
    })

    it('あとから古いぶんだけを消しても、掃除済みの位置は下がらない', () => {
      // 素朴に `INSERT OR REPLACE` で書くと小さい値へ巻き戻り、先に開いた穴が
      // 見えなくなる。`MAX()` を SQL の一文で当てること。
      db.prepare(
        `INSERT INTO _changelog (id, tableName, recordId, operation, changedAt)
         VALUES (5, ?, ?, ?, ?)`
      ).run('users', 'old-5', 'INSERT', '2020-01-01T00:00:00.000Z')
      expect(cleanupChangelog(db, 7)).toBe(1)
      expect(readChangelogPrunedThroughId(db)).toBe(5)

      // あとから、もっと小さいidの古いエントリが1件だけ現れて消える
      db.prepare(
        `INSERT INTO _changelog (id, tableName, recordId, operation, changedAt)
         VALUES (2, ?, ?, ?, ?)`
      ).run('users', 'old-2', 'INSERT', '2020-01-01T00:00:00.000Z')
      expect(cleanupChangelog(db, 7)).toBe(1)
      expect(readChangelogPrunedThroughId(db)).toBe(5)
    })

    it('読めない `changedAt` が壁になったら、そこから先は刈らずに知らせる', () => {
      // 壁の行を消して解決したことにはしない（消せばそれは穴）。残して知らせる。
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'broken', 'INSERT', 'not-a-timestamp')
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'old-behind-wall', 'INSERT', '2020-01-01T00:00:00.000Z')

      expect(cleanupChangelog(db, 7)).toBe(0)
      expect(readChangelog(db, 0)).toHaveLength(2)

      const wall = describeChangelogPruneWall(db, 7)
      expect(wall).toContain('id=1')
      expect(wall).toContain('not-a-timestamp')
      expect(wall).toContain('1 expired')
    })

    it('壁が何も塞いでいなければ黙っている', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'broken', 'INSERT', 'not-a-timestamp')

      // 壁があること自体は害ではない（後ろに刈れないものが居ることが害）
      expect(describeChangelogPruneWall(db, 7)).toBeNull()
    })

    it('削除した行数を返す', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'u1', 'INSERT', '2020-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'u2', 'INSERT', '2020-01-02T00:00:00Z')

      const deleted = cleanupChangelog(db, 7)
      expect(deleted).toBe(2)
    })
  })

  describe('_changelog_prune とスキーマの指紋', () => {
    it('表が増えても `computeSchemaHash` は変わらない', () => {
      // `computeSchemaHash` は設定に挙がった表だけを走査するので、
      // ライブラリが内部で足す表は指紋に効かない。**この事実を固定しておく。**
      // 指紋が変わると相手の `schemaVersion` と食い違い、**相手を全部見送る**
      // ——この表を足したせいで同期が丸ごと止まる、という最悪の形になる。
      const bare = new Database(':memory:')
      bare.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `)
      const before = computeSchemaHash(bare, [{ name: 'users' }])

      setupChangelog(bare, [{ name: 'users' }], 'id')
      expect(
        bare
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='_changelog_prune'`
          )
          .get()
      ).toBeTruthy()

      expect(computeSchemaHash(bare, [{ name: 'users' }])).toBe(before)
      bare.close()
    })

    it('`setupChangelog` は何度通しても同じ形になる（記録も消さない）', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'old', 'INSERT', '2020-01-01T00:00:00.000Z')
      expect(cleanupChangelog(db, 7)).toBe(1)
      expect(readChangelogPrunedThroughId(db)).toBe(1)

      // アプリの起動ごとに通る経路。ここで記録が消えると、開いた穴が見えなくなる
      setupChangelog(db, [{ name: 'users' }], 'id')
      expect(readChangelogPrunedThroughId(db)).toBe(1)
    })
  })
})
