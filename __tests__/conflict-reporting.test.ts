/**
 * 結果の**呼び名と数え方** —— 起きたことと、利用者へ返す言葉が食い違わないこと。
 *
 * 採らなかった行を「入れた」と数えない。どちらも勝てない膠着を「ローカルが勝った」と
 * 言わない。同じ状態が INSERT で届いたか UPDATE で届いたかで違って見えない。
 * データそのものは壊れないが、**壊れていることに気づけなくなる**ので固定する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert, applyUpdate } from '../src/conflict';
import { SyncResult, TableConfig } from '../src/types';
import { processChangelogEntries } from '../src/sync/entries';

const testDir = path.join(__dirname, 'test-data-conflict-reporting');

/** ファイルDBを作る（`:memory:` ではトリガーの検証がしづらいため、実ファイルで揃える） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true });
  return new Database(path.join(testDir, `${name}.sqlite`));
}

let db: Database.Database;

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

afterEach(() => {
  if (db && db.open) db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('採らなかったリモート行を `upserted` と数えない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('PK重複でローカルが勝ったら `skipped` を返す', () => {
    db = createDb('insert-local-wins');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO items (id, name, updatedAt)
       VALUES ('A', 'local', '2026-06-01T00:00:00.000Z')`
    ).run();

    const result = applyInsert(
      db,
      'items',
      'id',
      { id: 'A', name: 'remote', updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'name', 'updatedAt'],
      'updatedAt'
    );

    // 届いた行は捨てられている。`upserted` と名乗ると、`processChangelogEntries` が
    // これを `conflictsResolved` に数え、`action` だけを見る呼び出し元は
    // 「リモートを適用した」と読む
    expect(result.action).toBe('skipped');
    expect(result.conflict?.resolution).toBe('local_wins');
    const row = db
      .prepare(`SELECT name FROM items WHERE id = 'A'`)
      .get() as { name: string };
    expect(row.name).toBe('local');
  });

  it('セカンダリUNIQUE でローカルが勝っても `skipped` を返す', () => {
    // 同一PKの経路だけ直しても、こちらが `upserted` を返し続けると2つの入口で
    // 呼び方が食い違ったままになる（どちらも「届いた行は書いていない」結果）
    db = createDb('insert-unique-local-wins');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO items (id, name, updatedAt)
       VALUES ('A', 'same-name', '2026-06-01T00:00:00.000Z')`
    ).run();

    const result = applyInsert(
      db,
      'items',
      'id',
      { id: 'B', name: 'same-name', updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'name', 'updatedAt'],
      'updatedAt'
    );

    expect(result.action).toBe('skipped');
    expect(result.conflict?.resolution).toBe('local_wins');
    // 届いた B の行はどこにも入っていない
    const ids = db
      .prepare(`SELECT id FROM items ORDER BY id`)
      .all() as { id: string }[];
    expect(ids.map((row) => row.id)).toEqual(['A']);
    // 「2つが1つになった」ことは `folds` が伝える（数え落とさない）
    expect(result.folds).toHaveLength(1);
  });
});

describe('時刻が NULL でも、中身が違えば膠着は膠着', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('時刻列を許容 NULL にした表で、食い違いが黙って握り潰されない', () => {
    db = createDb('null-timestamp-stalemate');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        name      TEXT,
        updatedAt TEXT
      )
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO items (id, name, updatedAt) VALUES ('A', 'local', NULL)`
    ).run();

    const result = applyInsert(
      db,
      'items',
      'id',
      { id: 'A', name: 'remote', updatedAt: null },
      ['id', 'name', 'updatedAt'],
      'updatedAt'
    );

    expect(result.action).toBe('skipped');
    // 両側とも時刻が無く中身が違う ＝ どちらも勝てない。**黙ってはいけない**
    expect(
      result.warnings.filter((warning) => warning.startsWith('Stalemate'))
    ).toHaveLength(1);
  });
});

describe('膠着は「ローカルが勝った」ではない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('INSERT で届いた膠着に、矛盾する local_wins の競合を並べない', () => {
    db = createDb('stalemate-conflict');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        note      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO items (id, note, updatedAt)
       VALUES ('A', 'local', '2026-01-01T00:00:00.000Z')`
    ).run();

    const inserted = applyInsert(
      db,
      'items',
      'id',
      { id: 'A', note: 'remote', updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'note', 'updatedAt']
    );
    const updated = applyUpdate(
      db,
      'items',
      'id',
      { id: 'A', note: 'remote', updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'note', 'updatedAt']
    );

    // 膠着は報告する（どちらの届き方でも）
    expect(
      inserted.warnings.some((warning) => warning.startsWith('Stalemate on'))
    ).toBe(true);
    expect(
      updated.warnings.some((warning) => warning.startsWith('Stalemate on'))
    ).toBe(true);

    // **同じ状態が、届き方で違って見えないこと。**
    // `local_wins` の競合を並べると `Stalemate on …` と矛盾する
    expect(inserted.conflict).toBeUndefined();
    expect(updated.conflict).toBeUndefined();
  });

  it('時刻に差があるときは、今までどおり local_wins を返す', () => {
    db = createDb('local-wins-conflict');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        note      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO items (id, note, updatedAt)
       VALUES ('A', 'local', '2026-02-01T00:00:00.000Z')`
    ).run();

    const result = applyInsert(
      db,
      'items',
      'id',
      { id: 'A', note: 'remote', updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'note', 'updatedAt']
    );
    expect(result.conflict?.resolution).toBe('local_wins');
  });
});

describe('相手が違う綴りの表名で送ってきても、エントリを捨てない', () => {
  it('設定が `users`、届くエントリが `Users` でも取り込む', () => {
    db = createDb('table-name-case-dispatch');
    db.exec(`
      CREATE TABLE users (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, [{ name: 'users' }], 'id');

    const remoteDb = new Database(':memory:');
    remoteDb.exec(`
      CREATE TABLE users (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    remoteDb
      .prepare(
        `INSERT INTO users VALUES ('u1', 'Alice', '2026-01-01T00:00:00.000Z')`
      )
      .run();

    const result: SyncResult = {
      clientsSynced: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      conflictsResolved: 0,
      folds: [],
      warnings: [],
      skippedRemotes: [],
      hadChangelogGap: false,
    };

    // 相手のトリガは**相手の設定どおりの綴り**を埋め込む。素の Map で引くと
    // 全エントリが素通りし、しかもカーソルは進むので二度と提供されない
    processChangelogEntries(
      db,
      remoteDb,
      [
        {
          id: 1,
          tableName: 'Users',
          recordId: 'u1',
          operation: 'INSERT',
          changedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      'id',
      [{ name: 'users' }],
      result
    );
    remoteDb.close();

    expect(result.inserted).toBe(1);
    const row = db.prepare(`SELECT name FROM users WHERE id = 'u1'`).get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('Alice');
  });
});
