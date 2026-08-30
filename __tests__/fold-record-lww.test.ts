/**
 * 畳みの記録（`_tombstone` / `_id_merge`）も行と同じLWWの下に置く、という規則の回帰テスト。
 *
 * 記録は「主張」であって永久の真理ではない。それが確立した時刻を持ち、新しい主張が勝つ。
 *
 * - **規則2** 読み替えは、記録が**ローカルの敗者行**より新しいときだけ適用する
 * - **規則3** 読み替えて書き換えたら、その行は勝った側の版の時刻を名乗る
 *   （ただし**席を別の行と争っているときは名乗らない** — 理由は下の describe に書いた）
 * - **規則4** 敗者行が記録より新しく更新されていれば、その畳みは適用しない
 *
 * 規則5（読み替え先が消えているとき）は `fold-record-ondelete.test.ts`、
 * 規則1（記録に勝者の時刻を刻む）は `fold-tombstone-time.test.ts` にある。
 * 端末をまたいだ動きは `fold-record-sync.test.ts`。
 *
 * 規則4 は前から実装されていたが、記録の時刻が常に現在時刻だったため一度も発火しなかった。
 * ここでは**実際に発火すること**を見る。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { setupChangelog } from '../src/setup';
import { applyInsert, applyMergedDelete, applyUpdate } from '../src/conflict';
import {
  createForeignKeyDb,
  FK_TABLES,
  KID_COLUMNS,
  kidsOf,
  PARENT_COLUMNS,
} from './helpers/fold-record-fixtures';

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
