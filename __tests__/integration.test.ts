import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupSync, SyncResult } from '../src/index';
import { SyncConfig } from '../src/types';

describe('Integration Tests', () => {
  const testDir = path.join(__dirname, 'test-data-integration');
  const nasDir = path.join(testDir, 'nas');

  function createClientDb(clientId: string): string {
    const clientDir = path.join(testDir, clientId);
    fs.mkdirSync(clientDir, { recursive: true });
    const dbPath = path.join(clientDir, 'local.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        userId TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.close();
    return dbPath;
  }

  function makeConfig(dbPath: string, clientId: string): SyncConfig {
    return {
      dbPath,
      nasPath: nasDir,
      clientId,
      tables: [{ name: 'users' }, { name: 'posts' }],
      primaryKey: 'id',
      intervalMs: 100,
      changelogRetentionDays: 7,
    };
  }

  /** setupSync後にデータ挿入する（トリガーが発火する） */
  function insertUserViaDb(
    dbPath: string,
    id: string,
    name: string,
    email: string,
    updatedAt: string
  ): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
    ).run(id, name, email, updatedAt);
    db.close();
  }

  function updateUserViaDb(
    dbPath: string,
    id: string,
    name: string,
    email: string,
    updatedAt: string
  ): void {
    const db = new Database(dbPath);
    db.prepare(
      `UPDATE users SET name = ?, email = ?, updatedAt = ? WHERE id = ?`
    ).run(name, email, updatedAt, id);
    db.close();
  }

  function getUser(dbPath: string, id: string): Record<string, unknown> | undefined {
    const db = new Database(dbPath);
    const row = db
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    db.close();
    return row;
  }

  function getAllUsers(dbPath: string): Record<string, unknown>[] {
    const db = new Database(dbPath);
    const rows = db.prepare(`SELECT * FROM users ORDER BY id`).all() as Record<string, unknown>[];
    db.close();
    return rows;
  }

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(nasDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('2クライアント間の双方向sync', () => {
    it('Client AのデータがClient Bに、BのデータがAに同期される', async () => {
      const pathA = createClientDb('client-a');
      const pathB = createClientDb('client-b');

      // setupSyncでトリガーを作成
      const syncA = setupSync(makeConfig(pathA, 'client-a'));
      const syncB = setupSync(makeConfig(pathB, 'client-b'));

      // トリガー存在後にデータ追加
      insertUserViaDb(pathA, 'u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');
      insertUserViaDb(pathB, 'u2', 'Bob', 'bob@example.com', '2024-01-01T00:00:00Z');

      // Client A sync (NASにpush)
      await syncA.syncNow();

      // Client B sync (Aのデータを取得 + NASにpush)
      const resultB = await syncB.syncNow();
      expect(resultB.inserted).toBeGreaterThanOrEqual(1);

      // Client A 再sync (Bのデータを取得)
      const resultA2 = await syncA.syncNow();
      expect(resultA2.inserted).toBeGreaterThanOrEqual(1);

      // 両方に全ユーザーが存在
      syncA.stop();
      syncB.stop();

      const usersA = getAllUsers(pathA);
      const usersB = getAllUsers(pathB);
      expect(usersA).toHaveLength(2);
      expect(usersB).toHaveLength(2);
    });
  });

  describe('LWW競合解決', () => {
    it('同一レコードの競合がupdatedAtで解決される', async () => {
      const pathA = createClientDb('client-a');
      const pathB = createClientDb('client-b');

      // setupSyncでトリガーを作成
      const syncA = setupSync(makeConfig(pathA, 'client-a'));
      const syncB = setupSync(makeConfig(pathB, 'client-b'));

      // 両方に同じIDのレコード（異なる内容・タイムスタンプ）
      insertUserViaDb(pathA, 'u1', 'Alice Old', 'old@example.com', '2024-01-01T00:00:00Z');
      insertUserViaDb(pathB, 'u1', 'Alice New', 'new@example.com', '2024-06-01T00:00:00Z');

      // Client A sync
      await syncA.syncNow();

      // Client B sync → Aの古いデータは無視される（Bが新しい）
      await syncB.syncNow();
      const userB = getUser(pathB, 'u1') as any;
      expect(userB.name).toBe('Alice New');

      // Client A 再sync → Bの新しいデータが反映される
      await syncA.syncNow();
      syncA.stop();
      syncB.stop();

      const userA = getUser(pathA, 'u1') as any;
      expect(userA.name).toBe('Alice New');
    });
  });

  describe('DELETE伝播', () => {
    it('Client Aが削除したレコードがClient Bでも削除される', async () => {
      const pathA = createClientDb('client-a');
      const pathB = createClientDb('client-b');

      // setupSyncでトリガー作成
      const syncA = setupSync(makeConfig(pathA, 'client-a'));
      const syncB = setupSync(makeConfig(pathB, 'client-b'));

      // Client A: レコード追加 → sync
      insertUserViaDb(pathA, 'u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');
      await syncA.syncNow();

      // Client B: sync → レコード取得
      await syncB.syncNow();
      expect(getUser(pathB, 'u1')).toBeTruthy();

      // Client A: レコード削除（トリガーが _changelog に DELETE を記録）→ sync
      const dbA = new Database(pathA);
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      dbA.close();

      await syncA.syncNow();

      // Client B: 再sync → 削除が伝播
      const resultB2 = await syncB.syncNow();
      syncA.stop();
      syncB.stop();

      expect(resultB2.deleted).toBe(1);
      expect(getUser(pathB, 'u1')).toBeUndefined();
    });
  });

  describe('イベントシステム', () => {
    it('sync:start / sync:complete イベントが発火する', async () => {
      const pathA = createClientDb('client-a');
      const syncA = setupSync(makeConfig(pathA, 'client-a'));

      const events: string[] = [];
      let completedResult: SyncResult | null = null;

      syncA.on('sync:start', () => events.push('start'));
      syncA.on('sync:complete', (data) => {
        events.push('complete');
        completedResult = data as SyncResult;
      });

      await syncA.syncNow();
      syncA.stop();

      expect(events).toEqual(['start', 'complete']);
      expect(completedResult).toBeTruthy();
    });

    it('sync:error イベントが発火する（NAS接続不可時）', async () => {
      const pathA = createClientDb('client-a');
      const badConfig = makeConfig(pathA, 'client-a');
      badConfig.nasPath = '/nonexistent/path/that/cannot/exist';

      const syncA = setupSync(badConfig);

      const errors: unknown[] = [];
      syncA.on('sync:error', (err) => errors.push(err));

      await expect(syncA.syncNow()).rejects.toThrow();
      syncA.stop();

      expect(errors).toHaveLength(1);
    });
  });

  describe('getStatus', () => {
    it('初期状態が正しい', () => {
      const pathA = createClientDb('client-a');
      const syncA = setupSync(makeConfig(pathA, 'client-a'));

      const status = syncA.getStatus();
      expect(status.isSyncing).toBe(false);
      expect(status.lastSyncedAt).toBeNull();
      expect(status.lastResult).toBeNull();
      expect(status.isRunning).toBe(false);

      syncA.stop();
    });

    it('sync後にステータスが更新される', async () => {
      const pathA = createClientDb('client-a');
      const syncA = setupSync(makeConfig(pathA, 'client-a'));

      await syncA.syncNow();
      const status = syncA.getStatus();

      expect(status.isSyncing).toBe(false);
      expect(status.lastSyncedAt).toBeInstanceOf(Date);
      expect(status.lastResult).toBeTruthy();

      syncA.stop();
    });
  });

  describe('start / stop 定期sync', () => {
    it('start()で定期syncが開始され、stop()で停止する', async () => {
      const pathA = createClientDb('client-a');
      const config = makeConfig(pathA, 'client-a');
      config.intervalMs = 50;

      const syncA = setupSync(config);
      let syncCount = 0;
      syncA.on('sync:complete', () => syncCount++);

      expect(syncA.getStatus().isRunning).toBe(false);

      syncA.start();
      expect(syncA.getStatus().isRunning).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 200));

      syncA.stop();
      expect(syncA.getStatus().isRunning).toBe(false);
      expect(syncCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('バリデーションエラー', () => {
    it('テーブルが存在しない場合にエラーをスローする', () => {
      const clientDir = path.join(testDir, 'invalid');
      fs.mkdirSync(clientDir, { recursive: true });
      const dbPath = path.join(clientDir, 'local.sqlite');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);
      db.close();

      expect(() =>
        setupSync({
          ...makeConfig(dbPath, 'invalid'),
          tables: [{ name: 'users' }, { name: 'nonexistent' }],
        })
      ).toThrow('Validation failed');
    });
  });

  describe('複数テーブルsync', () => {
    it('usersとpostsが両方同期される', async () => {
      const pathA = createClientDb('client-a');
      const pathB = createClientDb('client-b');

      // setupSyncでトリガー作成
      const syncA = setupSync(makeConfig(pathA, 'client-a'));

      // トリガー存在後にデータ追加
      const dbA = new Database(pathA);
      dbA.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');
      dbA.prepare(
        `INSERT INTO posts (id, title, body, userId, updatedAt) VALUES (?, ?, ?, ?, ?)`
      ).run('p1', 'Hello World', 'Body text', 'u1', '2024-01-01T00:00:00Z');
      dbA.close();

      await syncA.syncNow();
      syncA.stop();

      // Client B sync
      const syncB = setupSync(makeConfig(pathB, 'client-b'));
      const result = await syncB.syncNow();
      syncB.stop();

      expect(result.inserted).toBe(2);

      const dbB = new Database(pathB);
      const users = dbB.prepare(`SELECT * FROM users`).all();
      const posts = dbB.prepare(`SELECT * FROM posts`).all();
      dbB.close();

      expect(users).toHaveLength(1);
      expect(posts).toHaveLength(1);
    });
  });

  describe('カスタムtimestampColumn', () => {
    function createClientDbWithModifiedAt(clientId: string): string {
      const clientDir = path.join(testDir, clientId);
      fs.mkdirSync(clientDir, { recursive: true });
      const dbPath = path.join(clientDir, 'local.sqlite');

      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          modifiedAt TEXT NOT NULL
        )
      `);
      db.close();
      return dbPath;
    }

    it('カスタムtimestampColumnでLWWが正しく動作する', async () => {
      const pathA = createClientDbWithModifiedAt('client-a');
      const pathB = createClientDbWithModifiedAt('client-b');

      const config = (dbPath: string, clientId: string): SyncConfig => ({
        dbPath,
        nasPath: nasDir,
        clientId,
        tables: [{ name: 'items', timestampColumn: 'modifiedAt' }],
        primaryKey: 'id',
        intervalMs: 100,
        changelogRetentionDays: 7,
      });

      const syncA = setupSync(config(pathA, 'client-a'));
      const syncB = setupSync(config(pathB, 'client-b'));

      // 両方に同じIDのレコード（Bが新しい）
      const dbA = new Database(pathA);
      dbA.prepare(`INSERT INTO items (id, name, modifiedAt) VALUES (?, ?, ?)`).run(
        'i1', 'Old Item', '2024-01-01T00:00:00Z'
      );
      dbA.close();

      const dbB = new Database(pathB);
      dbB.prepare(`INSERT INTO items (id, name, modifiedAt) VALUES (?, ?, ?)`).run(
        'i1', 'New Item', '2024-06-01T00:00:00Z'
      );
      dbB.close();

      // A sync → B sync → A resync
      await syncA.syncNow();
      await syncB.syncNow();
      await syncA.syncNow();

      syncA.stop();
      syncB.stop();

      // 両方ともBの新しいデータになっている
      const dbACheck = new Database(pathA);
      const itemA = dbACheck.prepare(`SELECT * FROM items WHERE id = ?`).get('i1') as any;
      dbACheck.close();
      expect(itemA.name).toBe('New Item');

      const dbBCheck = new Database(pathB);
      const itemB = dbBCheck.prepare(`SELECT * FROM items WHERE id = ?`).get('i1') as any;
      dbBCheck.close();
      expect(itemB.name).toBe('New Item');
    });
  });

  describe('deleteProtected', () => {
    it('deleteProtected: true のテーブルではDELETEがスキップされる', async () => {
      const pathA = createClientDb('client-a');
      const pathB = createClientDb('client-b');

      const configWithProtect = (dbPath: string, clientId: string): SyncConfig => ({
        dbPath,
        nasPath: nasDir,
        clientId,
        tables: [
          { name: 'users', deleteProtected: true },
          { name: 'posts' },
        ],
        primaryKey: 'id',
        intervalMs: 100,
        changelogRetentionDays: 7,
      });

      const syncA = setupSync(configWithProtect(pathA, 'client-a'));
      const syncB = setupSync(configWithProtect(pathB, 'client-b'));

      // Client A: レコード追加 → sync
      const dbA1 = new Database(pathA);
      dbA1.prepare(
        `INSERT INTO users (id, name, email, updatedAt) VALUES (?, ?, ?, ?)`
      ).run('u1', 'Alice', 'alice@example.com', '2024-01-01T00:00:00Z');
      dbA1.close();
      await syncA.syncNow();

      // Client B: sync → レコード取得
      await syncB.syncNow();
      expect(getUser(pathB, 'u1')).toBeTruthy();

      // Client A: レコード削除 → sync
      const dbA2 = new Database(pathA);
      dbA2.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      dbA2.close();
      await syncA.syncNow();

      // Client B: 再sync → deleteProtectedなのでレコードは残る
      const resultB = await syncB.syncNow();
      syncA.stop();
      syncB.stop();

      expect(resultB.deleted).toBe(0);
      expect(getUser(pathB, 'u1')).toBeTruthy();
    });
  });

  describe('onAfterSync', () => {
    it('sync完了後にonAfterSyncが呼ばれる', async () => {
      const pathA = createClientDb('client-a');

      let callbackCalled = false;
      let callbackResult: SyncResult | null = null;

      const config: SyncConfig = {
        ...makeConfig(pathA, 'client-a'),
        onAfterSync: (_db, result) => {
          callbackCalled = true;
          callbackResult = result;
        },
      };

      const syncA = setupSync(config);
      await syncA.syncNow();
      syncA.stop();

      expect(callbackCalled).toBe(true);
      expect(callbackResult).toBeTruthy();
      expect(callbackResult!.warnings).toBeDefined();
    });
  });
});
