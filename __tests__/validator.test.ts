import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { validateDatabase } from '../src/validator';

describe('validateDatabase', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('正しいスキーマのテーブルはエラーなし', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, ['users'], 'id');
    expect(errors).toHaveLength(0);
  });

  it('テーブルが存在しない場合エラー', () => {
    const errors = validateDatabase(db, ['nonexistent'], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].table).toBe('nonexistent');
    expect(errors[0].message).toContain('does not exist');
  });

  it('PKカラムが存在しない場合エラー', () => {
    db.exec(`
      CREATE TABLE users (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, ['users'], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Primary key column 'id' does not exist");
  });

  it('PKがTEXT型でない場合エラー', () => {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, ['users'], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('must be TEXT type');
  });

  it('updatedAtカラムがない場合エラー', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    `);

    const errors = validateDatabase(db, ['users'], 'id');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("'updatedAt' does not exist");
  });

  it('複数テーブルで一部だけエラー', () => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        message TEXT
      )
    `);

    const errors = validateDatabase(db, ['users', 'logs'], 'id');
    // logs: INTEGER PK + updatedAtなし
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.every((e) => e.table === 'logs')).toBe(true);
  });

  it('テーブル不在の場合、後続チェックをスキップ', () => {
    const errors = validateDatabase(db, ['missing'], 'id');
    // エラーは1つだけ（不在エラーのみ、PKやupdatedAtのエラーは出ない）
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Table does not exist');
  });
});
