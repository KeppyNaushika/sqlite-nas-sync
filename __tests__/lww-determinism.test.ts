/**
 * 削除 vs 更新の決定論的LWW回帰テスト。
 *
 * 修正前の2大バグを固定する:
 *  1. 順序依存: pullNormal の changelog DELETE が無条件適用で、クライアント処理順により
 *     「削除 vs より新しい更新」の勝敗が変わっていた。
 *  2. フォーマット不一致: updatedAt(ISO-T) と deletedAt(datetime('now') スペース形式) の
 *     文字列比較が壊れ、同日の削除vs更新で削除が常に負けていた。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { setupSync } from '../src/index';
import {
  applyUpdate,
  isLaterTimestamp,
  isShadowedByTombstone,
} from '../src/conflict';
import { setupChangelog } from '../src/setup';

describe('isLaterTimestamp: フォーマット差(ISO-T vs スペース)を吸収する', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('スペース形式の削除が1秒後でも「新しい」と判定される（文字列比較では誤判定する）', () => {
    const updatedAt = '2026-05-13T23:17:35.111+00:00'; // ISO-T
    const deletedAt = '2026-05-13 23:17:36'; // スペース形式・1秒後
    // 文字列比較は壊れている（' ' < 'T' で削除が小さく見える）
    expect(deletedAt > updatedAt).toBe(false);
    // julianday正規化では正しく「削除が後」
    expect(isLaterTimestamp(db, deletedAt, updatedAt)).toBe(true);
    expect(isLaterTimestamp(db, updatedAt, deletedAt)).toBe(false);
  });

  it('同時刻より前の削除は「新しくない」', () => {
    const updatedAt = '2026-05-13T23:17:35.111+00:00';
    const deletedAt = '2026-05-13 23:17:34';
    expect(isLaterTimestamp(db, deletedAt, updatedAt)).toBe(false);
  });
});

describe('pullNormal consolidation: 削除 vs 更新がクライアント処理順に依存しない', () => {
  let work: string;
  let syncDir: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nas-lww-'));
    syncDir = join(work, 'sync');
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  function makeDbFile(name: string): string {
    const p = join(work, name);
    const db = new Database(p);
    db.exec(
      `CREATE TABLE Item (id TEXT PRIMARY KEY, value TEXT, updatedAt TEXT NOT NULL)`
    );
    db.close();
    return p;
  }

  async function withSync(
    dbPath: string,
    clientId: string,
    fn: (db: Database.Database, sync: { syncNow: () => Promise<unknown> }) => Promise<void>
  ): Promise<void> {
    const sync = setupSync({
      dbPath,
      nasPath: syncDir,
      clientId,
      intervalMs: 3_600_000,
      heartbeatEnabled: false,
    });
    const db = new Database(dbPath);
    try {
      await fn(db, sync);
    } finally {
      db.close();
      sync.stop();
    }
  }

  /** delId が X を削除、updId が X をより新しい updatedAt で保持。consolidator が両方を pull。 */
  async function consolidate(delId: string, updId: string): Promise<string> {
    const delPath = makeDbFile(`${delId}.db`);
    const updPath = makeDbFile(`${updId}.db`);
    const mainPath = makeDbFile('school-planner.db');

    await withSync(delPath, delId, async (db, sync) => {
      db.prepare(`INSERT INTO Item (id, value, updatedAt) VALUES (?,?,?)`).run(
        'X', 'created', '2026-01-01T00:00:00.000+00:00'
      );
      await sync.syncNow();
      db.prepare(`DELETE FROM Item WHERE id = ?`).run('X');
      await sync.syncNow();
    });
    await withSync(updPath, updId, async (db, sync) => {
      db.prepare(`INSERT INTO Item (id, value, updatedAt) VALUES (?,?,?)`).run(
        'X', 'updated', '2099-12-31T00:00:00.000+00:00'
      );
      await sync.syncNow();
    });

    let result = 'ERR';
    await withSync(mainPath, 'zzconsolidator', async (db, sync) => {
      await sync.syncNow();
      const row = db.prepare(`SELECT value FROM Item WHERE id = ?`).get('X') as
        | { value: string }
        | undefined;
      result = row ? `SURVIVED:${row.value}` : 'DELETED';
    });
    return result;
  }

  it('削除が先・更新が後 → 更新(2099)が新しいので X は残る', async () => {
    expect(await consolidate('aaaa', 'bbbb')).toBe('SURVIVED:updated');
  });

  it('更新が先・削除が後 → 同じ結果（順序非依存）', async () => {
    // readdir順で削除が後に処理されても、無条件削除ではなくLWWなので結果は不変
    expect(await consolidate('zzzz', 'aaaa')).toBe('SURVIVED:updated');
  });
});

