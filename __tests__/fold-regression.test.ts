/**
 * 畳み（セカンダリUNIQUE違反の統合）まわりの回帰テスト。
 *
 * 畳みは「負けた行を消す」だけでは終わらない。消えた事実と**畳み先**が、
 * 競合を経験しなかった端末まで、しかも普通に同期している端末ほど早く届く必要がある。
 * ここでは、その伝播が途中で消えたり、行き過ぎたりしないことを確かめる。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { cleanupChangelog } from '../src/changelog';
import { applyInsert, applyMergedDelete } from '../src/conflict';
import { performSync } from '../src/sync';
import { SyncConfig, TableConfig } from '../src/types';

const testDir = path.join(__dirname, 'test-data-fold-regression');

function freshDir(): void {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
}

/** `parents(id, ukey UNIQUE, updatedAt)` だけの最小のDB */
function createParentsDb(name: string, withChangelog = true): Database.Database {
  const db = new Database(path.join(testDir, `${name}.sqlite`));
  db.exec(`
    CREATE TABLE parents (
      id        TEXT PRIMARY KEY,
      ukey      TEXT NOT NULL UNIQUE,
      updatedAt TEXT NOT NULL
    )
  `);
  if (withChangelog) setupChangelog(db, [{ name: 'parents' }], 'id');
  return db;
}

const PARENT_COLUMNS = ['id', 'ukey', 'updatedAt'];

function changelogDeletes(db: Database.Database, recordId: string): string[] {
  return (
    db
      .prepare(
        `SELECT changedAt FROM _changelog
         WHERE tableName = 'parents' AND recordId = ? AND operation = 'DELETE'
         ORDER BY id`
      )
      .all(recordId) as { changedAt: string }[]
  ).map((row) => row.changedAt);
}

function tombstoneOf(
  db: Database.Database,
  tableName: string,
  recordId: string
): { deletedAt: string; mergedInto: string | null } | undefined {
  return db
    .prepare(
      `SELECT deletedAt, mergedInto FROM _tombstone
       WHERE tableName = ? AND recordId = ?`
    )
    .get(tableName, recordId) as
    | { deletedAt: string; mergedInto: string | null }
    | undefined;
}

