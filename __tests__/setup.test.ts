import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';

describe('setupChangelog', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
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
  });

  afterEach(() => {
    db.close();
  });

  it('_changelog テーブルを作成する', () => {
    setupChangelog(db, [{ name: 'users' }], 'id');

    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_changelog'`)
      .get();
    expect(table).toBeTruthy();
  });

  it('_sync_state テーブルを作成する', () => {
    setupChangelog(db, [{ name: 'users' }], 'id');

    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_sync_state'`)
      .get();
    expect(table).toBeTruthy();
  });

  it('テーブルごとに3つのトリガーを作成する', () => {
    setupChangelog(db, [{ name: 'users' }, { name: 'posts' }], 'id');

    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`)
      .all() as { name: string }[];

    const triggerNames = triggers.map((t) => t.name);
    expect(triggerNames).toContain('_changelog_after_insert_users');
    expect(triggerNames).toContain('_changelog_after_update_users');
    expect(triggerNames).toContain('_changelog_after_delete_users');
    expect(triggerNames).toContain('_changelog_after_insert_posts');
    expect(triggerNames).toContain('_changelog_after_update_posts');
    expect(triggerNames).toContain('_changelog_after_delete_posts');
    expect(triggers).toHaveLength(6);
  });

  it('冪等: 2回実行してもエラーにならない', () => {
    setupChangelog(db, [{ name: 'users' }], 'id');
    expect(() => setupChangelog(db, [{ name: 'users' }], 'id')).not.toThrow();
  });

  it('INSERT時に_changelogにエントリが記録される', () => {
    setupChangelog(db, [{ name: 'users' }], 'id');

    db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );

    const entries = db.prepare(`SELECT * FROM _changelog`).all() as any[];
    expect(entries).toHaveLength(1);
    expect(entries[0].tableName).toBe('users');
    expect(entries[0].recordId).toBe('u1');
    expect(entries[0].operation).toBe('INSERT');
  });

  it('UPDATE時に_changelogにエントリが記録される', () => {
    setupChangelog(db, [{ name: 'users' }], 'id');

    db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run('Bob', 'u1');

    const entries = db.prepare(`SELECT * FROM _changelog`).all() as any[];
    expect(entries).toHaveLength(2);
    expect(entries[1].operation).toBe('UPDATE');
    expect(entries[1].recordId).toBe('u1');
  });

  it('DELETE時に_changelogにエントリが記録される', () => {
    setupChangelog(db, [{ name: 'users' }], 'id');

    db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    db.prepare(`DELETE FROM users WHERE id = ?`).run('u1');

    const entries = db.prepare(`SELECT * FROM _changelog`).all() as any[];
    expect(entries).toHaveLength(2);
    expect(entries[1].operation).toBe('DELETE');
    expect(entries[1].recordId).toBe('u1');
  });

  it('WALモードが設定される（ファイルDB）', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = path.join(__dirname, 'test-data-wal');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, 'wal-test.sqlite');

    const fileDb = new Database(tmpPath);
    fileDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    setupChangelog(fileDb, [{ name: 'users' }], 'id');

    const journalMode = fileDb.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');

    fileDb.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('Cascade削除でもトリガーが発火する', () => {
    db.exec(`PRAGMA foreign_keys = ON`);
    db.exec(`
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        body TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    setupChangelog(db, [{ name: 'users' }, { name: 'comments' }], 'id');

    db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    db.prepare(
      `INSERT INTO comments (id, userId, body, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('c1', 'u1', 'hello', '2024-01-01T00:00:00Z');

    // ユーザー削除でコメントもCascade削除される
    db.prepare(`DELETE FROM users WHERE id = ?`).run('u1');

    const entries = db.prepare(`SELECT * FROM _changelog ORDER BY id`).all() as any[];
    // INSERT users, INSERT comments, DELETE comments (cascade), DELETE users
    const deleteEntries = entries.filter((e: any) => e.operation === 'DELETE');
    expect(deleteEntries).toHaveLength(2);
    expect(deleteEntries.map((e: any) => e.tableName).sort()).toEqual(['comments', 'users']);
  });
});
