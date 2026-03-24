import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { performSync } from '../src/sync';
import { SyncConfig } from '../src/types';

describe('performSync', () => {
  const testDir = path.join(__dirname, 'test-data-sync');
  const nasDir = path.join(testDir, 'nas');

  function createClientDb(clientId: string): { db: Database.Database; dbPath: string } {
    const clientDir = path.join(testDir, clientId);
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
    db.exec(`
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        userId TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, [{ name: 'users' }, { name: 'posts' }], 'id');
    return { db, dbPath };
  }

  function makeConfig(dbPath: string, clientId: string): SyncConfig {
    return {
      dbPath,
      nasPath: nasDir,
      clientId,
      tables: [{ name: 'users' }, { name: 'posts' }],
      primaryKey: 'id',
      changelogRetentionDays: 7,
    };
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

  it('INSERTエントリがリモートからローカルに同期される', async () => {
    // Client A: レコードを挿入してsync
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    // Client B: syncするとAのレコードが取得できる
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    expect(result.inserted).toBe(1);
    const user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
    expect(user.name).toBe('Alice');

    dbB.close();
  });

  it('UPDATEエントリがLWWで同期される', async () => {
    // Client A: レコードを挿入してsync
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    // Client B: 同じレコードを持ち、Aからsync
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice Old', '2023-01-01T00:00:00Z'
    );

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    // Aの方が新しいのでBが更新される（INSERTエントリ+PK既存→UPSERT）
    const user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
    expect(user.name).toBe('Alice');
    expect(result.conflictsResolved).toBeGreaterThanOrEqual(1);

    dbB.close();
  });

  it('DELETEエントリが伝播される', async () => {
    // Client A: レコードを挿入してsync
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));

    // Client B: Aからsyncしてレコード取得
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'));

    let user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
    expect(user).toBeTruthy();

    // Client A: レコードを削除してsync
    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    // Client B: 再syncするとレコードが削除される
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));
    expect(result.deleted).toBe(1);

    user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
    expect(user).toBeUndefined();

    dbB.close();
  });

  it('複数テーブルが同時にsyncされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    dbA.prepare(`INSERT INTO posts (id, title, userId, updatedAt) VALUES (?, ?, ?, ?)`).run(
      'p1', 'Hello', 'u1', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    expect(result.inserted).toBe(2);

    const user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
    const post = dbB.prepare(`SELECT * FROM posts WHERE id = ?`).get('p1');
    expect(user).toBeTruthy();
    expect(post).toBeTruthy();

    dbB.close();
  });

  it('新しいエントリがない場合はスキップされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    // 1回目: 変更あり
    await performSync(dbB, makeConfig(pathB, 'client-b'));
    // 2回目: 変更なし
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.clientsSynced).toBe(1);

    dbB.close();
  });

  it('schemaVersionが一致するリモートは正常に同期される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v2' };
    await performSync(dbA, configA);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' };
    const result = await performSync(dbB, configB);

    expect(result.inserted).toBe(1);
    const user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
    expect(user.name).toBe('Alice');

    dbB.close();
  });

  it('schemaVersionが不一致のリモートはスキップされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v1' };
    await performSync(dbA, configA);
    dbA.close();

    // Client B は v2 で同期 → v1 の Client A はスキップされるべき
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' };
    const result = await performSync(dbB, configB);

    expect(result.inserted).toBe(0);
    expect(result.warnings.some((w) => w.includes('schema version mismatch'))).toBe(true);

    const user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
    expect(user).toBeUndefined();

    dbB.close();
  });

  it('schemaVersionが未設定のリモートはスキップされる', async () => {
    // Client A: schemaVersion未指定で同期
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    // Client B: schemaVersion指定で同期 → 未設定のAはスキップ
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' };
    const result = await performSync(dbB, configB);

    expect(result.inserted).toBe(0);
    expect(result.warnings.some((w) => w.includes('schema version mismatch'))).toBe(true);

    dbB.close();
  });

  it('リモートDBオープン失敗時は警告を出して続行する', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    // NASにダミーの壊れたファイルを配置
    fs.writeFileSync(path.join(nasDir, 'client-corrupt.sqlite'), 'not a database');

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    // corruptクライアントは警告、Aは正常処理
    expect(result.warnings.some((w) => w.includes('corrupt'))).toBe(true);

    dbB.close();
  });
});
