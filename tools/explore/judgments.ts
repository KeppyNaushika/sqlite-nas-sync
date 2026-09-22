/**
 * 判定5〜10（設計書 docs/rows-table-design.md §8.1）を検査器へ足すための土台。
 *
 * | # | 判定 | いまの状態 |
 * | --- | --- | --- |
 * | 5 | 同じ版の鍵ならどの端末でも中身が同じ | **有効**（同期のたびに当てる） |
 * | 6 | 各キーの `Max` が端末ごとに時間方向で単調 | **有効**（同上） |
 * | 7 | 作り直しの確定直後に、アプリの表が UNIQUE・外部キー・NOT NULL・CHECK を満たす | **有効**（同期のたびに当てる） |
 * | 8 | 作り直しの冪等性 | **有効**（{@link checkAfterRebuildCommit}。`rebuildDiffCount` が 0 か） |
 * | 9 | 不動点に達する回数の上限 | **有効**（tools/explore/probe.ts の `no-fixpoint`） |
 * | 10 | 判定4 を作り直しの確定ごとに当てる | **有効**（{@link checkAfterRebuildCommit}。`onRebuildCommitted` から） |
 * | 11 | 版の順序が全前順序 | **有効**（{@link checkVersionOrderIsTotalPreorder}。総当たり） |
 * | 12 | 突き合わせは格納クラス込み | **有効**（{@link typedValue}） |
 * | 13 | 置かない行・隠れた行の逆向きの検査 | **有効**（{@link checkAfterRebuildCommit}。参照実装の逆向き＋本物の帳簿との突き合わせ） |
 * | 20 | 計算が1つの快照から読む | **有効**（tools/explore/rebuild-scenarios.ts。`duringCompute`） |
 * | 21 | `SQLITE_BUSY` の見送りと k 回での合流経路 | **有効**（同上。`beginImmediate`） |
 *
 * ## 判定は実装より先に、設計書の字面から書く
 *
 * 実装を書き終えたあとで判定を書くと、「実装に都合のよい判定」になる。ここは案A が
 * `src/` に入る前に書いてある。集まらない場面（案A の表が無い版を駆動しているとき）では
 * 黙って何も言わない —— 偽の反例を出さないため。
 *
 * ## `src/` 側に要る差し込み口
 *
 * {@link REQUIRED_HOOKS} にまとめてある。**6つとも埋まっている**
 * （`src/rows/rebuild.ts` の `rebuildOnce` / `rebuildDiffCount` / `RowsRebuildHooks` と、
 * `src/rows/schema.ts` の `createRowsTables(db, tables, instanceId)`。
 * 検査器からの配線は tools/explore/world.ts）。
 *
 * @module tools/explore/judgments
 */
import type Database from 'better-sqlite3'
import {
  Derived,
  OracleSchema,
  SqlValue,
  ValueOracle,
  Version,
  compareVersions,
  derive,
} from './oracles/rows-d1'

/** 差し込み口1つ。 */
export interface RequiredHook {
  name: string
  why: string
  /** どの口に繋がったか（`src/` 側 → 検査器側） */
  wiredTo: string
}

/**
 * `src/` 側に用意してもらう差し込み口（設計書 §8.2「検査器の作り」）。
 *
 * **6つとも埋まっている。** どこに繋がっているかは {@link RequiredHook.wiredTo} を見ること。
 */