/**
 * 記録する時刻の精度の回帰テスト。
 *
 * `datetime('now')` は**秒に切り捨てた**値を返すため、同じ秒の中で起きた
 * 削除と更新の前後が失われていた。アプリが書く `updatedAt` はミリ秒まで持つので、
 * 削除側だけが粗いと「削除より前の更新」が新しいと判定され、行が復活する。
 */
describe('記録する時刻の精度', () => {
  let db: Database.Database;
  const columns = ['id', 'name', 'updatedAt'];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, [{ name: 'users' }], 'id');
  });
  afterEach(() => db.close());

  it('_tombstone.deletedAt と _changelog.changedAt がミリ秒まで持つ', () => {
    db.prepare('INSERT INTO users (id,name,updatedAt) VALUES (?,?,?)')
      .run('u1', 'a', '2026-01-01T00:00:00.000Z');
    db.prepare('DELETE FROM users WHERE id = ?').run('u1');

    const { deletedAt } = db
      .prepare('SELECT deletedAt FROM _tombstone WHERE recordId = ?')
      .get('u1') as { deletedAt: string };
    const { changedAt } = db
      .prepare(`SELECT changedAt FROM _changelog WHERE operation = 'DELETE'`)
      .get() as { changedAt: string };

    // updatedAt と同じ書式・同じ精度（例: 2026-05-02T02:19:56.111Z）
    const isoMillis = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(deletedAt).toMatch(isoMillis);
    expect(changedAt).toMatch(isoMillis);
  });

  it('同じ秒の中で「削除より前の更新」が行を復活させない', () => {
    db.prepare('INSERT INTO users (id,name,updatedAt) VALUES (?,?,?)')
      .run('u1', 'orig', '2020-01-01T00:00:00.000Z');

    // 秒の頭へ揃えてから 400ms 進める。更新を「秒の途中」に置くことで、
    // 秒へ切り捨てると削除の方が古く見える状況を作る
    while (new Date().getMilliseconds() > 80) {
      /* 秒境界を待つ */
    }
    const base = Date.now();
    while (Date.now() - base < 400) {
      /* 秒の途中まで進める */
    }
    const updatedAt = new Date().toISOString();

    // 更新より **あと** に削除する
    db.prepare('DELETE FROM users WHERE id = ?').run('u1');

    // 削除より前の更新が届いた → 捨てられなければならない
    const res = applyUpdate(db, 'users', 'id', { id: 'u1', name: 'zombie', updatedAt }, columns);
    expect(res.action).toBe('skipped');
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get('u1')).toBeUndefined();
  });

  it('古いDBに残る秒精度・スペース形式の値とも比べられる', () => {
    // 0.18.0 以前のトリガが書いた形をそのまま置く
    db.prepare(
      `INSERT INTO _tombstone (tableName, recordId, deletedAt) VALUES (?,?,?)`
    ).run('users', 'u9', '2026-05-02 02:19:56');

    // 削除より後の更新は通る
    expect(
      isShadowedByTombstone(db, 'users', 'u9', '2026-05-02T02:19:57.000Z')
    ).toBe(false);
    // 削除より前の更新は通らない
    expect(
      isShadowedByTombstone(db, 'users', 'u9', '2026-05-02T02:19:55.000Z')
    ).toBe(true);
  });

  it('古い定義のトリガは作り直される', () => {
    const name = '_changelog_after_delete_users';
    const sqlOf = (): string =>
      (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`)
          .get(name) as { sql: string }
      ).sql;

    // 0.18.0 以前の定義（秒精度）へ戻す
    db.exec(`DROP TRIGGER ${name}`);
    db.exec(`
      CREATE TRIGGER ${name}
      AFTER DELETE ON "users" FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation)
        VALUES ('users', OLD."id", 'DELETE');
        INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
        VALUES ('users', OLD."id", datetime('now'));
      END
    `);
    expect(sqlOf()).toContain("datetime('now')");

    setupChangelog(db, [{ name: 'users' }], 'id');

    expect(sqlOf()).not.toContain("datetime('now')");
    expect(sqlOf()).toContain('strftime');

    // 作り直したトリガが実際にミリ秒で書く
    db.prepare('INSERT INTO users (id,name,updatedAt) VALUES (?,?,?)')
      .run('u2', 'a', '2026-01-01T00:00:00.000Z');
    db.prepare('DELETE FROM users WHERE id = ?').run('u2');
    const { deletedAt } = db
      .prepare('SELECT deletedAt FROM _tombstone WHERE recordId = ?')
      .get('u2') as { deletedAt: string };
    expect(deletedAt).toMatch(/\.\d{3}Z$/);
  });
});
