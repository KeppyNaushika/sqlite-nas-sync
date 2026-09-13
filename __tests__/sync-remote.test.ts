/**
 * **取り込み元のDBは、自分と同じ形とは限らない** —— `sync/remote` の読み方を固定する。
 *
 * この層が守っているのは「相手の形が違っても同期全体を止めない」という約束である。
 * 列が無い、表が無い、綴りが違う。どれも例外にせず「分からない」と答えるべき場面だが、
 * 取りこぼしは例外にならないぶん**静かに**効く:
 *
 * - 表名を字面で引くと、相手が `Users`・こちらが `users` というだけで全エントリが
 *   素通りし、しかもカーソルは進むので、その変更は二度と提供されない
 * - tombstone の畳み先を取り逃がすと、受け取った側は畳まずに DELETE して子を道連れにする
 * - 作り直された親を「存在する」だけで生きていると答えると、消えた親を指す子を入れて
 *   外部キー違反を起こし、その相手ぶんの取り込みが丸ごと巻き戻る
 *
 * どれも症状が出るのは組み合わせが揃ったときだけなので、形で固定して残す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import {
  getRemoteTombstone,
  hasMergedIntoColumn,
  makeResurrectionProbe,
  makeTableConfigLookup,
  makeTimestampColumnFor,
  readRemoteRecord,
  resolveFoldTarget,
} from '../src/sync/remote'
import { ensureTombstoneMergedIntoColumn } from '../src/setup/tombstone'
import { TableConfig } from '../src/types'

const testDir = path.join(__dirname, 'test-data-sync-remote')

/** ファイルDBを作る（`:memory:` では他のテストと形を揃えづらいため、実ファイルで揃える） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true })
  return new Database(path.join(testDir, `${name}.sqlite`))
}

/** v0.14.0以前のクライアントのDBの形（`_tombstone` に `mergedInto` が無い） */
function createLegacyTombstone(db: Database.Database): void {
  db.exec(`
    CREATE TABLE _tombstone (
      tableName TEXT NOT NULL,
      recordId  TEXT NOT NULL,
      deletedAt TEXT NOT NULL,
      PRIMARY KEY (tableName, recordId)
    )
  `)
}

/** 現行の形の `_tombstone`（`setupChangelog` が作るものと同じ） */
function createCurrentTombstone(db: Database.Database): void {
  db.exec(`
    CREATE TABLE _tombstone (
      tableName  TEXT NOT NULL,
      recordId   TEXT NOT NULL,
      deletedAt  TEXT NOT NULL,
      mergedInto TEXT,
      PRIMARY KEY (tableName, recordId)
    )
  `)
}

let db: Database.Database

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

