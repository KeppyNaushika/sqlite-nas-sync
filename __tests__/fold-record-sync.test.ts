/**
 * 畳みの記録が**端末をまたいで**どう伝わるかの回帰テスト。
 *
 * 1台のDBだけを見ていると「記録は正しい」で通ってしまう壊れ方がある。
 * ここでは実際に `performSync` を回し、両端末が同じ1行へ収束すること、
 * 収束したあとに古い版が復活しないことを見る。
 *
 * 1台の中で閉じる規則は `fold-record-lww.test.ts` /
 * `fold-record-ondelete.test.ts` にある。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { performSync } from '../src/sync';
import { SyncConfig, TableConfig } from '../src/types';

describe('端末をまたいだ動き', () => {
  const testDir = path.join(__dirname, 'test-data-fold-record-lww');
  const nasDir = path.join(testDir, 'nas');

  const TABLES: TableConfig[] = [
    { name: 'exam_students' },
    { name: 'question_scores' },
    { name: 'memos' },
  ];

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
      );
      CREATE TABLE question_scores (
        id            TEXT PRIMARY KEY,
        examStudentId TEXT NOT NULL REFERENCES exam_students(id) ON DELETE CASCADE,
        regionId      TEXT NOT NULL,
        score         TEXT NOT NULL,
        updatedAt     TEXT NOT NULL,
        UNIQUE (examStudentId, regionId)
      );
      CREATE TABLE memos (
        id        TEXT PRIMARY KEY,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
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

  function idsOf(db: Database.Database, sql: string): string[] {
    return (db.prepare(sql).all() as { id: string }[]).map((row) => row.id);
  }

  function foreignKeyWarnings(warnings: string[]): string[] {
    return warnings.filter((warning) => warning.includes('FOREIGN KEY'));
  }

  beforeEach(() => {
    fs.mkdirSync(nasDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  /**
   * 「畳み先が消えたあとに、敗者の子が届く」形へ通常操作だけで到達する。
   *
   * 1. A が生徒を作って共有する
   * 2. B が独立に同じ生徒を作り、同期する（B が勝ち、A の行は B の行へ畳まれる）
   * 3. B がその生徒を消す（利用者操作。畳み先が世界から消える）
   * 4. A はそれを知らないまま、自分の（畳まれる運命の）生徒に採点を付ける
   */
  async function reachChildOfDeletedFoldTarget(): Promise<{
    dbA: Database.Database;
    pathA: string;
    dbB: Database.Database;
    pathB: string;
  }> {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    dbB.prepare(`DELETE FROM exam_students WHERE id = 'es-b'`).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES ('qs-a', 'es-a', 'region-1', '5', '2026-03-01T00:00:00Z')`
    ).run();

    return { dbA, pathA, dbB, pathB };
  }

  it('読み替え先が消えた子が届いても、同期が止まらない（2端末）', async () => {
    const { dbA, pathA, dbB, pathB } = await reachChildOfDeletedFoldTarget();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // 読み替え先（es-b）は消えている。CASCADE なので子は採らない — が、**黙っては捨てない**
    expect(foreignKeyWarnings(pull.warnings)).toEqual([]);
    expect(
      pull.warnings.filter((warning) => warning.startsWith('Dropped'))
    ).toEqual([
      'Dropped question_scores:qs-a: parent exam_students:es-b is gone (ON DELETE CASCADE)',
    ]);
    expect(idsOf(dbB, `SELECT id FROM question_scores`)).toEqual([]);

    // 取り込みが巻き戻っていないこと（巻き戻ると lastSeenId が進まず、
    // この相手からのデータが以後ずっと届かない）を、無関係な行で確かめる
    dbA.prepare(
      `INSERT INTO memos (id, body, updatedAt) VALUES ('memo-1', '後続', '2026-04-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(idsOf(dbB, `SELECT id FROM memos`)).toEqual(['memo-1']);

    dbA.close();
    dbB.close();
  });

  it('フルマージ経路（changelogギャップ）でも同じように扱う', async () => {
    const { dbA, pathA, dbB, pathB } = await reachChildOfDeletedFoldTarget();

    // A の changelog が保持期間を過ぎて消えた形にする（B から見るとギャップ）
    dbA.exec(`DELETE FROM _changelog`);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const fullMerge = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    );

    expect(fullMerge.hadChangelogGap).toBe(true);
    expect(foreignKeyWarnings(fullMerge.warnings)).toEqual([]);
    expect(
      fullMerge.warnings.filter((warning) => warning.startsWith('Dropped'))
    ).toEqual([
      'Dropped question_scores:qs-a: parent exam_students:es-b is gone (ON DELETE CASCADE)',
    ]);
    expect(idsOf(dbB, `SELECT id FROM question_scores`)).toEqual([]);

    dbA.close();
    dbB.close();
  });

  it('3端末目が遅れて参加しても、外部キー違反で取り込みが巻き戻らない', async () => {
    const { dbA, pathA, dbB, pathB } = await reachChildOfDeletedFoldTarget();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // C はここまで一度も参加していない。全員ぶんをまとめて受け取る
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');

    for (let round = 0; round < 3; round++) {
      const pull = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      expect(foreignKeyWarnings(pull.warnings)).toEqual([]);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    // 畳みを実際に適用した端末には、引き取り先の無い子は残らない
    expect(idsOf(dbB, `SELECT id FROM question_scores`)).toEqual([]);

    // **この形は全端末では揃わない。** 畳み先（es-b）が世界から消えているため、
    // 敗者行 es-a を持っている端末はそれを消せず（消すと子が道連れになる）、
    // es-a とその子を持ったまま残る。畳みの記録の時刻とは別の既知の食い違いで、
    // 規則1〜5 では直らない（README「直っていないこと」）。ここでは固定しない。

    // C の取り込みが巻き戻っていないこと（巻き戻ると以後ずっと届かない）
    dbB.prepare(
      `INSERT INTO memos (id, body, updatedAt) VALUES ('memo-1', '後続', '2026-05-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    expect(idsOf(dbC, `SELECT id FROM memos`)).toEqual(['memo-1']);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('同期経路でも、取り込み元に無い畳み先は「消えた」と判定される', async () => {
    // `makeResurrectionProbe` が同期経路で実際に働くことを見る。畳みの記録を持つ端末へ
    // 遅れて子が届き、畳み先は取り込み元にも無い —— このとき `ON DELETE` に従う。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // C は畳みの前に一度だけ同期する（以後はギャップ経路でしか受け取らない）
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

    // B が独立に同じ受験者を作り、畳みを記録してから削除する
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    dbB.prepare(`DELETE FROM exam_students WHERE id = 'es-b'`).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    // A は畳み先を見つけられず、敗者行を持ったまま残る
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // C はギャップ経路で全体を取り込み、畳みの記録を得る
    dbA.exec(`DELETE FROM _changelog`);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    expect(
      dbC.prepare(`SELECT losingId, winningId FROM _id_merge`).all()
    ).toEqual([{ losingId: 'es-a', winningId: 'es-b' }]);

    // A が遅れて敗者行の子を作る。取り込み元 A にも畳み先 es-b は無い
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES ('qs-late', 'es-a', 'region-1', '5', '2026-07-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

    expect(foreignKeyWarnings(pull.warnings)).toEqual([]);
    expect(
      pull.warnings.filter((warning) => warning.startsWith('Dropped'))
    ).toEqual([
      'Dropped question_scores:qs-late: parent exam_students:es-b is gone (ON DELETE CASCADE)',
    ]);
    expect(idsOf(dbC, `SELECT id FROM question_scores`)).toEqual([]);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('読み替えた行の時刻を進めないので、窓の中の他端末の編集が生き残る', async () => {
    // 読み替えで書き換わるのは外部キーの列だけ。行全体で畳みの時刻を名乗ると、
    // 「元の時刻〜畳みの時刻」の窓に入る他端末の編集が、内容の古い行に負けて消える。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES ('qs-a', 'es-a', 'region-1', '5', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // C が A の採点を受け取り、窓の中（3月）で直す
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    dbC.prepare(
      `UPDATE question_scores SET score = '8', updatedAt = '2026-03-01T00:00:00Z'
       WHERE id = 'qs-a'`
    ).run();

    // B が独立に同じ受験者を作る（6月）→ 畳みが起き、A の 2月版が読み替えられる
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-06-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (let round = 0; round < 3; round++) {
      await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    // 窓の中（2/1 〜 6/1）の編集が全端末で残り、揃うこと
    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
      ['C', dbC],
    ] as const) {
      expect(
        db.prepare(`SELECT id, score FROM question_scores`).all(),
        `client-${label}`
      ).toEqual([{ id: 'qs-a', score: '8' }]);
    }

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('解けない食い違い（同一主キー・同時刻・中身が違う）は報告される', async () => {
    // 同一主キーのLWWは「厳密に新しい」ものしか採らないので、両端末が同じ時刻で
    // 違う中身を持つと互いに拒み続けて動かない。**ライブラリは解かない。報告する。**
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');

    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-1', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // 同じ行を、両端末が**まったく同じ時刻**で別々の中身へ更新する
    dbA.prepare(
      `UPDATE exam_students SET studentId = 'student-A', updatedAt = '2026-05-01T00:00:00Z'
       WHERE id = 'es-1'`
    ).run();
    dbB.prepare(
      `UPDATE exam_students SET studentId = 'student-B', updatedAt = '2026-05-01T00:00:00Z'
       WHERE id = 'es-1'`
    ).run();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // 解けていない（B は自分の版のまま）
    expect(
      dbB.prepare(`SELECT studentId FROM exam_students WHERE id = 'es-1'`).get()
    ).toEqual({ studentId: 'student-B' });
    // だが黙ってはいない
    expect(
      pull.warnings.filter((warning) => warning.startsWith('Stalemate'))
    ).toEqual([
      'Stalemate on exam_students:es-1: both sides are at 2026-05-01T00:00:00Z ' +
        'but studentId differ, so neither can win. Edit the row on one side to break the tie.',
    ]);

    dbA.close();
    dbB.close();
  });

  it('膠着は INSERT の経路でも報告される', async () => {
    // 同じ id の行を、両端末が同じ時刻で別々に作る（changelog は INSERT になる）。
    // `applyUpdate` だけでなく `applyInsert` の同一主キー経路でも報告すること。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-1', 'exam-1', 'student-A', '2026-05-01T00:00:00Z')`
    ).run();
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-1', 'exam-1', 'student-B', '2026-05-01T00:00:00Z')`
    ).run();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(
      pull.warnings.filter((warning) => warning.startsWith('Stalemate'))
    ).toEqual([
      'Stalemate on exam_students:es-1: both sides are at 2026-05-01T00:00:00Z ' +
        'but studentId differ, so neither can win. Edit the row on one side to break the tie.',
    ]);

    dbA.close();
    dbB.close();
  });

  it('規則4が発火する: 畳みより後に更新された敗者行は、畳みに巻き込まれない', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // B が独立に同じ生徒を作る。B が勝ち、es-a は es-b へ畳まれたと記録される
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // A は、その畳みより後に es-a を**別の生徒**へ付け替えた。もう衝突しない
    dbA.prepare(
      `UPDATE exam_students SET studentId = 'student-2', updatedAt = '2026-03-01T00:00:00Z'
       WHERE id = 'es-a'`
    ).run();

    for (let round = 0; round < 3; round++) {
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    // 畳みは「衝突していた版」に対する判断であって、その後の版には及ばない。
    // 現在時刻を刻んでいたころは、この行は tombstone に永久に止められて
    // どちらの端末でも二度と生き返らなかった。
    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(
        db
          .prepare(`SELECT id, studentId FROM exam_students ORDER BY id`)
          .all(),
        `client-${label}`
      ).toEqual([
        { id: 'es-a', studentId: 'student-2' },
        { id: 'es-b', studentId: 'student-1' },
      ]);
    }

    dbA.close();
    dbB.close();
  });
});
