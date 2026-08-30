/**
 * 同期経路での**セカンダリUNIQUE の畳み** —— 届いた更新がローカルの**別の行**の
 * ユニークキーに当たったときに、両端末が同じ1行へ収束することを見る。
 *
 * 1台の中で閉じる畳みの規則は `conflict.test.ts` や `fold-record-lww.test.ts` にある。
 * ここで見るのは**端末をまたいだ収束**である。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { performSync } from '../src/sync';
import { TableConfig } from '../src/types';
import { createSyncFixture, TABLES } from './helpers/sync-fixtures';

const { nasDir, prepare, cleanup, createClientDb, makeConfig } =
  createSyncFixture('test-data-sync-unique');

describe('届いた更新がローカルの別の行のセカンダリUNIQUEに当たる', () => {
  beforeEach(prepare);
  afterEach(cleanup);

  interface TagRow {
    id: string;
    name: string;
  }
  interface NoteRow {
    id: string;
    tagId: string;
  }

  function tagRows(db: Database.Database): TagRow[] {
    return db
      .prepare(`SELECT id, name FROM tags ORDER BY id`)
      .all() as TagRow[];
  }

  function noteRows(db: Database.Database): NoteRow[] {
    return db
      .prepare(`SELECT id, tagId FROM tag_notes ORDER BY id`)
      .all() as NoteRow[];
  }

  function insertTag(
    db: Database.Database,
    id: string,
    name: string,
    updatedAt: string
  ): void {
    db.prepare(
      `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`
    ).run(id, name, updatedAt);
  }

  function insertNote(
    db: Database.Database,
    id: string,
    tagId: string,
    updatedAt: string
  ): void {
    db.prepare(
      `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
    ).run(id, tagId, `${id}の本文`, updatedAt);
  }

  function insertProfile(
    db: Database.Database,
    tagId: string,
    memo: string,
    updatedAt: string
  ): void {
    db.prepare(
      `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (?, ?, ?)`
    ).run(tagId, memo, updatedAt);
  }

  function profileRows(
    db: Database.Database
  ): { id: string; memo: string }[] {
    return db
      .prepare(`SELECT id, memo FROM tag_profiles ORDER BY id`)
      .all() as { id: string; memo: string }[];
  }

  function uniqueWarnings(warnings: string[]): string[] {
    return warnings.filter(
      (warning) =>
        warning.includes('UNIQUE constraint failed') ||
        warning.includes('FOREIGN KEY')
    );
  }

  /**
   * A が t1「数学」を作り、B もそれを受け取っている状態。
   * このあと A が t1 を改名し、B は独立に同じ名前の t2 を作る。
   */
  async function seedRenameCollision(
    renamedAt: string,
    rivalAt: string,
    tables: TableConfig[] = TABLES
  ) {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), tables);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), tables);
    expect(tagRows(dbB)).toEqual([{ id: 't1', name: '数学' }]);

    // B は受け取った t1 に自分のメモを付けている（畳まれても消えてはいけない）
    insertNote(dbB, 'note-t1', 't1', '2024-02-01T00:00:00Z');

    // A: t1 を「国語」へ改名
    dbA.prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`).run(
      '国語',
      renamedAt,
      't1'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'), tables);

    // B: 独立に「国語」の t2 を作成（メモ付き）
    insertTag(dbB, 't2', '国語', rivalAt);
    insertNote(dbB, 'note-t2', 't2', rivalAt);

    return { dbA, pathA, dbB, pathB };
  }

  it('届いた改名が勝つ場合、ローカルの邪魔な行が畳まれ、その子は改名された行へ移る', async () => {
    // A の改名(2024-06-01) > B の t2(2024-03-01) → 届いた更新が勝つ
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      '2024-06-01T00:00:00Z',
      '2024-03-01T00:00:00Z'
    );

    // 何度同期しても同じ場所で落ち続けるなら、A からは以後何も届かない
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(uniqueWarnings(result.warnings), `B ${attempt}回目`).toEqual([]);
      expect(result.clientsSynced, `B ${attempt}回目`).toBe(1);
    }

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(tagRows(db), `client-${label}`).toEqual([
        { id: 't1', name: '国語' },
      ]);
      expect(noteRows(db), `client-${label}`).toEqual([
        { id: 'note-t1', tagId: 't1' },
        { id: 'note-t2', tagId: 't1' },
      ]);
    }

    dbA.close();
    dbB.close();
  });

  it('畳みで動く 1:1 の子の席が埋まっていても、同期が止まらない', async () => {
    // A の改名(2024-06-01) > B の t2(2024-03-01) → 届いた更新が勝ち、t2 が畳まれる。
    // t2 に紐づく 1:1 の行は t1 の席へ動こうとするが、そこには t1 の行が既に居る。
    // 席の先客を「畳む相手」として扱うと、敗者idと勝者idが同じ畳みになって
    // 何も起きず、同じ付け替えをもう一度走らせて主キー違反を投げる
    // （どの catch にも捕まらず、その相手からの取り込みが毎回巻き戻る）。
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      '2024-06-01T00:00:00Z',
      '2024-03-01T00:00:00Z'
    );
    insertProfile(dbB, 't1', 'ふるい', '2024-02-01T00:00:00Z');
    insertProfile(dbB, 't2', 'あたらしい', '2024-09-01T00:00:00Z');

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(uniqueWarnings(result.warnings), `B ${attempt}回目`).toEqual([]);
      expect(result.clientsSynced, `B ${attempt}回目`).toBe(1);
    }

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(tagRows(db), `client-${label}`).toEqual([
        { id: 't1', name: '国語' },
      ]);
      // 席は1つ。中身は新しい方（t2 に付いていた行）が残る
      expect(profileRows(db), `client-${label}`).toEqual([
        { id: 't1', memo: 'あたらしい' },
      ]);
    }

    dbA.close();
    dbB.close();
  });

  it('ローカルの行が勝つ場合、届いた更新の行が畳まれ、両端末が同じ形へ収束する', async () => {
    // A の改名(2024-03-01) < B の t2(2024-06-01) → ローカルが勝つ
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      '2024-03-01T00:00:00Z',
      '2024-06-01T00:00:00Z'
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(uniqueWarnings(result.warnings), `B ${attempt}回目`).toEqual([]);
      expect(result.clientsSynced, `B ${attempt}回目`).toBe(1);
    }

    // 畳み先が `_tombstone.mergedInto` に載る（これが相手へ伝わる唯一の経路）。
    // ここが空だと、受け取った側は t1 をただ消して自分の子を道連れにする。
    expect(
      dbB
        .prepare(
          `SELECT recordId, mergedInto FROM _tombstone WHERE tableName = 'tags'`
        )
        .all()
    ).toEqual([{ recordId: 't1', mergedInto: 't2' }]);
    // ローカルの読み替え索引にも入る（あとから届く t1 の子を t2 へ向け直すため）
    expect(
      dbB
        .prepare(
          `SELECT losingId, winningId FROM _id_merge WHERE tableName = 'tags'`
        )
        .all()
    ).toEqual([{ losingId: 't1', winningId: 't2' }]);

    // 黙って捨てていると A は t1 を持ち続け、分岐したまま収束しない
    for (let round = 0; round < 2; round++) {
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(tagRows(db), `client-${label}`).toEqual([
        { id: 't2', name: '国語' },
      ]);
      expect(noteRows(db), `client-${label}`).toEqual([
        { id: 'note-t1', tagId: 't2' },
        { id: 'note-t2', tagId: 't2' },
      ]);
    }

    dbA.close();
    dbB.close();
  });

  it('競合を知らない3台目も、同じ形へ追いつく', async () => {
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      '2024-06-01T00:00:00Z',
      '2024-03-01T00:00:00Z'
    );

    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    const snapshot = (db: Database.Database): string =>
      JSON.stringify([tagRows(db), noteRows(db)]);
    const converged = snapshot(dbA);
    expect(snapshot(dbB)).toBe(converged);

    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    const resultC = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    expect(uniqueWarnings(resultC.warnings)).toEqual([]);
    expect(snapshot(dbC)).toBe(converged);

    // 3台目が加わっても付け替え合いが続かない
    for (let round = 0; round < 2; round++) {
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    }
    expect(snapshot(dbA)).toBe(converged);
    expect(snapshot(dbB)).toBe(converged);
    expect(snapshot(dbC)).toBe(converged);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('ローカルが勝つ畳みも、その決定が3台目まで伝わって同じ形へ揃う', async () => {
    // 3台目 C も先に t1 を受け取り、自分のメモを付けている状態を作る
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    insertNote(dbB, 'note-b', 't1', '2024-02-01T00:00:00Z');

    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    insertNote(dbC, 'note-c', 't1', '2024-02-01T00:00:00Z');
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

    // A は t1 を改名し、B は独立にもっと新しい「国語」を作る（ローカルが勝つ向き）
    dbA.prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`).run(
      '国語',
      '2024-03-01T00:00:00Z',
      't1'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    insertTag(dbB, 't2', '国語', '2024-06-01T00:00:00Z');
    insertNote(dbB, 'note-t2', 't2', '2024-06-01T00:00:00Z');

    const foldResult = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(uniqueWarnings(foldResult.warnings)).toEqual([]);

    // 全員が全員を取り込むまで回す
    for (let round = 0; round < 3; round++) {
      for (const [clientId, db, dbPath] of [
        ['client-a', dbA, pathA],
        ['client-b', dbB, pathB],
        ['client-c', dbC, pathC],
      ] as const) {
        const result = await performSync(db, makeConfig(dbPath, clientId), TABLES);
        expect(uniqueWarnings(result.warnings), `${clientId} round${round}`).toEqual([]);
      }
    }

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
      ['C', dbC],
    ] as const) {
      expect(tagRows(db), `client-${label}`).toEqual([
        { id: 't2', name: '国語' },
      ]);
      // 畳まれて消えた t1 にぶら下がっていたメモは、3台とも生き残った t2 へ移る
      expect(noteRows(db), `client-${label}`).toEqual([
        { id: 'note-b', tagId: 't2' },
        { id: 'note-c', tagId: 't2' },
        { id: 'note-t2', tagId: 't2' },
      ]);
    }

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('deleteProtected なテーブルでも畳みは行われる（利用者操作の削除だけが保護対象）', async () => {
    const protectedTables: TableConfig[] = TABLES.map((tableConfig) =>
      tableConfig.name === 'tags'
        ? { ...tableConfig, deleteProtected: true }
        : tableConfig
    );

    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      '2024-06-01T00:00:00Z',
      '2024-03-01T00:00:00Z',
      protectedTables
    );

    const result = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      protectedTables
    );
    expect(uniqueWarnings(result.warnings)).toEqual([]);
    expect(result.clientsSynced).toBe(1);

    await performSync(dbA, makeConfig(pathA, 'client-a'), protectedTables);
    await performSync(dbB, makeConfig(pathB, 'client-b'), protectedTables);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(tagRows(db), `client-${label}`).toEqual([
        { id: 't1', name: '国語' },
      ]);
      expect(noteRows(db), `client-${label}`).toEqual([
        { id: 'note-t1', tagId: 't1' },
        { id: 'note-t2', tagId: 't1' },
      ]);
    }

    // 保護そのものは効いている: A が普通に削除しても B からは消えない
    dbA.prepare(`DELETE FROM tags WHERE id = ?`).run('t1');
    await performSync(dbA, makeConfig(pathA, 'client-a'), protectedTables);
    await performSync(dbB, makeConfig(pathB, 'client-b'), protectedTables);
    expect(tagRows(dbB)).toEqual([{ id: 't1', name: '国語' }]);

    dbA.close();
    dbB.close();
  });

  it('フルマージ経路でも畳まれ、ギャップが解消される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // B が一度同期して lastSeenId を持つ（これが無いとギャップ判定にならない）
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    insertNote(dbB, 'note-t1', 't1', '2024-02-01T00:00:00Z');

    // A が改名し、changelog は7日経過で消えたことにする
    dbA.prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`).run(
      '国語',
      '2024-06-01T00:00:00Z',
      't1'
    );
    dbA.exec(`DELETE FROM _changelog`);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    insertTag(dbB, 't2', '国語', '2024-03-01T00:00:00Z');
    insertNote(dbB, 'note-t2', 't2', '2024-03-01T00:00:00Z');

    const fullMerge = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(fullMerge.hadChangelogGap).toBe(true);
    expect(uniqueWarnings(fullMerge.warnings)).toEqual([]);
    expect(fullMerge.clientsSynced).toBe(1);

    // フルマージが巻き戻っていれば lastSeenId が進まず、毎回ギャップを再検出する
    const next = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(next.hadChangelogGap).toBe(false);

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(tagRows(db), `client-${label}`).toEqual([
        { id: 't1', name: '国語' },
      ]);
      expect(noteRows(db), `client-${label}`).toEqual([
        { id: 'note-t1', tagId: 't1' },
        { id: 'note-t2', tagId: 't1' },
      ]);
    }

    dbA.close();
    dbB.close();
  });

  it('同時刻で衝突しても、両端末が同じ側を残す（振動しない）', async () => {
    // 両端末が同じ時刻を刻む（時計が揃っている・秒までしか持たない等）。
    // 時刻で決まらないぶんを端末ごとに違う向きで決めると、互いに相手を畳んで
    // 生き残るidが毎周入れ替わり、そのたびに新しい DELETE が積まれる。
    const sameMoment = '2024-06-01T00:00:00Z';
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      sameMoment,
      sameMoment
    );

    function tagDeletions(db: Database.Database): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM _changelog
           WHERE tableName = 'tags' AND operation = 'DELETE'`
        )
        .get() as { count: number };
      return row.count;
    }

    const shapes: string[] = [];
    const deletions: number[] = [];
    for (let round = 0; round < 6; round++) {
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      shapes.push(
        JSON.stringify([
          tagRows(dbA),
          noteRows(dbA),
          tagRows(dbB),
          noteRows(dbB),
        ])
      );
      deletions.push(tagDeletions(dbA) + tagDeletions(dbB));
    }

    // 収束したら以後は動かない（振動していると毎周違う形になる）
    expect(new Set(shapes.slice(2))).toEqual(new Set([shapes[5]]));
    // 振動していると畳みのたびに DELETE が積まれ、際限なく増える
    expect(deletions[5]).toBe(deletions[2]);

    // 時刻で決まらないぶんは主キーの辞書順で決める → t1 が残る
    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(tagRows(db), `client-${label}`).toEqual([
        { id: 't1', name: '国語' },
      ]);
      expect(noteRows(db), `client-${label}`).toEqual([
        { id: 'note-t1', tagId: 't1' },
        { id: 'note-t2', tagId: 't1' },
      ]);
    }

    dbA.close();
    dbB.close();
  });

  it('届いた改名が勝つ畳みが、消えた行として SyncResult に出る', async () => {
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      '2024-06-01T00:00:00Z',
      '2024-03-01T00:00:00Z'
    );

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(result.folds).toEqual([
      {
        tableName: 'tags',
        losingId: 't2',
        winningId: 't1',
        removedLocalRow: true,
        // t2 に付いていたメモ1件が t1 へ移った
        movedChildren: 1,
        lostChildren: 0,
      },
    ]);
    expect(result.deleted).toBe(1);
    expect(result.conflictsResolved).toBe(1);

    dbA.close();
    dbB.close();
  });

  it('ローカルの行が勝つ畳みも、消えた行として SyncResult に出る', async () => {
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      '2024-03-01T00:00:00Z',
      '2024-06-01T00:00:00Z'
    );

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // 届いた更新は採用しないが、更新対象の行は畳まれて消えている
    expect(result.folds).toEqual([
      {
        tableName: 'tags',
        losingId: 't1',
        winningId: 't2',
        removedLocalRow: true,
        // t1 に付いていたメモ1件が t2 へ移った
        movedChildren: 1,
        lostChildren: 0,
      },
    ]);
    expect(result.deleted).toBe(1);
    expect(result.conflictsResolved).toBe(1);

    dbA.close();
    dbB.close();
  });

  it('同時刻の衝突でも、あとから参加した3台目まで同じ形へ揃う', async () => {
    const sameMoment = '2024-06-01T00:00:00Z';
    const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
      sameMoment,
      sameMoment
    );

    for (let round = 0; round < 2; round++) {
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    const snapshot = (db: Database.Database): string =>
      JSON.stringify([tagRows(db), noteRows(db)]);
    const converged = snapshot(dbA);
    expect(snapshot(dbB)).toBe(converged);

    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    const resultC = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    expect(uniqueWarnings(resultC.warnings)).toEqual([]);
    expect(snapshot(dbC)).toBe(converged);

    for (let round = 0; round < 2; round++) {
      for (const [clientId, db, dbPath] of [
        ['client-a', dbA, pathA],
        ['client-b', dbB, pathB],
        ['client-c', dbC, pathC],
      ] as const) {
        const result = await performSync(db, makeConfig(dbPath, clientId), TABLES);
        expect(uniqueWarnings(result.warnings), `${clientId} round${round}`).toEqual(
          []
        );
      }
    }
    expect(snapshot(dbA)).toBe(converged);
    expect(snapshot(dbB)).toBe(converged);
    expect(snapshot(dbC)).toBe(converged);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('ユニークが2本ある表で更新が拒まれても、同期は止まらず巻き添えも出ない', async () => {
    interface AccountRow {
      id: string;
      username: string;
      email: string;
    }
    function accountRows(db: Database.Database): AccountRow[] {
      return db
        .prepare(`SELECT id, username, email FROM accounts ORDER BY id`)
        .all() as AccountRow[];
    }
    function insertAccount(
      db: Database.Database,
      id: string,
      username: string,
      email: string,
      updatedAt: string
    ): void {
      db.prepare(
        `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run(id, username, email, updatedAt);
    }

    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    insertAccount(dbA, 'r0', 'name0', 'mail0', '2024-05-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // B は独立に2つの行を作る。片方は email が、もう片方は username が、
    // このあと A が r0 へ書き込む値とぶつかる。
    insertAccount(dbB, 'r1', 'name1', 'mailX', '2024-01-01T00:00:00Z');
    insertAccount(dbB, 'r2', 'nameX', 'mail2', '2024-12-01T00:00:00Z');

    dbA
      .prepare(
        `UPDATE accounts SET username = ?, email = ?, updatedAt = ? WHERE id = ?`
      )
      .run('nameX', 'mailX', '2024-06-01T00:00:00Z', 'r0');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // 届いた更新は r2 に負ける。負けたのだから、先に見えた r1 を巻き添えにしない。
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(uniqueWarnings(result.warnings)).toEqual([]);
    expect(result.clientsSynced).toBe(1);
    expect(accountRows(dbB)).toEqual([
      { id: 'r1', username: 'name1', email: 'mailX' },
      { id: 'r2', username: 'nameX', email: 'mail2' },
    ]);

    // 何周回しても同じ所で落ち続けない（＝相手からの取り込みが止まらない）
    for (let round = 0; round < 3; round++) {
      for (const [clientId, db, dbPath] of [
        ['client-a', dbA, pathA],
        ['client-b', dbB, pathB],
      ] as const) {
        const roundResult = await performSync(
          db,
          makeConfig(dbPath, clientId),
          TABLES
        );
        expect(
          uniqueWarnings(roundResult.warnings),
          `${clientId} round${round}`
        ).toEqual([]);
      }
    }
    // 最後は両端末が同じ形へ収束する（email の索引でも LWW が働き、r1 も r2 へ畳まれる）
    expect(accountRows(dbA)).toEqual([
      { id: 'r2', username: 'nameX', email: 'mail2' },
    ]);
    expect(accountRows(dbB)).toEqual(accountRows(dbA));

    dbA.close();
    dbB.close();
  });

  it('ユニークが2本ある表で、届いた作成が2本目で拒まれても同期は止まらない', async () => {
    // 更新ではなく**作成**が索引ごとに別々の相手へぶつかる形。
    // SQLite が最初に告げるのは email の違反なので、エラー文からしか相手を知れない
    // うちは「先に r1 を畳んでから r2 に負ける」ことになり、挿入し直せずに例外が抜けて
    // その相手ぶんの取り込みが丸ごと巻き戻る（＝同期がそこで止まる）。
    interface AccountRow {
      id: string;
      username: string;
      email: string;
    }
    function accountRows(db: Database.Database): AccountRow[] {
      return db
        .prepare(`SELECT id, username, email FROM accounts ORDER BY id`)
        .all() as AccountRow[];
    }
    function insertAccount(
      db: Database.Database,
      id: string,
      username: string,
      email: string,
      updatedAt: string
    ): void {
      db.prepare(
        `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run(id, username, email, updatedAt);
    }

    // A: 1行だけ作る
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    insertAccount(dbA, 'r0', 'nameX', 'mailX', '2024-06-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // B: 独立に2行作る。片方は email が、もう片方は username が、A の r0 とぶつかる。
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    insertAccount(dbB, 'r1', 'name1', 'mailX', '2024-01-01T00:00:00Z');
    insertAccount(dbB, 'r2', 'nameX', 'mail2', '2024-12-01T00:00:00Z');

    // 届いた作成は r2 に負ける。負けたのだから、先に見えた r1 を巻き添えにしない。
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(uniqueWarnings(result.warnings)).toEqual([]);
    expect(result.clientsSynced).toBe(1);
    expect(accountRows(dbB)).toEqual([
      { id: 'r1', username: 'name1', email: 'mailX' },
      { id: 'r2', username: 'nameX', email: 'mail2' },
    ]);

    // 何周回しても同じ所で落ち続けない（＝相手からの取り込みが止まらない）
    for (let round = 0; round < 3; round++) {
      for (const [clientId, db, dbPath] of [
        ['client-a', dbA, pathA],
        ['client-b', dbB, pathB],
      ] as const) {
        const roundResult = await performSync(
          db,
          makeConfig(dbPath, clientId),
          TABLES
        );
        expect(
          uniqueWarnings(roundResult.warnings),
          `${clientId} round${round}`
        ).toEqual([]);
      }
    }

    // 両端末が同じ1行へ収束する
    expect(accountRows(dbA)).toEqual([
      { id: 'r2', username: 'nameX', email: 'mail2' },
    ]);
    expect(accountRows(dbB)).toEqual(accountRows(dbA));

    dbA.close();
    dbB.close();
  });

  it('畳みで付け替えた子の行数が RecordFold に出る', async () => {
    // 「1つにまとめました」だけでは影響範囲が分からない。何行が付け替わったかを返す。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // B は独立に「国語」の t2 を作り、そこへメモを3件ぶら下げる
    insertTag(dbB, 't2', '国語', '2024-03-01T00:00:00Z');
    insertNote(dbB, 'note-1', 't2', '2024-03-01T00:00:00Z');
    insertNote(dbB, 'note-2', 't2', '2024-03-01T00:00:00Z');
    insertNote(dbB, 'note-3', 't2', '2024-03-01T00:00:00Z');

    // A: t1 を「国語」へ改名。B の t2 より新しいので、届いた改名が勝つ
    dbA
      .prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`)
      .run('国語', '2024-06-01T00:00:00Z', 't1');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(result.folds).toEqual([
      {
        tableName: 'tags',
        losingId: 't2',
        winningId: 't1',
        removedLocalRow: true,
        movedChildren: 3,
        lostChildren: 0,
      },
    ]);
    // 返した数は、実際に付け替わった行と一致すること
    expect(noteRows(dbB)).toEqual([
      { id: 'note-1', tagId: 't1' },
      { id: 'note-2', tagId: 't1' },
      { id: 'note-3', tagId: 't1' },
    ]);

    dbA.close();
    dbB.close();
  });

  it('相手の作成を自分の行へ吸収した場合は、行は消えていないと出る', async () => {
    // A と B が独立に同じ名前のタグを作る。B のものが新しいので B 側は自分を残す。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    insertTag(dbA, 't1', '国語', '2024-03-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    insertTag(dbB, 't2', '国語', '2024-06-01T00:00:00Z');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(result.folds).toEqual([
      {
        tableName: 'tags',
        losingId: 't1',
        winningId: 't2',
        removedLocalRow: false,
        movedChildren: 0,
        lostChildren: 0,
      },
    ]);
    // B は t1 を一度も持っていないので、消えた行はない
    expect(result.deleted).toBe(0);
    expect(result.conflictsResolved).toBe(1);
    expect(tagRows(dbB)).toEqual([{ id: 't2', name: '国語' }]);

    dbA.close();
    dbB.close();
  });
});