export const REQUIRED_HOOKS: RequiredHook[] = [
  {
    name: '主スレッドで作り直しを計算する経路（公開 API にはしない）',
    why: '本物のワーカーは1回あたり約17ミリ秒。検査器は1つの列で何百回も作り直すので、ワーカー経由では現実的な時間で回らない（設計書 §8.2）',
    wiredTo:
      'src/rows/rebuild.ts の rebuildOnce（RowsSyncRuntime.forceMainThread で選ぶ）→ tools/explore/world.ts の runtimeFor',
  },
  {
    name: '「作り直しが確定した」ことを知らせる呼び出し（表・generation つき）',
    why: '判定4・7・8・10 は「作り直しの確定ごと」に当てる。同期の戻り値だけでは、1回の同期の中で何回確定したかが分からない',
    wiredTo:
      'RowsRebuildHooks.onRebuildCommitted → tools/explore/world.ts の runtimeFor（判定8・10・13）',
  },
  {
    name: '作り直しの計算の途中に書き込みを差し込む口',
    why: '設計書 §8.4「UPDATE トリガーが NEW の全列で版を作る」「計算中の差し込み」の壊し方は、この口が無いと踏めない',
    wiredTo:
      'RowsRebuildHooks.duringCompute → tools/explore/rebuild-scenarios.ts（判定20）',
  },
  {
    name: 'もう1回だけ作り直して差分を返す（適用はしない）関数',
    why: '判定8（作り直しの冪等性）。差が空でなければ違反',
    wiredTo:
      'src/rows/rebuild.ts の rebuildDiffCount → tools/explore/judgments.ts の checkAfterRebuildCommit（判定8）',
  },
  {
    name: '`BEGIN IMMEDIATE` を失敗させる差し込み口（試験用）',
    why: '作り直しの適用がロックを取れない場面（他の接続が書いている）を作る。設計書 §3.7.4 の「見送りが続いたときの経路」と、判定3（見送りが k 回を超えても前進しない）を踏むのに要る。検査器は端末ごとに接続を1本しか開かないので、外から失敗させない限りこの経路に入れない',
    wiredTo:
      'RowsRebuildHooks.beginImmediate → tools/explore/rebuild-scenarios.ts（判定21）',
  },
  {
    name: '`instanceId` を外から与える（試験用）',
    why: '同着の最後の鍵が `iid` の字面の比較なので、乱数のままだと1回の実行で片方の向きしか調べられない（tools/explore/normalize.ts の instanceLabels の「限界」）',
    wiredTo:
      'src/rows/schema.ts の createRowsTables(db, tables, instanceId)（RowsSyncRuntime.instanceId から migrateToRows 経由で渡る）→ tools/explore/world.ts の instanceIdFor',
  },
]

/* ------------------------------------------------------------------ *
 * 版を集める（判定2・4・5・6 の入力）
 * ------------------------------------------------------------------ */

/** 端末から読み取った版1つ。 */
export type CollectedVersion = Version & { client: string }

/**
 * 端末の DB から版を集める（設計書 §3.1 の `_sns_rows_<表>` と `_tombstone`）。
 *
 * **案A の表が無ければ空を返す。** 旧方式の `src/` を駆動しているあいだ、判定5・6 は
 * 何も言わない（偽の反例を出さないため）。
 */
export function collectVersions(
  db: Database.Database,
  client: string,
  tables: readonly string[]
): CollectedVersion[] {
  const collected: CollectedVersion[] = []
  for (const table of tables) {
    const rowsTable = `_sns_rows_${table}`
    if (!tableExists(db, rowsTable)) continue
    for (const row of db
      .prepare(`SELECT * FROM "${rowsTable}"`)
      .all() as Record<string, SqlValue>[]) {
      const content: Record<string, SqlValue> = {}
      for (const [column, value] of Object.entries(row)) {
        if (!column.startsWith('_sns_')) content[column] = value
      }
      collected.push({
        client,
        table,
        id: content.id ?? null,
        kind: 'row',
        ts: row._sns_ts ?? null,
        lamport: Number(row._sns_lamport ?? 0),
        instance: String(row._sns_instance ?? ''),
        content,
      })
    }
  }
  if (tableExists(db, '_tombstone') && hasColumn(db, '_tombstone', '_sns_ts')) {
    for (const row of db
      .prepare(
        `SELECT tableName, recordId, _sns_ts, _sns_lamport, _sns_instance FROM _tombstone`
      )
      .all() as Record<string, SqlValue>[]) {
      if (!tables.includes(String(row.tableName))) continue
      collected.push({
        client,
        table: String(row.tableName),
        id: row.recordId ?? null,
        kind: 'delete',
        ts: row._sns_ts ?? null,
        lamport: Number(row._sns_lamport ?? 0),
        instance: String(row._sns_instance ?? ''),
      })
    }
  }
  return collected
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const info = db.pragma(`table_info("${table}")`) as { name: string }[]
  return info.some((row) => row.name === column)
}

