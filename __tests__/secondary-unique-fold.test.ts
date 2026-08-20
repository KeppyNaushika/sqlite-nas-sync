/**
 * セカンダリUNIQUE違反を畳むとき、負けた行の子がどうなるかの回帰テスト。
 *
 * 2端末が同じ論理エンティティ（同じユニークキー）の行を独立に作ると、
 * 中身は同じで主キーだけ違う行が2つできる。`applyInsert` はこれをLWWで1行に畳むが、
 * 畳み方が「負けた行を削除する」だけだと2つの壊れ方をする:
 *
 *  1. 負けた行を指している子がカスケードで道連れになる（データが世界から消える）
 *  2. 勝った端末には負けた行が入らないため、あとから届く相手の子がFK違反になり、
 *     相手1人ぶんの取り込みが丸ごと巻き戻る（その相手からの同期が永久に止まる）
 *
 * どちらも `warnings` に積まれるだけで `performSync` は成功として返るため、
 * 利用者からは何も起きていないように見える。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { performSync } from '../src/sync';
import { SyncConfig, TableConfig } from '../src/types';

describe('セカンダリUNIQUE違反で負けた行の子の引き取り', () => {
  const testDir = path.join(__dirname, 'test-data-fold');
  const nasDir = path.join(testDir, 'nas');

  const TABLES: TableConfig[] = [
    { name: 'exam_students' },
    { name: 'question_scores' },
    { name: 'score_notes' },
    { name: 'memos' },
  ];

  /**
   * 実アプリの形（ExamStudent / QuestionScore / それ以外の無関係テーブル）を写した
   * クライアントDBを作る。親は複合ユニーク、子はカスケード、孫もカスケード。
   */
  function createClientDb(clientId: string): {
    db: Database.Database;
    dbPath: string;
  } {
    const clientDir = path.join(testDir, clientId);
    fs.mkdirSync(clientDir, { recursive: true });
    const dbPath = path.join(clientDir, 'local.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE exam_students (
        id        TEXT PRIMARY KEY,
        examId    TEXT NOT NULL,
        studentId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (examId, studentId)
      )
    `);
    db.exec(`
      CREATE TABLE question_scores (
        id            TEXT PRIMARY KEY,
        examStudentId TEXT NOT NULL REFERENCES exam_students(id) ON DELETE CASCADE,
        regionId      TEXT NOT NULL,
        score         TEXT NOT NULL,
        updatedAt     TEXT NOT NULL,
        UNIQUE (examStudentId, regionId)
      )
    `);
    db.exec(`
      CREATE TABLE score_notes (
        id              TEXT PRIMARY KEY,
        questionScoreId TEXT NOT NULL REFERENCES question_scores(id) ON DELETE CASCADE,
        body            TEXT NOT NULL,
        updatedAt       TEXT NOT NULL
      )
    `);
    // 競合とは何の関係も無いテーブル（同期が詰まっていないことの検査に使う）
    db.exec(`
      CREATE TABLE memos (
        id        TEXT PRIMARY KEY,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');
    return { db, dbPath };
  }

  function makeConfig(dbPath: string, clientId: string): SyncConfig {
    return {
      dbPath,
      nasPath: nasDir,
      clientId,
      primaryKey: 'id',
      changelogRetentionDays: 7,
    };
  }

  /** 2端末が同じ(examId, studentId)の生徒を独立に作り、それぞれに採点を持たせる。 */
  function seedIndependentDuplicates(): {
    dbA: Database.Database;
    pathA: string;
    dbB: Database.Database;
    pathB: string;
  } {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-a', 'exam-1', 'student-1', '2024-01-01T00:00:00Z');
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-a', 'es-a', 'region-1', '5', '2024-01-01T00:00:00Z');
    dbA.prepare(
      `INSERT INTO score_notes (id, questionScoreId, body, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('note-a', 'qs-a', 'A先生のメモ', '2024-01-01T00:00:00Z');

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-b', 'exam-1', 'student-1', '2024-06-01T00:00:00Z');
    dbB.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-b', 'es-b', 'region-2', '8', '2024-06-01T00:00:00Z');

    return { dbA, pathA, dbB, pathB };
  }

  function idsOf(db: Database.Database, sql: string): string[] {
    return (db.prepare(sql).all() as { id: string }[]).map((row) => row.id).sort();
  }

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(nasDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('負けた行の子が消えず、勝った行の子として両端末に残る', async () => {
    const { dbA, pathA, dbB, pathB } = seedIndependentDuplicates();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      // 生徒は1行に畳まれ、新しい方（es-b）が残る
      expect(idsOf(db, `SELECT id FROM exam_students`), `client-${label}`).toEqual(['es-b']);
      // 採点は両方とも残り、勝った生徒にぶら下がる
      expect(idsOf(db, `SELECT id FROM question_scores`), `client-${label}`).toEqual([
        'qs-a',
        'qs-b',
      ]);
      const parents = (
        db.prepare(`SELECT DISTINCT examStudentId AS id FROM question_scores`).all() as {
          id: string;
        }[]
      ).map((row) => row.id);
      expect(parents, `client-${label}`).toEqual(['es-b']);
      // 孫（採点のメモ）も道連れになっていない
      expect(idsOf(db, `SELECT id FROM score_notes`), `client-${label}`).toEqual(['note-a']);
    }

    dbA.close();
    dbB.close();
  });

  it('勝った側の同期が詰まらず、同じ相手の無関係な変更も届く', async () => {
    const { dbA, pathA, dbB, pathB } = seedIndependentDuplicates();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // B（勝つ側）がAの変更を取り込む — ここで敗者es-aの子qs-aがFK違反になると
    // Aぶんの取り込みが丸ごと巻き戻り、lastSeenId も進まない
    const firstPull = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(
      firstPull.warnings.filter((warning) => warning.includes('FOREIGN KEY'))
    ).toEqual([]);
    expect(firstPull.clientsSynced).toBe(1);

    // 競合のあとでAが無関係なテーブルへ書く
    dbA.prepare(`INSERT INTO memos (id, body, updatedAt) VALUES (?, ?, ?)`).run(
      'memo-1',
      '競合とは無関係な変更',
      '2024-07-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // 何度同期しても同じ場所で落ち続けるなら、この変更は永久に届かない
    for (let i = 0; i < 3; i++) {
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(result.clientsSynced).toBe(1);
      expect(result.warnings.filter((warning) => warning.includes('FOREIGN KEY'))).toEqual([]);
    }

    expect(idsOf(dbB, `SELECT id FROM memos`)).toEqual(['memo-1']);

    dbA.close();
    dbB.close();
  });

  it('収束したあとは何度同期しても状態が動かず、あとから参加した3台目も同じ形になる', async () => {
    const { dbA, pathA, dbB, pathB } = seedIndependentDuplicates();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    const snapshot = (db: Database.Database): string =>
      JSON.stringify([
        db.prepare(`SELECT id FROM exam_students ORDER BY id`).all(),
        db
          .prepare(`SELECT id, examStudentId FROM question_scores ORDER BY id`)
          .all(),
        db.prepare(`SELECT id, questionScoreId FROM score_notes ORDER BY id`).all(),
      ]);

    const converged = snapshot(dbA);
    expect(snapshot(dbB)).toBe(converged);

    // 付け替え合いが延々と続かないこと
    for (let i = 0; i < 3; i++) {
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }
    expect(snapshot(dbA)).toBe(converged);
    expect(snapshot(dbB)).toBe(converged);

    // 競合の経緯を何も知らない3台目が、同じ状態へ追いつく
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    const resultC = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    expect(resultC.warnings.filter((warning) => warning.includes('FOREIGN KEY'))).toEqual(
      []
    );
    expect(snapshot(dbC)).toBe(converged);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('フルマージ経路（changelogギャップ）でも負けた行の子が消えない', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO memos (id, body, updatedAt) VALUES (?, ?, ?)`).run(
      'memo-0',
      '同期の下地',
      '2023-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // Bが一度同期して lastSeenId を持つ（これが無いとギャップ判定にならない）
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // Aが生徒と採点を作り、changelogは7日経過で消えたことにする
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-a', 'exam-1', 'student-1', '2024-01-01T00:00:00Z');
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-a', 'es-a', 'region-1', '5', '2024-01-01T00:00:00Z');
    dbA.prepare(
      `INSERT INTO score_notes (id, questionScoreId, body, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('note-a', 'qs-a', 'A先生のメモ', '2024-01-01T00:00:00Z');
    dbA.exec(`DELETE FROM _changelog`);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // Bは同じ生徒を独立に作っており、ギャップ検出でフルマージへ入る
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-b', 'exam-1', 'student-1', '2024-06-01T00:00:00Z');
    dbB.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-b', 'es-b', 'region-2', '8', '2024-06-01T00:00:00Z');

    const fullMerge = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(fullMerge.hadChangelogGap).toBe(true);
    expect(fullMerge.warnings.filter((warning) => warning.includes('FOREIGN KEY'))).toEqual(
      []
    );

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(idsOf(db, `SELECT id FROM exam_students`), `client-${label}`).toEqual(['es-b']);
      expect(idsOf(db, `SELECT id FROM question_scores`), `client-${label}`).toEqual([
        'qs-a',
        'qs-b',
      ]);
      expect(idsOf(db, `SELECT id FROM score_notes`), `client-${label}`).toEqual(['note-a']);
    }

    dbA.close();
    dbB.close();
  });

  it('ユニーク衝突で付け替える側が負けた場合、その孫は生き残った側へ引き取られる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-a', 'exam-1', 'student-1', '2024-01-01T00:00:00Z');
    // 勝つ側の子（qs-b）より古い子。付け替えの衝突では負ける
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-a', 'es-a', 'region-1', '5', '2024-02-01T00:00:00Z');
    dbA.prepare(
      `INSERT INTO score_notes (id, questionScoreId, body, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('note-a', 'qs-a', 'A先生のメモ', '2024-02-01T00:00:00Z');

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-b', 'exam-1', 'student-1', '2024-06-01T00:00:00Z');
    dbB.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-b', 'es-b', 'region-1', '8', '2024-06-01T00:00:00Z');

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(idsOf(db, `SELECT id FROM exam_students`), `client-${label}`).toEqual(['es-b']);
      expect(idsOf(db, `SELECT id FROM question_scores`), `client-${label}`).toEqual(['qs-b']);
      // 畳まれて消えた qs-a の孫は、生き残った qs-b へ移る
      const noteParents = (
        db.prepare(`SELECT id, questionScoreId FROM score_notes`).all() as {
          id: string;
          questionScoreId: string;
        }[]
      ).map((note) => `${note.id}->${note.questionScoreId}`);
      expect(noteParents, `client-${label}`).toEqual(['note-a->qs-b']);
    }

    dbA.close();
    dbB.close();
  });

  it('付け替えた子が子自身のユニークにぶつかる場合もLWWで畳まれ、その孫も引き取られる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-a', 'exam-1', 'student-1', '2024-01-01T00:00:00Z');
    // 勝つ側の子と同じ (regionId) を持つ子 — 付け替えると子自身のユニークにぶつかる
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-a', 'es-a', 'region-1', '5', '2024-08-01T00:00:00Z');
    dbA.prepare(
      `INSERT INTO score_notes (id, questionScoreId, body, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('note-a', 'qs-a', 'A先生のメモ', '2024-08-01T00:00:00Z');

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('es-b', 'exam-1', 'student-1', '2024-06-01T00:00:00Z');
    dbB.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run('qs-b', 'es-b', 'region-1', '8', '2024-06-01T00:00:00Z');

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(idsOf(db, `SELECT id FROM exam_students`), `client-${label}`).toEqual(['es-b']);
      // (examStudentId, regionId) が同じ2つの採点は1つに畳まれ、新しい方（qs-a）が残る
      expect(idsOf(db, `SELECT id FROM question_scores`), `client-${label}`).toEqual(['qs-a']);
      // 畳まれて消えた側にぶら下がっていた孫も、生き残った側へ引き取られる
      expect(idsOf(db, `SELECT id FROM score_notes`), `client-${label}`).toEqual(['note-a']);
      const noteParents = (
        db.prepare(`SELECT DISTINCT questionScoreId AS id FROM score_notes`).all() as {
          id: string;
        }[]
      ).map((row) => row.id);
      expect(noteParents, `client-${label}`).toEqual(['qs-a']);
    }

    dbA.close();
    dbB.close();
  });
});
