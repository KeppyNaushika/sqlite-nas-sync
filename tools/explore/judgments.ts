/**
 * 判定5〜13（設計書 docs/rows-table-design.md §8.1）の当て方。
 *
 * | # | 判定 | 当て方 |
 * | --- | --- | --- |
 * | 5 | 同じ版の鍵ならどの端末でも中身が同じ | 収束の検査の同期のたびに当てる（{@link JudgmentLedger}） |
 * | 6 | 各キーの `Max` が端末ごとに時間方向で単調。一度見えたキーの版は消えない | 同上 |
 * | 7 | 作り直しの確定直後に、アプリの表が UNIQUE・外部キー・NOT NULL・CHECK を満たす | 同期のたびに当てる（{@link checkAppTables}） |
 * | 8 | 作り直しの冪等性 | 作り直しの確定ごと（{@link checkAfterRebuildCommit}。`rebuildDiffCount` が 0 か） |
 * | 9 | 不動点に達する回数の上限 | tools/explore/probe.ts の `no-fixpoint` |
 * | 10 | 判定4 を作り直しの確定ごとに当てる | 作り直しの確定ごと（{@link checkAfterRebuildCommit}） |
 * | 11 | 版の順序が全前順序 | 起動時の総当たり（{@link checkVersionOrderIsTotalPreorder}） |
 * | 12 | 突き合わせは格納クラス込み | {@link typedValue} |
 * | 13 | 置かない行・隠れた行の逆向きの検査 | 作り直しの確定ごと（参照実装の逆向き＋本物の帳簿との突き合わせ） |
 * | 20 | 計算が1つの快照から読む | tools/explore/rebuild-scenarios.ts（`duringCompute`） |
 * | 21 | `SQLITE_BUSY` の見送りと k 回での合流経路 | 同上（`beginImmediate`） |
 *
 * さらに、アプリの操作1回ごとに docs/principles.md の原則2・原則3・原則4 を直に確かめる
 * （{@link checkDeletionPrinciples}）。
 *
 * ## 判定は実装より先に、仕様の字面から書く
 *
 * 実装を書き終えたあとで判定を書くと、「実装に都合のよい判定」になる。判定は
 * docs/principles.md と設計書の字面から書き、実装の内部の手順は借りない。
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

/* ------------------------------------------------------------------ *
 * 版を集める（判定2・4・5・6 の入力）
 * ------------------------------------------------------------------ */

/** 端末から読み取った版1つ。 */
export type CollectedVersion = Version & { client: string }

