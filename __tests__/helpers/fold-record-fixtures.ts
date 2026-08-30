/**
 * 畳みの記録まわりのテストが共有する足場。
 *
 * `ON DELETE` の宣言だけが違う子テーブルを並べたDBと、そのDBに対する定型操作を置く。
 * 同じスキーマを複数のテストファイルが使うので、**形はここ1か所で決める**
 * （各ファイルに写すと、片方だけ直したときに「同じはずのDB」が食い違う）。
 */
import Database from 'better-sqlite3';
import { setupChangelog } from '../../src/setup';
import { applyInsert } from '../../src/conflict';
import { TableConfig } from '../../src/types';

export const PARENT_COLUMNS = ['id', 'tenantId', 'ukey', 'updatedAt'];
export const KID_COLUMNS = ['id', 'parentId', 'updatedAt'];
export const COMPOSITE_KID_COLUMNS = ['id', 'parentId', 'tenantId', 'updatedAt'];

export const FK_TABLES: TableConfig[] = [
  { name: 'parents' },
  { name: 'kids_cascade' },
  { name: 'kids_setnull' },
  { name: 'kids_setnull_notnull' },
  { name: 'kids_restrict' },
  { name: 'kids_noaction' },
  { name: 'kids_composite' },
  { name: 'kids_setdefault' },
  { name: 'kids_setdefault_missing' },
  { name: 'kids_setdefault_undeclared' },
  { name: 'kids_setdefault_composite' },
  { name: 'kids_setdefault_expr' },
  { name: 'kids_setdefault_expr_missing' },
  { name: 'detail_setnull' },
  { name: 'detail_setdefault' },
];

export interface KidRow {
  id: string;
  parentId: string | null;
  updatedAt: string;
}

/**
 * `ON DELETE` の宣言だけが違う子テーブルを並べたDB。
 * 親は「別id・同一ユニークキー」で畳まれる形（`ukey`）を持つ。
 */
export function createForeignKeyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE parents (
      id        TEXT PRIMARY KEY,
      tenantId  TEXT NOT NULL,
      ukey      TEXT NOT NULL UNIQUE,
      updatedAt TEXT NOT NULL,
      UNIQUE (id, tenantId)
    );
    CREATE TABLE kids_cascade (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE CASCADE,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setnull (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE SET NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setnull_notnull (
      id        TEXT PRIMARY KEY,
      parentId  TEXT NOT NULL REFERENCES parents(id) ON DELETE SET NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_restrict (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE RESTRICT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_noaction (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id),
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_composite (
      id        TEXT PRIMARY KEY,
      parentId  TEXT,
      tenantId  TEXT,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (parentId, tenantId) REFERENCES parents(id, tenantId) ON DELETE SET NULL
    );
    CREATE TABLE kids_setdefault (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT 'p-fallback' REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_missing (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT 'p-nowhere' REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_undeclared (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_expr (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT (lower('P-FALLBACK')) REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_expr_missing (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT (lower('P-NOWHERE')) REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE detail_setnull (
      id        TEXT PRIMARY KEY REFERENCES parents(id) ON DELETE SET NULL,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE detail_setdefault (
      id        TEXT PRIMARY KEY DEFAULT 'p-fallback' REFERENCES parents(id) ON DELETE SET DEFAULT,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_composite (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT 'p-fallback',
      tenantId  TEXT,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (parentId, tenantId) REFERENCES parents(id, tenantId) ON DELETE SET DEFAULT
    );
  `);
  setupChangelog(db, FK_TABLES, 'id');
  return db;
}

/**
 * 「p-a は p-b へ畳まれた」という記録を作り、そのあと利用者が p-b を消した状態にする。
 *
 * 畳みは通常の経路（同じ `ukey` の古い行が届く → ローカルが勝つ）で作る。
 * 記録を手で書かないのは、記録に刻まれる時刻まで含めて実物と同じにするため。
 */
export function foldThenDeleteWinner(db: Database.Database): void {
  db.prepare(
    `INSERT INTO parents (id, tenantId, ukey, updatedAt)
     VALUES ('p-b', 'tenant-1', 'k1', '2026-02-01T00:00:00Z')`
  ).run();

  applyInsert(
    db,
    'parents',
    'id',
    {
      id: 'p-a',
      tenantId: 'tenant-1',
      ukey: 'k1',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    PARENT_COLUMNS
  );

  db.prepare(`DELETE FROM parents WHERE id = 'p-b'`).run();
}

export function kidsOf(db: Database.Database, tableName: string): KidRow[] {
  return db
    .prepare(`SELECT id, parentId, updatedAt FROM ${tableName} ORDER BY id`)
    .all() as KidRow[];
}
