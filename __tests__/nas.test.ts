import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { openRemoteDbViaLocalCopy } from '../src/nas';

describe('openRemoteDbViaLocalCopy', () => {
  const testDir = path.join(__dirname, 'test-data-nas');
  const tmpDir = path.join(testDir, 'tmp');
  const srcPath = path.join(testDir, 'remote.sqlite');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    const db = new Database(srcPath);
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`);
    db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run('a', 'hello');
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('リモートDBファイルをローカルtmpにコピーしてから開く', () => {
    const handle = openRemoteDbViaLocalCopy(srcPath, tmpDir);
    expect(handle).not.toBeNull();
    const row = handle!.db.prepare(`SELECT v FROM t WHERE id = ?`).get('a') as { v: string };
    expect(row.v).toBe('hello');

    // tmp ファイルが実際に作られていること
    const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith('remote-'));
    expect(tmpFiles.length).toBe(1);

    handle!.cleanup();
    // cleanup 後に tmp ファイルが消えていること
    const tmpAfter = fs.readdirSync(tmpDir).filter((f) => f.startsWith('remote-'));
    expect(tmpAfter.length).toBe(0);
  });

  it('読み取り中にオリジナルが置き換わってもローカルコピーは影響を受けない', () => {
    const handle = openRemoteDbViaLocalCopy(srcPath, tmpDir);
    expect(handle).not.toBeNull();

    // オリジナルを書き換え
    const orig = new Database(srcPath);
    orig.prepare(`UPDATE t SET v = ? WHERE id = ?`).run('changed', 'a');
    orig.close();

    // ハンドルから読んだ値は元のまま
    const row = handle!.db.prepare(`SELECT v FROM t WHERE id = ?`).get('a') as { v: string };
    expect(row.v).toBe('hello');

    handle!.cleanup();
  });

  it('存在しないファイルを開こうとすると null を返す', () => {
    const handle = openRemoteDbViaLocalCopy(path.join(testDir, 'does-not-exist.sqlite'), tmpDir);
    expect(handle).toBeNull();
  });

  it('破損ファイルを開こうとすると null を返し、tmp も残らない', () => {
    const badPath = path.join(testDir, 'bad.sqlite');
    fs.writeFileSync(badPath, 'this is not a sqlite database');

    const handle = openRemoteDbViaLocalCopy(badPath, tmpDir);
    expect(handle).toBeNull();

    // tmp ディレクトリに残骸が無いこと
    if (fs.existsSync(tmpDir)) {
      const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith('remote-'));
      expect(tmpFiles.length).toBe(0);
    }
  });

  it('tmpDir を省略すると os.tmpdir() 配下を使う', () => {
    const handle = openRemoteDbViaLocalCopy(srcPath);
    expect(handle).not.toBeNull();

    const expectedDir = path.join(os.tmpdir(), 'sqlite-nas-sync');
    expect(fs.existsSync(expectedDir)).toBe(true);

    handle!.cleanup();
  });

  it('並行して複数開いても tmp ファイル名が衝突しない', () => {
    const handles = Array.from({ length: 5 }, () =>
      openRemoteDbViaLocalCopy(srcPath, tmpDir)
    );
    for (const h of handles) {
      expect(h).not.toBeNull();
    }
    const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith('remote-'));
    expect(tmpFiles.length).toBe(5);

    for (const h of handles) {
      h!.cleanup();
    }
  });
});
