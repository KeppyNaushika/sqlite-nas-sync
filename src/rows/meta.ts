/**
 * `_sync_meta` の「案A の鍵」（設計書 `docs/rows-table-design.md` §3.1）。
 *
 * | 鍵 | 中身 |
 * | --- | --- |
 * | `sns.instanceId` | いまの `setupSync` の端末の id（`crypto.randomBytes(16)`） |
 * | `sns.generation` | `copyToNas` の前に +1 する値 |
 * | `sns.lastInstance` | 自分が最後に NAS の写しへ書いたときの `instanceId` |
 * | `sns.lastLamport` | 同じく、そのときの `lamport` |
 *
 * **鍵の名前は固定**（§3.1 の H）。後ろ2つは §3.10 の「復元・巻き戻り」と
 * 「写しの取り合い」の判定に使うので、綴りが端末ごとに違うと検出が効かない。
 *
 * **段階4 ではまだ `setupSync` / `performSync` から呼ばれない**（切り替えは段階5）。
 *
 * @module rows/meta
 * @internal
 */
import * as crypto from 'crypto'
import Database from 'better-sqlite3'
import { foldIdentifier } from '../setup/sql'

/** `_sync_meta` に置く案A の鍵（設計書 §3.1）。 */
export const SNS_META_KEYS = {
  instanceId: 'sns.instanceId',
  generation: 'sns.generation',
  lastInstance: 'sns.lastInstance',
  lastLamport: 'sns.lastLamport',
  deleteProtected: 'sns.deleteProtected',
} as const

/** {@link SNS_META_KEYS} の値の型。 */
type SnsMetaKey = (typeof SNS_META_KEYS)[keyof typeof SNS_META_KEYS]

/**
 * 端末の id を1つ作る（設計書 §3.2）。
 *
 * `setupSync` のたびに作り直す。使い回すと、**復元された DB が
 * 同じ `instanceId` で同じ lamport を名乗り直す**ことになり、
 * 不変条件 U（`(t, k, iid, L, 種類)` が版を一意に定める）が破れる。
 */
export function newInstanceId(): string {
  return crypto.randomBytes(16).toString('hex')
}

/** `_sync_meta` が無ければ作る（冪等）。 */
export function ensureSyncMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

/** `_sync_meta` の1つの鍵を読む。表も鍵も無ければ `null`。 */
export function readSnsMeta(
  db: Database.Database,
  key: SnsMetaKey | string
): string | null {
  try {
    const row = db
      .prepare(`SELECT value FROM _sync_meta WHERE key = ?`)
      .get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch {
    // `_sync_meta` がまだ無い DB（旧版より前）。無いことと空であることを
    // 呼ぶ側で区別する必要が無いので、例外にはしない
    return null
  }
}

/** `_sync_meta` の1つの鍵を読んで整数にする。読めなければ `null`。 */
export function readSnsMetaNumber(
  db: Database.Database,
  key: SnsMetaKey | string
): number | null {
  const text = readSnsMeta(db, key)
  if (text === null) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** `_sync_meta` の1つの鍵を書く（`_sync_meta` が無ければ作る）。 */
export function writeSnsMeta(
  db: Database.Database,
  key: SnsMetaKey | string,
  value: string | number
): void {
  ensureSyncMetaTable(db)
  // **同じ値なら書かない**（`WHERE`）。値が変わらないのに毎回書き換えると、
  // 「この同期で手元は動いたか」が見分けられなくなる（`src/sync/idle.ts`）
  db.prepare(
    `INSERT INTO _sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value
      WHERE value <> excluded.value`
  ).run(key, String(value))
}

/* ------------------------------------------------------------------ *
 * `deleteProtected`（削除の版が表示の計算で勝たない表）
 * ------------------------------------------------------------------ */

/** 名前と `deleteProtected` だけを見る、表の指定の最小形。 */
interface DeleteProtectedSpec {
  name: string
  deleteProtected?: boolean
}

/**
 * `sns.deleteProtected` に書く字面。
 *
 * **綴りを畳んで、並べ替えて、`,` でつなぐ。** 端末ごとに綴りや並びが違っても
 * 同じ設定なら同じ字面になるようにしないと、食い違いの検出が空振りする。
 */
export function encodeDeleteProtected(
  tables: readonly DeleteProtectedSpec[]
): string {
  const names = new Set<string>()
  for (const table of tables) {
    if (table.deleteProtected === true) names.add(foldIdentifier(table.name))
  }
  return [...names].sort().join(',')
}

/** `sns.deleteProtected` を書く。 */
export function writeDeleteProtected(
  db: Database.Database,
  tables: readonly DeleteProtectedSpec[]
): void {
  writeSnsMeta(db, SNS_META_KEYS.deleteProtected, encodeDeleteProtected(tables))
}

/**
 * `sns.deleteProtected` の字面。鍵が無ければ `null`。
 *
 * `null`（鍵が無い）と `''`（守る表が1つも無い）は**別物**である。前者は
 * 「この端末の設定が分からない」で、食い違いの警告を出す材料にならない。
 */
export function readDeleteProtectedRaw(db: Database.Database): string | null {
  return readSnsMeta(db, SNS_META_KEYS.deleteProtected)
}

/**
 * 削除から守る表の集合（畳んだ綴り）。
 *
 * 作り直しの計算（`rebuild-plan`）は、渡された設定ではなく**この DB に
 * 書いてある設定**を読む。ワーカーで計算するときも同じ答えになるようにするため。
 */
export function readDeleteProtectedTables(db: Database.Database): Set<string> {
  const raw = readDeleteProtectedRaw(db)
  if (raw === null || raw === '') return new Set()
  return new Set(raw.split(',').filter((name) => name !== ''))
}

/** `_sns_clock.lamport`。行が無ければ `null`（§3.10 の「仕掛けの欠け」）。 */
export function readClockLamport(db: Database.Database): number | null {
  try {
    const row = db.prepare(`SELECT lamport FROM _sns_clock`).get() as
      { lamport: number | bigint } | undefined
    return row === undefined ? null : Number(row.lamport)
  } catch {
    return null
  }
}

/** `_sns_clock.instanceId`。行が無ければ `null`。 */
export function readClockInstanceId(db: Database.Database): string | null {
  try {
    const row = db.prepare(`SELECT instanceId FROM _sns_clock`).get() as
      { instanceId: string } | undefined
    return row?.instanceId ?? null
  } catch {
    return null
  }
}