/* ------------------------------------------------------------------ *
 * 判定5・6
 * ------------------------------------------------------------------ */

/**
 * 判定12: 値を**格納クラス（`typeof`）込み**で書き表す。
 *
 * 値だけで比べると、`1767225600000`（INTEGER）が TEXT 列を経由して `'1767225600000'`
 * （TEXT）に化けた形を「同じ」と見てしまう。この化け方は設計書 §1.2.3 の値の種類の順序を
 * 群1 から群2 へ動かすので、版の順序そのものが端末ごとに変わる。**突き合わせは必ずこの形で行う。**
 */
export function typedValue(value: SqlValue): [string, string] {
  if (value === null) return ['null', 'null']
  if (Buffer.isBuffer(value)) return ['blob', value.toString('base64')]
  if (typeof value === 'number') {
    return [Number.isInteger(value) ? 'integer' : 'real', String(value)]
  }
  if (typeof value === 'bigint') return ['integer', String(value)]
  return ['text', value]
}

/** 版の鍵（設計書 §1.2.5 の不変条件 U: `(iid, L)` は書き込み1回を一意に指す）。 */
export function versionKey(version: Version): string {
  return JSON.stringify([
    version.table,
    typedValue(version.id),
    version.instance,
    version.lamport,
  ])
}

/** 版の中身（鍵が同じなら、これも同じでなければならない）。判定12 により格納クラス込み。 */
export function versionBody(version: Version): string {
  const content =
    version.content === undefined
      ? null
      : Object.entries(version.content)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([column, value]) => [column, typedValue(value)])
  return JSON.stringify([version.kind, typedValue(version.ts), content])
}

/**
 * 判定5・6 を、実行のあいだ通して見る帳簿。
 *
 * - **判定5**: 同じ鍵の版を違う端末で見たら、中身も同じであること（設計書 §8.1 の穴15-1）。
 *   **1回の実行の中で**見る（{@link beginRun}）
 * - **判定6**: 端末ごとに、各キーの `Max` が時間方向で弱くならないこと（穴15-2）
 */
export class JudgmentLedger {
  private readonly values = new ValueOracle()
  /** 版の鍵 → (中身, 最初に見た端末) */
  private readonly bodies = new Map<string, { body: string; client: string }>()
  /** 端末 + キー → 直前に見た `Max` */
  private readonly lastMax = new Map<string, Version>()

  /**
   * 1つの世界を回し始めるときに呼ぶ。帳簿を空にする。
   *
   * **判定5 も判定6 も、1つの世界（1回の実行）の中でしか意味を持たない。**
   * 検査器は幅優先で枝分かれした**別々の世界**を同じワーカーで次々に回すので、
   * 帳簿を通したままにすると:
   *
   * - 判定6: 「枝Aの g2 の Max」と「枝Bの g2 の Max」を比べ、中身がまるで違う
   *   版どうしで「弱くなった」と言い出す
   * - 判定5: 枝分かれの**親の状態が既に移行済み**だと、枝A と枝B の
   *   `instanceId` は同じである（移行は分岐より前に1度だけ起きた）。そこから
   *   それぞれが1回書けば、どちらも `(iid, L) = (I, 1)` の版になり、中身だけが
   *   違う。**1つの実行の中では起きえない**組み合わせなので、これを違反と
   *   数えてはいけない
   *
   * どちらも段階5 で実際に踏んだ（偽の反例）。
   */
  beginRun(): void {
    this.lastMax.clear()
    this.bodies.clear()
  }

