/**
 * 規則5 —— 読み替え先が消えているときは `ON DELETE` の宣言に従う、の回帰テスト。
 *
 * 遅れて届いた子の親（畳み先）が既に消えている場合、このライブラリは
 * **「その子が手元に居たら何が起きていたか」をそのまま再現する**。宣言ごとに
 * 扱いが変わるので、`CASCADE` / `SET NULL` / `SET DEFAULT` / `RESTRICT` /
 * `NO ACTION` と、複合外部キー・式の既定値まで並べて固定する。
 *
 * 残りの規則（2・3・4）は `fold-record-lww.test.ts`、規則1は
 * `fold-tombstone-time.test.ts` にある。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert, applyUpdate } from '../src/conflict';
import {
  COMPOSITE_KID_COLUMNS,
  createForeignKeyDb,
  FK_TABLES,
  foldThenDeleteWinner,
  KID_COLUMNS,
  kidsOf,
  PARENT_COLUMNS,
} from './helpers/fold-record-fixtures';

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
