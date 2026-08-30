/**
 * **2つの帳簿は同じことを言っていなければならない** —— `_id_merge`（ローカル索引）と
 * `_tombstone.mergedInto`（他端末へ渡る主張）の一貫性を固定する。
 *
 * 食い違うと、遅れて届いた子が片方の勝者へ読み替えられる一方、他端末にはもう片方が
 * 伝わる。その先で外部キー違反が起き、**その相手ぶんの取り込みが丸ごと巻き戻る**
 * （＝同期がその相手から永久に止まる）。どれも症状が出るのは履歴の組み合わせが
 * 揃ったときだけなので、形で固定して残す。
 *
 * 起動時の刈り取りは `fold-ledger-repair.test.ts` にある。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert, applyMergedDelete } from '../src/conflict';
import { lookupIdMerge, recordMerge } from '../src/conflict/ledger';
import { TableConfig } from '../src/types';

interface TombstoneRow {
  recordId: string;
  deletedAt: string;
  mergedInto: string | null;
}

const testDir = path.join(__dirname, 'test-data-fold-ledger');

/** ファイルDBを作る（`:memory:` ではトリガーの検証がしづらいため、実ファイルで揃える） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true });
  return new Database(path.join(testDir, `${name}.sqlite`));
}

let db: Database.Database;

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

afterEach(() => {
  if (db && db.open) db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('鎖で畳み先が動いたとき、動く前の勝者行は入れない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('ローカルに C→B があるとき、届いた A→C は C を復活させない', () => {
    db = createDb('chain');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    // ローカルは C を B へ畳み終えている（C の行はもう無い）
    db.prepare(
      `INSERT INTO items (id, name, updatedAt) VALUES ('A', 'a', '2026-01-01T00:00:00.000Z')`
    ).run();
    recordMerge(db, 'items', 'C', 'B', '2026-02-01T00:00:00.000Z');

    // 相手からは「A は C へ畳まれた」が届く。勝者行として渡されるのは C の行
    const result = applyMergedDelete(
      db,
      'items',
      'id',
      'A',
      'C',
      { id: 'C', name: 'c', updatedAt: '2026-03-01T00:00:00.000Z' },
      ['id', 'name', 'updatedAt'],
      'updatedAt',
      '2026-03-01T00:00:00.000Z'
    );

    // 終端は B。B の行を持っていないので畳めない ＝ 何もしないのが正しい
    expect(result.action).toBe('skipped');
    // **既に畳んで消したはずの C が復活していないこと**
    const rows = db
      .prepare(`SELECT id FROM items ORDER BY id`)
      .all() as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(['A']);
    // **帳簿にも何も書かない。** 畳めなかったのに `A→B` を載せると、A の行は
    // 生きたまま「畳まれた」と記録され（`_tombstone.mergedInto` は同期で他端末へ
    // 伝わる）、遅れて届いた A の子だけが手元に無い B へ読み替えられる。
    // `applyTombstones` はリモートの `_tombstone` を毎回**全件**読み直すので、
    // B の行が届いた次の同期で同じ畳みがやり直される。
    expect(lookupIdMerge(db, 'items', 'A')).toBeNull();
    const tombstoneA = db
      .prepare(
        `SELECT mergedInto FROM _tombstone WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as { mergedInto: string | null } | undefined;
    expect(tombstoneA?.mergedInto ?? null).toBeNull();
  });
});

describe('受け取った判断の時刻を、勝者行の現在の時刻で置き換えない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('勝者行を持たない端末が、届いた deletedAt をそのまま刻む', () => {
    db = createDb('folded-at');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    // 敗者 A はローカルに在り、勝者 B は無い（＝渡された勝者行で入れ替える経路）
    db.prepare(
      `INSERT INTO items (id, name, updatedAt) VALUES ('A', 'a', '2025-12-01T00:00:00.000Z')`
    ).run();

    // 畳みが決まったのは T1。勝者 B はそのあと T5 まで編集されている
    const decidedAt = '2026-01-01T00:00:00.000Z';
    const result = applyMergedDelete(
      db,
      'items',
      'id',
      'A',
      'B',
      { id: 'B', name: 'b', updatedAt: '2026-05-01T00:00:00.000Z' },
      ['id', 'name', 'updatedAt'],
      'updatedAt',
      decidedAt
    );
    expect(result.action).toBe('folded');

    const tombstone = db
      .prepare(
        `SELECT recordId, deletedAt, mergedInto FROM _tombstone WHERE recordId = 'A'`
      )
      .get() as TombstoneRow;
    // 勝者行の T5 ではなく、判断の時刻 T1 が入っていること。
    // T5 が入ると、T1〜T5 の間に作られた A の版がこの端末でだけ黙って捨てられる
    expect(tombstone.deletedAt).toBe(decidedAt);
    expect(tombstone.mergedInto).toBe('B');
    expect(lookupIdMerge(db, 'items', 'A')?.mergedAt).toBe(decidedAt);
  });
});

describe('`_id_merge.mergedAt` は巻き戻らない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('あとから古い時刻の同じ畳みが届いても、記録は新しい方を保つ', () => {
    db = createDb('merged-at');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    recordMerge(db, 'items', 'A', 'B', '2026-05-01T00:00:00.000Z');
    recordMerge(db, 'items', 'A', 'B', '2026-01-01T00:00:00.000Z');

    // 巻き戻ると、その間に居る敗者行が「記録より新しい」と見えて読み替えが止まり、
    // 遅れて届いた子が存在しない親を指したまま入る（外部キー違反で取り込みが巻き戻る）
    expect(lookupIdMerge(db, 'items', 'A')?.mergedAt).toBe(
      '2026-05-01T00:00:00.000Z'
    );
  });

  it('書式の違う古い時刻（スペース形式）でも巻き戻らない', () => {
    db = createDb('merged-at-format');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    recordMerge(db, 'items', 'A', 'B', '2026-05-01T00:00:00.000Z');
    recordMerge(db, 'items', 'A', 'B', '2026-01-01 00:00:00');

    expect(lookupIdMerge(db, 'items', 'A')?.mergedAt).toBe(
      '2026-05-01T00:00:00.000Z'
    );
  });
});

describe('張り替えは `_id_merge.mergedAt` を進めもしない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('あとから来た新しい畳みの巻き添えで、既存の記録の時刻が動かない', () => {
    db = createDb('repoint-time');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    // A は1月に B へ畳まれ、その B が6月に C へ畳まれる（A は C へ張り替わる）
    recordMerge(db, 'items', 'A', 'B', '2026-01-01T00:00:00.000Z');
    recordMerge(db, 'items', 'B', 'C', '2026-06-01T00:00:00.000Z');

    const record = lookupIdMerge(db, 'items', 'A')!;
    expect(record.winningId).toBe('C');
    // **A が畳まれたのは1月**。向き先が変わっただけで事実の時刻は動かない
    expect(record.mergedAt).toBe('2026-01-01T00:00:00.000Z');

    // 対になる `_tombstone.deletedAt` と揃っていること。ここがずれると、3月版の A は
    // `isShadowedByTombstone`（1月より新しい）を通って復活する一方、
    // `isFoldRecordStale`（6月より古い）は畳みを有効と見て、**A が生きたまま
    // その子だけ C へ読み替えられる**
    const tombstone = db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as TombstoneRow;
    expect(tombstone.deletedAt).toBe(record.mergedAt);
    expect(tombstone.mergedInto).toBe('C');
  });
});

describe('勝者行を採れないなら、帳簿にも書かない', () => {
  const TABLES: TableConfig[] = [{ name: 'parents' }, { name: 'children' }];

  it('消えた親を指す勝者行を捨てるとき、畳みを記録しない', () => {
    db = createDb('winner-dropped');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE children (
        id        TEXT PRIMARY KEY,
        parentId  TEXT REFERENCES parents(id) ON DELETE CASCADE,
        updatedAt TEXT NOT NULL
      );
    `);
    setupChangelog(db, TABLES, 'id');

    // 親 P は Q へ畳まれ、その Q も既に消えている（＝読み替えた先が居ない）
    db.prepare(
      `INSERT INTO parents (id, updatedAt) VALUES ('Q', '2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(`DELETE FROM parents WHERE id = 'Q'`).run();
    recordMerge(db, 'parents', 'P', 'Q', '2026-01-01T00:00:00.000Z');

    // 敗者 c1 はローカルに在る（親は指していない）
    db.prepare(
      `INSERT INTO children (id, parentId, updatedAt)
       VALUES ('c1', NULL, '2026-01-01T00:00:00.000Z')`
    ).run();

    // 届いた「c1 は c2 へ畳まれた」。勝者 c2 の行は**消えた親（P→Q）を指している**
    const result = applyMergedDelete(
      db,
      'children',
      'id',
      'c1',
      'c2',
      { id: 'c2', parentId: 'P', updatedAt: '2026-02-01T00:00:00.000Z' },
      ['id', 'parentId', 'updatedAt'],
      'updatedAt',
      '2026-02-01T00:00:00.000Z'
    );

    // 勝者行を採らないと決めたので、敗者 c1 も畳まない
    expect(result.action).toBe('skipped');
    expect(result.warnings.length).toBeGreaterThan(0);
    const ids = db
      .prepare(`SELECT id FROM children ORDER BY id`)
      .all() as { id: string }[];
    expect(ids.map((row) => row.id)).toEqual(['c1']);

    // **帳簿にも書かない。** 書くと c1 は生きたまま「c2 へ畳まれた」と記録され、
    // 遅れて届いた c1 の子だけがどこにも無い c2 へ読み替えられて、COMMIT 時の
    // 外部キー検査でその相手ぶんの取り込みが丸ごと巻き戻る
    expect(lookupIdMerge(db, 'children', 'c1')).toBeNull();
    const tombstone = db
      .prepare(
        `SELECT mergedInto FROM _tombstone
         WHERE tableName = 'children' AND recordId = 'c1'`
      )
      .get() as { mergedInto: string | null } | undefined;
    expect(tombstone?.mergedInto ?? null).toBeNull();
  });
});

describe('古い主張は、どちらの帳簿にも書かない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('新しい畳みのあとに古い畳みが届いても、2つの帳簿は同じ勝者を名乗る', () => {
    db = createDb('two-ledgers');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    recordMerge(db, 'items', 'A', 'B', '2026-06-01T00:00:00.000Z');
    // 1月の主張。`_tombstone` 側は TOMBSTONE_CLAIM_WINS が断る
    recordMerge(db, 'items', 'A', 'C', '2026-01-01T00:00:00.000Z');

    const merge = lookupIdMerge(db, 'items', 'A');
    const tombstone = db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as { deletedAt: string; mergedInto: string | null };

    // **2つの帳簿が別々の勝者を名乗らないこと。**
    // `_id_merge` だけ C になると、A の遅れた子は C へ送られる一方、
    // 他端末には B と伝わり、`isFoldRecordStale` は C の主張を B の時刻で判定する
    expect(merge?.winningId).toBe('B');
    expect(tombstone.mergedInto).toBe('B');
    expect(merge?.mergedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(tombstone.deletedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('新しい畳み先が届けば、両方そろって動く', () => {
    db = createDb('two-ledgers-newer');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    recordMerge(db, 'items', 'A', 'B', '2026-01-01T00:00:00.000Z');
    recordMerge(db, 'items', 'A', 'C', '2026-06-01T00:00:00.000Z');

    const tombstone = db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as { deletedAt: string; mergedInto: string | null };
    expect(lookupIdMerge(db, 'items', 'A')?.winningId).toBe('C');
    expect(tombstone.mergedInto).toBe('C');
    expect(tombstone.deletedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('終端が動いていれば、勝者行が渡されなくても帳簿に書かない', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('鎖が動いた理由は中間の勝者が消えたことなので、勝者行は普通 undefined で来る', () => {
    db = createDb('moved-no-winner-row');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    // ローカルは B を C へ畳み終えている（B の行も C の行もここには無い）
    recordMerge(db, 'items', 'B', 'C', '2026-02-01T00:00:00.000Z');
    // 敗者 A は生きている
    db.prepare(
      `INSERT INTO items (id, updatedAt) VALUES ('A', '2025-12-01T00:00:00.000Z')`
    ).run();

    // 届いた「A は B へ畳まれた」。B の行は取り込み元にもう無いので undefined
    const result = applyMergedDelete(
      db,
      'items',
      'id',
      'A',
      'B',
      undefined,
      ['id', 'updatedAt'],
      'updatedAt',
      '2026-03-01T00:00:00.000Z'
    );

    expect(result.action).toBe('skipped');
    // **黙って落とさない**（分岐に気づけるように伝える）
    expect(result.warnings.length).toBeGreaterThan(0);

    // A は生きている。その A を「畳まれた」と記録してはいけない —— 記録すると
    // `_tombstone.mergedInto` として他端末へ渡り、**向こうの生きている A が消される**
    const alive = db.prepare(`SELECT id FROM items WHERE id = 'A'`).get();
    expect(alive).toBeDefined();
    expect(lookupIdMerge(db, 'items', 'A')).toBeNull();
    const tombstone = db
      .prepare(
        `SELECT mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as { mergedInto: string | null } | undefined;
    expect(tombstone?.mergedInto ?? null).toBeNull();
  });

  it('終端が動いていなければ、今までどおり記録する', () => {
    db = createDb('not-moved-no-winner-row');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO items (id, updatedAt) VALUES ('A', '2025-12-01T00:00:00.000Z')`
    ).run();

    // 畳み先 B は単にまだ届いていないだけ（鎖は動いていない）。
    // 読み替えを覚えておかないと、あとから届く A の子が存在しない親を指す
    const result = applyMergedDelete(
      db,
      'items',
      'id',
      'A',
      'B',
      undefined,
      ['id', 'updatedAt'],
      'updatedAt',
      '2026-03-01T00:00:00.000Z'
    );

    expect(result.action).toBe('skipped');
    expect(lookupIdMerge(db, 'items', 'A')?.winningId).toBe('B');
  });
});

describe('判断は2つの帳簿の両方を見て、一度だけ下す', () => {
  const TABLES: TableConfig[] = [{ name: 'items' }];

  it('ローカルの新しい削除に、届いた古い畳みは勝てない（どちらの帳簿にも書かない）', () => {
    db = createDb('both-ledgers-gate');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    // 手元で普通に削除する。DELETEトリガが `deletedAt = 現在時刻` / `mergedInto = NULL`
    // を書く（`_id_merge` には何も入らない ＝ 片方の帳簿にだけ記録がある状態）
    db.prepare(
      `INSERT INTO items (id, updatedAt) VALUES ('A', '2020-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(`DELETE FROM items WHERE id = 'A'`).run();

    // そこへ、よそで 2020 年に決まった畳み A→C が届く
    const result = applyMergedDelete(
      db,
      'items',
      'id',
      'A',
      'C',
      undefined,
      ['id', 'updatedAt'],
      'updatedAt',
      '2020-01-01T00:00:00.000Z'
    );
    expect(result.action).toBe('skipped');

    // **2つの帳簿が別々のことを言わないこと。**
    // `_id_merge` だけが受け入れると、ローカルでは A の遅れた子が C へ読み替えられる
    // 一方、他端末には「A はただ削除された」と伝わり、向こうは生きている A を
    // 子ごと消す（`_id_merge` を見て決め、`_tombstone` を見ずに決めていた穴）
    expect(lookupIdMerge(db, 'items', 'A')).toBeNull();
    const tombstone = db
      .prepare(
        `SELECT mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as { mergedInto: string | null };
    expect(tombstone.mergedInto).toBeNull();
  });

  it('届いた畳みの方が新しければ、両方そろって受け入れる', () => {
    db = createDb('both-ledgers-gate-newer');
    db.exec(`
      CREATE TABLE items (
        id        TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL
      )
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO items (id, updatedAt) VALUES ('A', '2020-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(`DELETE FROM items WHERE id = 'A'`).run();
    // 手元の削除は「ずっと前」に起きたことにする（トリガは現在時刻を刻むため）
    db.prepare(
      `UPDATE _tombstone SET deletedAt = '2020-01-01T00:00:00.000Z'
       WHERE tableName = 'items' AND recordId = 'A'`
    ).run();

    applyMergedDelete(
      db,
      'items',
      'id',
      'A',
      'C',
      undefined,
      ['id', 'updatedAt'],
      'updatedAt',
      '2026-06-01T00:00:00.000Z'
    );

    expect(lookupIdMerge(db, 'items', 'A')?.winningId).toBe('C');
    const tombstone = db
      .prepare(
        `SELECT deletedAt, mergedInto FROM _tombstone
         WHERE tableName = 'items' AND recordId = 'A'`
      )
      .get() as { deletedAt: string; mergedInto: string | null };
    expect(tombstone.mergedInto).toBe('C');
    expect(tombstone.deletedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('自分の手で起こした移動は、古い記録に断られない', () => {
  const TABLES: TableConfig[] = [{ name: 'parents' }, { name: 'profiles' }];

  it('付け替えで子のidが動いたとき、帳簿は実体の在る方を指す', () => {
    db = createDb('moved-pk-records');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE parents (
        id        TEXT PRIMARY KEY,
        ukey      TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE profiles (
        id        TEXT PRIMARY KEY REFERENCES parents(id) ON DELETE CASCADE,
        bio       TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    setupChangelog(db, TABLES, 'id');

    db.prepare(
      `INSERT INTO parents (id, ukey, updatedAt)
       VALUES ('p1', 'k1', '2020-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO profiles (id, bio, updatedAt)
       VALUES ('p1', '自己紹介', '2020-01-01T00:00:00.000Z')`
    ).run();

    // 子テーブルに、**古くて誤った**畳みの記録が先に残っている状況を作る
    // （`applyMergedDelete` はローカルに行が無い敗者idの畳みも覚えるので、
    //  この記録は `p1` の行より長生きしうる）
    recordMerge(db, 'profiles', 'p1', 'zz', '2026-06-01T00:00:00.000Z');

    // 親 p1 が p2 へ畳まれる。子は主キーを親と共有しているので、id が p1 → p2 へ動く
    applyInsert(
      db,
      'parents',
      'id',
      { id: 'p2', ukey: 'k1', updatedAt: '2026-07-01T00:00:00.000Z' },
      ['id', 'ukey', 'updatedAt']
    );

    const profiles = db
      .prepare(`SELECT id FROM profiles ORDER BY id`)
      .all() as { id: string }[];
    expect(profiles.map((row) => row.id)).toEqual(['p2']);

    // **実体は p2 に在る。** 古い記録に断られて `p1 → zz` のままだと、帳簿は
    // 実在しない勝者を指したまま、`writeFoldDeletion` だけが p1 の DELETE を
    // 公開する（受け取った端末は p1 の子を行き先の無い zz へ読み替えて捨てる）
    expect(lookupIdMerge(db, 'profiles', 'p1')?.winningId).toBe('p2');
  });
});
