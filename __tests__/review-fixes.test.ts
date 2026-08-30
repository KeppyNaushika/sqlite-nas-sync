/**
 * コードレビューで見つかった6件の回帰テスト。
 *
 * どれも「同期がその相手から永久に止まる」「書かれたデータが黙って消える」側の壊れ方で、
 * 症状が出るのは**設定や履歴の組み合わせが揃ったときだけ**なので、形を固定して残す。
 *
 * 1. 鎖を辿って畳み先が動いたのに、動く前の勝者行を入れてしまう（死んだidの復活）
 * 2. 受け取った判断の時刻を捨て、勝者行の**現在の**時刻でしきい値を作る
 * 3. `_id_merge.mergedAt` が巻き戻り、`_tombstone.deletedAt` と食い違う
 * 4. 循環へ流れ込む鎖が1回の走査では畳み切れない
 * 5. NULL を含む複合外部キーを「親が居ない」と判定して行を捨てる
 * 6. 親の表を**子の**時刻列で引き、作り直し／記録の有効性を判定し損ねる
 * 7. 張り替えで `_id_merge.mergedAt` が**進み**、`_tombstone.deletedAt` と食い違う
 * 8. 循環の刈り取りが `_tombstone.mergedInto` を置き去りにする
 * 9. 届いたリモート行を採らなかったのに `upserted` と名乗る
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert, applyMergedDelete } from '../src/conflict';
import { lookupIdMerge, recordMerge } from '../src/conflict/ledger';
import { TableConfig } from '../src/types';

const testDir = path.join(__dirname, 'test-data-review-fixes');

interface TombstoneRow {
  recordId: string;
  deletedAt: string;
  mergedInto: string | null;
}

/** ファイルDBを作る（`:memory:` ではトリガーの検証がしづらいため、実ファイルで揃える） */
function createDb(name: string): Database.Database {
  fs.mkdirSync(testDir, { recursive: true });
  return new Database(path.join(testDir, `${name}.sqlite`));
}