describe('畳みの伝播', () => {
  beforeEach(freshDir);
  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('古いtombstoneが既にあっても、畳みのDELETEが掃除で消えない', () => {
    // 敗者idには「ずっと前に消して作り直した」履歴があり、tombstoneが保持期間より古い
    const db = createParentsDb('retention');
    db.prepare(`INSERT INTO parents VALUES ('aaa', 'k1', '2026-08-19')`).run();
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('parents', 'bbb', datetime('now', '-30 days'))`
    ).run();
    db.prepare(`DELETE FROM _changelog`).run();

    const { conflict } = applyInsert(
      db,
      'parents',
      'id',
      { id: 'bbb', ukey: 'k1', updatedAt: '2026-08-01' },
      PARENT_COLUMNS
    );
    expect(conflict?.resolution).toBe('local_wins');
    expect(changelogDeletes(db, 'bbb')).toHaveLength(1);

    // 生まれた直後の掃除で消えてはいけない（消えると二度と載らず、
    // 畳み先がフルマージ経路でしか渡らなくなる）
    cleanupChangelog(db, 7);
    expect(changelogDeletes(db, 'bbb')).toHaveLength(1);

    // 畳みは「今下した判断」なので、削除時刻も勝者のタイムスタンプまで進む
    expect(tombstoneOf(db, 'parents', 'bbb')).toEqual({
      deletedAt: '2026-08-19',
      mergedInto: 'aaa',
    });

    db.close();
  });

  it('`_changelog` が無いうちに畳みが起きても、揃った後で差分経路に載る', () => {
    // setupChangelog を通す前に applyInsert が使われたDB
    const db = createParentsDb('late-setup', false);
    db.prepare(`INSERT INTO parents VALUES ('aaa', 'k1', '2026-08-19')`).run();

    const remote = { id: 'bbb', ukey: 'k1', updatedAt: '2026-08-01' };
    applyInsert(db, 'parents', 'id', remote, PARENT_COLUMNS);
    expect(
      db.prepare(`SELECT winningId FROM _id_merge WHERE losingId = 'bbb'`).get()
    ).toEqual({ winningId: 'aaa' });

    setupChangelog(db, [{ name: 'parents' }], 'id');
    db.prepare(`DELETE FROM _changelog`).run();

    // `_id_merge` に記録済みだからと打ち切ってはいけない
    applyInsert(db, 'parents', 'id', remote, PARENT_COLUMNS);
    expect(changelogDeletes(db, 'bbb')).toHaveLength(1);

    // 二度目以降は増やさない
    applyInsert(db, 'parents', 'id', remote, PARENT_COLUMNS);
    expect(changelogDeletes(db, 'bbb')).toHaveLength(1);

    db.close();
  });

  it('畳みのtombstoneは、勝者より新しい行の到着まで止めない', () => {
    const db = createParentsDb('shadow');

    // 実データのタイムスタンプは必ず過去なので、「現在時刻」を刻むと全部が止まる。
    // それと区別するため、勝者より後・現在より前の時刻を用意する。
    const { loser, winner, later } = db
      .prepare(
        `SELECT datetime('now', '-3 days') AS loser,
                datetime('now', '-2 days') AS winner,
                datetime('now', '-1 days') AS later`
      )
      .get() as { loser: string; winner: string; later: string };

    db.prepare(`INSERT INTO parents VALUES ('aaa', 'k1', ?)`).run(winner);
    applyInsert(
      db,
      'parents',
      'id',
      { id: 'bbb', ukey: 'k1', updatedAt: loser },
      PARENT_COLUMNS
    );
    expect(tombstoneOf(db, 'parents', 'bbb')).toEqual({
      deletedAt: winner,
      mergedInto: 'aaa',
    });

    // 畳みに負けた版より古いものは通さない（LWWどおり）
    expect(
      applyInsert(
        db,
        'parents',
        'id',
        { id: 'bbb', ukey: 'k2', updatedAt: loser },
        PARENT_COLUMNS
      ).action
    ).toBe('skipped');

    // ユニークキーが変わってもう衝突しない、勝者より新しい行は受け取る
    expect(
      applyInsert(
        db,
        'parents',
        'id',
        { id: 'bbb', ukey: 'k2', updatedAt: later },
        PARENT_COLUMNS
      ).action
    ).toBe('inserted');
    expect(
      db.prepare(`SELECT ukey FROM parents WHERE id = 'bbb'`).get()
    ).toEqual({ ukey: 'k2' });

    db.close();
  });

  it('畳みより後に更新された行は、届いた畳みでは消さない', () => {
    const db = createParentsDb('merged-lww');
    db.prepare(`INSERT INTO parents VALUES ('aaa', 'k1', '2026-08-19')`).run();
    db.prepare(`INSERT INTO parents VALUES ('bbb', 'k2', '2026-12-31')`).run();

    // 畳みは 2026-08-19 時点の判断。bbb はその後ユニークキーごと更新されている
    expect(
      applyMergedDelete(
        db,
        'parents',
        'id',
        'bbb',
        'aaa',
        undefined,
        PARENT_COLUMNS,
        'updatedAt',
        '2026-08-19'
      ).action
    ).toBe('skipped');
    expect(
      db.prepare(`SELECT id FROM parents WHERE id = 'bbb'`).get()
    ).toBeDefined();
    // 生きている行の子は今のままで正しいので、読み替えも覚えない
    expect(
      db.prepare(`SELECT 1 FROM _id_merge WHERE losingId = 'bbb'`).get()
    ).toBeUndefined();

    // 畳みの方が新しければ普通に畳む
    expect(
      applyMergedDelete(
        db,
        'parents',
        'id',
        'bbb',
        'aaa',
        undefined,
        PARENT_COLUMNS,
        'updatedAt',
        '2027-01-05'
      ).action
    ).toBe('folded');
    expect(
      db.prepare(`SELECT id FROM parents WHERE id = 'bbb'`).get()
    ).toBeUndefined();

    db.close();
  });

  it('トリガーを外した状態（フルマージ中）の畳みも差分経路に載る', () => {
    const db = createParentsDb('full-merge');
    db.prepare(`INSERT INTO parents VALUES ('aaa', 'k1', '2026-08-01')`).run();
    db.exec(`DROP TRIGGER _changelog_after_delete_parents`);
    db.prepare(`DELETE FROM _changelog`).run();

    // リモートが勝つ → aaa が畳まれて消えるが、トリガーが無いので誰も記録しない
    applyInsert(
      db,
      'parents',
      'id',
      { id: 'bbb', ukey: 'k1', updatedAt: '2026-08-19' },
      PARENT_COLUMNS
    );

    expect(changelogDeletes(db, 'aaa')).toHaveLength(1);
    expect(tombstoneOf(db, 'parents', 'aaa')?.mergedInto).toBe('bbb');

    db.close();
  });

  it('トリガーが生きているときは畳みのDELETEを二重に書かない', () => {
    const db = createParentsDb('no-dup');
    db.prepare(`INSERT INTO parents VALUES ('aaa', 'k1', '2026-08-01')`).run();
    db.prepare(`DELETE FROM _changelog`).run();

    applyInsert(
      db,
      'parents',
      'id',
      { id: 'bbb', ukey: 'k1', updatedAt: '2026-08-19' },
      PARENT_COLUMNS
    );

    expect(changelogDeletes(db, 'aaa')).toHaveLength(1);
    db.close();
  });
});

describe('循環する外部キーの畳み', () => {
  beforeEach(freshDir);
  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('同じ行の畳みへ再入しても、外部キーを壊さず畳み終わる', () => {
    // n1 → n3 → n1 と参照が一周する形。畳みの途中で n1 の畳みへ再入する
    // （`foldRowInto` が同じ行に二度入る唯一の経路）。
    const db = new Database(path.join(testDir, 'cyclic.sqlite'));
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE n (
        id        TEXT PRIMARY KEY,
        ukey      TEXT NOT NULL UNIQUE,
        pId       TEXT REFERENCES n(id),
        tag       TEXT,
        updatedAt TEXT NOT NULL,
        UNIQUE (pId, tag)
      )
    `);
    setupChangelog(db, [{ name: 'n' }], 'id');

    db.exec(`
      INSERT INTO n (id, ukey, pId, tag, updatedAt) VALUES
        ('n2', 'k2', NULL, NULL, '2026-01-01'),
        ('n1', 'k1', NULL, NULL, '2026-01-01');
      INSERT INTO n (id, ukey, pId, tag, updatedAt) VALUES
        ('n3', 'k3', 'n1', 't', '2026-01-01');
      UPDATE n SET pId = 'n3', tag = 'v' WHERE id = 'n1';
      INSERT INTO n (id, ukey, pId, tag, updatedAt) VALUES
        ('n4', 'k4', 'n2', 't', '2026-06-01'),
        ('n6', 'k6', 'n4', 'v', '2026-06-01');
    `);

    // n1 を n2 へ畳む。途中で n3 が n4 へ畳まれ、その子として n1 に戻ってきて、
    // さらに n1 が n6 へ畳まれる（＝ n1 の畳みへの再入）。
    const { action } = applyMergedDelete(
      db,
      'n',
      'id',
      'n1',
      'n2',
      undefined,
      ['id', 'ukey', 'pId', 'tag', 'updatedAt']
    );
    expect(action).toBe('folded');

    const remaining = (
      db.prepare(`SELECT id FROM n ORDER BY id`).all() as { id: string }[]
    ).map((row) => row.id);
    expect(remaining).toEqual(['n2', 'n4', 'n6']);

    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});

describe('deleteProtected と畳み', () => {
  const nasDir = path.join(testDir, 'nas');

  const TABLES: TableConfig[] = [
    { name: 'parents', deleteProtected: true },
    { name: 'children' },
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
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        ukey      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE children (
        id        TEXT PRIMARY KEY,
        parentId  TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
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

  beforeEach(() => {
    freshDir();
    fs.mkdirSync(nasDir, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('畳みは deleteProtected でも適用される（勝者行が差分に無くても）', async () => {
    const a = createClientDb('client-a');
    const b = createClientDb('client-b');

    a.db
      .prepare(`INSERT INTO parents VALUES ('p_a', 'k1', '2026-08-19')`)
      .run();
    a.db
      .prepare(`INSERT INTO children VALUES ('c_a', 'p_a', '2026-08-19')`)
      .run();
    b.db
      .prepare(`INSERT INTO parents VALUES ('p_b', 'k1', '2026-08-01')`)
      .run();
    b.db
      .prepare(`INSERT INTO children VALUES ('c_b', 'p_b', '2026-08-01')`)
      .run();

    // B をNASへ載せてから、A が B の p_b を受け取り自分の p_a へ畳む
    // （A側では敗者行の削除が起きないので、DELETEトリガーは何も残さない）
    await performSync(b.db, makeConfig(b.dbPath, 'client-b'), TABLES);
    await performSync(a.db, makeConfig(a.dbPath, 'client-a'), TABLES);
    // 畳みの記録をNASへ載せる（通常フローはpullの前にアップロードするため）
    await performSync(a.db, makeConfig(a.dbPath, 'client-a'), TABLES);

    const foldEntryId = (
      a.db
        .prepare(
          `SELECT id FROM _changelog
           WHERE tableName = 'parents' AND recordId = 'p_b' AND operation = 'DELETE'`
        )
        .get() as { id: number }
    ).id;

    // B は勝者 p_a のINSERTを既に見た後だとして、畳みのDELETEだけを受け取る
    b.db
      .prepare(
        `INSERT OR REPLACE INTO _sync_state (remoteClientId, lastSeenId, lastSyncedAt)
         VALUES ('client-a', ?, datetime('now'))`
      )
      .run(foldEntryId - 1);

    await performSync(b.db, makeConfig(b.dbPath, 'client-b'), TABLES);

    // 畳みはユニーク制約が強制する統合なので、削除保護の対象外
    expect(
      b.db.prepare(`SELECT id FROM parents ORDER BY id`).all()
    ).toEqual([{ id: 'p_a' }]);
    // 子は道連れにならず、畳み先へ引き取られる
    expect(
      b.db.prepare(`SELECT id, parentId FROM children ORDER BY id`).all()
    ).toEqual([{ id: 'c_b', parentId: 'p_a' }]);

    a.db.close();
    b.db.close();
  });

  it('畳みでない削除は deleteProtected のまま適用されない', async () => {
    const a = createClientDb('client-a');
    const b = createClientDb('client-b');

    a.db
      .prepare(`INSERT INTO parents VALUES ('p1', 'k1', '2026-08-01')`)
      .run();
    await performSync(a.db, makeConfig(a.dbPath, 'client-a'), TABLES);
    await performSync(b.db, makeConfig(b.dbPath, 'client-b'), TABLES);
    expect(b.db.prepare(`SELECT id FROM parents`).all()).toEqual([{ id: 'p1' }]);

    a.db.prepare(`DELETE FROM parents WHERE id = 'p1'`).run();
    await performSync(a.db, makeConfig(a.dbPath, 'client-a'), TABLES);
    await performSync(b.db, makeConfig(b.dbPath, 'client-b'), TABLES);

    expect(b.db.prepare(`SELECT id FROM parents`).all()).toEqual([{ id: 'p1' }]);

    a.db.close();
    b.db.close();
  });
});
