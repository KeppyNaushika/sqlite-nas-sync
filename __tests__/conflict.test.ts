import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyInsert, applyUpdate, applyDelete } from '../src/conflict';

describe('conflict', () => {
  let db: Database.Database;
  const columns = ['id', 'name', 'email', 'updatedAt'];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('applyInsert', () => {
    it('新規レコードを挿入する', () => {
      const result = applyInsert(db, 'users', 'id', {
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('inserted');
      expect(result.conflict).toBeUndefined();

      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
      expect(row.name).toBe('Alice');
    });

    it('PK重複時はUPSERTする（リモートが新しい場合）', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');

      const result = applyInsert(db, 'users', 'id', {
        id: 'u1',
        name: 'Alice Updated',
        email: 'alice.new@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('upserted');
      expect(result.conflict?.resolution).toBe('remote_wins');

      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
      expect(row.name).toBe('Alice Updated');
    });

    it('UNIQUE制約違反（PK以外）でUPSERTする', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');

      // 異なるIDだが同じemail
      const result = applyInsert(db, 'users', 'id', {
        id: 'u2',
        name: 'Alice Clone',
        email: 'alice@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('upserted');
      expect(result.conflict).toBeDefined();
    });
  });

  describe('applyUpdate', () => {
    it('リモートが新しい場合は更新する', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');

      const result = applyUpdate(db, 'users', 'id', {
        id: 'u1',
        name: 'Alice Updated',
        email: 'alice.new@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('updated');
      expect(result.conflict?.resolution).toBe('remote_wins');

      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
      expect(row.name).toBe('Alice Updated');
    });

    it('ローカルが新しい場合はスキップする', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-06-01T00:00:00Z');

      const result = applyUpdate(db, 'users', 'id', {
        id: 'u1',
        name: 'Alice Old',
        email: 'alice.old@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('skipped');
      expect(result.conflict?.resolution).toBe('local_wins');

      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
      expect(row.name).toBe('Alice');
    });

    it('同じタイムスタンプならスキップする', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');

      const result = applyUpdate(db, 'users', 'id', {
        id: 'u1',
        name: 'Alice Same',
        email: 'alice.same@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('skipped');
      expect(result.conflict).toBeUndefined();
    });

    it('ローカルに存在しない場合はINSERTする', () => {
      const result = applyUpdate(db, 'users', 'id', {
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('inserted');

      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
      expect(row.name).toBe('Alice');
    });
  });

  describe('applyDelete', () => {
    it('存在するレコードを削除する', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');

      const result = applyDelete(db, 'users', 'id', 'u1');
      expect(result.action).toBe('deleted');

      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
      expect(row).toBeUndefined();
    });

    it('存在しないレコードの削除はスキップする', () => {
      const result = applyDelete(db, 'users', 'id', 'nonexistent');
      expect(result.action).toBe('skipped');
    });
  });
});
