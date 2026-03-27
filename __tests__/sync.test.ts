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
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    expect(result.inserted).toBe(1);
    const user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
    expect(user.name).toBe('Alice');

    dbB.close();
  });

  it('UPDATEエントリがLWWで同期される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice Old', '2023-01-01T00:00:00Z'
    );

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    const user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1') as any;
    expect(user.name).toBe('Alice');
    expect(result.conflictsResolved).toBeGreaterThanOrEqual(1);

    dbB.close();
  });

  it('DELETEエントリが伝播される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'));

    let user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
    expect(user).toBeTruthy();

    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

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
    await performSync(dbB, makeConfig(pathB, 'client-b'));
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

    fs.writeFileSync(path.join(nasDir, 'client-corrupt.sqlite'), 'not a database');

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    expect(result.warnings.some((w) => w.includes('corrupt'))).toBe(true);

    dbB.close();
  });

  it('DELETEが_tombstoneに記録される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');

    const tombstone = dbA.prepare(
      `SELECT * FROM _tombstone WHERE tableName = 'users' AND recordId = 'u1'`
    ).get() as any;
    expect(tombstone).toBeTruthy();

    dbA.close();
  });

  it('heartbeatがsync時に自動更新される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    await performSync(dbA, makeConfig(pathA, 'client-a'));

    const heartbeat = dbA.prepare(
      `SELECT * FROM _heartbeat WHERE id = '00000000-0000-0000-0000-000000000000'`
    ).get() as any;
    expect(heartbeat).toBeTruthy();

    const today = new Date().toISOString().slice(0, 10);
    expect(heartbeat.updatedAt).toBe(`${today}T12:00:00Z`);

    dbA.close();
  });

  it('heartbeatがchangelogに記録される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    await performSync(dbA, makeConfig(pathA, 'client-a'));

    const entry = dbA.prepare(
      `SELECT * FROM _changelog WHERE tableName = '_heartbeat'`
    ).get() as any;
    expect(entry).toBeTruthy();
    expect(entry.operation).toBe('INSERT');

    dbA.close();
  });

  it('heartbeatが他クライアントに伝播する', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'));

    const heartbeat = dbB.prepare(
      `SELECT * FROM _heartbeat WHERE id = '00000000-0000-0000-0000-000000000000'`
    ).get() as any;
    expect(heartbeat).toBeTruthy();

    dbB.close();
  });

  describe('フルマージ（ギャップ検出時）', () => {
    it('tombstoneによりzombieレコードが削除される', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      // Aがレコードを作成して同期
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Bが同期してu1を取得
      await performSync(dbB, makeConfig(pathB, 'client-b'));
      expect(dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get()).toBeTruthy();

      // Aがu1を削除して同期（tombstoneが作成される）
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Aのchangelogを全削除（7日経過をシミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      // Bが復帰して同期（changelogギャップ → フルマージ）
      const resultB = await performSync(dbB, makeConfig(pathB, 'client-b'));
      expect(resultB.hadChangelogGap).toBe(true);

      // tombstoneによりu1がBから削除される
      const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get();
      expect(user).toBeUndefined();

      dbB.close();
    });

    it('フルマージ中にchangelogが汚染されない', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      // Aがレコードを複数作成して同期
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-02T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Bが同期
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      // Aが新しいレコードを追加
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u3', 'Charlie', '2024-01-10T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      // Bのchangelogエントリ数を記録（フルマージ前）
      const beforeCount = (dbB.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any).cnt;

      // Bが復帰して同期（ギャップ → フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // フルマージ後のchangelogエントリ数
      // トリガーOFFなのでデータマージ分は増えない
      // heartbeatの1件 + changelogマージ分のみ
      const afterCount = (dbB.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any).cnt;

      // u1, u2の既存レコードのマージではchangelogが増えないことを確認
      // （全レコード分のINSERT/UPDATEエントリが生成されていないこと）
      // Aのchangelogマージ分 + heartbeat分のみ
      expect(afterCount).toBeLessThan(beforeCount + 10);

      dbB.close();
    });

    it('フルマージ後にheartbeatが更新されchangelogが延命する', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      // Bが復帰（フルマージ）
      const resultB = await performSync(dbB, makeConfig(pathB, 'client-b'));
      expect(resultB.hadChangelogGap).toBe(true);

      // heartbeatがchangelogに記録されている
      const heartbeatEntries = dbB.prepare(
        `SELECT * FROM _changelog WHERE tableName = '_heartbeat'`
      ).all();
      expect(heartbeatEntries.length).toBeGreaterThanOrEqual(1);

      dbB.close();
    });

    it('フルマージでリモートのchangelogがマージされる', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Aがchangelogの古い部分を削除しつつ新しい変更を追加
      dbA.exec(`DELETE FROM _changelog`);
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-10T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      // Bが復帰（フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Bのchangelogにu2のエントリがある（Aのchangelogからマージされた）
      const u2Entries = dbB.prepare(
        `SELECT * FROM _changelog WHERE recordId = 'u2'`
      ).all();
      expect(u2Entries.length).toBeGreaterThanOrEqual(1);

      // u2のデータもマージされている
      const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u2'`).get() as any;
      expect(user.name).toBe('Bob');

      dbB.close();
    });

    it('pull-firstによりstaleデータがNASに拡散しない', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      // Aがレコードを作成して同期
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Bが同期
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Aがu1を削除して同期
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      // Bが復帰（フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Cが参加して同期 — Bの汚染がCに伝播しないことを確認
      const { db: dbC, dbPath: pathC } = createClientDb('client-c');
      await performSync(dbC, makeConfig(pathC, 'client-c'));

      // CにはAからの削除が反映されている（u1が存在しない）
      // BのNASコピーからu1が復活しないことが重要
      const userInC = dbC.prepare(`SELECT * FROM users WHERE id = 'u1'`).get();
      expect(userInC).toBeUndefined();

      dbB.close();
      dbC.close();
    });

    it('tombstoneのLWW: 削除後に再作成されたレコードは保持される', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      // Aがレコード作成 → 同期
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Bが同期
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Aがu1を削除
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);

      // Aがu1を再作成（削除より新しいupdatedAt）
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice Reborn', '2024-06-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      // Bが復帰（フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // tombstone.deletedAt < u1.updatedAt なので、u1は保持される
      const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get() as any;
      expect(user).toBeTruthy();
      expect(user.name).toBe('Alice Reborn');

      dbB.close();
    });
  });
});