describe('レビュー指摘の回帰', () => {
  let db: Database.Database;

  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    if (db && db.open) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('1. 鎖で畳み先が動いたとき、動く前の勝者行は入れない', () => {
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

  describe('2. 受け取った判断の時刻を、勝者行の現在の時刻で置き換えない', () => {
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

  describe('3. `_id_merge.mergedAt` は巻き戻らない', () => {
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

  describe('4. 循環へ流れ込む鎖も、起動1回で畳み切る', () => {
    const TABLES: TableConfig[] = [{ name: 'items' }];

    it('D→A と A↔B が同居していても、D は生き残った終端を指す', () => {
      db = createDb('cycle');
      db.exec(`
        CREATE TABLE items (
          id        TEXT PRIMARY KEY,
          updatedAt TEXT NOT NULL
        )
      `);
      setupChangelog(db, TABLES, 'id');

      // 旧バージョンが残しえた形を直接書く（循環 A↔B と、そこへ流れ込む D→A）
      const insert = db.prepare(
        `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
         VALUES ('items', ?, ?, ?)`
      );
      // A→B の方が新しい主張なので、循環の刈り取りでは B→A が消えて A→B が残る。
      // つまり刈ったあとに `D→A→B` という鎖が生まれる（1回の走査では見えない形）
      insert.run('A', 'B', '2026-02-01T00:00:00.000Z');
      insert.run('B', 'A', '2026-01-01T00:00:00.000Z');
      insert.run('D', 'A', '2026-03-01T00:00:00.000Z');

      // 起動時の掃除は setupChangelog が呼ぶ（＝利用者は何もしない）
      setupChangelog(db, TABLES, 'id');

      const records = db
        .prepare(`SELECT losingId, winningId FROM _id_merge ORDER BY losingId`)
        .all() as { losingId: string; winningId: string }[];

      // 循環はいちばん新しい主張（A→B）だけが残る
      expect(records.find((r) => r.losingId === 'B')).toBeUndefined();
      expect(records.find((r) => r.losingId === 'A')?.winningId).toBe('B');
      // **D は既に畳まれた A ではなく、終端の B を指すこと。**
      // 1回の走査で止めると `D→A→B` の鎖が残り、D の子が死んだ A へ向けられて捨てられる
      expect(records.find((r) => r.losingId === 'D')?.winningId).toBe('B');

      // 読み替えは1段で終わる（終端がさらに畳まれていない）
      const terminal = lookupIdMerge(db, 'items', 'D')!.winningId;
      expect(lookupIdMerge(db, 'items', terminal)).toBeNull();
    });
  });

  describe('5. NULL を含む複合外部キーは検査されない（捨てない）', () => {
    const TABLES: TableConfig[] = [{ name: 'parents' }, { name: 'children' }];

    it('参照列の片方が NULL の子は、畳み先が消えていても採る', () => {
      db = createDb('composite-null');
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE parents (
          id        TEXT NOT NULL,
          tenantId  TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          PRIMARY KEY (id, tenantId)
        );
        CREATE TABLE children (
          id        TEXT PRIMARY KEY,
          parentId  TEXT,
          tenantId  TEXT,
          updatedAt TEXT NOT NULL,
          FOREIGN KEY (parentId, tenantId) REFERENCES parents(id, tenantId)
        );
      `);
      setupChangelog(db, TABLES, 'id');

      // 親 A は既に B へ畳まれて消えており、その B もそのあと消えている
      // （＝読み替え先が「消えたと分かっている」状態。ここで `ON DELETE` の再現に入る）
      recordMerge(db, 'parents', 'A', 'B', '2026-01-01T00:00:00.000Z');
      db.prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt)
         VALUES ('parents', 'B', '2026-01-15T00:00:00.000Z')`
      ).run();

      // 遅れて届いた子。参照列の片方が NULL なので、SQLite はこの外部キーを検査しない
      const result = applyInsert(
        db,
        'children',
        'id',
        {
          id: 'c1',
          parentId: 'A',
          tenantId: null,
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        ['id', 'parentId', 'tenantId', 'updatedAt']
      );

      // SQLite ならそのまま通る行を、こちらが勝手に捨てないこと
      expect(result.action).toBe('inserted');
      expect(result.warnings).toEqual([]);
      const row = db
        .prepare(`SELECT id FROM children WHERE id = 'c1'`)
        .get();
      expect(row).toBeDefined();
    });
  });

  describe('6. 親の表は、親の時刻列で引く', () => {
    const TABLES: TableConfig[] = [
      { name: 'parents', timestampColumn: 'modifiedAt' },
      { name: 'children' },
    ];

    it('親だけ時刻列が違っても、畳みの記録の有効性を判定できる', () => {
      db = createDb('per-table-timestamp');
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE parents (
          id         TEXT PRIMARY KEY,
          modifiedAt TEXT NOT NULL
        );
        CREATE TABLE children (
          id        TEXT PRIMARY KEY,
          parentId  TEXT REFERENCES parents(id),
          updatedAt TEXT NOT NULL
        );
      `);
      setupChangelog(db, TABLES, 'id');

      // 親 A は B へ畳まれた（判断は 2026-01）。しかし A の行はそのあと 2026-06 に
      // 更新されている ＝ この畳みはもう古い判断であり、読み替えてはいけない
      db.prepare(
        `INSERT INTO parents (id, modifiedAt) VALUES ('A', '2026-06-01T00:00:00.000Z')`
      ).run();
      db.prepare(
        `INSERT INTO parents (id, modifiedAt) VALUES ('B', '2026-01-01T00:00:00.000Z')`
      ).run();
      recordMerge(db, 'parents', 'A', 'B', '2026-01-01T00:00:00.000Z');

      const timestampColumnFor = (tableName: string): string =>
        tableName.toLowerCase() === 'parents' ? 'modifiedAt' : 'updatedAt';

      const result = applyInsert(
        db,
        'children',
        'id',
        {
          id: 'c1',
          parentId: 'A',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        ['id', 'parentId', 'updatedAt'],
        'updatedAt',
        undefined,
        timestampColumnFor
      );

      expect(result.action).toBe('inserted');
      // 子の列名（updatedAt）で親を引くと `modifiedAt` に辿り着けず、記録が
      // いつまでも有効に見えて A の子が B へ向けられてしまう
      const row = db
        .prepare(`SELECT parentId FROM children WHERE id = 'c1'`)
        .get() as { parentId: string };
      expect(row.parentId).toBe('A');
    });
  });
  describe('7. 張り替えは `_id_merge.mergedAt` を進めもしない', () => {
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

  describe('8. 鎖の畳み直しは `_tombstone.mergedInto` も連れて動く', () => {
    const TABLES: TableConfig[] = [{ name: 'items' }];

    it('刈られた循環の tombstone は畳み先を名乗らなくなる', () => {
      db = createDb('cycle-tombstone');
      db.exec(`
        CREATE TABLE items (
          id        TEXT PRIMARY KEY,
          updatedAt TEXT NOT NULL
        )
      `);
      setupChangelog(db, TABLES, 'id');

      // 旧バージョンが残しえた形（循環 A↔B と、そこへ流れ込む D→A）を2つの帳簿へ直接書く
      const insertMerge = db.prepare(
        `INSERT OR REPLACE INTO _id_merge (tableName, losingId, winningId, mergedAt)
         VALUES ('items', ?, ?, ?)`
      );
      const insertTombstone = db.prepare(
        `INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt, mergedInto)
         VALUES ('items', ?, ?, ?)`
      );
      for (const [losingId, winningId, at] of [
        ['A', 'B', '2026-02-01T00:00:00.000Z'],
        ['B', 'A', '2026-01-01T00:00:00.000Z'],
        ['D', 'A', '2026-03-01T00:00:00.000Z'],
      ]) {
        insertMerge.run(losingId, winningId, at);
        insertTombstone.run(losingId, at, winningId);
      }

      // 起動時の掃除は setupChangelog が呼ぶ
      setupChangelog(db, TABLES, 'id');

      const tombstoneOf = (recordId: string) =>
        db
          .prepare(
            `SELECT deletedAt, mergedInto FROM _tombstone
             WHERE tableName = 'items' AND recordId = ?`
          )
          .get(recordId) as TombstoneRow;

      // 刈られた B は、もう畳み先を名乗らない。名乗ったままだと `lookupIdMerge` は
      // null を返すのに tombstone だけが `A` を指し、`remapMergedForeignKeys` が
      // 読み替えをやめる（遅れて届いた B の子が消えた親を指して取り込みが巻き戻る）
      expect(tombstoneOf('B').mergedInto).toBeNull();
      // 張り替えた D は終端の B を指す（`_id_merge` と同じ向き）
      expect(tombstoneOf('D').mergedInto).toBe('B');
      // 時刻は動かさない
      expect(tombstoneOf('D').deletedAt).toBe('2026-03-01T00:00:00.000Z');
    });
  });

  describe('9. 採らなかったリモート行を `upserted` と数えない', () => {
    const TABLES: TableConfig[] = [{ name: 'items' }];

    it('PK重複でローカルが勝ったら `skipped` を返す', () => {
      db = createDb('insert-local-wins');
      db.exec(`
        CREATE TABLE items (
          id        TEXT PRIMARY KEY,
          name      TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);
      setupChangelog(db, TABLES, 'id');

      db.prepare(
        `INSERT INTO items (id, name, updatedAt)
         VALUES ('A', 'local', '2026-06-01T00:00:00.000Z')`
      ).run();

      const result = applyInsert(
        db,
        'items',
        'id',
        { id: 'A', name: 'remote', updatedAt: '2026-01-01T00:00:00.000Z' },
        ['id', 'name', 'updatedAt'],
        'updatedAt'
      );

      // 届いた行は捨てられている。`upserted` と名乗ると、`processChangelogEntries` が
      // これを `conflictsResolved` に数え、`action` だけを見る呼び出し元は
      // 「リモートを適用した」と読む
      expect(result.action).toBe('skipped');
      expect(result.conflict?.resolution).toBe('local_wins');
      const row = db
        .prepare(`SELECT name FROM items WHERE id = 'A'`)
        .get() as { name: string };
      expect(row.name).toBe('local');
    });
  });
});
