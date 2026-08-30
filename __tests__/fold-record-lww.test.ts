/**
 * 畳みの記録（`_tombstone` / `_id_merge`）も行と同じLWWの下に置く、という規則の回帰テスト。
 *
 * 記録は「主張」であって永久の真理ではない。それが確立した時刻を持ち、新しい主張が勝つ。
 *
 * - **規則2** 読み替えは、記録が**ローカルの敗者行**より新しいときだけ適用する
 * - **規則3** 読み替えて書き換えたら、その行は勝った側の版の時刻を名乗る
 *   （ただし**席を別の行と争っているときは名乗らない** — 理由は下の describe に書いた）
 * - **規則4** 敗者行が記録より新しく更新されていれば、その畳みは適用しない
 * - **規則5** 読み替え先が消えているときは `ON DELETE` の宣言に従う
 *
 * 規則1（記録に勝者の時刻を刻む）は `fold-tombstone-time.test.ts` にある。
 * 規則4 は前から実装されていたが、記録の時刻が常に現在時刻だったため一度も発火しなかった。
 * ここでは**実際に発火すること**を見る。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert, applyMergedDelete, applyUpdate } from '../src/conflict';
import { performSync } from '../src/sync';
import { SyncConfig, TableConfig } from '../src/types';

const PARENT_COLUMNS = ['id', 'tenantId', 'ukey', 'updatedAt'];
const KID_COLUMNS = ['id', 'parentId', 'updatedAt'];
const COMPOSITE_KID_COLUMNS = ['id', 'parentId', 'tenantId', 'updatedAt'];

const FK_TABLES: TableConfig[] = [
  { name: 'parents' },
  { name: 'kids_cascade' },
  { name: 'kids_setnull' },
  { name: 'kids_setnull_notnull' },
  { name: 'kids_restrict' },
  { name: 'kids_noaction' },
  { name: 'kids_composite' },
  { name: 'kids_setdefault' },
  { name: 'kids_setdefault_missing' },
  { name: 'kids_setdefault_undeclared' },
  { name: 'kids_setdefault_composite' },
  { name: 'kids_setdefault_expr' },
  { name: 'kids_setdefault_expr_missing' },
  { name: 'detail_setnull' },
  { name: 'detail_setdefault' },
];

interface KidRow {
  id: string;
  parentId: string | null;
  updatedAt: string;
}

/**
 * `ON DELETE` の宣言だけが違う子テーブルを並べたDB。
 * 親は「別id・同一ユニークキー」で畳まれる形（`ukey`）を持つ。
 */
function createForeignKeyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE parents (
      id        TEXT PRIMARY KEY,
      tenantId  TEXT NOT NULL,
      ukey      TEXT NOT NULL UNIQUE,
      updatedAt TEXT NOT NULL,
      UNIQUE (id, tenantId)
    );
    CREATE TABLE kids_cascade (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE CASCADE,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setnull (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE SET NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setnull_notnull (
      id        TEXT PRIMARY KEY,
      parentId  TEXT NOT NULL REFERENCES parents(id) ON DELETE SET NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_restrict (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE RESTRICT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_noaction (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id),
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_composite (
      id        TEXT PRIMARY KEY,
      parentId  TEXT,
      tenantId  TEXT,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (parentId, tenantId) REFERENCES parents(id, tenantId) ON DELETE SET NULL
    );
    CREATE TABLE kids_setdefault (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT 'p-fallback' REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_missing (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT 'p-nowhere' REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_undeclared (
      id        TEXT PRIMARY KEY,
      parentId  TEXT REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_expr (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT (lower('P-FALLBACK')) REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_expr_missing (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT (lower('P-NOWHERE')) REFERENCES parents(id) ON DELETE SET DEFAULT,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE detail_setnull (
      id        TEXT PRIMARY KEY REFERENCES parents(id) ON DELETE SET NULL,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE detail_setdefault (
      id        TEXT PRIMARY KEY DEFAULT 'p-fallback' REFERENCES parents(id) ON DELETE SET DEFAULT,
      body      TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE kids_setdefault_composite (
      id        TEXT PRIMARY KEY,
      parentId  TEXT DEFAULT 'p-fallback',
      tenantId  TEXT,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (parentId, tenantId) REFERENCES parents(id, tenantId) ON DELETE SET DEFAULT
    );
  `);
  setupChangelog(db, FK_TABLES, 'id');
  return db;
}

/**
 * 「p-a は p-b へ畳まれた」という記録を作り、そのあと利用者が p-b を消した状態にする。
 *
 * 畳みは通常の経路（同じ `ukey` の古い行が届く → ローカルが勝つ）で作る。
 * 記録を手で書かないのは、記録に刻まれる時刻まで含めて実物と同じにするため。
 */
function foldThenDeleteWinner(db: Database.Database): void {
  db.prepare(
    `INSERT INTO parents (id, tenantId, ukey, updatedAt)
     VALUES ('p-b', 'tenant-1', 'k1', '2026-02-01T00:00:00Z')`
  ).run();

  applyInsert(
    db,
    'parents',
    'id',
    {
      id: 'p-a',
      tenantId: 'tenant-1',
      ukey: 'k1',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    PARENT_COLUMNS
  );

  db.prepare(`DELETE FROM parents WHERE id = 'p-b'`).run();
}

function kidsOf(db: Database.Database, tableName: string): KidRow[] {
  return db
    .prepare(`SELECT id, parentId, updatedAt FROM ${tableName} ORDER BY id`)
    .all() as KidRow[];
}

describe('規則5: 読み替え先が消えているときは onDelete に従う', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createForeignKeyDb();
    foldThenDeleteWinner(db);
  });

  afterEach(() => {
    db.close();
  });

  it('CASCADE の子は採らない（手元に居たら道連れになっていた）', () => {
    const result = applyInsert(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('skipped');
    expect(kidsOf(db, 'kids_cascade')).toEqual([]);
    expect(result.warnings).toEqual([
      'Dropped kids_cascade:kid-1: parent parents:p-b is gone (ON DELETE CASCADE)',
    ]);
  });

  it('SET NULL の子は外部キーを null にして採る', () => {
    const result = applyInsert(
      db,
      'kids_setnull',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    expect(kidsOf(db, 'kids_setnull')).toEqual([
      { id: 'kid-1', parentId: null, updatedAt: '2026-03-01T00:00:00Z' },
    ]);
    expect(result.warnings).toEqual([
      'Kept kids_setnull:kid-1 with parentId set to NULL: parent parents:p-b is gone (ON DELETE SET NULL)',
    ]);
  });

  it('SET NULL でも NOT NULL 列なら採らない（実質 RESTRICT）', () => {
    const result = applyInsert(
      db,
      'kids_setnull_notnull',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('skipped');
    expect(kidsOf(db, 'kids_setnull_notnull')).toEqual([]);
    expect(result.warnings).toEqual([
      'Dropped kids_setnull_notnull:kid-1: parent parents:p-b is gone and ON DELETE SET NULL cannot apply (parentId is NOT NULL)',
    ]);
  });

  it('RESTRICT の子は採らずに警告する', () => {
    const result = applyInsert(
      db,
      'kids_restrict',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('skipped');
    expect(kidsOf(db, 'kids_restrict')).toEqual([]);
    expect(result.warnings).toEqual([
      'Dropped kids_restrict:kid-1: parent parents:p-b is gone (ON DELETE RESTRICT)',
    ]);
  });

  it('NO ACTION の子も採らずに警告する', () => {
    const result = applyInsert(
      db,
      'kids_noaction',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('skipped');
    expect(kidsOf(db, 'kids_noaction')).toEqual([]);
    expect(result.warnings).toEqual([
      'Dropped kids_noaction:kid-1: parent parents:p-b is gone (ON DELETE NO ACTION)',
    ]);
  });

  it('複合外部キーは全列を null にする（一部だけでは残った列が孤児を指す）', () => {
    const result = applyInsert(
      db,
      'kids_composite',
      'id',
      {
        id: 'kid-1',
        parentId: 'p-a',
        tenantId: 'tenant-1',
        updatedAt: '2026-03-01T00:00:00Z',
      },
      COMPOSITE_KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    expect(
      db.prepare(`SELECT id, parentId, tenantId FROM kids_composite`).all()
    ).toEqual([{ id: 'kid-1', parentId: null, tenantId: null }]);
    expect(result.warnings).toEqual([
      'Kept kids_composite:kid-1 with parentId, tenantId set to NULL: parent parents:p-b is gone (ON DELETE SET NULL)',
    ]);
  });

  it('ローカルに行が在るときの上書き経路（applyUpdate）も素通りしない', () => {
    // applyUpdate が applyInsert へ委譲するのは「ローカルに行が無いとき」だけなので、
    // 行が在るときの上書きは別に見る必要がある。
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-c', 'tenant-1', 'k2', '2026-01-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO kids_cascade (id, parentId, updatedAt)
       VALUES ('kid-1', 'p-c', '2026-01-01T00:00:00Z')`
    ).run();

    const result = applyUpdate(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('skipped');
    // 届いた更新を採らなかったので、ローカルの行はそのまま
    expect(kidsOf(db, 'kids_cascade')).toEqual([
      { id: 'kid-1', parentId: 'p-c', updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(result.warnings).toEqual([
      'Dropped kids_cascade:kid-1: parent parents:p-b is gone (ON DELETE CASCADE)',
    ]);
  });

  it('applyUpdate の SET NULL は、届いた更新を列を外して採る', () => {
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-c', 'tenant-1', 'k2', '2026-01-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO kids_setnull (id, parentId, updatedAt)
       VALUES ('kid-1', 'p-c', '2026-01-01T00:00:00Z')`
    ).run();

    const result = applyUpdate(
      db,
      'kids_setnull',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('updated');
    expect(kidsOf(db, 'kids_setnull')).toEqual([
      { id: 'kid-1', parentId: null, updatedAt: '2026-03-01T00:00:00Z' },
    ]);
  });

  it('SET DEFAULT: 既定値の親が居れば、既定値を入れて採る', () => {
    // SQLite の実動作は「子の外部キー列を宣言された既定値にする」で、その既定値の親が
    // 在れば子はそこへ繋がって生き残る（実測）。`dflt_value` はSQLの字面なので、
    // クォートごと入れずに SQLite に評価させる。
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-fallback', 'tenant-1', 'k-fallback', '2026-01-01T00:00:00Z')`
    ).run();

    const result = applyInsert(
      db,
      'kids_setdefault',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    expect(kidsOf(db, 'kids_setdefault')).toEqual([
      { id: 'kid-1', parentId: 'p-fallback', updatedAt: '2026-03-01T00:00:00Z' },
    ]);
    expect(result.warnings).toEqual([
      'Kept kids_setdefault:kid-1 with parentId set to its default: parent parents:p-b is gone (ON DELETE SET DEFAULT)',
    ]);
  });

  it('SET DEFAULT: 既定値の親が居なければ採らない（SQLiteでは削除自体が失敗する形）', () => {
    const result = applyInsert(
      db,
      'kids_setdefault_missing',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('skipped');
    expect(kidsOf(db, 'kids_setdefault_missing')).toEqual([]);
    expect(result.warnings).toEqual([
      'Dropped kids_setdefault_missing:kid-1: parent parents:p-b is gone and ON DELETE SET DEFAULT cannot apply (default parent parents row is missing)',
    ]);
  });

  it('SET DEFAULT: 既定値の宣言が無ければ NULL（SET NULL と同じ）', () => {
    const result = applyInsert(
      db,
      'kids_setdefault_undeclared',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    expect(kidsOf(db, 'kids_setdefault_undeclared')).toEqual([
      { id: 'kid-1', parentId: null, updatedAt: '2026-03-01T00:00:00Z' },
    ]);
  });

  it('SET DEFAULT: 既定値が式でも、評価した先の親を探す', () => {
    // `PRAGMA table_info` の `dflt_value` はSQLの字面なので、式はそのままでは使えない。
    // SQLite に評価させた値で親を探す（SQLite 自身の動作と一致することを実測済み）。
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-fallback', 'tenant-1', 'k-fallback', '2026-01-01T00:00:00Z')`
    ).run();

    const kept = applyInsert(
      db,
      'kids_setdefault_expr',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );
    expect(kept.action).toBe('inserted');
    expect(kidsOf(db, 'kids_setdefault_expr')).toEqual([
      // lower('P-FALLBACK') を評価した 'p-fallback' が入る（字面 "(lower('P-FALLBACK'))" ではない）
      { id: 'kid-1', parentId: 'p-fallback', updatedAt: '2026-03-01T00:00:00Z' },
    ]);

    const dropped = applyInsert(
      db,
      'kids_setdefault_expr_missing',
      'id',
      { id: 'kid-2', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );
    expect(dropped.action).toBe('skipped');
    expect(kidsOf(db, 'kids_setdefault_expr_missing')).toEqual([]);
  });

  it('SET DEFAULT: 複合外部キーは全列を既定値にする（宣言の無い列は NULL）', () => {
    // SQLite は複合でも**その外部キーの全列**を既定値にし、宣言の無い列は NULL にする
    // （実測）。NULL を含む組は外部キーの検査対象外なので、既定値の親を探す必要も無い。
    const result = applyInsert(
      db,
      'kids_setdefault_composite',
      'id',
      {
        id: 'kid-1',
        parentId: 'p-a',
        tenantId: 'tenant-1',
        updatedAt: '2026-03-01T00:00:00Z',
      },
      COMPOSITE_KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    expect(
      db.prepare(`SELECT id, parentId, tenantId FROM kids_setdefault_composite`).all()
    ).toEqual([{ id: 'kid-1', parentId: 'p-fallback', tenantId: null }]);
  });

  it('外部キーが子の主キーを兼ねる1:1では、SET NULL も SET DEFAULT も適用しない', () => {
    // SQLite は主キーでも書き換える（`id` を NULL にし、既定値を入れる。実測）。
    // だがこのライブラリは行を主キーで同定しているので追随できない。実測では:
    //  - NULL にすると `_changelog.recordId` の NOT NULL に触れて**例外**になり、
    //    その相手ぶんの取り込みが丸ごと巻き戻る（同期が黙って止まる）
    //  - 既定値にすると**その行が別のidの行に化ける**
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-fallback', 'tenant-1', 'k-fallback', '2026-01-01T00:00:00Z')`
    ).run();

    for (const tableName of ['detail_setnull', 'detail_setdefault'] as const) {
      const result = applyInsert(
        db,
        tableName,
        'id',
        { id: 'p-a', body: '詳細', updatedAt: '2026-03-01T00:00:00Z' },
        ['id', 'body', 'updatedAt']
      );

      expect(result.action, tableName).toBe('skipped');
      expect(db.prepare(`SELECT id FROM ${tableName}`).all(), tableName).toEqual(
        []
      );
      expect(result.warnings, tableName).toEqual([
        `Dropped ${tableName}:p-a: parent parents:p-b is gone and ON DELETE ${
          tableName === 'detail_setnull' ? 'SET NULL' : 'SET DEFAULT'
        } cannot apply (id is part of the primary key)`,
      ]);
    }
  });

  it('CASCADE と SET NULL の親を両方持つ表は、外部キーを見る順番で答えが変わらない', () => {
    // 途中で結論を出すと `PRAGMA foreign_key_list` の順で「null にしてから採らない」に
    // なったり「採らない」だけになったりする。採らないと決めた相手が1人でも居れば
    // 採らない、が順番によらない答え。
    db.exec(`
      CREATE TABLE kids_mixed (
        id         TEXT PRIMARY KEY,
        hardParent TEXT REFERENCES parents(id) ON DELETE CASCADE,
        softParent TEXT REFERENCES parents(id) ON DELETE SET NULL,
        updatedAt  TEXT NOT NULL
      )
    `);
    setupChangelog(db, [...FK_TABLES, { name: 'kids_mixed' }], 'id');

    const result = applyInsert(
      db,
      'kids_mixed',
      'id',
      {
        id: 'kid-1',
        hardParent: 'p-a',
        softParent: 'p-a',
        updatedAt: '2026-03-01T00:00:00Z',
      },
      ['id', 'hardParent', 'softParent', 'updatedAt']
    );

    expect(result.action).toBe('skipped');
    expect(db.prepare(`SELECT id FROM kids_mixed`).all()).toEqual([]);
    // 採らないと決めたのだから、「null にして採った」とは言わない
    expect(result.warnings).toEqual([
      'Dropped kids_mixed:kid-1: parent parents:p-b is gone (ON DELETE CASCADE)',
    ]);
  });

  it('取り込み元で作り直された親は「消えた」と見なさない（順番で結果が変わらない）', () => {
    // `_tombstone` は「いつか消された」の記録であって「今も消えている」ではない。
    // 同じ取り込みの中で親が**作り直されて**届くとき、子の方が先に処理されることがある。
    // そこで tombstone だけを見て子を捨てると、**親は蘇ったのに子だけ失われる**
    // （順番だけで結果が変わる）。取り込み元にその行が現存するかを見て見分ける。
    const remoteHasParent = (tableName: string, recordId: string): boolean =>
      tableName === 'parents' && recordId === 'p-b';

    let kidResult: ReturnType<typeof applyInsert> | null = null;
    db.transaction(() => {
      // 取り込みと同じく、外部キーの検査は終端まで遅らせる
      db.pragma('defer_foreign_keys = ON');
      // 子が先に届く
      kidResult = applyInsert(
        db,
        'kids_cascade',
        'id',
        { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
        KID_COLUMNS,
        'updatedAt',
        remoteHasParent
      );
      // 親の作り直しはそのあとで届く
      applyInsert(
        db,
        'parents',
        'id',
        {
          id: 'p-b',
          tenantId: 'tenant-1',
          ukey: 'k1',
          updatedAt: '2099-01-01T00:00:00Z',
        },
        PARENT_COLUMNS,
        'updatedAt',
        remoteHasParent
      );
    })();

    expect(kidResult).not.toBeNull();
    expect(kidResult!.action).toBe('inserted');
    expect(kidResult!.warnings).toEqual([]);
    expect(kidsOf(db, 'kids_cascade')).toEqual([
      { id: 'kid-1', parentId: 'p-b', updatedAt: '2026-03-01T00:00:00Z' },
    ]);
  });

  it('取り込み元が削除より古い行しか持っていなければ、作り直しではない', () => {
    // **「取り込み元にその行がある」だけでは作り直しの証拠にならない。**
    // 削除をまだ受け取っていない相手はその行を持ったままなので、存在だけで判断すると
    // 「生きている」と誤って答え、消えた親を指す子をそのまま入れて外部キー違反になる
    // （＝その相手ぶんの取り込みが丸ごと巻き戻り、同期がその相手から永久に止まる）。
    const seen: { recordId: string; deletedAt: string }[] = [];
    const staleSource = (
      tableName: string,
      recordId: string,
      deletedAt: string
    ): boolean => {
      seen.push({ recordId, deletedAt });
      // 相手が持っているのは削除より**古い**版なので、作り直しではない
      return false;
    };

    const result = applyInsert(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS,
      'updatedAt',
      staleSource
    );

    // 判定の材料として、こちらの `_tombstone` の削除時刻が渡ること
    expect(seen).toHaveLength(1);
    expect(seen[0].recordId).toBe('p-b');
    expect(seen[0].deletedAt).not.toBe('');

    expect(result.action).toBe('skipped');
    expect(result.warnings).toEqual([
      'Dropped kids_cascade:kid-1: parent parents:p-b is gone (ON DELETE CASCADE)',
    ]);
  });

  it('取り込み元からも消えている親は、これまでどおり onDelete に従う', () => {
    const goneEverywhere = (): boolean => false;
    const result = applyInsert(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS,
      'updatedAt',
      goneEverywhere
    );

    expect(result.action).toBe('skipped');
    expect(kidsOf(db, 'kids_cascade')).toEqual([]);
    expect(result.warnings).toEqual([
      'Dropped kids_cascade:kid-1: parent parents:p-b is gone (ON DELETE CASCADE)',
    ]);
  });

  it('まだ届いていないだけの親は「消えた」と見なさない', () => {
    // 取り込みは外部キーの検査を終端まで遅らせるので、親がこのあと同じ取り込みで届くのは
    // 普通に起きる。`_tombstone` に載っていない親を「消えた」と扱うと、順番が違うだけの
    // 行を殺すことになる。
    db.prepare(`DELETE FROM _tombstone WHERE recordId = 'p-b'`).run();
    db.pragma('foreign_keys = OFF');

    const result = applyInsert(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    expect(result.warnings).toEqual([]);
    // 読み替えそのものは行われる（畳み先が届けば繋がる）
    expect(kidsOf(db, 'kids_cascade')).toEqual([
      { id: 'kid-1', parentId: 'p-b', updatedAt: '2026-03-01T00:00:00Z' },
    ]);
  });
});

describe('規則2・規則3: 読み替えの適用条件と、読み替えた行が名乗る時刻', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createForeignKeyDb();
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-b', 'tenant-1', 'k1', '2026-02-01T00:00:00Z')`
    ).run();
    // 「p-a は p-b へ、2026-02-01（勝者 p-b の版）に畳まれた」
    applyInsert(
      db,
      'parents',
      'id',
      {
        id: 'p-a',
        tenantId: 'tenant-1',
        ukey: 'k1',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      PARENT_COLUMNS
    );
  });

  afterEach(() => {
    db.close();
  });

  it('敗者行が記録より新しく復活していれば読み替えない', () => {
    // 敗者idの行が、畳みより後の版で戻ってきた（ユニークキーはもう衝突しない）
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-a', 'tenant-1', 'k9', '2026-03-01T00:00:00Z')`
    ).run();

    const result = applyInsert(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-02T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    // 畳みはもう古い判断なので、子は p-a を指したまま入る
    expect(kidsOf(db, 'kids_cascade')).toEqual([
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-02T00:00:00Z' },
    ]);
  });

  it('敗者行が記録より古ければ読み替える', () => {
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-a', 'tenant-1', 'k9', '2026-01-15T00:00:00Z')`
    ).run();

    applyInsert(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-03-02T00:00:00Z' },
      KID_COLUMNS
    );

    expect(kidsOf(db, 'kids_cascade')).toEqual([
      { id: 'kid-1', parentId: 'p-b', updatedAt: '2026-03-02T00:00:00Z' },
    ]);
  });

  it('読み替えても、行の時刻には触らない', () => {
    // 書き換わるのは外部キーの列だけで、他の列は元の書き手のもの。行全体で畳みの時刻を
    // 名乗ると、外部キー以外の列について過大に申告することになり、その分だけ
    // 「元の時刻〜畳みの時刻」の窓に入る**他端末の本物の編集を殺す**（実測）。
    const result = applyInsert(
      db,
      'kids_cascade',
      'id',
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-01-20T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('inserted');
    expect(kidsOf(db, 'kids_cascade')).toEqual([
      // 親は畳み先へ向き直るが、時刻はこの行自身の版のまま
      { id: 'kid-1', parentId: 'p-b', updatedAt: '2026-01-20T00:00:00Z' },
    ]);
  });

  it('LWWで負けた行は名乗らない（古いリモートが新しいローカルを上書きしない）', () => {
    // **名乗りを勝負の前に当ててはいけない。** 届いた行の時刻は呼び出し元が
    // ローカル行と比べる材料そのもので、そこを畳みの時刻へ水増しすると、
    // 負けるはずの古い版が新しいローカルの編集を黙って上書きする。
    db.prepare(
      `INSERT INTO kids_cascade (id, parentId, updatedAt)
       VALUES ('kid-1', 'p-b', '2026-03-01T00:00:00Z')`
    ).run();

    const result = applyUpdate(
      db,
      'kids_cascade',
      'id',
      // 畳みの時刻（2026-02-01）より古い、1月の版が届く
      { id: 'kid-1', parentId: 'p-a', updatedAt: '2026-01-01T00:00:00Z' },
      KID_COLUMNS
    );

    expect(result.action).toBe('skipped');
    expect(kidsOf(db, 'kids_cascade')).toEqual([
      { id: 'kid-1', parentId: 'p-b', updatedAt: '2026-03-01T00:00:00Z' },
    ]);
  });

  it('席を別の行と争っているときは名乗らない（借りた時刻で勝つと収束しない）', () => {
    // 子にもユニークキーがある形。届いた子を読み替えると、ローカルの**別の行**と
    // 同じ席（同じユニークキー）を争うことになる。
    //
    // ここで親の畳みの時刻を借りて勝たせると、同じ付け替えを手元で行った端末
    // （そちらは行の時刻を触らない）と食い違い、互いに逆向きの畳みを記録して
    // 永久に入れ替わり続ける（実測。`secondary-unique-fold.test.ts` の
    // 「ユニーク衝突で付け替える側が負けた場合…」がその形）。
    db.exec(`
      CREATE TABLE scores (
        id        TEXT PRIMARY KEY,
        parentId  TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        regionId  TEXT NOT NULL,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (parentId, regionId)
      )
    `);
    setupChangelog(db, [...FK_TABLES, { name: 'scores' }], 'id');
    db.prepare(
      `INSERT INTO scores (id, parentId, regionId, body, updatedAt)
       VALUES ('s-b', 'p-b', 'region-1', '新しい方', '2026-02-01T00:00:00Z')`
    ).run();

    // 届いた s-a は本来 2026-01-05（席の相手 s-b より古い）
    applyInsert(
      db,
      'scores',
      'id',
      {
        id: 's-a',
        parentId: 'p-a',
        regionId: 'region-1',
        body: '古い方',
        updatedAt: '2026-01-05T00:00:00Z',
      },
      ['id', 'parentId', 'regionId', 'body', 'updatedAt']
    );

    // 借りた時刻（2026-02-01）で同点にして辞書順で勝つ、が起きていないこと
    expect(
      db.prepare(`SELECT id, body FROM scores ORDER BY id`).all()
    ).toEqual([{ id: 's-b', body: '新しい方' }]);
  });
});

/**
 * 同一主キーへの上書きが、ローカルの**別の行**のユニークにぶつかったときに刻む時刻。
 *
 * 改名で起こる形（2つの端末が独立に同じ名前へ辿り着く）。どちらが負けても行が1つ消える。
 */
describe('上書きが別の行のユニークにぶつかったときに刻む時刻', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createForeignKeyDb();
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-x', 'tenant-1', 'k1', '2026-02-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO parents (id, tenantId, ukey, updatedAt)
       VALUES ('p-y', 'tenant-1', 'k2', '2026-01-01T00:00:00Z')`
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  function tombstoneOf(
    recordId: string
  ): { deletedAt: string; mergedInto: string | null } | undefined {
    return db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'parents' AND recordId = ?`
      )
      .get(recordId) as
      | { deletedAt: string; mergedInto: string | null }
      | undefined;
  }

  it('届いた版が勝つ場合、その版の時刻を刻む', () => {
    // p-y が k1 へ改名して届いた。ローカルの p-x（k1）より新しい
    const result = applyUpdate(
      db,
      'parents',
      'id',
      {
        id: 'p-y',
        tenantId: 'tenant-1',
        ukey: 'k1',
        updatedAt: '2026-03-01T00:00:00Z',
      },
      PARENT_COLUMNS
    );

    expect(result.action).toBe('updated');
    expect(db.prepare(`SELECT id, ukey FROM parents`).all()).toEqual([
      { id: 'p-y', ukey: 'k1' },
    ]);
    expect(tombstoneOf('p-x')).toEqual({
      deletedAt: '2026-03-01T00:00:00Z',
      mergedInto: 'p-y',
    });
  });

  it('ローカル行が勝つ場合、そのローカル行の時刻を刻む', () => {
    // p-y が k1 へ改名して届いたが、ローカルの p-x（k1, 2026-02-01）の方が新しい。
    // 届いた版は採らないが、更新対象の p-y の方を p-x へ畳む（黙って捨てない）
    const result = applyUpdate(
      db,
      'parents',
      'id',
      {
        id: 'p-y',
        tenantId: 'tenant-1',
        ukey: 'k1',
        updatedAt: '2026-01-15T00:00:00Z',
      },
      PARENT_COLUMNS
    );

    expect(result.action).toBe('skipped');
    expect(db.prepare(`SELECT id, ukey FROM parents`).all()).toEqual([
      { id: 'p-x', ukey: 'k1' },
    ]);
    expect(tombstoneOf('p-y')).toEqual({
      deletedAt: '2026-02-01T00:00:00Z',
      mergedInto: 'p-x',
    });
  });
});

/**
 * 子どうしの畳み（{@link repointChild}）が刻む時刻。
 *
 * ここは**親の時刻列の名前をそのまま子へ持ち込むと壊れる**場所。親の列名で子の行を
 * 引くと値が取れず、記録は黙って現在時刻に落ちる（＝畳みではなく「今消した」と
 * 主張してしまう）。親は `modifiedAt`、子はライブラリ既定の `updatedAt` にしてある。
 */
describe('子どうしの畳みが刻む時刻（親と子で時刻列の名前が違う場合）', () => {
  const PARENT_ONLY_COLUMNS = ['id', 'modifiedAt'];
  let db: Database.Database;

  function createRepointDb(): Database.Database {
    const created = new Database(':memory:');
    created.exec(`
      CREATE TABLE parents (
        id         TEXT PRIMARY KEY,
        modifiedAt TEXT NOT NULL
      );
      CREATE TABLE scores (
        id        TEXT PRIMARY KEY,
        parentId  TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        regionId  TEXT NOT NULL,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (parentId, regionId)
      );
      CREATE TABLE details (
        id        TEXT PRIMARY KEY REFERENCES parents(id) ON DELETE CASCADE,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE detail_notes (
        id        TEXT PRIMARY KEY,
        detailId  TEXT NOT NULL REFERENCES details(id) ON UPDATE CASCADE ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      );
    `);
    setupChangelog(
      created,
      [
        { name: 'parents', timestampColumn: 'modifiedAt' },
        { name: 'scores' },
        { name: 'details' },
        { name: 'detail_notes' },
      ],
      'id'
    );
    return created;
  }

  /** 「p-a は p-b へ、2026-02-01 に畳まれた」を他端末から受け取った形 */
  function foldParents(): void {
    applyMergedDelete(
      db,
      'parents',
      'id',
      'p-a',
      'p-b',
      undefined,
      PARENT_ONLY_COLUMNS,
      'modifiedAt',
      '2026-02-01T00:00:00Z'
    );
  }

  function tombstoneOf(
    tableName: string,
    recordId: string
  ): { deletedAt: string; mergedInto: string | null } | undefined {
    return db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = ? AND recordId = ?`
      )
      .get(tableName, recordId) as
      | { deletedAt: string; mergedInto: string | null }
      | undefined;
  }

  beforeEach(() => {
    db = createRepointDb();
    db.prepare(
      `INSERT INTO parents (id, modifiedAt) VALUES ('p-a', '2026-01-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO parents (id, modifiedAt) VALUES ('p-b', '2026-02-01T00:00:00Z')`
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('付け替える子が負ける場合、勝ち残った子の時刻を刻む', () => {
    db.prepare(
      `INSERT INTO scores VALUES ('s-a', 'p-a', 'region-1', '古い方', '2026-01-05T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO scores VALUES ('s-b', 'p-b', 'region-1', '新しい方', '2026-03-01T00:00:00Z')`
    ).run();

    foldParents();

    expect(db.prepare(`SELECT id, body FROM scores`).all()).toEqual([
      { id: 's-b', body: '新しい方' },
    ]);
    expect(tombstoneOf('scores', 's-a')).toEqual({
      deletedAt: '2026-03-01T00:00:00Z',
      mergedInto: 's-b',
    });
  });

  it('付け替える子が勝つ場合、その子の時刻を刻む', () => {
    db.prepare(
      `INSERT INTO scores VALUES ('s-a', 'p-a', 'region-1', '新しい方', '2026-03-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO scores VALUES ('s-b', 'p-b', 'region-1', '古い方', '2026-01-05T00:00:00Z')`
    ).run();

    foldParents();

    expect(db.prepare(`SELECT id, body FROM scores`).all()).toEqual([
      { id: 's-a', body: '新しい方' },
    ]);
    expect(tombstoneOf('scores', 's-b')).toEqual({
      deletedAt: '2026-03-01T00:00:00Z',
      mergedInto: 's-a',
    });
  });

  it('外部キーが子の主キーを兼ねる1:1で、席が埋まっている場合', () => {
    db.prepare(
      `INSERT INTO details VALUES ('p-a', '動かす側', '2026-03-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO details VALUES ('p-b', '席の主', '2026-01-05T00:00:00Z')`
    ).run();

    foldParents();

    // 席は1つしか無いので、残るのは席の行1つ。勝敗が決めるのは中身
    expect(db.prepare(`SELECT id, body FROM details`).all()).toEqual([
      { id: 'p-b', body: '動かす側' },
    ]);
    expect(tombstoneOf('details', 'p-a')).toEqual({
      deletedAt: '2026-03-01T00:00:00Z',
      mergedInto: 'p-b',
    });
  });

  it('外部キーが子の主キーを兼ねる1:1で、席が空いている場合（idが動くだけ）', () => {
    db.prepare(
      `INSERT INTO details VALUES ('p-a', '動かす側', '2026-03-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO detail_notes VALUES ('note-1', 'p-a', '2026-03-01T00:00:00Z')`
    ).run();

    foldParents();

    expect(db.prepare(`SELECT id, body FROM details`).all()).toEqual([
      { id: 'p-b', body: '動かす側' },
    ]);
    // 行が消えたのではなく1行のidが動いただけだが、古いidはもうどこにも無いので
    // 「古いid → 新しいid」として記録される。刻む時刻は動いた先の行の版
    expect(tombstoneOf('details', 'p-a')).toEqual({
      deletedAt: '2026-03-01T00:00:00Z',
      mergedInto: 'p-b',
    });
    // 孫（`ON UPDATE CASCADE` 付き）は新しいidを指したまま生き残る
    expect(
      db.prepare(`SELECT id, detailId FROM detail_notes`).all()
    ).toEqual([{ id: 'note-1', detailId: 'p-b' }]);
  });
});

describe('畳み先の鎖を張り替えるとき', () => {
  it('張り替えても、その記録が確定した時刻は巻き戻らない', () => {
    // `A→B` のあとに `B→C` が来たら記録は `A→C` へ張り替える（参照を1段で解くため）。
    // **張り替えても「A が畳まれた時刻」は変わらない。** 新しい畳みの時刻をそのまま
    // 置くと、それが古いときに既存の記録が過去へ引き戻され、`isFoldRecordStale` の
    // 判定が変わる。遅い方を採る。
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE n (
        id TEXT PRIMARY KEY, ukey TEXT NOT NULL UNIQUE, updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, [{ name: 'n' }], 'id');
    const columns = ['id', 'ukey', 'updatedAt'];

    // ローカルの B（2026-06-01）が勝ち、届いた A は B へ畳まれる
    db.prepare(`INSERT INTO n VALUES ('B', 'k1', '2026-06-01T00:00:00Z')`).run();
    applyInsert(
      db,
      'n',
      'id',
      { id: 'A', ukey: 'k1', updatedAt: '2000-01-01T00:00:00Z' },
      columns
    );

    // B はこの端末では既に消えており、よそで 2026-01-01 に決まった畳み B→C が届く
    db.prepare(`DELETE FROM n WHERE id = 'B'`).run();
    applyMergedDelete(
      db,
      'n',
      'id',
      'B',
      'C',
      undefined,
      columns,
      'updatedAt',
      '2026-01-01T00:00:00Z'
    );

    expect(
      db
        .prepare(`SELECT losingId, winningId, mergedAt FROM _id_merge ORDER BY losingId`)
        .all()
    ).toEqual([
      // 張り替えられたが、A が畳まれた時刻（6月）は動かない
      { losingId: 'A', winningId: 'C', mergedAt: '2026-06-01T00:00:00Z' },
      // 新しい主張はその畳みの時刻をそのまま持つ
      { losingId: 'B', winningId: 'C', mergedAt: '2026-01-01T00:00:00Z' },
    ]);

    db.close();
  });
});

describe('あとから届いた畳みの勝者が、既に畳まれているとき', () => {
  it('終端まで辿ってから記録する（鎖を作らない）', () => {
    // 張り替えが直せるのは「**いまの敗者**を勝者として持つ既存の記録」だけ。
    // あとから届いた記録の**勝者**が既に畳まれている場合は直せないので、書く前に
    // 終端まで辿る。鎖のまま残すと読み替えが1段で終わらず、実測では、その状態で
    // 届いた子が**既に消えている中間の行へ向けられ、`ON DELETE` に従って捨てられた**。
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE n (id TEXT PRIMARY KEY, ukey TEXT NOT NULL UNIQUE, updatedAt TEXT NOT NULL)`
    );
    setupChangelog(db, [{ name: 'n' }], 'id');
    const columns = ['id', 'ukey', 'updatedAt'];

    // 先に C→B が届く
    applyMergedDelete(
      db, 'n', 'id', 'C', 'B', undefined, columns, 'updatedAt',
      '2026-06-01T00:00:00Z'
    );
    // あとから A→C が届く（勝者 C は既に B へ畳まれている）
    applyMergedDelete(
      db, 'n', 'id', 'A', 'C', undefined, columns, 'updatedAt',
      '2026-03-01T00:00:00Z'
    );

    expect(
      db
        .prepare(`SELECT losingId, winningId, mergedAt FROM _id_merge ORDER BY losingId`)
        .all()
    ).toEqual([
      // 鎖 A→C→B ではなく、終端の B を直接指す。A が畳まれた時刻は動かない
      { losingId: 'A', winningId: 'B', mergedAt: '2026-03-01T00:00:00Z' },
      { losingId: 'C', winningId: 'B', mergedAt: '2026-06-01T00:00:00Z' },
    ]);

    db.close();
  });
});

describe('膠着の報告', () => {
  it('差のある列が多いときは、先頭だけ挙げて残りは数で畳む', () => {
    // 全部並べると読めない（実測: 40列で844文字）。人が最初に見るのは
    // 「どの行か」と「どのあたりが違うか」。
    const db = new Database(':memory:');
    const columns = Array.from({ length: 40 }, (_, index) => `col${index}`);
    db.exec(
      `CREATE TABLE wide (id TEXT PRIMARY KEY, ${columns
        .map((column) => `${column} TEXT`)
        .join(', ')}, updatedAt TEXT NOT NULL)`
    );
    setupChangelog(db, [{ name: 'wide' }], 'id');

    const all = ['id', ...columns, 'updatedAt'];
    const local: Record<string, unknown> = {
      id: 'r1',
      updatedAt: '2026-05-01T00:00:00Z',
    };
    const remote: Record<string, unknown> = {
      id: 'r1',
      updatedAt: '2026-05-01T00:00:00Z',
    };
    for (const column of columns) {
      local[column] = 'ローカル';
      remote[column] = 'リモート';
    }
    db.prepare(
      `INSERT INTO wide (${all.map((c) => `"${c}"`).join(', ')})
       VALUES (${all.map(() => '?').join(', ')})`
    ).run(...all.map((column) => local[column]));

    const result = applyInsert(db, 'wide', 'id', remote, all);

    expect(result.warnings).toEqual([
      'Stalemate on wide:r1: both sides are at 2026-05-01T00:00:00Z ' +
        'but col0, col1, col2, col3, col4 and 35 more differ, so neither can win. ' +
        'Edit the row on one side to break the tie.',
    ]);
    db.close();
  });
});

describe('旧バージョンが残した畳み先の鎖', () => {
  /** 鎖の入った `_id_merge` を持つDBを作る（書き込み側が終端解決する前の形）。 */
  function createChainedDb(chain: [string, string, string][]): Database.Database {
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE n (id TEXT PRIMARY KEY, ukey TEXT NOT NULL UNIQUE, updatedAt TEXT NOT NULL)`
    );
    setupChangelog(db, [{ name: 'n' }], 'id');
    const insert = db.prepare(
      `INSERT INTO _id_merge (tableName, losingId, winningId, mergedAt) VALUES ('n', ?, ?, ?)`
    );
    for (const [losingId, winningId, mergedAt] of chain) {
      insert.run(losingId, winningId, mergedAt);
    }
    return db;
  }
  const mergesOf = (db: Database.Database): unknown[] =>
    db
      .prepare(`SELECT losingId, winningId, mergedAt FROM _id_merge ORDER BY losingId`)
      .all();

  it('起動時に終端まで畳まれ、記録の時刻は動かない', () => {
    const db = createChainedDb([
      ['A', 'C', '2026-03-01T00:00:00Z'],
      ['C', 'B', '2026-06-01T00:00:00Z'],
    ]);

    // 起動時（`setupChangelog`）に畳まれる
    setupChangelog(db, [{ name: 'n' }], 'id');

    expect(mergesOf(db)).toEqual([
      // 終端の B を直接指す。A が畳まれた時刻は動かさない
      { losingId: 'A', winningId: 'B', mergedAt: '2026-03-01T00:00:00Z' },
      { losingId: 'C', winningId: 'B', mergedAt: '2026-06-01T00:00:00Z' },
    ]);
    db.close();
  });

  it('記録に循環があっても止まらない', () => {
    const db = createChainedDb([
      ['A', 'B', '2026-01-01T00:00:00Z'],
      ['B', 'A', '2026-02-01T00:00:00Z'],
    ]);

    setupChangelog(db, [{ name: 'n' }], 'id');

    // 矛盾した記録なので、いちばん新しい主張だけを残す
    expect(mergesOf(db)).toEqual([
      { losingId: 'B', winningId: 'A', mergedAt: '2026-02-01T00:00:00Z' },
    ]);
    db.close();
  });

  it('何度走らせても結果が変わらない', () => {
    const db = createChainedDb([
      ['A', 'C', '2026-03-01T00:00:00Z'],
      ['C', 'D', '2026-04-01T00:00:00Z'],
      ['D', 'B', '2026-06-01T00:00:00Z'],
    ]);

    setupChangelog(db, [{ name: 'n' }], 'id');
    const once = mergesOf(db);
    setupChangelog(db, [{ name: 'n' }], 'id');
    setupChangelog(db, [{ name: 'n' }], 'id');

    expect(mergesOf(db)).toEqual(once);
    expect(once).toEqual([
      { losingId: 'A', winningId: 'B', mergedAt: '2026-03-01T00:00:00Z' },
      { losingId: 'C', winningId: 'B', mergedAt: '2026-04-01T00:00:00Z' },
      { losingId: 'D', winningId: 'B', mergedAt: '2026-06-01T00:00:00Z' },
    ]);
    db.close();
  });

  it('届いた畳み先が既に畳まれていても、敗者行を終端へ畳める', () => {
    // `_tombstone.mergedInto` は同期で渡るので `A→C` と `C→B` の鎖がそのまま届く（実測）。
    // 中間の C は既に死んでいるため、そのまま使うと畳み先が見つからず敗者行が残る。
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE n (id TEXT PRIMARY KEY, ukey TEXT NOT NULL UNIQUE, updatedAt TEXT NOT NULL);
      CREATE TABLE m (id TEXT PRIMARY KEY, parentId TEXT NOT NULL REFERENCES n(id) ON DELETE CASCADE, updatedAt TEXT NOT NULL);
    `);
    setupChangelog(db, [{ name: 'n' }, { name: 'm' }], 'id');
    const columns = ['id', 'ukey', 'updatedAt'];

    // 終端の勝者 B は生きていて、中間 C は B へ畳まれて消えている
    db.prepare(`INSERT INTO n VALUES ('B', 'k1', '2026-06-01T00:00:00Z')`).run();
    applyInsert(
      db, 'n', 'id',
      { id: 'C', ukey: 'k1', updatedAt: '2026-03-01T00:00:00Z' },
      columns
    );
    // 敗者 A とその子はローカルに在る
    db.prepare(`INSERT INTO n VALUES ('A', 'k9', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO m VALUES ('kid-1', 'A', '2026-01-02T00:00:00Z')`).run();

    // 届いた畳み先は中間の C
    const { action } = applyMergedDelete(
      db, 'n', 'id', 'A', 'C', undefined, columns, 'updatedAt',
      '2026-02-01T00:00:00Z'
    );

    expect(action).toBe('folded');
    expect(db.prepare(`SELECT id FROM n ORDER BY id`).all()).toEqual([{ id: 'B' }]);
    // 子は中間ではなく終端へ付け替わる
    expect(db.prepare(`SELECT id, parentId FROM m`).all()).toEqual([
      { id: 'kid-1', parentId: 'B' },
    ]);
    db.close();
  });
});

describe('端末をまたいだ動き', () => {
  const testDir = path.join(__dirname, 'test-data-fold-record-lww');
  const nasDir = path.join(testDir, 'nas');

  const TABLES: TableConfig[] = [
    { name: 'exam_students' },
    { name: 'question_scores' },
    { name: 'memos' },
  ];

  function createClientDb(clientId: string): {
    db: Database.Database;
    dbPath: string;
  } {
    const clientDir = path.join(testDir, clientId);
    fs.mkdirSync(clientDir, { recursive: true });
    const dbPath = path.join(clientDir, 'local.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE exam_students (
        id        TEXT PRIMARY KEY,
        examId    TEXT NOT NULL,
        studentId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (examId, studentId)
      );
      CREATE TABLE question_scores (
        id            TEXT PRIMARY KEY,
        examStudentId TEXT NOT NULL REFERENCES exam_students(id) ON DELETE CASCADE,
        regionId      TEXT NOT NULL,
        score         TEXT NOT NULL,
        updatedAt     TEXT NOT NULL,
        UNIQUE (examStudentId, regionId)
      );
      CREATE TABLE memos (
        id        TEXT PRIMARY KEY,
        body      TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
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

  function idsOf(db: Database.Database, sql: string): string[] {
    return (db.prepare(sql).all() as { id: string }[]).map((row) => row.id);
  }

  function foreignKeyWarnings(warnings: string[]): string[] {
    return warnings.filter((warning) => warning.includes('FOREIGN KEY'));
  }

  beforeEach(() => {
    fs.mkdirSync(nasDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  /**
   * 「畳み先が消えたあとに、敗者の子が届く」形へ通常操作だけで到達する。
   *
   * 1. A が生徒を作って共有する
   * 2. B が独立に同じ生徒を作り、同期する（B が勝ち、A の行は B の行へ畳まれる）
   * 3. B がその生徒を消す（利用者操作。畳み先が世界から消える）
   * 4. A はそれを知らないまま、自分の（畳まれる運命の）生徒に採点を付ける
   */
  async function reachChildOfDeletedFoldTarget(): Promise<{
    dbA: Database.Database;
    pathA: string;
    dbB: Database.Database;
    pathB: string;
  }> {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    dbB.prepare(`DELETE FROM exam_students WHERE id = 'es-b'`).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES ('qs-a', 'es-a', 'region-1', '5', '2026-03-01T00:00:00Z')`
    ).run();

    return { dbA, pathA, dbB, pathB };
  }

  it('読み替え先が消えた子が届いても、同期が止まらない（2端末）', async () => {
    const { dbA, pathA, dbB, pathB } = await reachChildOfDeletedFoldTarget();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // 読み替え先（es-b）は消えている。CASCADE なので子は採らない — が、**黙っては捨てない**
    expect(foreignKeyWarnings(pull.warnings)).toEqual([]);
    expect(
      pull.warnings.filter((warning) => warning.startsWith('Dropped'))
    ).toEqual([
      'Dropped question_scores:qs-a: parent exam_students:es-b is gone (ON DELETE CASCADE)',
    ]);
    expect(idsOf(dbB, `SELECT id FROM question_scores`)).toEqual([]);

    // 取り込みが巻き戻っていないこと（巻き戻ると lastSeenId が進まず、
    // この相手からのデータが以後ずっと届かない）を、無関係な行で確かめる
    dbA.prepare(
      `INSERT INTO memos (id, body, updatedAt) VALUES ('memo-1', '後続', '2026-04-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    expect(idsOf(dbB, `SELECT id FROM memos`)).toEqual(['memo-1']);

    dbA.close();
    dbB.close();
  });

  it('フルマージ経路（changelogギャップ）でも同じように扱う', async () => {
    const { dbA, pathA, dbB, pathB } = await reachChildOfDeletedFoldTarget();

    // A の changelog が保持期間を過ぎて消えた形にする（B から見るとギャップ）
    dbA.exec(`DELETE FROM _changelog`);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const fullMerge = await performSync(
      dbB,
      makeConfig(pathB, 'client-b'),
      TABLES
    );

    expect(fullMerge.hadChangelogGap).toBe(true);
    expect(foreignKeyWarnings(fullMerge.warnings)).toEqual([]);
    expect(
      fullMerge.warnings.filter((warning) => warning.startsWith('Dropped'))
    ).toEqual([
      'Dropped question_scores:qs-a: parent exam_students:es-b is gone (ON DELETE CASCADE)',
    ]);
    expect(idsOf(dbB, `SELECT id FROM question_scores`)).toEqual([]);

    dbA.close();
    dbB.close();
  });

  it('3端末目が遅れて参加しても、外部キー違反で取り込みが巻き戻らない', async () => {
    const { dbA, pathA, dbB, pathB } = await reachChildOfDeletedFoldTarget();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // C はここまで一度も参加していない。全員ぶんをまとめて受け取る
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');

    for (let round = 0; round < 3; round++) {
      const pull = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      expect(foreignKeyWarnings(pull.warnings)).toEqual([]);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    // 畳みを実際に適用した端末には、引き取り先の無い子は残らない
    expect(idsOf(dbB, `SELECT id FROM question_scores`)).toEqual([]);

    // **この形は全端末では揃わない。** 畳み先（es-b）が世界から消えているため、
    // 敗者行 es-a を持っている端末はそれを消せず（消すと子が道連れになる）、
    // es-a とその子を持ったまま残る。畳みの記録の時刻とは別の既知の食い違いで、
    // 規則1〜5 では直らない（README「直っていないこと」）。ここでは固定しない。

    // C の取り込みが巻き戻っていないこと（巻き戻ると以後ずっと届かない）
    dbB.prepare(
      `INSERT INTO memos (id, body, updatedAt) VALUES ('memo-1', '後続', '2026-05-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    expect(idsOf(dbC, `SELECT id FROM memos`)).toEqual(['memo-1']);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('同期経路でも、取り込み元に無い畳み先は「消えた」と判定される', async () => {
    // `makeResurrectionProbe` が同期経路で実際に働くことを見る。畳みの記録を持つ端末へ
    // 遅れて子が届き、畳み先は取り込み元にも無い —— このとき `ON DELETE` に従う。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // C は畳みの前に一度だけ同期する（以後はギャップ経路でしか受け取らない）
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

    // B が独立に同じ受験者を作り、畳みを記録してから削除する
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    dbB.prepare(`DELETE FROM exam_students WHERE id = 'es-b'`).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    // A は畳み先を見つけられず、敗者行を持ったまま残る
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // C はギャップ経路で全体を取り込み、畳みの記録を得る
    dbA.exec(`DELETE FROM _changelog`);
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    expect(
      dbC.prepare(`SELECT losingId, winningId FROM _id_merge`).all()
    ).toEqual([{ losingId: 'es-a', winningId: 'es-b' }]);

    // A が遅れて敗者行の子を作る。取り込み元 A にも畳み先 es-b は無い
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES ('qs-late', 'es-a', 'region-1', '5', '2026-07-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);

    expect(foreignKeyWarnings(pull.warnings)).toEqual([]);
    expect(
      pull.warnings.filter((warning) => warning.startsWith('Dropped'))
    ).toEqual([
      'Dropped question_scores:qs-late: parent exam_students:es-b is gone (ON DELETE CASCADE)',
    ]);
    expect(idsOf(dbC, `SELECT id FROM question_scores`)).toEqual([]);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('読み替えた行の時刻を進めないので、窓の中の他端末の編集が生き残る', async () => {
    // 読み替えで書き換わるのは外部キーの列だけ。行全体で畳みの時刻を名乗ると、
    // 「元の時刻〜畳みの時刻」の窓に入る他端末の編集が、内容の古い行に負けて消える。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    dbA.prepare(
      `INSERT INTO question_scores (id, examStudentId, regionId, score, updatedAt)
       VALUES ('qs-a', 'es-a', 'region-1', '5', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // C が A の採点を受け取り、窓の中（3月）で直す
    const { db: dbC, dbPath: pathC } = createClientDb('client-c');
    await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
    dbC.prepare(
      `UPDATE question_scores SET score = '8', updatedAt = '2026-03-01T00:00:00Z'
       WHERE id = 'qs-a'`
    ).run();

    // B が独立に同じ受験者を作る（6月）→ 畳みが起き、A の 2月版が読み替えられる
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-06-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    for (let round = 0; round < 3; round++) {
      await performSync(dbC, makeConfig(pathC, 'client-c'), TABLES);
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    // 窓の中（2/1 〜 6/1）の編集が全端末で残り、揃うこと
    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
      ['C', dbC],
    ] as const) {
      expect(
        db.prepare(`SELECT id, score FROM question_scores`).all(),
        `client-${label}`
      ).toEqual([{ id: 'qs-a', score: '8' }]);
    }

    dbA.close();
    dbB.close();
    dbC.close();
  });

  it('解けない食い違い（同一主キー・同時刻・中身が違う）は報告される', async () => {
    // 同一主キーのLWWは「厳密に新しい」ものしか採らないので、両端末が同じ時刻で
    // 違う中身を持つと互いに拒み続けて動かない。**ライブラリは解かない。報告する。**
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');

    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-1', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // 同じ行を、両端末が**まったく同じ時刻**で別々の中身へ更新する
    dbA.prepare(
      `UPDATE exam_students SET studentId = 'student-A', updatedAt = '2026-05-01T00:00:00Z'
       WHERE id = 'es-1'`
    ).run();
    dbB.prepare(
      `UPDATE exam_students SET studentId = 'student-B', updatedAt = '2026-05-01T00:00:00Z'
       WHERE id = 'es-1'`
    ).run();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // 解けていない（B は自分の版のまま）
    expect(
      dbB.prepare(`SELECT studentId FROM exam_students WHERE id = 'es-1'`).get()
    ).toEqual({ studentId: 'student-B' });
    // だが黙ってはいない
    expect(
      pull.warnings.filter((warning) => warning.startsWith('Stalemate'))
    ).toEqual([
      'Stalemate on exam_students:es-1: both sides are at 2026-05-01T00:00:00Z ' +
        'but studentId differ, so neither can win. Edit the row on one side to break the tie.',
    ]);

    dbA.close();
    dbB.close();
  });

  it('膠着は INSERT の経路でも報告される', async () => {
    // 同じ id の行を、両端末が同じ時刻で別々に作る（changelog は INSERT になる）。
    // `applyUpdate` だけでなく `applyInsert` の同一主キー経路でも報告すること。
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-1', 'exam-1', 'student-A', '2026-05-01T00:00:00Z')`
    ).run();
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-1', 'exam-1', 'student-B', '2026-05-01T00:00:00Z')`
    ).run();

    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
    const pull = await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    expect(
      pull.warnings.filter((warning) => warning.startsWith('Stalemate'))
    ).toEqual([
      'Stalemate on exam_students:es-1: both sides are at 2026-05-01T00:00:00Z ' +
        'but studentId differ, so neither can win. Edit the row on one side to break the tie.',
    ]);

    dbA.close();
    dbB.close();
  });

  it('規則4が発火する: 畳みより後に更新された敗者行は、畳みに巻き込まれない', async () => {
    const { db: dbA, dbPath: pathA } = createClientDb('client-a');
    dbA.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-a', 'exam-1', 'student-1', '2026-01-01T00:00:00Z')`
    ).run();
    await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);

    // B が独立に同じ生徒を作る。B が勝ち、es-a は es-b へ畳まれたと記録される
    const { db: dbB, dbPath: pathB } = createClientDb('client-b');
    dbB.prepare(
      `INSERT INTO exam_students (id, examId, studentId, updatedAt)
       VALUES ('es-b', 'exam-1', 'student-1', '2026-02-01T00:00:00Z')`
    ).run();
    await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);

    // A は、その畳みより後に es-a を**別の生徒**へ付け替えた。もう衝突しない
    dbA.prepare(
      `UPDATE exam_students SET studentId = 'student-2', updatedAt = '2026-03-01T00:00:00Z'
       WHERE id = 'es-a'`
    ).run();

    for (let round = 0; round < 3; round++) {
      await performSync(dbA, makeConfig(pathA, 'client-a'), TABLES);
      await performSync(dbB, makeConfig(pathB, 'client-b'), TABLES);
    }

    // 畳みは「衝突していた版」に対する判断であって、その後の版には及ばない。
    // 現在時刻を刻んでいたころは、この行は tombstone に永久に止められて
    // どちらの端末でも二度と生き返らなかった。
    for (const [label, db] of [
      ['A', dbA],
      ['B', dbB],
    ] as const) {
      expect(
        db
          .prepare(`SELECT id, studentId FROM exam_students ORDER BY id`)
          .all(),
        `client-${label}`
      ).toEqual([
        { id: 'es-a', studentId: 'student-2' },
        { id: 'es-b', studentId: 'student-1' },
      ]);
    }

    dbA.close();
    dbB.close();
  });
});