  /**
   * ある時点の、ある端末の版を受け取る。
   *
   * @returns 見つかった違反の説明（空なら違反なし）
   */
  observe(versions: CollectedVersion[]): string[] {
    const violations: string[] = []
    // 判定5
    for (const version of versions) {
      const key = versionKey(version)
      const body = versionBody(version)
      const seen = this.bodies.get(key)
      if (seen === undefined) {
        this.bodies.set(key, { body, client: version.client })
      } else if (seen.body !== body) {
        violations.push(
          `判定5 違反: 同じ版の鍵 ${key} なのに中身が違う（${seen.client}: ${seen.body} / ${version.client}: ${body}）`
        )
      }
    }
    // 判定6
    const maxByKey = new Map<string, CollectedVersion>()
    for (const version of versions) {
      const key = `${version.client}|${version.table}|${String(version.id)}`
      const current = maxByKey.get(key)
      if (
        current === undefined ||
        compareVersions(this.values, current, version) < 0
      ) {
        maxByKey.set(key, version)
      }
    }
    for (const [key, version] of maxByKey) {
      const previous = this.lastMax.get(key)
      if (
        previous !== undefined &&
        compareVersions(this.values, version, previous) < 0
      ) {
        violations.push(
          `判定6 違反: ${key} の Max が弱くなった（${versionBody(previous)} → ${versionBody(version)}）`
        )
      }
      this.lastMax.set(key, version)
    }
    return violations
  }
}

/* ------------------------------------------------------------------ *
 * 判定7
 * ------------------------------------------------------------------ */

/**
 * 判定7: アプリの表が、宣言された UNIQUE・外部キー・NOT NULL・CHECK を満たすこと
 * （設計書 §8.1 の穴15-3）。
 *
 * `PRAGMA integrity_check`（UNIQUE 索引の整合・NOT NULL・CHECK）と
 * `PRAGMA foreign_key_check`（外部キー）を当てる。**これは案A でなくても効く**ので、
 * いまの `src/` にもそのまま当てている。
 *
 * @returns 違反の説明（`null` なら満たしている）
 */
