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
    { name: 'tags' },
    { name: 'tag_notes' },
    { name: 'tag_profiles' },
    { name: 'accounts' },
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
    // 利用者が編集できる名前（`Tag.name` のような列）を持つテーブル。
    // 改名が届いたときに、ローカルの別の行のユニークへ当たる形を作れる。
    db.exec(`
      CREATE TABLE tags (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE tag_notes (
        id        TEXT PRIMARY KEY,
        tagId     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    // 親と主キーを共有する 1:1 の表。親が畳まれると子のidそのものが動くため、
    // 動いた先の席が既に埋まっている形を作れる。
    db.exec(`
      CREATE TABLE tag_profiles (
        id        TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
        memo      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    // ユニークが2本ある表（`User(username UNIQUE, email UNIQUE)` の形）。
    // 1回の書き込みが索引ごとに別々の相手へぶつかる形を作れる。
    db.exec(`
      CREATE TABLE accounts (
        id        TEXT PRIMARY KEY,
        username  TEXT NOT NULL UNIQUE,
        email     TEXT NOT NULL UNIQUE,
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

  describe('届いた更新がローカルの別の行のセカンダリUNIQUEに当たる', () => {
    interface TagRow {
      id: string;
      name: string;
    }
    interface NoteRow {
      id: string;
      tagId: string;
    }

    function tagRows(db: Database.Database): TagRow[] {
      return db
        .prepare(`SELECT id, name FROM tags ORDER BY id`)
        .all() as TagRow[];
    }

    function noteRows(db: Database.Database): NoteRow[] {
      return db
        .prepare(`SELECT id, tagId FROM tag_notes ORDER BY id`)
        .all() as NoteRow[];
    }

    function insertTag(
      db: Database.Database,
      id: string,
      name: string,
      updatedAt: string
    ): void {
      db.prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)`
      ).run(id, name, updatedAt);
    }

    function insertNote(
      db: Database.Database,
      id: string,
      tagId: string,
      updatedAt: string
    ): void {
      db.prepare(
        `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)`
      ).run(id, tagId, `${id}の本文`, updatedAt);
    }

    function insertProfile(
      db: Database.Database,
      tagId: string,
      memo: string,
      updatedAt: string
    ): void {
      db.prepare(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (?, ?, ?)`
      ).run(tagId, memo, updatedAt);
    }

    function profileRows(
      db: Database.Database
    ): { id: string; memo: string }[] {
      return db
        .prepare(`SELECT id, memo FROM tag_profiles ORDER BY id`)
        .all() as { id: string; memo: string }[];
    }

    function uniqueWarnings(warnings: string[]): string[] {
      return warnings.filter(
        (warning) =>
          warning.includes('UNIQUE constraint failed') ||
          warning.includes('FOREIGN KEY')
      );
    }

    /**
     * A が t1「数学」を作り、B もそれを受け取っている状態。
     * このあと A が t1 を改名し、B は独立に同じ名前の t2 を作る。
     */
    async function seedRenameCollision(
      renamedAt: string,
      rivalAt: string,
      tables: TableConfig[] = TABLES
    ) {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
      await performSync(dbA, makeConfig(pathA, 'client-a'), tables);

      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      await performSync(dbB, makeConfig(pathB, 'client-b'), tables);
      expect(tagRows(dbB)).toEqual([{ id: 't1', name: '数学' }]);

      // B は受け取った t1 に自分のメモを付けている（畳まれても消えてはいけない）
      insertNote(dbB, 'note-t1', 't1', '2024-02-01T00:00:00Z');

      // A: t1 を「国語」へ改名
      dbA.prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`).run(
        '国語',
        renamedAt,
        't1'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'), tables);

      // B: 独立に「国語」の t2 を作成（メモ付き）
      insertTag(dbB, 't2', '国語', rivalAt);
      insertNote(dbB, 'note-t2', 't2', rivalAt);

      return { dbA, pathA, dbB, pathB };
    }

    it('届いた改名が勝つ場合、ローカルの邪魔な行が畳まれ、その子は改名された行へ移る', async () => {
      // A の改名(2024-06-01) > B の t2(2024-03-01) → 届いた更新が勝つ
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        '2024-06-01T00:00:00Z',
        '2024-03-01T00:00:00Z'
      );

      // 何度同期しても同じ場所で落ち続けるなら、A からは以後何も届かない
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
        expect(uniqueWarnings(result.warnings), `B ${attempt}回目`).toEqual([]);
        expect(result.clientsSynced, `B ${attempt}回目`).toBe(1);
      }

      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
      ] as const) {
        expect(tagRows(db), `client-${label}`).toEqual([
          { id: 't1', name: '国語' },
        ]);
        expect(noteRows(db), `client-${label}`).toEqual([
          { id: 'note-t1', tagId: 't1' },
          { id: 'note-t2', tagId: 't1' },
        ]);
      }

      dbA.close();
      dbB.close();
    });

    it('畳みで動く 1:1 の子の席が埋まっていても、同期が止まらない', async () => {
      // A の改名(2024-06-01) > B の t2(2024-03-01) → 届いた更新が勝ち、t2 が畳まれる。
      // t2 に紐づく 1:1 の行は t1 の席へ動こうとするが、そこには t1 の行が既に居る。
      // 席の先客を「畳む相手」として扱うと、敗者idと勝者idが同じ畳みになって
      // 何も起きず、同じ付け替えをもう一度走らせて主キー違反を投げる
      // （どの catch にも捕まらず、その相手からの取り込みが毎回巻き戻る）。
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        '2024-06-01T00:00:00Z',
        '2024-03-01T00:00:00Z'
      );
      insertProfile(dbB, 't1', 'ふるい', '2024-02-01T00:00:00Z');
      insertProfile(dbB, 't2', 'あたらしい', '2024-09-01T00:00:00Z');

      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
        expect(uniqueWarnings(result.warnings), `B ${attempt}回目`).toEqual([]);
        expect(result.clientsSynced, `B ${attempt}回目`).toBe(1);
      }

      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
      ] as const) {
        expect(tagRows(db), `client-${label}`).toEqual([
          { id: 't1', name: '国語' },
        ]);
        // 席は1つ。中身は新しい方（t2 に付いていた行）が残る
        expect(profileRows(db), `client-${label}`).toEqual([
          { id: 't1', memo: 'あたらしい' },
        ]);
      }

      dbA.close();
      dbB.close();
    });

    it('ローカルの行が勝つ場合、届いた更新の行が畳まれ、両端末が同じ形へ収束する', async () => {
      // A の改名(2024-03-01) < B の t2(2024-06-01) → ローカルが勝つ
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        '2024-03-01T00:00:00Z',
        '2024-06-01T00:00:00Z'
      );

      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
        expect(uniqueWarnings(result.warnings), `B ${attempt}回目`).toEqual([]);
        expect(result.clientsSynced, `B ${attempt}回目`).toBe(1);
      }

      // 畳み先が `_tombstone.mergedInto` に載る（これが相手へ伝わる唯一の経路）。
      // ここが空だと、受け取った側は t1 をただ消して自分の子を道連れにする。
      expect(
        dbB
          .prepare(
            `SELECT recordId, mergedInto FROM _tombstone WHERE tableName = 'tags'`
          )
          .all()
      ).toEqual([{ recordId: 't1', mergedInto: 't2' }]);
      // ローカルの読み替え索引にも入る（あとから届く t1 の子を t2 へ向け直すため）
      expect(
        dbB
          .prepare(
            `SELECT losingId, winningId FROM _id_merge WHERE tableName = 'tags'`
          )
          .all()
      ).toEqual([{ losingId: 't1', winningId: 't2' }]);

      // 黙って捨てていると A は t1 を持ち続け、分岐したまま収束しない
      for (let round = 0; round < 2; round++) {
        await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
        await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      }

      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
      ] as const) {
        expect(tagRows(db), `client-${label}`).toEqual([
          { id: 't2', name: '国語' },
        ]);
        expect(noteRows(db), `client-${label}`).toEqual([
          { id: 'note-t1', tagId: 't2' },
          { id: 'note-t2', tagId: 't2' },
        ]);
      }

      dbA.close();
      dbB.close();
    });

    it('競合を知らない3台目も、同じ形へ追いつく', async () => {
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        '2024-06-01T00:00:00Z',
        '2024-03-01T00:00:00Z'
      );

      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      const snapshot = (db: Database.Database): string =>
        JSON.stringify([tagRows(db), noteRows(db)]);
      const converged = snapshot(dbA);
      expect(snapshot(dbB)).toBe(converged);

      const { db: dbC, dbPath: pathC } = createClientDb('client-c');
      const resultC = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      expect(uniqueWarnings(resultC.warnings)).toEqual([]);
      expect(snapshot(dbC)).toBe(converged);

      // 3台目が加わっても付け替え合いが続かない
      for (let round = 0; round < 2; round++) {
        await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
        await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
        await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      }
      expect(snapshot(dbA)).toBe(converged);
      expect(snapshot(dbB)).toBe(converged);
      expect(snapshot(dbC)).toBe(converged);

      dbA.close();
      dbB.close();
      dbC.close();
    });

    it('ローカルが勝つ畳みも、その決定が3台目まで伝わって同じ形へ揃う', async () => {
      // 3台目 C も先に t1 を受け取り、自分のメモを付けている状態を作る
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      insertNote(dbB, 'note-b', 't1', '2024-02-01T00:00:00Z');

      const { db: dbC, dbPath: pathC } = createClientDb('client-c');
      await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      insertNote(dbC, 'note-c', 't1', '2024-02-01T00:00:00Z');
      await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

      // A は t1 を改名し、B は独立にもっと新しい「国語」を作る（ローカルが勝つ向き）
      dbA.prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`).run(
        '国語',
        '2024-03-01T00:00:00Z',
        't1'
      );
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      insertTag(dbB, 't2', '国語', '2024-06-01T00:00:00Z');
      insertNote(dbB, 'note-t2', 't2', '2024-06-01T00:00:00Z');

      const foldResult = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(uniqueWarnings(foldResult.warnings)).toEqual([]);

      // 全員が全員を取り込むまで回す
      for (let round = 0; round < 3; round++) {
        for (const [clientId, db, dbPath] of [
          ['client-a', dbA, pathA],
          ['client-b', dbB, pathB],
          ['client-c', dbC, pathC],
        ] as const) {
          const result = await performSync(db, makeConfig(dbPath, clientId), TABLES);
          expect(uniqueWarnings(result.warnings), `${clientId} round${round}`).toEqual([]);
        }
      }

      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
        ['C', dbC],
      ] as const) {
        expect(tagRows(db), `client-${label}`).toEqual([
          { id: 't2', name: '国語' },
        ]);
        // 畳まれて消えた t1 にぶら下がっていたメモは、3台とも生き残った t2 へ移る
        expect(noteRows(db), `client-${label}`).toEqual([
          { id: 'note-b', tagId: 't2' },
          { id: 'note-c', tagId: 't2' },
          { id: 'note-t2', tagId: 't2' },
        ]);
      }

      dbA.close();
      dbB.close();
      dbC.close();
    });

    it('deleteProtected なテーブルでも畳みは行われる（利用者操作の削除だけが保護対象）', async () => {
      const protectedTables: TableConfig[] = TABLES.map((tableConfig) =>
        tableConfig.name === 'tags'
          ? { ...tableConfig, deleteProtected: true }
          : tableConfig
      );

      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        '2024-06-01T00:00:00Z',
        '2024-03-01T00:00:00Z',
        protectedTables
      );

      const result = await performSync(
        dbB,
        makeConfig(pathB, 'client-b'),
        protectedTables
      );
      expect(uniqueWarnings(result.warnings)).toEqual([]);
      expect(result.clientsSynced).toBe(1);

      await performSync(dbA, makeConfig(pathA, 'client-a'), protectedTables);
      await performSync(dbB, makeConfig(pathB, 'client-b'), protectedTables);

      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
      ] as const) {
        expect(tagRows(db), `client-${label}`).toEqual([
          { id: 't1', name: '国語' },
        ]);
        expect(noteRows(db), `client-${label}`).toEqual([
          { id: 'note-t1', tagId: 't1' },
          { id: 'note-t2', tagId: 't1' },
        ]);
      }

      // 保護そのものは効いている: A が普通に削除しても B からは消えない
      dbA.prepare(`DELETE FROM tags WHERE id = ?`).run('t1');
      await performSync(dbA, makeConfig(pathA, 'client-a'), protectedTables);
      await performSync(dbB, makeConfig(pathB, 'client-b'), protectedTables);
      expect(tagRows(dbB)).toEqual([{ id: 't1', name: '国語' }]);

      dbA.close();
      dbB.close();
    });

    it('フルマージ経路でも畳まれ、ギャップが解消される', async () => {
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // B が一度同期して lastSeenId を持つ（これが無いとギャップ判定にならない）
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      insertNote(dbB, 'note-t1', 't1', '2024-02-01T00:00:00Z');

      // A が改名し、changelog は7日経過で消えたことにする
      dbA.prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`).run(
        '国語',
        '2024-06-01T00:00:00Z',
        't1'
      );
      dbA.exec(`DELETE FROM _changelog`);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      insertTag(dbB, 't2', '国語', '2024-03-01T00:00:00Z');
      insertNote(dbB, 'note-t2', 't2', '2024-03-01T00:00:00Z');

      const fullMerge = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(fullMerge.hadChangelogGap).toBe(true);
      expect(uniqueWarnings(fullMerge.warnings)).toEqual([]);
      expect(fullMerge.clientsSynced).toBe(1);

      // フルマージが巻き戻っていれば lastSeenId が進まず、毎回ギャップを再検出する
      const next = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(next.hadChangelogGap).toBe(false);

      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
      ] as const) {
        expect(tagRows(db), `client-${label}`).toEqual([
          { id: 't1', name: '国語' },
        ]);
        expect(noteRows(db), `client-${label}`).toEqual([
          { id: 'note-t1', tagId: 't1' },
          { id: 'note-t2', tagId: 't1' },
        ]);
      }

      dbA.close();
      dbB.close();
    });

    it('同時刻で衝突しても、両端末が同じ側を残す（振動しない）', async () => {
      // 両端末が同じ時刻を刻む（時計が揃っている・秒までしか持たない等）。
      // 時刻で決まらないぶんを端末ごとに違う向きで決めると、互いに相手を畳んで
      // 生き残るidが毎周入れ替わり、そのたびに新しい DELETE が積まれる。
      const sameMoment = '2024-06-01T00:00:00Z';
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        sameMoment,
        sameMoment
      );

      function tagDeletions(db: Database.Database): number {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS count FROM _changelog
             WHERE tableName = 'tags' AND operation = 'DELETE'`
          )
          .get() as { count: number };
        return row.count;
      }

      const shapes: string[] = [];
      const deletions: number[] = [];
      for (let round = 0; round < 6; round++) {
        await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
        await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
        shapes.push(
          JSON.stringify([
            tagRows(dbA),
            noteRows(dbA),
            tagRows(dbB),
            noteRows(dbB),
          ])
        );
        deletions.push(tagDeletions(dbA) + tagDeletions(dbB));
      }

      // 収束したら以後は動かない（振動していると毎周違う形になる）
      expect(new Set(shapes.slice(2))).toEqual(new Set([shapes[5]]));
      // 振動していると畳みのたびに DELETE が積まれ、際限なく増える
      expect(deletions[5]).toBe(deletions[2]);

      // 時刻で決まらないぶんは主キーの辞書順で決める → t1 が残る
      for (const [label, db] of [
        ['A', dbA],
        ['B', dbB],
      ] as const) {
        expect(tagRows(db), `client-${label}`).toEqual([
          { id: 't1', name: '国語' },
        ]);
        expect(noteRows(db), `client-${label}`).toEqual([
          { id: 'note-t1', tagId: 't1' },
          { id: 'note-t2', tagId: 't1' },
        ]);
      }

      dbA.close();
      dbB.close();
    });

    it('届いた改名が勝つ畳みが、消えた行として SyncResult に出る', async () => {
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        '2024-06-01T00:00:00Z',
        '2024-03-01T00:00:00Z'
      );

      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      expect(result.folds).toEqual([
        {
          tableName: 'tags',
          losingId: 't2',
          winningId: 't1',
          removedLocalRow: true,
          // t2 に付いていたメモ1件が t1 へ移った
          movedChildren: 1,
          lostChildren: 0,
        },
      ]);
      expect(result.deleted).toBe(1);
      expect(result.conflictsResolved).toBe(1);

      dbA.close();
      dbB.close();
    });

    it('ローカルの行が勝つ畳みも、消えた行として SyncResult に出る', async () => {
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        '2024-03-01T00:00:00Z',
        '2024-06-01T00:00:00Z'
      );

      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // 届いた更新は採用しないが、更新対象の行は畳まれて消えている
      expect(result.folds).toEqual([
        {
          tableName: 'tags',
          losingId: 't1',
          winningId: 't2',
          removedLocalRow: true,
          // t1 に付いていたメモ1件が t2 へ移った
          movedChildren: 1,
          lostChildren: 0,
        },
      ]);
      expect(result.deleted).toBe(1);
      expect(result.conflictsResolved).toBe(1);

      dbA.close();
      dbB.close();
    });

    it('同時刻の衝突でも、あとから参加した3台目まで同じ形へ揃う', async () => {
      const sameMoment = '2024-06-01T00:00:00Z';
      const { dbA, pathA, dbB, pathB } = await seedRenameCollision(
        sameMoment,
        sameMoment
      );

      for (let round = 0; round < 2; round++) {
        await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
        await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      }

      const snapshot = (db: Database.Database): string =>
        JSON.stringify([tagRows(db), noteRows(db)]);
      const converged = snapshot(dbA);
      expect(snapshot(dbB)).toBe(converged);

      const { db: dbC, dbPath: pathC } = createClientDb('client-c');
      const resultC = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      expect(uniqueWarnings(resultC.warnings)).toEqual([]);
      expect(snapshot(dbC)).toBe(converged);

      for (let round = 0; round < 2; round++) {
        for (const [clientId, db, dbPath] of [
          ['client-a', dbA, pathA],
          ['client-b', dbB, pathB],
          ['client-c', dbC, pathC],
        ] as const) {
          const result = await performSync(db, makeConfig(dbPath, clientId), TABLES);
          expect(uniqueWarnings(result.warnings), `${clientId} round${round}`).toEqual(
            []
          );
        }
      }
      expect(snapshot(dbA)).toBe(converged);
      expect(snapshot(dbB)).toBe(converged);
      expect(snapshot(dbC)).toBe(converged);

      dbA.close();
      dbB.close();
      dbC.close();
    });

    it('ユニークが2本ある表で更新が拒まれても、同期は止まらず巻き添えも出ない', async () => {
      interface AccountRow {
        id: string;
        username: string;
        email: string;
      }
      function accountRows(db: Database.Database): AccountRow[] {
        return db
          .prepare(`SELECT id, username, email FROM accounts ORDER BY id`)
          .all() as AccountRow[];
      }
      function insertAccount(
        db: Database.Database,
        id: string,
        username: string,
        email: string,
        updatedAt: string
      ): void {
        db.prepare(
          `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)`
        ).run(id, username, email, updatedAt);
      }

      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      insertAccount(dbA, 'r0', 'name0', 'mail0', '2024-05-01T00:00:00Z');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // B は独立に2つの行を作る。片方は email が、もう片方は username が、
      // このあと A が r0 へ書き込む値とぶつかる。
      insertAccount(dbB, 'r1', 'name1', 'mailX', '2024-01-01T00:00:00Z');
      insertAccount(dbB, 'r2', 'nameX', 'mail2', '2024-12-01T00:00:00Z');

      dbA
        .prepare(
          `UPDATE accounts SET username = ?, email = ?, updatedAt = ? WHERE id = ?`
        )
        .run('nameX', 'mailX', '2024-06-01T00:00:00Z', 'r0');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // 届いた更新は r2 に負ける。負けたのだから、先に見えた r1 を巻き添えにしない。
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(uniqueWarnings(result.warnings)).toEqual([]);
      expect(result.clientsSynced).toBe(1);
      expect(accountRows(dbB)).toEqual([
        { id: 'r1', username: 'name1', email: 'mailX' },
        { id: 'r2', username: 'nameX', email: 'mail2' },
      ]);

      // 何周回しても同じ所で落ち続けない（＝相手からの取り込みが止まらない）
      for (let round = 0; round < 3; round++) {
        for (const [clientId, db, dbPath] of [
          ['client-a', dbA, pathA],
          ['client-b', dbB, pathB],
        ] as const) {
          const roundResult = await performSync(
            db,
            makeConfig(dbPath, clientId),
            TABLES
          );
          expect(
            uniqueWarnings(roundResult.warnings),
            `${clientId} round${round}`
          ).toEqual([]);
        }
      }
      // 最後は両端末が同じ形へ収束する（email の索引でも LWW が働き、r1 も r2 へ畳まれる）
      expect(accountRows(dbA)).toEqual([
        { id: 'r2', username: 'nameX', email: 'mail2' },
      ]);
      expect(accountRows(dbB)).toEqual(accountRows(dbA));

      dbA.close();
      dbB.close();
    });

    it('ユニークが2本ある表で、届いた作成が2本目で拒まれても同期は止まらない', async () => {
      // 更新ではなく**作成**が索引ごとに別々の相手へぶつかる形。
      // SQLite が最初に告げるのは email の違反なので、エラー文からしか相手を知れない
      // うちは「先に r1 を畳んでから r2 に負ける」ことになり、挿入し直せずに例外が抜けて
      // その相手ぶんの取り込みが丸ごと巻き戻る（＝同期がそこで止まる）。
      interface AccountRow {
        id: string;
        username: string;
        email: string;
      }
      function accountRows(db: Database.Database): AccountRow[] {
        return db
          .prepare(`SELECT id, username, email FROM accounts ORDER BY id`)
          .all() as AccountRow[];
      }
      function insertAccount(
        db: Database.Database,
        id: string,
        username: string,
        email: string,
        updatedAt: string
      ): void {
        db.prepare(
          `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)`
        ).run(id, username, email, updatedAt);
      }

      // A: 1行だけ作る
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      insertAccount(dbA, 'r0', 'nameX', 'mailX', '2024-06-01T00:00:00Z');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      // B: 独立に2行作る。片方は email が、もう片方は username が、A の r0 とぶつかる。
      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      insertAccount(dbB, 'r1', 'name1', 'mailX', '2024-01-01T00:00:00Z');
      insertAccount(dbB, 'r2', 'nameX', 'mail2', '2024-12-01T00:00:00Z');

      // 届いた作成は r2 に負ける。負けたのだから、先に見えた r1 を巻き添えにしない。
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
      expect(uniqueWarnings(result.warnings)).toEqual([]);
      expect(result.clientsSynced).toBe(1);
      expect(accountRows(dbB)).toEqual([
        { id: 'r1', username: 'name1', email: 'mailX' },
        { id: 'r2', username: 'nameX', email: 'mail2' },
      ]);

      // 何周回しても同じ所で落ち続けない（＝相手からの取り込みが止まらない）
      for (let round = 0; round < 3; round++) {
        for (const [clientId, db, dbPath] of [
          ['client-a', dbA, pathA],
          ['client-b', dbB, pathB],
        ] as const) {
          const roundResult = await performSync(
            db,
            makeConfig(dbPath, clientId),
            TABLES
          );
          expect(
            uniqueWarnings(roundResult.warnings),
            `${clientId} round${round}`
          ).toEqual([]);
        }
      }

      // 両端末が同じ1行へ収束する
      expect(accountRows(dbA)).toEqual([
        { id: 'r2', username: 'nameX', email: 'mail2' },
      ]);
      expect(accountRows(dbB)).toEqual(accountRows(dbA));

      dbA.close();
      dbB.close();
    });

    it('畳みで付け替えた子の行数が RecordFold に出る', async () => {
      // 「1つにまとめました」だけでは影響範囲が分からない。何行が付け替わったかを返す。
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      insertTag(dbA, 't1', '数学', '2024-01-01T00:00:00Z');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      // B は独立に「国語」の t2 を作り、そこへメモを3件ぶら下げる
      insertTag(dbB, 't2', '国語', '2024-03-01T00:00:00Z');
      insertNote(dbB, 'note-1', 't2', '2024-03-01T00:00:00Z');
      insertNote(dbB, 'note-2', 't2', '2024-03-01T00:00:00Z');
      insertNote(dbB, 'note-3', 't2', '2024-03-01T00:00:00Z');

      // A: t1 を「国語」へ改名。B の t2 より新しいので、届いた改名が勝つ
      dbA
        .prepare(`UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?`)
        .run('国語', '2024-06-01T00:00:00Z', 't1');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      expect(result.folds).toEqual([
        {
          tableName: 'tags',
          losingId: 't2',
          winningId: 't1',
          removedLocalRow: true,
          movedChildren: 3,
          lostChildren: 0,
        },
      ]);
      // 返した数は、実際に付け替わった行と一致すること
      expect(noteRows(dbB)).toEqual([
        { id: 'note-1', tagId: 't1' },
        { id: 'note-2', tagId: 't1' },
        { id: 'note-3', tagId: 't1' },
      ]);

      dbA.close();
      dbB.close();
    });

    it('相手の作成を自分の行へ吸収した場合は、行は消えていないと出る', async () => {
      // A と B が独立に同じ名前のタグを作る。B のものが新しいので B 側は自分を残す。
      const { db: dbA, dbPath: pathA } = createClientDb('client-a');
      insertTag(dbA, 't1', '国語', '2024-03-01T00:00:00Z');
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

      const { db: dbB, dbPath: pathB } = createClientDb('client-b');
      insertTag(dbB, 't2', '国語', '2024-06-01T00:00:00Z');
      const result = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

      expect(result.folds).toEqual([
        {
          tableName: 'tags',
          losingId: 't1',
          winningId: 't2',
          removedLocalRow: false,
          movedChildren: 0,
          lostChildren: 0,
        },
      ]);
      // B は t1 を一度も持っていないので、消えた行はない
      expect(result.deleted).toBe(0);
      expect(result.conflictsResolved).toBe(1);
      expect(tagRows(dbB)).toEqual([{ id: 't2', name: '国語' }]);

      dbA.close();
      dbB.close();
    });
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
