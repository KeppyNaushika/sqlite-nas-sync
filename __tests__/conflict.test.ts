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

    it('セカンダリUNIQUE違反（別ID・同一ユニークキー）でリモートが新しい場合、ローカル行を置換する', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');

      // 異なるIDだが同じemail、リモートの方が新しい
      const result = applyInsert(db, 'users', 'id', {
        id: 'u2',
        name: 'Alice Clone',
        email: 'alice@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('upserted');
      expect(result.conflict?.resolution).toBe('remote_wins');

      // 敗者（u1）は削除され、勝者（u2）が存在する
      const u1 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
      const u2 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u2') as any;
      expect(u1).toBeUndefined();
      expect(u2.name).toBe('Alice Clone');
    });

    it('セカンダリUNIQUE違反でローカルが新しい場合、リモート行を採用しない', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-06-01T00:00:00Z');

      const result = applyInsert(db, 'users', 'id', {
        id: 'u2',
        name: 'Alice Clone',
        email: 'alice@example.com',
        updatedAt: '2024-01-01T00:00:00Z',
      }, columns);

      expect(result.action).toBe('upserted');
      expect(result.conflict?.resolution).toBe('local_wins');

      // ローカル（u1）が保持され、リモート（u2）は挿入されない
      const u1 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
      const u2 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u2');
      expect(u1.name).toBe('Alice');
      expect(u2).toBeUndefined();
    });
  });

  describe('applyInsert: 敗者行の子の引き取り', () => {
    const orderColumns = ['id', 'userId', 'label', 'updatedAt'];

    beforeEach(() => {
      db.exec(`
        CREATE TABLE orders (
          id        TEXT PRIMARY KEY,
          userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label     TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);
    });

    it('トランザクションの外から呼んでも、敗者の子が勝者へ付け替えられる', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');
      db.prepare(
        `INSERT INTO orders (id, userId, label, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('o1', 'u1', '注文1', '2024-01-01T00:00:00Z');

      const result = applyInsert(
        db,
        'users',
        'id',
        {
          id: 'u2',
          name: 'Alice Clone',
          email: 'alice@example.com',
          updatedAt: '2024-06-01T00:00:00Z',
        },
        columns
      );

      expect(result.conflict?.resolution).toBe('remote_wins');
      const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get('o1') as any;
      expect(order.userId).toBe('u2');
    });

    it('親と主キーを共有する子（1:1）では、子のidが動いても孫が付いてくる', () => {
      db.exec(`
        CREATE TABLE profiles (
          id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          bio       TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE profile_notes (
          id        TEXT PRIMARY KEY,
          profileId TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          body      TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);

      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');
      db.prepare(
        `INSERT INTO profiles (id, bio, updatedAt) VALUES (?, ?, ?)`
      ).run('u1', '自己紹介', '2024-01-01T00:00:00Z');
      db.prepare(
        `INSERT INTO profile_notes (id, profileId, body, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('n1', 'u1', 'メモ', '2024-01-01T00:00:00Z');

      applyInsert(
        db,
        'users',
        'id',
        {
          id: 'u2',
          name: 'Alice Clone',
          email: 'alice@example.com',
          updatedAt: '2024-06-01T00:00:00Z',
        },
        columns
      );

      const profile = db.prepare(`SELECT * FROM profiles`).all() as any[];
      expect(profile).toHaveLength(1);
      expect(profile[0].id).toBe('u2');
      const note = db.prepare(`SELECT * FROM profile_notes WHERE id = ?`).get('n1') as any;
      expect(note.profileId).toBe('u2');
    });

    it('ローカルが勝った場合、あとから届く敗者の子は勝者へ向け直して挿入される', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-06-01T00:00:00Z');

      // リモートのu2は古いので採用されない（が、対応は記録される）
      applyInsert(
        db,
        'users',
        'id',
        {
          id: 'u2',
          name: 'Alice Clone',
          email: 'alice@example.com',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        columns
      );

      // 存在しないu2を指す子が遅れて届く
      const result = applyInsert(
        db,
        'orders',
        'id',
        { id: 'o2', userId: 'u2', label: '注文2', updatedAt: '2024-01-01T00:00:00Z' },
        orderColumns
      );

      expect(result.action).toBe('inserted');
      const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get('o2') as any;
      expect(order.userId).toBe('u1');
    });
  });

  describe('applyUpdate', () => {
    it('ローカルにPKが無くセカンダリUNIQUE違反になる場合も競合解決される', () => {
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');

      // リモートのUPDATEエントリだが、ローカルにu2は無く、emailがu1と衝突する
      const result = applyUpdate(db, 'users', 'id', {
        id: 'u2',
        name: 'Alice Remote',
        email: 'alice@example.com',
        updatedAt: '2024-06-01T00:00:00Z',
      }, columns);

      // 例外にならず、LWWで解決される（リモートが新しい → 置換）
      expect(result.action).toBe('updated');
      const u1 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
      const u2 = db.prepare(`SELECT * FROM users WHERE id = ?`).get('u2') as any;
      expect(u1).toBeUndefined();
      expect(u2.name).toBe('Alice Remote');
    });

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

    it('タイムゾーンオフセット混在でも時刻として比較する（字句比較だと更新喪失する回帰ケース）', () => {
      // ローカルは 10:00 UTC。リモートは +09:00 表記の 18:30（=09:30 UTC）で実際は古い。
      // 字句比較では "T18:30" > "T10:00" となりリモートが新しく見えてしまうが、
      // julianday 正規化により本当の時刻順（ローカルが新しい）で local_wins になるべき。
      db.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2026-05-13T10:00:00.000+00:00');

      const result = applyUpdate(db, 'users', 'id', {
        id: 'u1',
        name: 'Alice Stale',
        email: 'alice.stale@example.com',
        updatedAt: '2026-05-13T18:30:00.000+09:00',
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
