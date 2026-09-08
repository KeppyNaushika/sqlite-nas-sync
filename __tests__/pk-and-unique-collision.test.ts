/**
 * 1回のINSERTが「同じ主キーの行」と「別の行のセカンダリUNIQUE」の**両方**にぶつかる場合の
 * 回帰テスト。
 *
 * `applyInsert` は例外の種類ではなく「同じ主キーの行が在るか」だけで分岐していたため、
 * 両方成り立つ入力は必ず主キー側（LWWでUPDATE）へ入り、ユニークを畳む経路には
 * 永久に辿り着かなかった。しかもその UPDATE は catch の中に居るので、そこから出た
 * UNIQUE 例外は `applyInsert` の外へそのまま抜ける。
 *
 * 抜けた例外を受けるのは `performSync` の catch で、そこは取り込みトランザクションの
 * **外側**にある。したがって:
 *
 *  1. その相手から取り込んだぶんが丸ごとロールバックされる（1行が入らないのではない）
 *  2. `lastSeenId` が進まないので、次回も同じ差分を読み、同じ行で同じ例外を出す
 *  3. `performSync` は成功として返る（警告が1本積まれるだけ）
 *
 * 結果として、**その端末からのデータだけが永久に届かない。エラーは何も出ない。**
 *
 * 主キーとセカンダリユニークが両方ぶつかるとき、SQLite が報告するのは
 * `SQLITE_CONSTRAINT_UNIQUE` の方（主キーだけなら `SQLITE_CONSTRAINT_PRIMARYKEY`）。
 * 例外は正しく「別の行とぶつかった」と告げていた。
 *
 * 主キーが決定論的に決まる表（席番号や合成キーから id を作る中間テーブルなど）では、
 * 2端末が同じ id の行を独立に作り、しかも中身が食い違うことが普通に起きる。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { applyInsert, applyUpdate } from '../src/conflict'
import { setupChangelog } from '../src/setup'
import { performSync } from '../src/sync'
import { SyncConfig, TableConfig } from '../src/types'

/** 主キーは席から決まり、ユニークは(試験,生徒)に張られている表 */
const SEAT_TABLES: TableConfig[] = [
  { name: 'exam_students' },
  { name: 'question_scores' },
  { name: 'memos' },
]

const EXAM_STUDENT_COLUMNS = ['id', 'examId', 'studentId', 'updatedAt']

function createSeatDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE exam_students (
      id        TEXT PRIMARY KEY,
      examId    TEXT NOT NULL,
      studentId TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE (examId, studentId)
    )
  `)
  db.exec(`
    CREATE TABLE question_scores (
      id            TEXT PRIMARY KEY,
      examStudentId TEXT NOT NULL REFERENCES exam_students(id) ON DELETE CASCADE,
      regionId      TEXT NOT NULL,
      score         TEXT NOT NULL,
      updatedAt     TEXT NOT NULL
    )
  `)
  // 競合とは何の関係も無い表（changelogギャップを作る下地・同期が詰まっていないことの検査）
  db.exec(`
    CREATE TABLE memos (
      id        TEXT PRIMARY KEY,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `)
  setupChangelog(db, SEAT_TABLES, 'id')
  return db
}

function insertExamStudent(
  db: Database.Database,
  id: string,
  studentId: string,
  updatedAt: string
): void {
  db.prepare(
    `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, 'exam-1', ?, ?)`
  ).run(id, studentId, updatedAt)
}

function insertQuestionScore(
  db: Database.Database,
  id: string,
  examStudentId: string,
  updatedAt: string
): void {
  db.prepare(
    `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
     VALUES (?, ?, 'region-1', '5', ?)`
  ).run(id, examStudentId, updatedAt)
}

function rowsOf(db: Database.Database, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[]
}

describe('主キーとセカンダリUNIQUEに同時にぶつかるINSERT', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createSeatDb(':memory:')
    // 席3の行（届く行と同じ主キー・古い）と、席9の行（届く行のユニークキーを先に持っている）
    insertExamStudent(db, 'seat-3', 'student-1', '2024-01-01T00:00:00Z')
    insertExamStudent(db, 'seat-9', 'student-2', '2024-03-01T00:00:00Z')
  })

  afterEach(() => {
    db.close()
  })

  /** 席3の行として届く「生徒2に割り当て直した」版 */
  const arrivingSeat3 = (updatedAt: string): Record<string, unknown> => ({
    id: 'seat-3',
    examId: 'exam-1',
    studentId: 'student-2',
    updatedAt,
  })

  it('リモートが新しいとき、例外を抜けさせず1行へ畳む', () => {
    const result = applyInsert(
      db,
      'exam_students',
      'id',
      arrivingSeat3('2024-06-01T00:00:00Z'),
      EXAM_STUDENT_COLUMNS
    )

    expect(result.action).toBe('upserted')
    expect(result.conflict?.resolution).toBe('remote_wins')
    expect(
      rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`)
    ).toEqual([{ id: 'seat-3', studentId: 'student-2' }])
    // 消えた席9は「あの行へ畳まれた」として記録され、他端末にも伝わる
    expect(result.folds).toEqual([
      {
        tableName: 'exam_students',
        losingId: 'seat-9',
        winningId: 'seat-3',
        removedLocalRow: true,
        movedChildren: 0,
        lostChildren: 0,
      },
    ])
    expect(rowsOf(db, `SELECT recordId, mergedInto FROM _tombstone`)).toEqual([
      { recordId: 'seat-9', mergedInto: 'seat-3' },
    ])
  })

  it('ローカルが新しいとき（元から通っていた向き）も投げず、届いた版を採らない', () => {
    const result = applyInsert(
      db,
      'exam_students',
      'id',
      arrivingSeat3('2023-06-01T00:00:00Z'),
      EXAM_STUDENT_COLUMNS
    )

    // 届いた版は書いていないので `upserted` ではない（`applyUpdate` と同じ呼び方）
    expect(result.action).toBe('skipped')
    expect(result.conflict?.resolution).toBe('local_wins')
    expect(result.folds).toEqual([])
    expect(
      rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`)
    ).toEqual([
      { id: 'seat-3', studentId: 'student-1' },
      { id: 'seat-9', studentId: 'student-2' },
    ])
  })

  it('畳んで消える行の子は、勝った行へ付け替わって生き残る', () => {
    insertQuestionScore(db, 'qs-3', 'seat-3', '2024-01-01T00:00:00Z')
    insertQuestionScore(db, 'qs-9', 'seat-9', '2024-03-01T00:00:00Z')

    const result = applyInsert(
      db,
      'exam_students',
      'id',
      arrivingSeat3('2024-06-01T00:00:00Z'),
      EXAM_STUDENT_COLUMNS
    )

    expect(result.action).toBe('upserted')
    // カスケードで道連れになっていない
    expect(
      rowsOf(db, `SELECT id, examStudentId FROM question_scores ORDER BY id`)
    ).toEqual([
      { id: 'qs-3', examStudentId: 'seat-3' },
      { id: 'qs-9', examStudentId: 'seat-3' },
    ])
    expect(result.folds[0].movedChildren).toBe(1)
    expect(result.folds[0].lostChildren).toBe(0)
  })

  it('ローカル行が勝つ相手が居れば、更新対象の行の方を勝者へ畳む（届いた版を黙って捨てない）', () => {
    // 席9の方が届いた版より新しい → 席3（更新対象）が席9へ畳まれる
    insertQuestionScore(db, 'qs-3', 'seat-3', '2024-01-01T00:00:00Z')

    const result = applyInsert(
      db,
      'exam_students',
      'id',
      arrivingSeat3('2024-02-01T00:00:00Z'),
      EXAM_STUDENT_COLUMNS
    )

    expect(result.conflict?.resolution).toBe('local_wins')
    expect(
      rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`)
    ).toEqual([{ id: 'seat-9', studentId: 'student-2' }])
    // 席3の子は席9へ引き取られる
    expect(rowsOf(db, `SELECT id, examStudentId FROM question_scores`)).toEqual(
      [{ id: 'qs-3', examStudentId: 'seat-9' }]
    )
    expect(result.folds).toEqual([
      {
        tableName: 'exam_students',
        losingId: 'seat-3',
        winningId: 'seat-9',
        removedLocalRow: true,
        movedChildren: 1,
        lostChildren: 0,
      },
    ])
  })
})

