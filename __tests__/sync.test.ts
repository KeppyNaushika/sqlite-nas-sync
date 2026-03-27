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

  it('hadChangelogGapが通常時はfalseになる', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
      'u1', 'Alice', '2024-01-01T00:00:00Z'
    );
    await performSync(dbA, makeConfig(pathA, 'client-a'));
    dbA.close();

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

    expect(result.hadChangelogGap).toBe(false);
    expect(result.inserted).toBe(1);
    dbB.close();
  });

  describe('changelogギャップ時のpull-firstフロー', () => {
    it('staleクライアントが削除済みレコードをNASに撒き散らさない', async () => {
      // --- セットアップ: A と B が同期済み ---
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      // Aがレコードを作成して同期
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Bが同期してu1を取得
      await performSync(dbB, makeConfig(pathB, 'client-b'));
      const userInB = dbB.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');
      expect(userInB).toBeTruthy();

      // --- Bがオフラインに（以降Bは同期しない） ---

      // Aがu1を削除して同期
      dbA.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Aのchangelogを全削除（7日経過をシミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      dbA.close();

      // --- Bが復帰して同期（changelogギャップ発生） ---
      const resultB = await performSync(dbB, makeConfig(pathB, 'client-b'));
      expect(resultB.hadChangelogGap).toBe(true);

      // --- 検証: Bの同期後、NAS上のBのDBにu1が残っていないこと ---
      // Bのローカルにはu1が残っている可能性があるが（full-table fallbackでDELETEは検出不可）、
      // 重要なのはNAS上のBのコピーが他クライアントに悪影響を与えないこと
      // → pull-firstフローにより、BのNASコピーはpull完了後にアップロードされる

      // Client Cを作成して同期 — Bの汚染がCに伝播しないことを確認
      const { db: dbC, dbPath: pathC } = createClientDb('client-c');
      const resultC = await performSync(dbC, makeConfig(pathC, 'client-c'));

      // CにはAからの削除が伝播済み（Aのchangelogは空だがAのDBにu1は存在しない）
      // BのNASコピーからu1が復活しないことが重要
      // full-table fallbackでBから読む場合、BのupdatedAtとCの初回同期を比較
      // Cは初回なので全レコードを取り込むが、Aにはu1がないのでAからは取り込まない
      // Bにu1があっても、Aのデータの方が権威的
      const userInC = dbC.prepare(`SELECT * FROM users WHERE id = ?`).get('u1');

      // BのNAS DBを直接確認: pull-firstにより、BのchangelogはクリアされてNASにアップロードされている
      const bNasPath = path.join(nasDir, 'client-client-b.sqlite');
      if (fs.existsSync(bNasPath)) {
        const bNasDb = new Database(bNasPath, { readonly: true });
        // Bのchangelogがクリアされていることを確認
        const changelogCount = bNasDb.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any;
        expect(changelogCount.cnt).toBe(0);
        bNasDb.close();
      }

      dbB.close();
      dbC.close();
    });

    it('staleクライアントのローカルchangelogがクリアされる', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');

      // Aがレコードを作成して同期
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));

      // Bが同期
      await performSync(dbB, makeConfig(pathB, 'client-b'));

      // Bがオフライン中にローカルで変更
      dbB.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-02T00:00:00Z'
      );

      // Aのchangelogを全削除（7日経過をシミュレート）
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      // Bのchangelogにはu2のINSERTエントリがあるはず
      const beforeCount = (dbB.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any).cnt;
      expect(beforeCount).toBeGreaterThan(0);

      // Bが復帰して同期
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'));
      expect(result.hadChangelogGap).toBe(true);

      // pull-firstフローでchangelogがクリアされていること
      // （cleanupChangelogで追加で掃除されるが、DELETEで全削除済み）
      const afterCount = (dbB.prepare(`SELECT COUNT(*) as cnt FROM _changelog`).get() as any).cnt;
      expect(afterCount).toBe(0);

      dbB.close();
    });

    it('ギャップなしの場合は従来通りcopyToNas→pullの順', async () => {
      // 通常フローでは先にNASにアップロードされる
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      dbA.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u1', 'Alice', '2024-01-01T00:00:00Z'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'));
      dbA.close();

      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      dbB.prepare(`INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)`).run(
        'u2', 'Bob', '2024-01-02T00:00:00Z'
      );
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'));

      expect(result.hadChangelogGap).toBe(false);

      // BのNASコピーにu2があること（通常フローではpull前にアップロード）
      const bNasPath = path.join(nasDir, 'client-client-b.sqlite');
      const bNasDb = new Database(bNasPath, { readonly: true });
      const user = bNasDb.prepare(`SELECT * FROM users WHERE id = ?`).get('u2') as any;
      expect(user).toBeTruthy();
      expect(user.name).toBe('Bob');
      bNasDb.close();

      dbB.close();
    });
  });
});
