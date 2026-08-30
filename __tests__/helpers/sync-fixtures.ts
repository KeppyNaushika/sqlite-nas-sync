/**
 * `performSync` のテストが共有する足場。
 *
 * NASに見立てたディレクトリと、そこへぶら下がるクライアントDBを作る。
 * スキーマは複数のテストファイルが同じものを使うので、**形はここ1か所で決める**
 * （各ファイルに写すと、片方だけ直したときに「同じはずのDB」が食い違う）。
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../../src/setup';
import { SyncConfig, TableConfig } from '../../src/types';

export const TABLES: TableConfig[] = [
  { name: 'users' },
  { name: 'posts' },
  { name: 'decisions' },
  { name: 'tags' },
  { name: 'tag_notes' },
  { name: 'tag_profiles' },
  { name: 'accounts' },
];

/**
 * 1つのテストファイル専用の作業ディレクトリと、その中で使う道具を作る。
 *
 * **作業ディレクトリはファイルごとに分けること。** vitest は複数のテストファイルを
 * 並行して走らせるので、同じディレクトリを共有すると、片方の `afterEach` の後片付けが
 * もう片方の走行中のDBを消す（実測: 「ファイル単体では通るのに全体では落ちる」形になる）。
 *
 * @param name - 作業ディレクトリの名前。テストファイルごとに違う名前を渡す
 */
export function createSyncFixture(name: string): {
  testDir: string;
  nasDir: string;
  /** 空の作業ディレクトリを用意する（`beforeEach` から呼ぶ） */
  prepare: () => void;
  /** 作業ディレクトリを丸ごと消す（`afterEach` から呼ぶ） */
  cleanup: () => void;
  createClientDb: (clientId: string) => {
    db: Database.Database;
    dbPath: string;
  };
  makeConfig: (dbPath: string, clientId: string) => SyncConfig;
} {
  const testDir = path.join(__dirname, name);
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

  /**
   * 空の作業ディレクトリを用意する。
   *
   * **前のテストの残骸が残っていると `CREATE TABLE` が「既に在る」で落ちる**ので、
   * 作る前に必ず消す（`afterEach` だけに任せると、途中で失敗したテストの後始末が
   * 飛んだときに次が巻き添えになる）。
   */
  function prepare(): void {
    cleanup();
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(nasDir, { recursive: true });
  }

  /** 作業ディレクトリを丸ごと消す。 */
  function cleanup(): void {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { testDir, nasDir, prepare, cleanup, createClientDb, makeConfig };
}
