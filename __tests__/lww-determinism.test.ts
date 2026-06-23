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
import { isLaterTimestamp } from '../src/conflict';

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
