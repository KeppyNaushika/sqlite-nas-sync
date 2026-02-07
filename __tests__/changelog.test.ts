import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import {
  readChangelog,
  getMaxChangelogId,
  hasChangelogGap,
  cleanupChangelog,
} from '../src/changelog';

describe('changelog', () => {
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
    setupChangelog(db, ['users'], 'id');
  });

  afterEach(() => {
    db.close();
  });

  describe('readChangelog', () => {
    it('sinceId以降のエントリを返す', () => {
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-01T00:00:00Z'
      );

      const all = readChangelog(db, 0);
      expect(all).toHaveLength(2);

      const fromSecond = readChangelog(db, all[0].id);
      expect(fromSecond).toHaveLength(1);
      expect(fromSecond[0].recordId).toBe('u2');
    });

    it('新しいエントリがない場合は空配列', () => {
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );

      const maxId = getMaxChangelogId(db);
      const entries = readChangelog(db, maxId);
      expect(entries).toHaveLength(0);
    });
  });

  describe('getMaxChangelogId', () => {
    it('最大IDを返す', () => {
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-01T00:00:00Z'
      );

      const maxId = getMaxChangelogId(db);
      expect(maxId).toBe(2);
    });

    it('空の_changelogでは0を返す', () => {
      const maxId = getMaxChangelogId(db);
      expect(maxId).toBe(0);
    });
  });

  describe('hasChangelogGap', () => {
    it('lastSeenId=0の場合はギャップなし', () => {
      expect(hasChangelogGap(db, 0)).toBe(false);
    });

    it('ギャップがない場合はfalse', () => {
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );

      // lastSeenId=0, MIN(id)=1 → ギャップなし
      expect(hasChangelogGap(db, 0)).toBe(false);
    });

    it('エントリが掃除された場合はtrue', () => {
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-01T00:00:00Z'
      );

      // ID=1のエントリを削除（掃除をシミュレート）
      db.prepare(`DELETE FROM _changelog WHERE id = 1`).run();

      // lastSeenId=1, MIN(id)=2 → ギャップあり
      expect(hasChangelogGap(db, 1)).toBe(true);
    });

    it('_changelogが完全に空でlastSeenId>0の場合はtrue', () => {
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      db.prepare(`DELETE FROM _changelog`).run();

      expect(hasChangelogGap(db, 5)).toBe(true);
    });
  });

  describe('cleanupChangelog', () => {
    it('古いエントリを削除する', () => {
      // 古い日時のエントリを直接挿入
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'u1', 'INSERT', '2020-01-01T00:00:00Z');

      // 新しいエントリ
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-01T00:00:00Z'
      );

      const deleted = cleanupChangelog(db, 7);
      expect(deleted).toBe(1);

      const remaining = readChangelog(db, 0);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].recordId).toBe('u2');
    });

    it('最近のエントリは残す', () => {
      db.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );

      // 今日のエントリは7日以内なので残る
      const deleted = cleanupChangelog(db, 7);
      expect(deleted).toBe(0);

      const remaining = readChangelog(db, 0);
      expect(remaining).toHaveLength(1);
    });

    it('削除した行数を返す', () => {
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'u1', 'INSERT', '2020-01-01T00:00:00Z');
      db.prepare(
        `INSERT INTO _changelog (tableName, recordId, operation, changedAt) VALUES (?, ?, ?, ?)`
      ).run('users', 'u2', 'INSERT', '2020-01-02T00:00:00Z');

      const deleted = cleanupChangelog(db, 7);
      expect(deleted).toBe(2);
    });
  });
});