describe('主キー衝突と同時に、ユニーク索引ごとに別々の相手へぶつかるINSERT', () => {
  let db: Database.Database
  const columns = ['id', 'examId', 'studentId', 'seatCode', 'updatedAt']

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE seats (
        id        TEXT PRIMARY KEY,
        examId    TEXT NOT NULL,
        studentId TEXT NOT NULL,
        seatCode  TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (examId, studentId),
        UNIQUE (examId, seatCode)
      )
    `)
    setupChangelog(db, [{ name: 'seats' }], 'id')
    const insert = db.prepare(
      `INSERT INTO seats (id, examId, studentId, seatCode, updatedAt)
       VALUES (?, 'exam-1', ?, ?, ?)`
    )
    // 届く行と同じ主キー
    insert.run('row-1', 'student-1', 'seat-01', '2024-01-01T00:00:00Z')
    // 届く行の studentId を持っている相手
    insert.run('row-2', 'student-2', 'seat-02', '2024-02-01T00:00:00Z')
    // 届く行の seatCode を持っている相手
    insert.run('row-3', 'student-3', 'seat-03', '2024-02-01T00:00:00Z')
  })

  afterEach(() => {
    db.close()
  })

  const arriving = (updatedAt: string): Record<string, unknown> => ({
    id: 'row-1',
    examId: 'exam-1',
    studentId: 'student-2',
    seatCode: 'seat-03',
    updatedAt,
  })

  it('全員に勝てば、索引ごとの相手をまとめて1行へ畳む', () => {
    const result = applyInsert(
      db,
      'seats',
      'id',
      arriving('2024-06-01T00:00:00Z'),
      columns
    )

    expect(result.conflict?.resolution).toBe('remote_wins')
    expect(
      rowsOf(db, `SELECT id, studentId, seatCode FROM seats ORDER BY id`)
    ).toEqual([{ id: 'row-1', studentId: 'student-2', seatCode: 'seat-03' }])
    expect(
      result.folds.map((fold) => `${fold.losingId}->${fold.winningId}`).sort()
    ).toEqual(['row-2->row-1', 'row-3->row-1'])
  })

  it('1人でも勝てない相手が居れば、どの相手も畳まない', () => {
    // row-3 の方が新しい → 届いた版は通せない
    db.prepare(`UPDATE seats SET updatedAt = ? WHERE id = 'row-3'`).run(
      '2024-09-01T00:00:00Z'
    )

    const result = applyInsert(
      db,
      'seats',
      'id',
      arriving('2024-06-01T00:00:00Z'),
      columns
    )

    expect(result.conflict?.resolution).toBe('local_wins')
    // 相手は2つとも無傷。畳まれたのは更新対象の row-1 だけ
    expect(rowsOf(db, `SELECT id FROM seats ORDER BY id`)).toEqual([
      { id: 'row-2' },
      { id: 'row-3' },
    ])
    expect(
      result.folds.map((fold) => `${fold.losingId}->${fold.winningId}`)
    ).toEqual(['row-1->row-3'])
  })

  it('部分索引のユニークで落ちた場合は、相手を引けないので元の例外を投げる', () => {
    db.exec(`
      CREATE TABLE partial_rows (
        id        TEXT PRIMARY KEY,
        code      TEXT NOT NULL,
        active    INTEGER NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    db.exec(
      `CREATE UNIQUE INDEX partial_rows_code ON partial_rows (code) WHERE active = 1`
    )
    const insert = db.prepare(
      `INSERT INTO partial_rows (id, code, active, updatedAt) VALUES (?, ?, 1, ?)`
    )
    insert.run('p-1', 'code-1', '2024-01-01T00:00:00Z')
    insert.run('p-2', 'code-2', '2024-01-01T00:00:00Z')

    // 主キー p-1 は在り、code-2 は p-2 が持っている（部分索引なので先に数えられない）
    expect(() =>
      applyInsert(
        db,
        'partial_rows',
        'id',
        {
          id: 'p-1',
          code: 'code-2',
          active: 1,
          updatedAt: '2024-06-01T00:00:00Z',
        },
        ['id', 'code', 'active', 'updatedAt']
      )
    ).toThrow(/UNIQUE/)
  })
})

