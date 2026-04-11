import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { discoverTables, validateDatabase } from '../src/validator';

describe('validateDatabase', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('正しいスキーマのテーブルはエラーなし', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, [{ name: 'users' }], 'id');
    expect(errors).toHaveLength(0);
  });

  it('テーブルが存在しない場合エラー', () => {
    const errors = validateDatabase(db, [{ name: 'nonexistent' }], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].table).toBe('nonexistent');
    expect(errors[0].message).toContain('does not exist');
  });

  it('PKカラムが存在しない場合エラー', () => {
    db.exec(`
      CREATE TABLE users (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, [{ name: 'users' }], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Primary key column 'id' does not exist");
  });

  it('PKがTEXT型でない場合エラー', () => {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, [{ name: 'users' }], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('must be TEXT type');
  });

  it('updatedAtカラムがない場合エラー', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, [{ name: 'users' }], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("'updatedAt' does not exist");
  });

  it('複数テーブルで一部だけエラー', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        message TEXT
      )
    `);

    const errors = validateDatabase(db, [{ name: 'users' }, { name: 'logs' }], 'id');
    // logs: INTEGER PK + updatedAtなし
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.every((e) => e.table === 'logs')).toBe(true);
  });

  it('テーブル不在の場合、後続チェックをスキップ', () => {
    const errors = validateDatabase(db, [{ name: 'missing' }], 'id');
    // エラーは1つだけ（不在エラーのみ、PKやupdatedAtのエラーは出ない）
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Table does not exist');
  });

  it('カスタムtimestampColumnが存在しない場合エラー', () => {
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(
      db,
      [{ name: 'items', timestampColumn: 'modifiedAt' }],
      'id'
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("'modifiedAt' does not exist");
  });

  it('カスタムtimestampColumnが存在する場合はエラーなし', () => {
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        modifiedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(
      db,
      [{ name: 'items', timestampColumn: 'modifiedAt' }],
      'id'
    );
    expect(errors).toHaveLength(0);
  });
});

describe('discoverTables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('id と updatedAt を持つテーブルを検出する', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const tables = discoverTables(db);
    expect(tables.map((t) => t.name).sort()).toEqual(['posts', 'users']);
  });

  it('_ プレフィックスのテーブルは除外される', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE _changelog (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE _prisma_migrations (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);

    const tables = discoverTables(db);
    expect(tables.map((t) => t.name)).toEqual(['users']);
  });

  it('sqlite_ プレフィックスのテーブルは除外される', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    // sqlite_sequence は AUTOINCREMENT 使用時に自動作成される
    db.exec(`
      CREATE TABLE auto (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT
      )
    `);

    const tables = discoverTables(db);
    expect(tables.map((t) => t.name)).toEqual(['users']);
  });

  it('id カラムが無いテーブルは静かにスキップされる', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE join_table (
        userId TEXT NOT NULL,
        groupId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (userId, groupId)
      )
    `);

    const warnings: string[] = [];
    const tables = discoverTables(db, { onWarning: (m) => warnings.push(m) });

    expect(tables.map((t) => t.name)).toEqual(['users']);
    expect(warnings).toHaveLength(0); // 警告は出ない
  });

  it('updatedAt が無いテーブルは警告つきでスキップされる', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE local_cache (
        id TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    const warnings: string[] = [];
    const tables = discoverTables(db, { onWarning: (m) => warnings.push(m) });

    expect(tables.map((t) => t.name)).toEqual(['users']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('local_cache');
    expect(warnings[0]).toContain('updatedAt');
  });

  it('excludeTables に含まれるテーブルは除外され、警告も出ない', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE local_cache (
        id TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    const warnings: string[] = [];
    const tables = discoverTables(db, {
      excludeTables: ['local_cache'],
      onWarning: (m) => warnings.push(m),
    });

    expect(tables.map((t) => t.name)).toEqual(['users']);
    expect(warnings).toHaveLength(0);
  });

  it('tableOptions の deleteProtected が適用される', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);

    const tables = discoverTables(db, {
      tableOptions: { users: { deleteProtected: true } },
    });

    const users = tables.find((t) => t.name === 'users');
    const posts = tables.find((t) => t.name === 'posts');
    expect(users?.deleteProtected).toBe(true);
    expect(posts?.deleteProtected).toBeUndefined();
  });

  it('tableOptions の timestampColumn でカスタム列を使える', () => {
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        modifiedAt TEXT NOT NULL
      )
    `);

    const tables = discoverTables(db, {
      tableOptions: { items: { timestampColumn: 'modifiedAt' } },
    });

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('items');
    expect(tables[0].timestampColumn).toBe('modifiedAt');
  });

  it('tableOptions の timestampColumn が存在しないなら警告つきでスキップ', () => {
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);

    const warnings: string[] = [];
    const tables = discoverTables(db, {
      tableOptions: { items: { timestampColumn: 'modifiedAt' } },
      onWarning: (m) => warnings.push(m),
    });

    expect(tables).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('modifiedAt');
  });

  it('カスタム primaryKey で検出する', () => {
    db.exec(`
      CREATE TABLE users (
        uuid TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);

    const tables = discoverTables(db, { primaryKey: 'uuid' });
    expect(tables.map((t) => t.name)).toEqual(['users']);
  });

  it('該当テーブルが0件なら空配列を返す', () => {
    expect(discoverTables(db)).toEqual([]);
  });

  it('結果は名前順にソートされる', () => {
    db.exec(`CREATE TABLE zeta (id TEXT PRIMARY KEY, updatedAt TEXT NOT NULL)`);
    db.exec(`CREATE TABLE alpha (id TEXT PRIMARY KEY, updatedAt TEXT NOT NULL)`);
    db.exec(`CREATE TABLE mike (id TEXT PRIMARY KEY, updatedAt TEXT NOT NULL)`);

    const tables = discoverTables(db);
    expect(tables.map((t) => t.name)).toEqual(['alpha', 'mike', 'zeta']);
  });
});