afterEach(() => {
  if (db && db.open) db.close()
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('`_tombstone` の形の違いは、読む前に確かめる', () => {
  it('`_tombstone` そのものが無いDBでは「列は無い」と答える（例外にしない）', () => {
    db = createDb('no-tombstone-table')

    // 利用者のDBが `setupChangelog` を通していない場合にこの形になる。
    // ここで例外を投げると、相手1人の形が違うだけで同期全体が止まる
    expect(hasMergedIntoColumn(db)).toBe(false)
    expect(getRemoteTombstone(db, 'tags', 'A')).toBeNull()
  })

  it('v0.14.0以前の `_tombstone`（`mergedInto` 列が無い）では畳み先を null と読む', () => {
    db = createDb('legacy-tombstone')
    createLegacyTombstone(db)
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('tags', 'A', '2026-01-01T00:00:00.000Z')`
    ).run()

    expect(hasMergedIntoColumn(db)).toBe(false)

    // 列が無いDBに対して `mergedInto` を綴ると `no such column` で落ちる。
    // 落とさず「畳み先は無い＝普通の削除」と読めることが、旧版クライアントと
    // 同期を続けられる条件
    const tombstone = getRemoteTombstone(db, 'tags', 'A')
    expect(tombstone).toEqual({
      deletedAt: '2026-01-01T00:00:00.000Z',
      mergedInto: null,
    })
  })

  it('`mergedInto` 列の綴りの大小は畳んで見る', () => {
    db = createDb('mergedinto-case')
    db.exec(`
      CREATE TABLE _tombstone (
        tableName  TEXT NOT NULL,
        recordId   TEXT NOT NULL,
        deletedAt  TEXT NOT NULL,
        MERGEDINTO TEXT,
        PRIMARY KEY (tableName, recordId)
      )
    `)

    // SQLiteの列名比較は大小を区別しないので、`mergedInto` と綴っても引ける。
    // ここで false と答えると、畳み先を持っているDBから畳み先を読み落とす
    expect(hasMergedIntoColumn(db)).toBe(true)
  })

  it('削除された記録が無いレコードは null（「消えていない」と「分からない」を混ぜない）', () => {
    db = createDb('tombstone-absent')
    createCurrentTombstone(db)

    expect(getRemoteTombstone(db, 'tags', 'A')).toBeNull()
  })
})

describe('表名の綴り違いで2行ある `_tombstone` は、1行を選ばず合成する', () => {
  it('最も新しい削除時刻と、主張されている中で最も新しい畳み先を別々に採る', () => {
    db = createDb('tombstone-fold')
    createCurrentTombstone(db)

    // 主キーは BINARY なので、`tags` と `Tags` は別の行として同居できる。
    // 畳みを記録した行（古い）と、そのあと DELETE トリガーが
    // `INSERT OR REPLACE` で書いた畳み先の無い行（新しい）の2行がある形
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('tags', 'A', '2026-01-01T00:00:00.000Z', 'B')`
    ).run()
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('Tags', 'A', '2026-02-01T00:00:00.000Z', NULL)`
    ).run()

    const tombstone = getRemoteTombstone(db, 'tags', 'A')

    // 「新しい方の行」を丸ごと採ると mergedInto が null になり、受け取った側は
    // 畳まずに DELETE して A の子を道連れにする。**畳み先は消えてはならない**
    expect(tombstone).toEqual({
      deletedAt: '2026-02-01T00:00:00.000Z',
      mergedInto: 'B',
    })
  })

  it('畳み先が2つ主張されていれば新しい方を採る', () => {
    db = createDb('tombstone-fold-latest')
    createCurrentTombstone(db)
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('tags', 'A', '2026-01-01T00:00:00.000Z', 'B')`
    ).run()
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
       VALUES ('TAGS', 'A', '2026-03-01T00:00:00.000Z', 'C')`
    ).run()

    expect(getRemoteTombstone(db, 'tags', 'A')).toEqual({
      deletedAt: '2026-03-01T00:00:00.000Z',
      mergedInto: 'C',
    })
  })
})

describe('畳み先として使える値かを正規化する', () => {
  it('自分自身を指す畳み先は畳みではない', () => {
    // 畳む向きが反転したときの後始末でこの形が生まれうる。そのまま使うと
    // 「A を A へ畳む」ことになり、読み替えが自分自身を指して進まなくなる
    expect(resolveFoldTarget('A', 'A')).toBeNull()
    expect(resolveFoldTarget('A', 'B')).toBe('B')
    expect(resolveFoldTarget('A', null)).toBeNull()
    expect(resolveFoldTarget('A', undefined)).toBeNull()
  })
})

describe('取り込み元の行を読む', () => {
  it('取り込み元にその表が無ければ undefined（例外にしない）', () => {
    db = createDb('read-missing-table')
    db.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY, updatedAt TEXT)`)

    // 相手のスキーマにこの表が無いのは、ライブラリのバージョン差や設定差で普通に起こる。
    // ここで投げると、その相手ぶんの取り込みが丸ごと巻き戻る
    expect(readRemoteRecord(db, 'posts', 'id', 'p1')).toBeUndefined()
    expect(readRemoteRecord(db, 'tags', 'id', 'missing')).toBeUndefined()
  })

  it('在る行はそのまま読める', () => {
    db = createDb('read-existing')
    db.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY, updatedAt TEXT)`)
    db.prepare(
      `INSERT INTO tags VALUES ('t1', '2026-01-01T00:00:00.000Z')`
    ).run()

    expect(readRemoteRecord(db, 'tags', 'id', 't1')).toEqual({
      id: 't1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })
})

describe('表名から設定を引くとき、大小は畳む', () => {
  const tables: TableConfig[] = [
    { name: 'users' },
    { name: 'Posts', timestampColumn: 'modifiedAt' },
  ]

  it('相手の綴りで名乗られた表名から自分の設定を引ける', () => {
    const lookup = makeTableConfigLookup(tables)

    // `_changelog` のエントリは**相手の設定どおりの綴り**で表名を名乗る。
    // 字面で引くと全エントリが素通りし、それでもカーソルは進むので、
    // その変更は二度と提供されない（しかも成功として報告される）
    expect(lookup('USERS')?.name).toBe('users')
    expect(lookup('posts')?.name).toBe('Posts')
    expect(lookup('unknown')).toBeUndefined()
  })

  it('時刻列は表ごとに引く（設定に無い表は既定の updatedAt）', () => {
    const timestampColumnFor = makeTimestampColumnFor(tables)

    // 子の設定を親の表に当てると列が見つからず、その先の判断が黙って既定値へ落ちる
    expect(timestampColumnFor('POSTS')).toBe('modifiedAt')
    expect(timestampColumnFor('users')).toBe('updatedAt')
    expect(timestampColumnFor('_heartbeat')).toBe('updatedAt')
  })
})

describe('「今も消えているか」は、行の存在ではなく時刻で答える', () => {
  const timestampColumnFor = makeTimestampColumnFor([
    { name: 'tags' },
    { name: 'posts', timestampColumn: 'modifiedAt' },
  ])

  function createRemote(name: string): Database.Database {
    const remote = createDb(name)
    remote.exec(`
      CREATE TABLE tags (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE posts (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        modifiedAt TEXT NOT NULL
      );
    `)
    return remote
  }

  it('削除より厳密に新しい行だけを「作り直された」と答える', () => {
    db = createRemote('resurrection')
    db.prepare(
      `INSERT INTO tags VALUES ('t1', 'new', '2026-02-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO tags VALUES ('t2', 'stale', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO tags VALUES ('t3', 'same', '2026-01-15T00:00:00.000Z')`
    ).run()

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)
    const deletedAt = '2026-01-15T00:00:00.000Z'

    // 削除より新しい＝削除のあとに作り直された。届いた子はこの親に繋げてよい
    expect(probe('tags', 't1', deletedAt)).toBe(true)
    // **削除をまだ受け取っていない相手はその行を持ったまま。** 存在だけで
    // 「生きている」と答えると、消えた親を指す子を入れて外部キー違反を起こす
    expect(probe('tags', 't2', deletedAt)).toBe(false)
    // 同時刻は作り直しの証拠にならない（厳密に新しいものだけ）
    expect(probe('tags', 't3', deletedAt)).toBe(false)
    // 行そのものが無ければ当然「消えている」
    expect(probe('tags', 'missing', deletedAt)).toBe(false)
  })

  it('時刻列は聞かれた表の設定から引く（呼び出し元の表の列名で引かない）', () => {
    db = createRemote('resurrection-per-table')
    db.prepare(
      `INSERT INTO posts VALUES ('p1', 'title', '2026-02-01T00:00:00.000Z')`
    ).run()

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)

    // `posts` の時刻列は `modifiedAt`。子（`tags`）の列名 `updatedAt` で引くと
    // 列が見つからず、作り直された親を認識できないまま子を捨てる
    expect(probe('posts', 'p1', '2026-01-01T00:00:00.000Z')).toBe(true)
  })

  it('時刻列の値が NULL の行は作り直しと認めない', () => {
    db = createDb('resurrection-null-ts')
    db.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY, updatedAt TEXT)`)
    db.prepare(`INSERT INTO tags VALUES ('t1', NULL)`).run()

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)

    // 時刻が分からない行を「新しい」と読むと、消えたはずの親が生き返る
    expect(probe('tags', 't1', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('取り込み元にその表が無ければ、作り直しの証拠も無い', () => {
    db = createRemote('resurrection-missing-table')

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)

    expect(probe('unknown_table', 'x', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('取り込み元のその表に主キー列が無ければ（スキーマ違い）false を返す', () => {
    db = createDb('resurrection-no-pk-column')
    // 相手は同じ表を別の主キー名で持っている。`WHERE "id" = ?` は prepare の時点で
    // `no such column: id` になるので、ここを拾えないと取り込みが丸ごと止まる
    db.exec(
      `CREATE TABLE tags (uuid TEXT PRIMARY KEY, updatedAt TEXT NOT NULL)`
    )
    db.prepare(
      `INSERT INTO tags VALUES ('t1', '2026-02-01T00:00:00.000Z')`
    ).run()

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)

    expect(probe('tags', 't1', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('時刻列が名乗った名前で無くても updatedAt で代替する', () => {
    db = createDb('resurrection-fallback')
    // 設定は `posts.modifiedAt` だが、相手の `posts` は `updatedAt` しか持たない
    // （設定差やバージョン差で起こる）。代替を引けないと作り直しを見落とす
    db.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY, updatedAt TEXT NOT NULL)`)
    db.prepare(
      `INSERT INTO posts VALUES ('p1', '2026-02-01T00:00:00.000Z')`
    ).run()

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)

    expect(probe('posts', 'p1', '2026-01-01T00:00:00.000Z')).toBe(true)
  })

  it('時刻列も updatedAt も無い表は、作り直しを判断できないので false', () => {
    db = createDb('resurrection-no-ts-column')
    db.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
    db.prepare(`INSERT INTO tags VALUES ('t1', 'x')`).run()

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)

    // 行は在るが時刻が無い。存在だけで「生きている」と答えてはいけない
    expect(probe('tags', 't1', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('一度作った問い合わせが途中で使えなくなっても、その表を false で済ませる', () => {
    db = createRemote('resurrection-broken-statement')
    db.prepare(
      `INSERT INTO tags VALUES ('t1', 'new', '2026-02-01T00:00:00.000Z')`
    ).run()

    const probe = makeResurrectionProbe(db, 'id', timestampColumnFor)
    expect(probe('tags', 't1', '2026-01-01T00:00:00.000Z')).toBe(true)

    // 表ごとの問い合わせは取り込み1回のあいだ使い回される。その途中で表が
    // 読めなくなった場合（相手のコピーが作り直された等）、投げると取り込み全体が
    // 巻き戻る。1つの表が読めないだけなら「証拠が無い」で済ませる
    db.exec(`DROP TABLE tags`)
    expect(probe('tags', 't1', '2026-01-01T00:00:00.000Z')).toBe(false)
  })
})

describe('`_tombstone` の後付けの列は、既存のDBにも足す', () => {
  it('`_tombstone` が無いDBでは何もしない（例外にしない）', () => {
    db = createDb('ensure-no-table')

    // `setupChangelog` を通していないDBをそのまま渡される経路がある。
    // ここで `ALTER TABLE` を試みると落ちる
    expect(() => ensureTombstoneMergedIntoColumn(db)).not.toThrow()
    expect(hasMergedIntoColumn(db)).toBe(false)
  })

  it('`mergedInto` が無い既存DBには足し、あるDBには二度足さない（冪等）', () => {
    db = createDb('ensure-alter')
    createLegacyTombstone(db)
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('tags', 'A', '2026-01-01T00:00:00.000Z')`
    ).run()

    ensureTombstoneMergedIntoColumn(db)
    expect(hasMergedIntoColumn(db)).toBe(true)

    // 既にある行は残る（作り直しではなく列の追加であること）
    expect(getRemoteTombstone(db, 'tags', 'A')).toEqual({
      deletedAt: '2026-01-01T00:00:00.000Z',
      mergedInto: null,
    })

    // 起動ごとに呼ばれるので、2回目以降は何もしないこと
    expect(() => ensureTombstoneMergedIntoColumn(db)).not.toThrow()
    const columns = db.prepare(`PRAGMA table_info(_tombstone)`).all() as {
      name: string
    }[]
    expect(columns.filter((c) => c.name === 'mergedInto')).toHaveLength(1)
  })
})