/** 端末の DB から版を集める（設計書 §3.1 の `_sns_rows_<表>` と `_tombstone`）。 */
export function collectVersions(
  db: Database.Database,
  client: string,
  tables: readonly string[]
): CollectedVersion[] {
  const collected: CollectedVersion[] = []
  for (const table of tables) {
    const rowsTable = `_sns_rows_${table}`
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
  return collected
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

/** 版の鍵（設計書 §1.2.4〜1.2.5 の不変条件 U: `(iid, L)` は書き込み1回を一意に指す）。 */
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
 * - **判定5**: 同じ鍵の版を違う端末で見たら、中身も同じであること。
 *   **1回の実行の中で**見る（{@link beginRun}）
 * - **判定6**: 端末ごとに、各キーの `Max` が時間方向で弱くならないこと
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
   * どちらも実際に踏んだ（偽の反例）。
   */
  beginRun(): void {
    this.lastMax.clear()
    this.bodies.clear()
  }

  /**
   * ある時点の、ある端末の版を受け取る。
   *
   * @param client 版を集めた端末。渡すと、その端末の版が1つも無いときも「消えた」を見る
   * @returns 見つかった違反の説明（空なら違反なし）
   */
  observe(versions: CollectedVersion[], client?: string): string[] {
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
    // 判定6 の続き: 一度見えたキーの版が、同じ端末から消えないこと。版は併合で
    // 強い方に置き換わるだけで、キーごと消える経路は無い（原則4 で親が削除されている
    // 子の版も捨てない）。消えると、2周で一致する議論の前提
    // 「各端末の版の集合は併合でしか変わらない」が破れる
    const clients = new Set(versions.map((version) => version.client))
    if (client !== undefined) clients.add(client)
    for (const [key, previous] of this.lastMax) {
      if (maxByKey.has(key)) continue
      if (!clients.has(key.slice(0, key.indexOf('|')))) continue
      violations.push(
        `判定6 違反: ${key} の版が消えた（直前の Max: ${versionBody(previous)}）`
      )
      this.lastMax.delete(key)
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
 * 判定7: アプリの表が、宣言された UNIQUE・外部キー・NOT NULL・CHECK を満たすこと。
 *
 * `PRAGMA integrity_check`（UNIQUE 索引の整合・NOT NULL・CHECK）と
 * `PRAGMA foreign_key_check`（外部キー）を当てる。
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
 * 判定8・10・13（作り直しの確定ごと）
 * ------------------------------------------------------------------ */

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
 * @param diffCount 判定8 の当て手（`rebuildDiffCount`）
 * @returns 違反の説明（空なら違反なし）
 */
export function checkAfterRebuildCommit(
  db: Database.Database,
  client: string,
  tables: readonly string[],
  schema: OracleSchema,
  applied: readonly string[],
  diffCount: () => number
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
  const diff = diffCount()
  if (diff !== 0) {
    failures.push(
      `判定8 違反: 確定した直後にもう1回作り直すと ${String(diff)} 件の差が出た（冪等でない）`
    )
  }
  return failures
}

/**
 * 本物の帳簿（`_sns_hidden` / `_sns_unplaceable` / `_sns_shown`）と、参照実装の
 * 行き先を突き合わせる（判定13 の後半）。
 *
 * 親が削除されているので置かない行（原則4）は、`_sns_unplaceable` に**原因の親つきで**
 * 載るのが正しい。原因の親は利用者への報告（`SyncResult.parentDeleted`）の元になるので、
 * 原因まで突き合わせる。アプリの表の見え方はどちらでも同じなので、判定4・10 では出ない。
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
    } else if (
      candidate.placement === 'unplaceable' ||
      candidate.placement === 'parentDeleted'
    ) {
      expectedUnplaceable.push(
        JSON.stringify([
          candidate.key,
          candidate.cause?.table ?? null,
          candidate.cause?.key ?? null,
        ])
      )
    }
  }
  for (const [key, value] of derived.res.get(table) ?? []) {
    const placed = candidates.get(key)
    if (placed?.placement !== 'placed' || value === null) continue
    const shown = String(value)
    if (shown !== key) expectedShown.push(JSON.stringify([key, shown]))
  }

  const rows = (sql: string): Record<string, SqlValue>[] =>
    db.prepare(sql).all(table) as Record<string, SqlValue>[]
  const actualHidden = rows(
    `SELECT trueId, winnerId FROM _sns_hidden WHERE tableName = ?`
  ).map((row) => JSON.stringify([String(row.trueId), row.winnerId ?? null]))
  const actualUnplaceable = rows(
    `SELECT trueId, causeTable, causeId FROM _sns_unplaceable WHERE tableName = ?`
  ).map((row) =>
    JSON.stringify([
      String(row.trueId),
      row.causeTable === null ? null : String(row.causeTable),
      row.causeId === null ? null : String(row.causeId),
    ])
  )
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
  say(
    '置かない行と親の削除の原因（_sns_unplaceable）',
    expectedUnplaceable,
    actualUnplaceable
  )
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
 * 判定11: 版の順序 `≺`（設計書 §1.2.4〜1.2.5。`_sns_ts`・`L`・`iid` の辞書順で、時刻は
 * §1.2.3 の値の種類の順序）が**全前順序**であること。
 *
 * - 反射: `compare(x, x) = 0`
 * - 反対称（前順序の形）: `sign(compare(a, b)) = -sign(compare(b, a))`
 * - 推移: `a ≼ b` かつ `b ≼ c` なら `a ≼ c`。同順どうしの推移も見る
 * - 全: どの2つにも大小か同順が決まる（`compare` が常に数を返す）
 *
 * 全前順序でないと、「強い順に並べる」（§1.3〜1.7）の答えが並べ方によって変わり、
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
 * 外部キーは検査しない（親が置かれていないときの扱いは §1.3〜1.7 の表示値の規則で決めるもので、
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
 * 原則2・原則3・原則4（アプリの操作ごと）
 * ------------------------------------------------------------------ */

/**
 * 操作の直前に読んでおくもの（{@link checkDeletionPrinciples} の入力）。
 *
 * 統合で隠れている行と、アプリの表に見えている行（真の id）。どちらも「アプリから見て
 * いま何が1行に統合されているか」であり、原則3 の「統合した行」はこれを指す。
 */
export type DeletionWitness = {
  /** 同期時計の lamport（この操作で書かれた版を見分けるのに使う。tools/explore/world.ts） */
  lamport: number
  /** 表 → 見えている行の、表示上の id → 真の id */
  shown: Map<string, Map<string, string>>
  /** 統合で隠れている行（勝者の決まっているものだけ） */
  hidden: { table: string; trueId: string; winnerId: string }[]
}

/** {@link checkDeletionPrinciples} が使い回す比較の道具（操作ごとに作ると `:memory:` の DB が溜まる）。 */
let deletionValues: ValueOracle | null = null

/** 操作の直前に {@link DeletionWitness} を読む。 */
export function witnessBeforeOp(
  db: Database.Database,
  tables: readonly string[]
): DeletionWitness {
  const lamport = (
    db.prepare(`SELECT lamport FROM _sns_clock`).get() as { lamport: number }
  ).lamport
  const shown = new Map<string, Map<string, string>>()
  for (const table of tables) {
    shown.set(table, visibleRows(db, table))
  }
  const hidden = (
    db
      .prepare(
        `SELECT tableName, trueId, winnerId FROM _sns_hidden WHERE winnerId IS NOT NULL`
      )
      .all() as { tableName: string; trueId: string; winnerId: string }[]
  )
    .filter((row) => tables.includes(row.tableName))
    .map((row) => ({
      table: row.tableName,
      trueId: String(row.trueId),
      winnerId: String(row.winnerId),
    }))
  return { lamport, shown, hidden }
}

/** アプリの表に見えている行の、表示上の id → 真の id（1:1 の表では `_sns_shown` で引く）。 */
function visibleRows(
  db: Database.Database,
  table: string
): Map<string, string> {
  const remapped = new Map<string, string>()
  for (const row of db
    .prepare(`SELECT trueId, shownId FROM _sns_shown WHERE tableName = ?`)
    .all(table) as { trueId: SqlValue; shownId: SqlValue }[]) {
    remapped.set(String(row.shownId), String(row.trueId))
  }
  const visible = new Map<string, string>()
  for (const id of db
    .prepare(`SELECT CAST(id AS TEXT) FROM "${table}"`)
    .pluck()
    .all() as string[]) {
    visible.set(id, remapped.get(id) ?? id)
  }
  return visible
}

/**
 * アプリの操作1回ごとに、docs/principles.md の原則2・原則3・原則4 を直に確かめる。
 *
 * - **原則2**（付則2）: `DELETE` の版の順序に使う時刻は、削除を実行した時刻である。
 *   手元の Max がそれより強ければ単調化でそこまで上がるが、実行した時刻より弱くはならない。
 *   そこで、この操作で書かれた削除の版ごとに「`_sns_ts` ≧ 実行した時刻（`deletedAt`）」を見る
 * - **原則3**: 統合した行を `DELETE` したら、統合されていた両方の主キーが削除される。
 *   この操作でアプリの表から消えた行（`recreated` を含む）ごとに、その後ろに隠れていた
 *   主キーの Max が削除の版になっていることを見る
 * - **原則4**（付則3 の前半）: 親行を `DELETE` したクライアントにその時点であった子行は、
 *   SQLite が `ON DELETE` に従って削除し、その削除は変更として複製される。そこで、
 *   この操作でアプリの表から消えた行（消してすぐ作り直した行を除く）ごとに、その主キーの
 *   Max が削除の版になっていることを見る。子行に削除の版が無いと、親行を書き直したときに
 *   子行が戻る
 *
 * どちらも、収束や参照実装との突き合わせでは見えない壊れ方を捕まえる。全端末が同じように
 * 壊れて一致してしまい、しかも何が統合されていたか・いつ実行したかは発行した操作の列から
 * 決められない（tools/explore/oracles/from-history.ts）ので、参照実装も突き合わせを見送る。
 *
 * **時計 C へ書き換える前に呼ぶこと**（実行した時刻と比べるので、壁時計の値が要る）。
 *
 * @param recreated この操作で消してすぐ作り直した行（表, 表示上の id）。アプリの表には
 *   残っているが、一度消えている
 * @returns 違反の説明（空なら違反なし）
 */
export function checkDeletionPrinciples(
  db: Database.Database,
  tables: readonly string[],
  witness: DeletionWitness,
  recreated: { table: string; id: string }[]
): string[] {
  const failures: string[] = []
  deletionValues ??= new ValueOracle()
  const values = deletionValues

  // 原則2
  for (const row of db
    .prepare(
      `SELECT tableName, recordId, deletedAt, _sns_ts FROM _tombstone WHERE _sns_lamport > ?`
    )
    .all(witness.lamport) as {
    tableName: string
    recordId: string
    deletedAt: SqlValue
    _sns_ts: SqlValue
  }[]) {
    if (values.compareTs(row._sns_ts, row.deletedAt) < 0) {
      failures.push(
        `原則2 違反: ${row.tableName}:${row.recordId} の削除の版の _sns_ts（${String(row._sns_ts)}）が、` +
          `削除を実行した時刻（${String(row.deletedAt)}）より弱い`
      )
    }
  }

  const strongestOf = (table: string, trueId: string): Version | null => {
    let strongest: Version | null = null
    for (const version of collectVersions(db, 'self', [table])) {
      if (values.idKey(version.id) !== trueId) continue
      if (
        strongest === null ||
        compareVersions(values, strongest, version) < 0
      ) {
        strongest = version
      }
    }
    return strongest
  }

  // 原則3・原則4
  const deleted = new Map<string, Set<string>>()
  for (const table of tables) {
    const before = witness.shown.get(table) ?? new Map<string, string>()
    const after = visibleRows(db, table)
    const gone = new Set<string>()
    for (const [displayId, trueId] of before) {
      if (after.has(displayId)) continue
      gone.add(trueId)
      // 原則4: 消えた行（`ON DELETE CASCADE` で消えた子行を含む）は削除の版を持つ
      const strongest = strongestOf(table, trueId)
      if (strongest === null || strongest.kind !== 'delete') {
        failures.push(
          `原則4 違反: ${table}:${trueId} がこの操作でアプリの表から消えたのに、` +
            `Max が削除の版でない（${strongest === null ? '版が無い' : '行の版'}）`
        )
      }
    }
    for (const entry of recreated) {
      if (entry.table !== table) continue
      const trueId = before.get(entry.id)
      if (trueId !== undefined) gone.add(trueId)
    }
    deleted.set(table, gone)
  }
  for (const entry of witness.hidden) {
    if (!(deleted.get(entry.table)?.has(entry.winnerId) ?? false)) continue
    const strongest = strongestOf(entry.table, entry.trueId)
    if (strongest === null || strongest.kind !== 'delete') {
      failures.push(
        `原則3 違反: ${entry.table}:${entry.winnerId} を消したのに、統合されていた ` +
          `${entry.table}:${entry.trueId} が消えていない（Max が ${strongest === null ? '無い' : '行の版'}）`
      )
    }
  }
  return failures
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
  const vanish = new JudgmentLedger()
  vanish.observe([version('a', 2, '2026-01-01T00:00:01.000Z', 't2')], 'a')
  check('判定6 版が消えれば違反', vanish.observe([], 'a').length, 1)
  const regress = new JudgmentLedger()
  regress.observe([version('a', 2, '2026-01-01T00:00:01.000Z', 't2')])
  check(
    '判定6 弱くなれば違反',
    regress.observe([version('a', 1, '2026-01-01T00:00:00.000Z', 't1')]).length,
    1
  )

  // 判定7: 制約を満たす表では黙り、壊れた表では言う
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sqlite = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Sqlite(':memory:')
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
