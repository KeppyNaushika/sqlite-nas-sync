/**
 * **引き方**の回帰テスト —— どの列で、どの表を、どう照合して引くか。
 *
 * 複合外部キーの NULL 規則、表ごとに違う時刻列、表名の大小。どれも「引けなかった」
 * ことが例外ではなく**静かな取りこぼし**として現れるので、形で固定する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert } from '../src/conflict';
import { recordMerge } from '../src/conflict/ledger';
import { TableConfig } from '../src/types';

const testDir = path.join(__dirname, 'test-data-conflict-fk-lookup');

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

describe('NULL を含む複合外部キーは検査されない（捨てない）', () => {
  const TABLES: TableConfig[] = [{ name: 'parents' }, { name: 'children' }];

  it('参照列の片方が NULL の子は、畳み先が消えていても採る', () => {
    db = createDb('composite-null');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE parents (
        id        TEXT NOT NULL,
        tenantId  TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (id, tenantId)
      );
      CREATE TABLE children (
        id        TEXT PRIMARY KEY,
        parentId  TEXT,
        tenantId  TEXT,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (parentId, tenantId) REFERENCES parents(id, tenantId)
      );
    `);
    setupChangelog(db, TABLES, 'id');

    // 親 A は既に B へ畳まれて消えており、その B もそのあと消えている
    // （＝読み替え先が「消えたと分かっている」状態。ここで `ON DELETE` の再現に入る）
    recordMerge(db, 'parents', 'A', 'B', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt)
       VALUES ('parents', 'B', '2026-01-15T00:00:00.000Z')`
    ).run();

    // 遅れて届いた子。参照列の片方が NULL なので、SQLite はこの外部キーを検査しない
    const result = applyInsert(
      db,
      'children',
      'id',
      {
        id: 'c1',
        parentId: 'A',
        tenantId: null,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      ['id', 'parentId', 'tenantId', 'updatedAt']
    );

    // SQLite ならそのまま通る行を、こちらが勝手に捨てないこと
    expect(result.action).toBe('inserted');
    expect(result.warnings).toEqual([]);
    const row = db
      .prepare(`SELECT id FROM children WHERE id = 'c1'`)
      .get();
    expect(row).toBeDefined();
  });
});

describe('親の表は、親の時刻列で引く', () => {
  const TABLES: TableConfig[] = [
    { name: 'parents', timestampColumn: 'modifiedAt' },
    { name: 'children' },
  ];

  it('親だけ時刻列が違っても、畳みの記録の有効性を判定できる', () => {
    db = createDb('per-table-timestamp');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE parents (
        id         TEXT PRIMARY KEY,
        modifiedAt TEXT NOT NULL
      );
      CREATE TABLE children (
        id        TEXT PRIMARY KEY,
        parentId  TEXT REFERENCES parents(id),
        updatedAt TEXT NOT NULL
      );
    `);
    setupChangelog(db, TABLES, 'id');

    // 親 A は B へ畳まれた（判断は 2026-01）。しかし A の行はそのあと 2026-06 に
    // 更新されている ＝ この畳みはもう古い判断であり、読み替えてはいけない
    db.prepare(
      `INSERT INTO parents (id, modifiedAt) VALUES ('A', '2026-06-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO parents (id, modifiedAt) VALUES ('B', '2026-01-01T00:00:00.000Z')`
    ).run();
    recordMerge(db, 'parents', 'A', 'B', '2026-01-01T00:00:00.000Z');

    const timestampColumnFor = (tableName: string): string =>
      tableName.toLowerCase() === 'parents' ? 'modifiedAt' : 'updatedAt';

    const result = applyInsert(
      db,
      'children',
      'id',
      {
        id: 'c1',
        parentId: 'A',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      ['id', 'parentId', 'updatedAt'],
      'updatedAt',
      undefined,
      timestampColumnFor
    );

    expect(result.action).toBe('inserted');
    // 子の列名（updatedAt）で親を引くと `modifiedAt` に辿り着けず、記録が
    // いつまでも有効に見えて A の子が B へ向けられてしまう
    const row = db
      .prepare(`SELECT parentId FROM children WHERE id = 'c1'`)
      .get() as { parentId: string };
    expect(row.parentId).toBe('A');
  });
});

describe('表名の綴り違いでも tombstone を引ける', () => {
  const TABLES: TableConfig[] = [{ name: 'Items' }];

  it('相手が `items`、こちらが `Items` でも、削除済みの行は復活しない', () => {
    db = createDb('collate-nocase');
    db.exec(`
      CREATE TABLE Items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    // トリガは設定どおりの `Items` で書く
    db.prepare(
      `INSERT INTO Items (id, updatedAt) VALUES ('A', '2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(`DELETE FROM Items WHERE id = 'A'`).run();

    // 届くエントリは**相手の設定どおりの綴り**（`items`）を持つ
    const result = applyInsert(
      db,
      'items',
      'id',
      { id: 'A', updatedAt: '2026-01-01T00:00:00.000Z' },
      ['id', 'updatedAt']
    );

    // 引きが外れると、削除済みの行がここで復活する
    expect(result.action).toBe('skipped');
    const rows = db.prepare(`SELECT id FROM Items`).all();
    expect(rows).toHaveLength(0);
  });
});