export function checkAppTables(
  db: Database.Database,
  tables: readonly string[]
): string | null {
  const integrity = db.pragma('integrity_check') as {
    integrity_check: string
  }[]
  const bad = integrity
    .map((row) => row.integrity_check)
    .filter((line) => line !== 'ok')
  if (bad.length > 0) {
    return `判定7 違反: アプリの表が制約を満たしていない: ${bad.join(' / ')}`
  }
  for (const table of tables) {
    const broken = db.pragma(`foreign_key_check("${table}")`) as unknown[]
    if (broken.length > 0) {
      return `判定7 違反: ${table} が外部キーを満たしていない: ${JSON.stringify(broken)}`
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 判定8・10（差し込み口を待つ）
 * ------------------------------------------------------------------ */

/**
 * 作り直しの差し込み口（{@link REQUIRED_HOOKS}）。`src/` が案A になったら、
 * 検査器はこの形の関数を受け取って判定8・10 を当てる。
 */
export type RebuildHooks = {
  /** もう1回だけ作り直して、前の結果との差の件数を返す（適用はしない） */
  rebuildDiffCount: (db: Database.Database) => number
  /** 作り直しが確定するたびに呼ばれる（判定4・7・10 をここで当てる） */
  onRebuildCommitted: (
    listener: (db: Database.Database) => string | null
  ) => void
}

/** 判定8: 続けてもう1回作り直すと差が空であること（設計書 §8.1 の穴15-4）。 */
export function checkRebuildIdempotent(
  db: Database.Database,
  hooks: RebuildHooks | null
): string | null {
  if (hooks === null) return null // 差し込み口が無いあいだは何も言わない
  const diff = hooks.rebuildDiffCount(db)
  return diff === 0
    ? null
    : `判定8 違反: もう1回作り直すと ${String(diff)} 件の差が出た（冪等でない）`
}

/**
 * **作り直しが確定するたびに**当てる判定（設計書 §8.1 の判定8・10・13）。
 *
 * `RowsRebuildHooks.onRebuildCommitted` から呼ぶ。確定の直後は「版の集合」と
 * 「アプリの表」が一致していなければならない瞬間で、ここを外すと
 * 不動点でしか突き合わせられない（＝途中で1回だけ裂けた表を見逃す）。
 *
 * - **判定10**: 参照実装 `rows-d1` が**この端末の版**から計算した置く行と、
 *   いま確定したアプリの表が一致すること
 * - **判定13**: その計算の置かない行・隠れた行が、本物の表へ入れ直すと
 *   ちゃんと落ちること（逆向きの検査）
 * - **判定8**: もう1回作り直しても差が出ないこと（冪等）
 *
 * @param applied 今回入れ替えた表（それ以外は汚れていないので触っていない）
 * @param diffCount 判定8 の当て手（`rebuildDiffCount`）。無ければ判定8 は黙る
 * @returns 違反の説明（空なら違反なし）
 */
export function checkAfterRebuildCommit(
  db: Database.Database,
  client: string,
  tables: readonly string[],
  schema: OracleSchema,
  applied: readonly string[],
  diffCount: (() => number) | null
): string[] {
  const failures: string[] = []
  const derived = derive(collectVersions(db, client, tables), schema)

  // 判定10（参照実装との一致）。確定した表だけを見る
  for (const table of applied) {
    if (!schema.tables.some((entry) => entry.name === table)) continue
    const expected = normalizedRows(derived.rows.get(table) ?? [])
    const actual = normalizedRows(
      db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, SqlValue>[]
    )
    if (expected !== actual) {
      failures.push(
        `判定10 違反: 作り直しの確定直後の ${table} が参照実装と違う` +
          `（参照実装: ${expected} / 本物: ${actual}）`
      )
    }
  }

  // 判定13（置かない行・隠れた行の逆向きの検査）。2段でかける:
  //
  // 1. 参照実装が出した置かない行・隠れた行が、本物の表へ入れ直すとちゃんと
  //    落ちること（参照実装そのものの逆向きの検査）
  // 2. **本物の帳簿**（`_sns_hidden` / `_sns_unplaceable` / `_sns_shown`）が
  //    参照実装と同じ行き先を言っていること。ここを見ないと、見え方が同じでも
  //    「かぶり」を「置かない行」に落とすような取り違えを取り逃がす
  //    （勝者が決まらないので、あとで畳み先を聞かれたときに答えられない）
  failures.push(...checkPlacementsAreReal(derived, schema))
  for (const table of applied) {
    if (!schema.tables.some((entry) => entry.name === table)) continue
    failures.push(...comparePlacementLedgers(db, derived, table))
  }

  // 判定8（冪等）
  if (diffCount !== null) {
    const diff = diffCount()
    if (diff !== 0) {
      failures.push(
        `判定8 違反: 確定した直後にもう1回作り直すと ${String(diff)} 件の差が出た（冪等でない）`
      )
    }
  }
  return failures
}

/**
 * 本物の帳簿（`_sns_hidden` / `_sns_unplaceable` / `_sns_shown`）と、参照実装の
 * 行き先を突き合わせる（判定13 の後半）。
 *
 * 帳簿が無い DB（旧方式）では何も言わない。
 */
function comparePlacementLedgers(
  db: Database.Database,
  derived: Derived,
  table: string
): string[] {
  const failures: string[] = []
  const candidates = derived.candidates.get(table)
  if (candidates === undefined) return failures

  const expectedHidden: string[] = []
  const expectedUnplaceable: string[] = []
  const expectedShown: string[] = []
  for (const candidate of candidates.values()) {
    if (candidate.placement === 'hidden') {
      expectedHidden.push(
        JSON.stringify([candidate.key, candidate.winner ?? null])
      )
    } else if (candidate.placement === 'unplaceable') {
      expectedUnplaceable.push(candidate.key)
    }
  }
  for (const [key, value] of derived.res.get(table) ?? []) {
    const placed = candidates.get(key)
    if (placed?.placement !== 'placed' || value === null) continue
    const shown = String(value)
    if (shown !== key) expectedShown.push(JSON.stringify([key, shown]))
  }

  const rows = (sql: string): Record<string, SqlValue>[] => {
    try {
      return db.prepare(sql).all(table) as Record<string, SqlValue>[]
    } catch {
      return [] // 帳簿の無い DB
    }
  }
  const actualHidden = rows(
    `SELECT trueId, winnerId FROM _sns_hidden WHERE tableName = ?`
  ).map((row) => JSON.stringify([String(row.trueId), row.winnerId ?? null]))
  const actualUnplaceable = rows(
    `SELECT trueId FROM _sns_unplaceable WHERE tableName = ?`
  ).map((row) => String(row.trueId))
  const actualShown = rows(
    `SELECT trueId, shownId FROM _sns_shown WHERE tableName = ?`
  ).map((row) => JSON.stringify([String(row.trueId), String(row.shownId)]))

  const same = (a: string[], b: string[]): boolean =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  const say = (name: string, want: string[], got: string[]): void => {
    if (same(want, got)) return
    failures.push(
      `判定13 違反: ${table} の ${name} が参照実装と違う` +
        `（参照実装: ${JSON.stringify([...want].sort())} / 本物: ${JSON.stringify([...got].sort())}）`
    )
  }
  say('隠れた行（_sns_hidden）', expectedHidden, actualHidden)
  say('置かない行（_sns_unplaceable）', expectedUnplaceable, actualUnplaceable)
  say('表示している id（_sns_shown）', expectedShown, actualShown)
  return failures
}

/**
 * 行の集まりを、突き合わせられる1つの字面にする。
 *
 * **格納クラス込み**（判定12）で、行の並びにも列の並びにも依らない形にする。
 */
function normalizedRows(rows: readonly Record<string, SqlValue>[]): string {
  return JSON.stringify(
    rows
      .map((row) =>
        Object.keys(row)
          .sort()
          .map((column) => [column, typedValue(row[column] ?? null)])
      )
      .map((row) => JSON.stringify(row))
      .sort()
  )
}

/* ------------------------------------------------------------------ *
 * 判定11: 版の順序が全前順序であること
 * ------------------------------------------------------------------ */

/**
 * 判定11 で総当たりに使う値。**設計書 §1.2.3 の群を全部またぐように選ぶ。**
 *
 * 群0: NULL / 群1: 整数・実数・大きな整数 / 群2: 読めない文字列 /
 * 群3: `julianday` で読める文字列（書式違いの同じ瞬間を含む）/ 群4: BLOB
 */
export const ORDER_PROBE_VALUES: SqlValue[] = [
  null,
  0,
  1,
  -1,
  1.5,
  1767225600000,
  9007199254740993n,
  'zzz',
  'not a time',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01 00:00:00',
  '2026-01-01T00:00:01.000Z',
  Buffer.from([0x00]),
  Buffer.from('2026-01-01T00:00:00.000Z', 'utf8'),
]

/**
 * 判定11: 版の順序 `≺`（設計書 §1.2.5。`_sns_ts`・`L`・`iid` の辞書順で、時刻は
 * §1.2.3 の値の種類の順序）が**全前順序**であること。
 *
 * - 反射: `compare(x, x) = 0`
 * - 反対称（前順序の形）: `sign(compare(a, b)) = -sign(compare(b, a))`
 * - 推移: `a ≼ b` かつ `b ≼ c` なら `a ≼ c`。同順どうしの推移も見る
 * - 全: どの2つにも大小か同順が決まる（`compare` が常に数を返す）
 *
 * 全前順序でないと、「強い順に並べる」（§1.6）の答えが並べ方によって変わり、
 * 端末ごとに違う表ができる。**総当たりで確かめる。**
 *
 * @returns 違反の説明（空なら成り立っている）
 */
export function checkVersionOrderIsTotalPreorder(): string[] {
  const values = new ValueOracle()
  const probes: Version[] = []
  for (const ts of ORDER_PROBE_VALUES) {
    for (const lamport of [1, 2]) {
      for (const instance of ['iid-a', 'iid-b']) {
        probes.push({ table: 't', id: 'k', kind: 'row', ts, lamport, instance })
      }
    }
  }
  // 削除の版も混ぜる（同じ鍵のとき種類で決まる段がある）
  probes.push({
    table: 't',
    id: 'k',
    kind: 'delete',
    ts: '2026-01-01T00:00:00.000Z',
    lamport: 1,
    instance: 'iid-a',
  })

  const failures: string[] = []
  const sign = (value: number): number => (value < 0 ? -1 : value > 0 ? 1 : 0)
  const at = (a: Version, b: Version): number =>
    sign(compareVersions(values, a, b))
  const show = (version: Version): string =>
    `${String(version.ts)}/${String(version.lamport)}/${version.instance}/${version.kind}`

  for (const a of probes) {
    if (at(a, a) !== 0) failures.push(`判定11 反射が崩れた: ${show(a)}`)
    for (const b of probes) {
      const ab = at(a, b)
      if (!Number.isFinite(ab)) {
        failures.push(`判定11 大小が決まらない: ${show(a)} と ${show(b)}`)
        continue
      }
      if (ab !== -at(b, a)) {
        failures.push(`判定11 反対称が崩れた: ${show(a)} と ${show(b)}`)
      }
      for (const c of probes) {
        if (ab <= 0 && at(b, c) <= 0 && at(a, c) > 0) {
          failures.push(
            `判定11 推移が崩れた: ${show(a)} ≼ ${show(b)} ≼ ${show(c)} なのに ${show(a)} ≻ ${show(c)}`
          )
        }
        if (ab === 0 && at(b, c) === 0 && at(a, c) !== 0) {
          failures.push(
            `判定11 同順の推移が崩れた: ${show(a)} ~ ${show(b)} ~ ${show(c)}`
          )
        }
      }
    }
  }
  // 同じ説明を何度も並べない（総当たりなので同じ組が何度も出る）
  return [...new Set(failures)]
}

/* ------------------------------------------------------------------ *
 * 判定13: 置かない行・隠れた行の逆向きの検査
 * ------------------------------------------------------------------ */

/**
 * 判定13: **「本当は置けた行を置かない行にした」を捕まえる。**
 *
 * 参照実装が出した置く行を本物の表へ入れ直したうえで、
 *
 * - **隠れた行**を入れると `SQLITE_CONSTRAINT_UNIQUE`（か主キー）で落ちること
 * - 行に閉じた制約で**置かない行**にしたものを入れると、UNIQUE 以外の制約で落ちること
 *
 * を確かめる。順方向（「入らなかったから隠れた行」）だけだと、入れる順や表示値の作り方を
 * 間違えて**入るはずの行を捨てた**場合に気づけない。
 *
 * 外部キーは検査しない（親が置かれていないときの扱いは §1.4 の表示値の規則で決めるもので、
 * SQLite に判定させる部分ではない）。
 *
 * @returns 違反の説明（空なら成り立っている）
 */
export function checkPlacementsAreReal(
  derived: Derived,
  schema: OracleSchema
): string[] {
  const failures: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = OFF')
    for (const table of schema.tables) {
      db.exec(table.ddl)
      for (const index of table.indexes ?? []) db.exec(index)
    }
    const insert = (
      table: string,
      row: Record<string, SqlValue>
    ): string | null => {
      const columns = Object.keys(row)
      try {
        db.prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`
        ).run(...columns.map((column) => row[column] as never))
        return null
      } catch (error) {
        return (error as { code?: string }).code ?? 'SQLITE_ERROR'
      }
    }
    const isUnique = (code: string): boolean =>
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 'SQLITE_CONSTRAINT_PRIMARYKEY'

    for (const table of schema.tables) {
      for (const row of derived.rows.get(table.name) ?? []) {
        const code = insert(table.name, row)
        if (code !== null) {
          failures.push(
            `判定13 違反: ${table.name} の置く行が本物の表に入らない（${code}）: ${JSON.stringify(row)}`
          )
        }
      }
    }
    for (const table of schema.tables) {
      for (const candidate of derived.candidates.get(table.name)?.values() ??
        []) {
        if (candidate.placement === 'hidden') {
          const code = insert(table.name, candidate.display)
          if (code === null || !isUnique(code)) {
            failures.push(
              `判定13 違反: ${table.name}:${candidate.key} を隠れた行にしたのに、入れ直すと ${code ?? '入ってしまう'}`
            )
          }
        } else if (candidate.reasonKind === 'constraint') {
          const code = insert(table.name, candidate.display)
          if (code === null || isUnique(code)) {
            failures.push(
              `判定13 違反: ${table.name}:${candidate.key} を置かない行にしたのに、入れ直すと ${code ?? '入ってしまう'}`
            )
          }
        }
      }
    }
    return failures
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ *
 * 単体テスト
 * ------------------------------------------------------------------ */

/**
 * この模組の単体テスト（`__tests__/` に置けない理由は tools/tsconfig.json の冒頭）。
 *
 * @returns 失敗の説明（空なら全部通った）
 */
export function runJudgmentUnitTests(): string[] {
  const failures: string[] = []
  const check = (name: string, actual: unknown, expected: unknown): void => {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) failures.push(`${name}: 期待 ${b} / 実際 ${a}`)
  }
  const version = (
    client: string,
    lamport: number,
    ts: string,
    name: string
  ): CollectedVersion => ({
    client,
    table: 'tags',
    id: 'g1',
    kind: 'row',
    ts,
    lamport,
    instance: client,
    content: { id: 'g1', name, updatedAt: ts },
  })

  // 判定5: 鍵が同じで中身が違えば違反、同じなら黙る
  const ledger = new JudgmentLedger()
  check(
    '判定5 同じ版は黙る',
    ledger.observe([
      version('a', 1, '2026-01-01T00:00:00.000Z', 't1'),
      version('b', 1, '2026-01-01T00:00:00.000Z', 't1'),
    ]).length,
    0
  )
  const clash = new JudgmentLedger()
  clash.observe([version('a', 1, '2026-01-01T00:00:00.000Z', 't1')])
  check(
    '判定5 鍵が同じで中身が違えば違反',
    clash.observe([{ ...version('a', 1, '2026-01-01T00:00:00.000Z', 't2') }])
      .length,
    1
  )

  // 判定6: Max は弱くならない
  const monotone = new JudgmentLedger()
  monotone.observe([version('a', 2, '2026-01-01T00:00:01.000Z', 't2')])
  check(
    '判定6 強くなるのは良い',
    monotone.observe([version('a', 3, '2026-01-01T00:00:02.000Z', 't3')])
      .length,
    0
  )
  const regress = new JudgmentLedger()
  regress.observe([version('a', 2, '2026-01-01T00:00:01.000Z', 't2')])
  check(
    '判定6 弱くなれば違反',
    regress.observe([version('a', 1, '2026-01-01T00:00:00.000Z', 't1')]).length,
    1
  )

  // 判定7: 制約を満たす表では黙り、壊れた表では言う
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = OFF')
    db.exec(
      `CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)`
    )
    db.exec(
      `CREATE TABLE tag_notes (id TEXT PRIMARY KEY, tagId TEXT NOT NULL REFERENCES tags(id))`
    )
    db.prepare(`INSERT INTO tags VALUES ('g1', 't1')`).run()
    check(
      '判定7 満たしていれば黙る',
      checkAppTables(db, ['tags', 'tag_notes']),
      null
    )
    // 外部キーを切ってあるので、親の居ない子を入れられる（＝作り直しが壊れた形の再現）
    db.prepare(`INSERT INTO tag_notes VALUES ('n1', 'g9')`).run()
    const said = checkAppTables(db, ['tags', 'tag_notes'])
    check('判定7 外部キーが壊れていれば言う', said !== null, true)
  } finally {
    db.close()
  }

  // 判定8: 差し込み口が無ければ黙る
  check(
    '判定8 差し込み口が無ければ黙る',
    checkRebuildIdempotent(null as unknown as Database.Database, null),
    null
  )

  // 判定11: 版の順序が全前順序であること（総当たり）
  failures.push(...checkVersionOrderIsTotalPreorder())

  // 判定12: 値の化けを見分ける
  check(
    '判定12 整数と文字列は別',
    typedValue(1)[0] !== typedValue('1')[0],
    true
  )
  check(
    '判定12 同じ値・同じ格納クラスは同じ',
    JSON.stringify(typedValue('x')) === JSON.stringify(typedValue('x')),
    true
  )
  check(
    '判定12 版の中身が格納クラス込みで違う',
    versionBody({
      table: 't',
      id: 'k',
      kind: 'row',
      ts: 1767225600000,
      lamport: 1,
      instance: 'a',
    }) ===
      versionBody({
        table: 't',
        id: 'k',
        kind: 'row',
        ts: '1767225600000',
        lamport: 1,
        instance: 'a',
      }),
    false
  )
  check(
    '判定12 版の鍵も格納クラス込み',
    versionKey({
      table: 't',
      id: 1,
      kind: 'row',
      ts: null,
      lamport: 1,
      instance: 'a',
    }) ===
      versionKey({
        table: 't',
        id: '1',
        kind: 'row',
        ts: null,
        lamport: 1,
        instance: 'a',
      }),
    false
  )

  return failures
}
