/**
 * 畳みが `_tombstone.deletedAt` に何の時刻を刻むか。
 *
 * 畳みは「別id・同一ユニークキーの2行は同じもの」という判断であって、削除ではない。
 * その判断がいつのものかは `_tombstone.deletedAt` として他クライアントへ渡り、
 * 受け取った側の {@link isShadowedByTombstone} と `applyMergedDelete` の両方が
 * 「この時刻より新しい版だけ通す」ためのしきい値に使う。
 *
 * したがって刻むべきは**勝者の版の時刻**であって、畳みを実行した端末の現在時刻ではない。
 * 現在時刻を刻むと、実データの `updatedAt` は必ずそれより過去なので、敗者idは
 * 「勝者より新しい版を持っていた端末」ごと永久に黙って捨てられる。
 *
 * 敗者行をローカルに持っていなかった側（`local_wins`）は既に勝者の時刻を刻んでいる
 * （`fold-regression.test.ts` の「畳みのtombstoneは、勝者より新しい行の到着まで止めない」）。
 * 敗者行を実際に消した側も、DELETEトリガーが書いた現在時刻を**畳みの時刻で置き直す**。
 * 進めるのではなく置くのは、トリガーの現在時刻が必ず新しく、進めるだけでは勝てないため。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert, applyMergedDelete } from '../src/conflict';
import { performSync } from '../src/sync';
import { SyncConfig, TableConfig } from '../src/types';

const TABLES: TableConfig[] = [{ name: 'exam_students' }];

interface TombstoneRow {
  recordId: string;
  deletedAt: string;
  mergedInto: string | null;
}

interface StudentRow {
  id: string;
  note: string;
  updatedAt: string;
}

describe('畳みが tombstone に刻む時刻', () => {
  const testDir = path.join(__dirname, 'test-data-fold-time');
  const nasDir = path.join(testDir, 'nas');

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
        note      TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (examId, studentId)
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

  /** 端末が「今」書いた行として扱う時刻。過去日付を作らない（後ろ倒しの疑いを消すため）。 */
  function now(): string {
    return new Date().toISOString();
  }

  function addStudent(
    db: Database.Database,
    id: string,
    note: string,
    updatedAt: string
  ): void {
    db.prepare(
      `INSERT INTO exam_students (id, examId, studentId, note, updatedAt)
       VALUES (?, 'exam-1', 'student-1', ?, ?)`
    ).run(id, note, updatedAt);
  }

  function students(db: Database.Database): StudentRow[] {
    return db
      .prepare(`SELECT id, note, updatedAt FROM exam_students ORDER BY id`)
      .all() as StudentRow[];
  }

  function tombstoneOf(
    db: Database.Database,
    recordId: string
  ): TombstoneRow | undefined {
    return db
      .prepare(
        `SELECT recordId, deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'exam_students' AND recordId = ?`
      )
      .get(recordId) as TombstoneRow | undefined;
  }

  /**
   * 3端末を、**通常の書き込みと `performSync` だけで**次の形へ持っていく。
   *
   * - A: 世界で最新の `es-a` を持っている。まだ誰の変更も受け取っていない
   * - B: `es-b` を持っている（A を見ないまま同じ生徒を作った）
   * - C: A の**古いスナップショット**と B のスナップショットを見て
   *   「es-a は es-b へ畳まれた」と確定させ、それを共有フォルダへ出している
   *
   * DBの中身を直接組み立てていないこと・過去日付を1つも使っていないことが要点。
   * 現場では「担当者が編集した数分後に、別の端末が同期して畳みを確定させる」で起きる。
   */
  async function reachFoldDecidedBeforeNewestEdit(): Promise<{
    dbA: Database.Database;
    pathA: string;
    dbB: Database.Database;
    pathB: string;
    dbC: Database.Database;
    pathC: string;
    newestUpdatedAt: string;
  }> {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    addStudent(dbA, 'es-a', 'A版', now());
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    addStudent(dbB, 'es-b', 'B版', now());
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // A の担当者が編集する。A はまだ B のことも C のことも知らない
    const newestUpdatedAt = now();
    dbA.prepare(
      `UPDATE exam_students SET note = ?, updatedAt = ? WHERE id = ?`
    ).run('A版（世界で最新）', newestUpdatedAt, 'es-a');

    // C が同期する。C が見る A は**この編集より前のスナップショット**
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

    return { dbA, pathA, dbB, pathB, dbC, pathC, newestUpdatedAt };
  }

  beforeEach(() => {
    fs.mkdirSync(nasDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it('「畳みが決まったあとに、より新しい敗者版を持つ端末が残っている」状態へ通常操作だけで到達する', async () => {
    const { dbA, dbB, dbC, newestUpdatedAt } =
      await reachFoldDecidedBeforeNewestEdit();

    // C は畳みを確定し、敗者 es-a を消して畳み先を共有できる形にしている
    expect(students(dbC).map((student) => student.id)).toEqual(['es-b']);
    expect(tombstoneOf(dbC, 'es-a')?.mergedInto).toBe('es-b');

    // A は敗者idの行を、勝者 es-b よりも新しい版で持ったままでいる
    expect(students(dbA)).toEqual([
      { id: 'es-a', note: 'A版（世界で最新）', updatedAt: newestUpdatedAt },
    ]);
    const winner = students(dbB).find((student) => student.id === 'es-b');
    expect(winner).toBeDefined();
    expect(newestUpdatedAt > String(winner?.updatedAt)).toBe(true);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it(
    'その状態から同期しても、世界で最新の版が残る',
    async () => {
      const { dbA, pathA, dbB, pathB, dbC, pathC, newestUpdatedAt } =
        await reachFoldDecidedBeforeNewestEdit();

      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      for (let round = 0; round < 3; round++) {
        await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
        await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
        await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      }

      // 畳みは「同じ生徒だから1行にする」であって、古い方を選ぶことではない
      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
        ['C', dbC],
      ] as const) {
        expect(students(db), `client-${label}`).toEqual([
          { id: 'es-a', note: 'A版（世界で最新）', updatedAt: newestUpdatedAt },
        ]);
      }

      dbA.close();
      dbB.close();
      dbC.close();
    }
  );

  it('敗者行を持っていなかった端末は、勝者の版の時刻を刻む', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    addStudent(dbA, 'es-a', 'A版', '2026-01-01T00:00:00.000Z');
    addStudent(dbB, 'es-b', 'B版', '2026-02-01T00:00:00.000Z');

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    // B は es-a を受け取るが、自分の es-b の方が新しいので採らない（行は消えない）
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(tombstoneOf(dbB, 'es-a')).toEqual({
      recordId: 'es-a',
      deletedAt: '2026-02-01T00:00:00.000Z',
      mergedInto: 'es-b',
    });

    dbA.close();
    dbB.close();
  });

  it(
    '敗者行を実際に消した端末も、同じ1回の畳みには同じ時刻を刻む',
    async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      addStudent(dbA, 'es-a', 'A版', '2026-01-01T00:00:00.000Z');
      addStudent(dbB, 'es-b', 'B版', '2026-02-01T00:00:00.000Z');

      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      // A は自分の es-a を消して es-b へ畳む
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // 同じ1回の畳みなのだから、両端末の記録は一致していなければならない
      expect(tombstoneOf(dbA, 'es-a')).toEqual(tombstoneOf(dbB, 'es-a'));

      dbA.close();
      dbB.close();
    }
  );

  it('古い畳みは、新しい実削除の記録を上書きしない', () => {
    // `_tombstone` の1行は「この id はいつ死んだか」の主張。**新しい主張が勝つ。**
    // 古い畳みを無条件に置くと `deletedAt` が過去へ戻り、{@link isShadowedByTombstone}
    // を素通りして**消したはずの行が別の端末の版で復活する**。`mergedInto` も同じで、
    // 実削除の NULL を古い畳み先で塗り替えると、受け取った側はその削除を畳みとして扱う。
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, ukey TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, [{ name: 'notes' }], 'id');
    const columns = ['id', 'ukey', 'body', 'updatedAt'];

    // 利用者が X を消す（実削除。tombstone は「いま」で入る）
    db.prepare(
      `INSERT INTO notes VALUES ('X', 'kx', '本文', '2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(`DELETE FROM notes WHERE id = 'X'`).run();
    const afterDelete = db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'notes' AND recordId = 'X'`
      )
      .get() as { deletedAt: string; mergedInto: string | null };

    // ずっと昔に決まった畳み X→Y が、いま届く
    applyMergedDelete(
      db,
      'notes',
      'id',
      'X',
      'Y',
      undefined,
      columns,
      'updatedAt',
      '2020-01-01T00:00:00.000Z'
    );

    expect(
      db
        .prepare(
          `SELECT deletedAt, mergedInto FROM _tombstone
           WHERE tableName = 'notes' AND recordId = 'X'`
        )
        .get()
    ).toEqual(afterDelete);

    // 第三の端末が持っていた「削除より古い」版が復活しないこと
    const { action } = applyInsert(
      db,
      'notes',
      'id',
      {
        id: 'X',
        ukey: 'kx',
        body: '2023年版',
        updatedAt: '2023-01-01T00:00:00.000Z',
      },
      columns
    );
    expect(action).toBe('skipped');
    expect(db.prepare(`SELECT id FROM notes`).all()).toEqual([]);

    db.close();
  });

  it(
    '届いた畳みを適用しても、畳みが決まった時刻は書き換わらない',
    () => {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE parents (
          id TEXT PRIMARY KEY, ukey TEXT UNIQUE, updatedAt TEXT NOT NULL
        )
      `);
      setupChangelog(db, [{ name: 'parents' }], 'id');
      db.prepare(`INSERT INTO parents VALUES ('aaa', 'k1', ?)`).run(
        '2026-01-01T00:00:00.000Z'
      );
      db.prepare(`INSERT INTO parents VALUES ('bbb', 'k2', ?)`).run(
        '2026-01-01T00:00:00.000Z'
      );

      // 他の端末が 2026-02-01 時点で下した判断を適用する
      applyMergedDelete(
        db,
        'parents',
        'id',
        'bbb',
        'aaa',
        undefined,
        ['id', 'ukey', 'updatedAt'],
        'updatedAt',
        '2026-02-01T00:00:00.000Z'
      );

      // 適用しただけで判断の時刻が「今」へ繰り上がると、畳みを適用した端末が増えるたびに
      // しきい値が現在へ寄り、まだ届いていない新しい版が捨てられる範囲が広がる
      const tombstone = db
        .prepare(
          `SELECT deletedAt FROM _tombstone WHERE tableName = 'parents' AND recordId = 'bbb'`
        )
        .get() as { deletedAt: string };
      expect(tombstone.deletedAt).toBe('2026-02-01T00:00:00.000Z');

      db.close();
    }
  );
});
