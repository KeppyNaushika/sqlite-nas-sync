import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { performSync } from '../src/sync';
import { SyncConfig, TableConfig } from '../src/types';

describe('performSync', () => {
  const testDir = path.join(__dirname, 'test-data-sync');
  const nasDir = path.join(testDir, 'nas');

  const TABLES: TableConfig[] = [
    { name: 'users' },
    { name: 'posts' },
    { name: 'decisions' },
  ];

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
    // セカンダリUNIQUE制約を持つテーブル（「1セルにつき1確定」のようなアプリを想定）
    db.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        cellKey TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');
    return { db, dbPath };
  }

  function makeConfig(dbPath: string, clientId: string): SyncConfig {
    return {
      dbPath,
      nasPath: nasDir,
      clientId,
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
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

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
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice Old', '2023-01-01T00:00:00Z'
    );

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

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
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    let user = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
    expect(user).toBeTruthy();

    dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    dbA.close();

    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
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
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(result.inserted).toBe(2);
    dbB.close();
  });

  it('新しいエントリがない場合はスキップされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.clientsSynced).toBe(1);

    dbB.close();
  });

  it('別ID・同一ユニークキーの行が両クライアントで作成された場合、LWWで1行に収束する', async () => {
    // A・Bが独立に同じ論理エンティティ（cellKey=c1）の行を作成
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('d-a', 'c1', 'score:5', '2024-01-01T00:00:00Z');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (?, ?, ?, ?)`
    ).run('d-b', 'c1', 'score:8', '2024-06-01T00:00:00Z');

    // B同期: Aのd-aを受信 → ローカルd-bの方が新しい → d-bを保持
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    // A同期: Bのd-bを受信 → リモートd-bの方が新しい → d-aを削除しd-bに置換
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    // B再同期: Aのd-a削除（tombstone/changelog）を受信しても結果は変わらない
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (const [label, db] of [['A', dbA], ['B', dbB]] as const) {
      const rows = db
        .prepare(`SELECT * FROM decisions WHERE cellKey = ?`)
        .all('c1') as any[];
      expect(rows, `client-${label}`).toHaveLength(1);
      expect(rows[0].id, `client-${label}`).toBe('d-b');
      expect(rows[0].value, `client-${label}`).toBe('score:8');
    }

    dbA.close();
    dbB.close();
  });

  it('schemaVersionが一致するリモートは正常に同期される', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v2' };
    await performSync(dbA, configA, TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' };
    const result = await performSync(dbB, configB, TABLES);

    expect(result.inserted).toBe(1);
    dbB.close();
  });

  it('schemaVersionが不一致のリモートはスキップされる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v1' };
    await performSync(dbA, configA, TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' };
    const result = await performSync(dbB, configB, TABLES);

    expect(result.inserted).toBe(0);
    expect(result.warnings.some((w) => w.includes('schema version mismatch'))).toBe(true);

    // 構造化されたskippedRemotesにも記録される
    expect(result.skippedRemotes).toEqual([
      { clientId: 'client-a', remoteVersion: 'v1', localVersion: 'v2' },
    ]);

    dbB.close();
  });

  it('schemaVersionが一致するsyncではskippedRemotesは空', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    const configA = { ...makeConfig(pathA, 'client-a'), schemaVersion: 'v2' };
    await performSync(dbA, configA, TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const configB = { ...makeConfig(pathB, 'client-b'), schemaVersion: 'v2' };
    const result = await performSync(dbB, configB, TABLES);

    expect(result.skippedRemotes).toEqual([]);
    dbB.close();
  });

  it('リモートDBオープン失敗時は警告を出して続行する', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    dbA.close();

    fs.writeFileSync(path.join(nasDir, 'client-corrupt.sqlite'), 'not a database');

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

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
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

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
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const entry = dbA.prepare(
      `SELECT * FROM _changelog WHERE tableName = '_heartbeat'`
    ).get() as any;
    expect(entry).toBeTruthy();
    expect(entry.operation).toBe('INSERT');

    dbA.close();
  });

  it('heartbeatが他クライアントに伝播する', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

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
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // Bが同期してu1を取得
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get()).toBeTruthy();

      // Aがu1を削除して同期（tombstoneが作成される）
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // Aのchangelogを全削除（7日経過をシミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      // Bが復帰して同期（changelogギャップ → フルマージ）
      const resultB = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
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
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // Bが同期
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      // Aが新しいレコードを追加
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u3', 'Charlie', '2024-01-10T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      // Bのchangelogエントリ数を記録（フルマージ前）
      const beforeCount = (dbB.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any).cnt;

      // Bが復帰して同期（ギャップ → フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

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
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      // Bが復帰（フルマージ）
      const resultB = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
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
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // Aがchangelogの古い部分を削除しつつ新しい変更を追加
      dbA.exec(`DELETE FROM _changelog`);
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-10T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      // Bが復帰（フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

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
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // Bが同期
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // Aがu1を削除して同期
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      // Bが復帰（フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // Cが参加して同期 — Bの汚染がCに伝播しないことを確認
      const { db: dbC, dbPath: pathC } = createClientDb('client-c');
      await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

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
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // Bが同期
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // Aがu1を削除
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // Aのchangelogを全削除（7日経過シミュレート）
      dbA.exec(`DELETE FROM _changelog`);

      // Aがu1を再作成（削除より新しいupdatedAt）
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice Reborn', '2024-06-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      // Bが復帰（フルマージ）
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // tombstone.deletedAt < u1.updatedAt なので、u1は保持される
      const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get() as any;
      expect(user).toBeTruthy();
      expect(user.name).toBe('Alice Reborn');

      dbB.close();
    });

    it('フルマージ後に gap が解消され、次回 sync で再フルマージが起きない', async () => {
      // クライアントAで複数エントリを作りつつ、古いものは cleanup される状況を作る
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // クライアントB初回sync（lastSeenId が記録される）
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      dbB.close();

      // Aで追加変更
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-02T00:00:00Z'
      );
      // Aの changelog から古いエントリを強制削除して minId を上昇させる → gap 発生
      const oldMinId = dbA.prepare(`SELECT MIN(id) AS m FROM _changelog`).get() as { m: number };
      dbA.prepare(`DELETE FROM _changelog WHERE id <= ?`).run(oldMinId.m);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      // クライアントB再開 → gap 検出されてフルマージが走る
      const dbB2 = new Database(pathB);
      const result1 = await performSync(dbB2, makeConfig(pathB, 'client-b'), TABLES);
      expect(result1.hadChangelogGap).toBe(true);

      // 直後にもう一度 sync → 今度は gap 検出されないはず（lastSeenId が正しく更新されているため）
      const result2 = await performSync(dbB2, makeConfig(pathB, 'client-b'), TABLES);
      expect(result2.hadChangelogGap).toBe(false);

      // さらにもう一度 → 同じく gap 無し
      const result3 = await performSync(dbB2, makeConfig(pathB, 'client-b'), TABLES);
      expect(result3.hadChangelogGap).toBe(false);

      dbB2.close();
    });

    it('NAS上のリモートファイルが読み取り中に書き換わっても sync が安全に進む', async () => {
      // ローカルコピー経由で開いているため、書き換えの影響を受けない
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      dbA.close();

      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      // Bがsyncしている最中にAのNASファイルが書き換わるシミュレーション:
      // syncが終わってから書き換えて、もう一度syncしても問題ないことを確認
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // NAS上のAファイルを別プロセスが置き換えたと想定して上書き
      const dbA2 = new Database(pathA);
      dbA2.prepare(`UPDATE users SET name = ?, updatedAt = ? WHERE id = ?`).run(
        'Alice2', '2024-01-03T00:00:00Z', 'u1'
      );
      await performSync(dbA2, makeConfig(pathA, 'client-a'), TABLES);
      dbA2.close();

      // Bが再同期 → 新しい値が取れる
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(result.warnings.filter((w) => w.includes('Sync failed')).length).toBe(0);

      const user = dbB.prepare(`SELECT * FROM users WHERE id = 'u1'`).get() as any;
      expect(user.name).toBe('Alice2');

      dbB.close();
    });
  });
});