describe('2端末が同じ席の行を独立に作った場合の収束', () => {
  const testDir = path.join(__dirname, 'test-data-pk-unique')
  const nasDir = path.join(testDir, 'nas')

  function makeClient(clientId: string): {
    db: Database.Database
    config: SyncConfig
  } {
    const clientDir = path.join(testDir, clientId)
    fs.mkdirSync(clientDir, { recursive: true })
    const dbPath = path.join(clientDir, 'local.sqlite')
    return {
      db: createSeatDb(dbPath),
      config: {
        dbPath,
        nasPath: nasDir,
        clientId,
        primaryKey: 'id',
        changelogRetentionDays: 7,
      },
    }
  }

  beforeEach(() => {
    fs.mkdirSync(nasDir, { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
  })

  it('両端末が同じ1行へ揃い、どちらの子も失われない', async () => {
    // A: 席3を生徒2へ割り当てた（新しい）
    const { db: dbA, config: configA } = makeClient('client-a')
    insertExamStudent(dbA, 'seat-3', 'student-2', '2024-06-01T00:00:00Z')
    insertQuestionScore(dbA, 'qs-a', 'seat-3', '2024-06-01T00:00:00Z')

    // B: 席3は生徒1（古い）。生徒2は席9に居る
    const { db: dbB, config: configB } = makeClient('client-b')
    insertExamStudent(dbB, 'seat-3', 'student-1', '2024-01-01T00:00:00Z')
    insertExamStudent(dbB, 'seat-9', 'student-2', '2024-03-01T00:00:00Z')
    insertQuestionScore(dbB, 'qs-b', 'seat-9', '2024-03-01T00:00:00Z')

    const syncBoth = async (round: number): Promise<void> => {
      const resultA = await performSync(dbA, configA, SEAT_TABLES)
      const resultB = await performSync(dbB, configB, SEAT_TABLES)
      // 例外がトランザクションの外へ抜けると、警告1本を残して「成功」で返る
      expect(
        [...resultA.warnings, ...resultB.warnings].filter((warning) =>
          warning.includes('Sync failed')
        ),
        `round ${round}`
      ).toEqual([])
    }

    for (let round = 0; round < 3; round++) await syncBoth(round)

    const snapshot = (db: Database.Database): string =>
      JSON.stringify([
        rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`),
        rowsOf(db, `SELECT id, examStudentId FROM question_scores ORDER BY id`),
      ])

    expect(snapshot(dbA)).toBe(snapshot(dbB))

    // 生き残るidが毎周入れ替わる（振動する）と、ここで動く
    const converged = snapshot(dbA)
    for (let round = 3; round < 6; round++) {
      await syncBoth(round)
      expect(snapshot(dbA), `round ${round} A`).toBe(converged)
      expect(snapshot(dbB), `round ${round} B`).toBe(converged)
    }
    expect(rowsOf(dbA, `SELECT id, studentId FROM exam_students`)).toEqual([
      { id: 'seat-3', studentId: 'student-2' },
    ])
    // 採点はどちらの端末のぶんも、生き残った行にぶら下がって残る
    expect(
      rowsOf(dbA, `SELECT id, examStudentId FROM question_scores ORDER BY id`)
    ).toEqual([
      { id: 'qs-a', examStudentId: 'seat-3' },
      { id: 'qs-b', examStudentId: 'seat-3' },
    ])

    dbA.close()
    dbB.close()
  })

  it('同時刻でも主キーの辞書順で決まるので、生き残るidが毎周入れ替わらない', async () => {
    // 両端末の「生徒2の行」がまったく同じ時刻。時刻では勝敗が付かない
    const { db: dbA, config: configA } = makeClient('client-a')
    insertExamStudent(dbA, 'seat-3', 'student-2', '2024-06-01T00:00:00Z')

    const { db: dbB, config: configB } = makeClient('client-b')
    insertExamStudent(dbB, 'seat-3', 'student-1', '2024-01-01T00:00:00Z')
    insertExamStudent(dbB, 'seat-9', 'student-2', '2024-06-01T00:00:00Z')

    for (let round = 0; round < 4; round++) {
      await performSync(dbA, configA, SEAT_TABLES)
      await performSync(dbB, configB, SEAT_TABLES)
    }

    // 辞書順で小さい seat-3 が両端末で生き残る（「同点ならローカルが勝つ」だと
    // 両端末が逆向きに畳み合い、永久に振動する）
    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(
        rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`),
        `client-${label}`
      ).toEqual([{ id: 'seat-3', studentId: 'student-2' }])
    }

    dbA.close()
    dbB.close()
  })

  /**
   * ケース1 で**ローカル行が勝つ**向き。届いた版は採用されず、畳みも起きない。
   *
   * このとき重複したユニークキーは残らない — 生き残るローカル行が (E,S1) を名乗るので、
   * (E,S2) を持つのは席9だけになり、そもそも畳む対象が無い。逆に、ここで「ユニークが
   * 重複しているから」と畳んでしまうと、**片側だけ行が消えて行の集合が食い違う**。
   * 収束したかどうかだけでなく、両端末の行の集合が一致することを見る。
   */
  it('ローカル行が勝つ向きでは畳みが起きず、両端末の行の集合が一致する', async () => {
    // A: 席3は生徒1（新しい）。生徒2は席9に居る
    const { db: dbA, config: configA } = makeClient('client-a')
    insertExamStudent(dbA, 'seat-3', 'student-1', '2024-06-01T00:00:00Z')
    insertExamStudent(dbA, 'seat-9', 'student-2', '2024-03-01T00:00:00Z')
    insertQuestionScore(dbA, 'qs-a', 'seat-9', '2024-03-01T00:00:00Z')

    // B: 席3は生徒2（古い）
    const { db: dbB, config: configB } = makeClient('client-b')
    insertExamStudent(dbB, 'seat-3', 'student-2', '2024-01-01T00:00:00Z')
    insertQuestionScore(dbB, 'qs-b', 'seat-3', '2024-01-01T00:00:00Z')

    const snapshot = (db: Database.Database): string =>
      JSON.stringify([
        rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`),
        rowsOf(db, `SELECT id, examStudentId FROM question_scores ORDER BY id`),
      ])

    for (let round = 0; round < 4; round++) {
      const resultA = await performSync(dbA, configA, SEAT_TABLES)
      const resultB = await performSync(dbB, configB, SEAT_TABLES)
      expect(
        [...resultA.warnings, ...resultB.warnings].filter((warning) =>
          warning.includes('Sync failed')
        ),
        `round ${round}`
      ).toEqual([])
    }

    // 行の集合が一致する（片方だけ席9を畳んで消していれば、ここで食い違う）
    expect(snapshot(dbA)).toBe(snapshot(dbB))
    // 2行のまま。ローカルが勝った側の (E,S1) が残り、(E,S2) は席9だけが持つ
    expect(
      rowsOf(dbA, `SELECT id, studentId FROM exam_students ORDER BY id`)
    ).toEqual([
      { id: 'seat-3', studentId: 'student-1' },
      { id: 'seat-9', studentId: 'student-2' },
    ])
    // 畳みが起きていないので、どちらの端末の子もそれぞれの親に付いたまま
    expect(
      rowsOf(dbA, `SELECT id, examStudentId FROM question_scores ORDER BY id`)
    ).toEqual([
      { id: 'qs-a', examStudentId: 'seat-9' },
      { id: 'qs-b', examStudentId: 'seat-3' },
    ])
    // 畳んでいないのだから、畳み先の記録も残らない
    expect(rowsOf(dbA, `SELECT recordId, mergedInto FROM _tombstone`)).toEqual(
      []
    )
    expect(rowsOf(dbB, `SELECT recordId, mergedInto FROM _tombstone`)).toEqual(
      []
    )

    dbA.close()
    dbB.close()
  })

  it('競合の経緯を知らない3台目も、同じ1行へ追いつく', async () => {
    const { db: dbA, config: configA } = makeClient('client-a')
    insertExamStudent(dbA, 'seat-3', 'student-2', '2024-06-01T00:00:00Z')
    insertQuestionScore(dbA, 'qs-a', 'seat-3', '2024-06-01T00:00:00Z')

    const { db: dbB, config: configB } = makeClient('client-b')
    insertExamStudent(dbB, 'seat-3', 'student-1', '2024-01-01T00:00:00Z')
    insertExamStudent(dbB, 'seat-9', 'student-2', '2024-03-01T00:00:00Z')
    insertQuestionScore(dbB, 'qs-b', 'seat-9', '2024-03-01T00:00:00Z')

    // 3台目は席3の更に別の版を独立に持っている（3者とも主キーがぶつかる）
    const { db: dbC, config: configC } = makeClient('client-c')
    insertExamStudent(dbC, 'seat-3', 'student-3', '2024-02-01T00:00:00Z')
    insertQuestionScore(dbC, 'qs-c', 'seat-3', '2024-02-01T00:00:00Z')

    const clients = [
      ['A', dbA, configA],
      ['B', dbB, configB],
      ['C', dbC, configC],
    ] as const

    for (let round = 0; round < 4; round++) {
      for (const [label, db, config] of clients) {
        const result = await performSync(db, config, SEAT_TABLES)
        expect(
          result.warnings.filter((warning) => warning.includes('Sync failed')),
          `round ${round} client-${label}`
        ).toEqual([])
      }
    }

    const snapshot = (db: Database.Database): string =>
      JSON.stringify([
        rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`),
        rowsOf(db, `SELECT id, examStudentId FROM question_scores ORDER BY id`),
      ])

    // 3台とも、いちばん新しい席3の版へ揃う
    for (const [label, db] of clients) {
      expect(
        rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`),
        `client-${label}`
      ).toEqual([{ id: 'seat-3', studentId: 'student-2' }])
      expect(snapshot(db), `client-${label}`).toBe(snapshot(dbA))
    }
    // 3台ぶんの採点がすべて生き残る
    expect(
      rowsOf(dbA, `SELECT id, examStudentId FROM question_scores ORDER BY id`)
    ).toEqual([
      { id: 'qs-a', examStudentId: 'seat-3' },
      { id: 'qs-b', examStudentId: 'seat-3' },
      { id: 'qs-c', examStudentId: 'seat-3' },
    ])

    dbA.close()
    dbB.close()
    dbC.close()
  })

  it('フルマージ経路（changelogギャップ）でも同じ形が畳まれる', async () => {
    const { db: dbA, config: configA } = makeClient('client-a')
    dbA
      .prepare(`INSERT INTO memos (id, body, updatedAt) VALUES (?, ?, ?)`)
      .run('memo-0', '同期の下地', '2023-01-01T00:00:00Z')
    await performSync(dbA, configA, SEAT_TABLES)

    // Bが一度同期して lastSeenId を持つ（これが無いとギャップ判定にならない）
    const { db: dbB, config: configB } = makeClient('client-b')
    await performSync(dbB, configB, SEAT_TABLES)

    // Aが席3を作り、changelogは保持期間切れで消えたことにする
    insertExamStudent(dbA, 'seat-3', 'student-2', '2024-06-01T00:00:00Z')
    insertQuestionScore(dbA, 'qs-a', 'seat-3', '2024-06-01T00:00:00Z')
    dbA.exec(`DELETE FROM _changelog`)
    await performSync(dbA, configA, SEAT_TABLES)

    // Bは席3の古い版と、生徒2を持つ席9を独立に持っている
    insertExamStudent(dbB, 'seat-3', 'student-1', '2024-01-01T00:00:00Z')
    insertExamStudent(dbB, 'seat-9', 'student-2', '2024-03-01T00:00:00Z')
    insertQuestionScore(dbB, 'qs-b', 'seat-9', '2024-03-01T00:00:00Z')

    const fullMerge = await performSync(dbB, configB, SEAT_TABLES)
    expect(fullMerge.hadChangelogGap).toBe(true)
    expect(
      fullMerge.warnings.filter((warning) => warning.includes('Sync failed'))
    ).toEqual([])

    await performSync(dbA, configA, SEAT_TABLES)
    await performSync(dbB, configB, SEAT_TABLES)

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(
        rowsOf(db, `SELECT id, studentId FROM exam_students ORDER BY id`),
        `client-${label}`
      ).toEqual([{ id: 'seat-3', studentId: 'student-2' }])
      expect(
        rowsOf(db, `SELECT id, examStudentId FROM question_scores ORDER BY id`),
        `client-${label}`
      ).toEqual([
        { id: 'qs-a', examStudentId: 'seat-3' },
        { id: 'qs-b', examStudentId: 'seat-3' },
      ])
    }

    dbA.close()
    dbB.close()
  })
})

describe('公開APIを直接呼んだときの「書く列が無い」', () => {
  /**
   * 同期経路からは到達しない — `discoverTables` がタイムスタンプ列の無い表を同期対象から
   * 外すので、`columns`（表の全列）には必ずその列が残る。到達するのは公開API
   * （`index.ts` が export する `applyInsert` / `applyUpdate`）を直接呼び、`columns` が
   * 表や record と食い違っている場合だけ。以前はそこで SQLite の
   * `near "WHERE": syntax error` が出ていて、原因を何も指していなかった。
   */
  it('columns が主キーだけなら、原因を名指しして止まる', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE only_pk (id TEXT PRIMARY KEY)`)
    db.prepare(`INSERT INTO only_pk (id) VALUES ('a')`).run()

    // record 側にだけタイムスタンプが有るのでLWWは「リモートが新しい」と判定し、
    // 書く列が1つも無いまま書き込みへ進む
    const arriving = { id: 'a', updatedAt: '2024-06-01T00:00:00Z' }
    expect(() => applyInsert(db, 'only_pk', 'id', arriving, ['id'])).toThrow(
      /holds only the primary key/
    )
    expect(() => applyUpdate(db, 'only_pk', 'id', arriving, ['id'])).toThrow(
      /holds only the primary key/
    )

    db.close()
  })

  it('主キーとタイムスタンプだけの表は、列を正しく渡せば普通に書ける', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE pk_ts (id TEXT PRIMARY KEY, updatedAt TEXT NOT NULL)`)
    db.prepare(`INSERT INTO pk_ts VALUES ('a', '2024-01-01T00:00:00Z')`).run()

    const result = applyInsert(
      db,
      'pk_ts',
      'id',
      { id: 'a', updatedAt: '2024-06-01T00:00:00Z' },
      ['id', 'updatedAt']
    )

    expect(result.conflict?.resolution).toBe('remote_wins')
    expect(rowsOf(db, `SELECT * FROM pk_ts`)).toEqual([
      { id: 'a', updatedAt: '2024-06-01T00:00:00Z' },
    ])
    db.close()
  })
})
