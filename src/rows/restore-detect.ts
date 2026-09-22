/**
 * 外部での複製・復元・書き換えの検出（設計書 `docs/rows-table-design.md` §3.10）。
 *
 * 案A は「手元の lamport は二度と後戻りしない」ことに寄りかかっている。
 * ファイルを丸ごと差し替えられると、その約束だけが黙って破れる ——
 * 同じ `instanceId` で同じ lamport が名乗り直され、**中身の違う2つの版が
 * 同じ鍵**を持つ（不変条件 U の破れ）。ここで見るのは3つである。
 *
 * | 検出 | 条件 | いつ見るか |
 * | --- | --- | --- |
 * | 復元・巻き戻り | NAS 上の**自分の写し**の `sns.lastLamport` より手元の `lamport` が小さい、または `sns.generation` が写しより小さい | その同期回の**取り込みより前**（H） |
 * | 仕掛けの欠け | トリガーが無い・`_sns_clock` の行が無い・`_sns_tick` の行が足りない・`_sns_rebuilding` に行が残っている | `setupSync` と同期の段階0 |
 * | 写しの取り合い | NAS 上の自分の写しの `sns.instanceId` が自分のものでない | **その回に自分が写しを書いたあと**だけ |
 *
 * **取り込みより前に見る理由**（H）: 取り込みは `_sns_clock.lamport` を相手の値まで
 * 引き上げる。引き上げたあとで比べると、巻き戻った手元の lamport が写しの値を
 * 追い越してしまい、**証拠が消える**。
 *
 * **写しを書いたあとだけ見る理由**: `instanceId` は `setupSync` のたびに作り直すので、
 * 前回の自分が書いた写しの `instanceId` は当然いまの自分と違う。自分が書いた
 * 直後に読んで初めて、「自分以外が同じファイル名へ書いている」ことが言える。
 *
 * **段階4 ではまだ `performSync` から呼ばれない**（切り替えるのは段階5）。
 *
 * @module rows/restore-detect
 * @internal
 */
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { openRemoteDbViaLocalCopy } from '../nas'
import { escapeIdentifier } from '../setup/sql'
import {
  SNS_META_KEYS,
  readClockInstanceId,
  readClockLamport,
  readSnsMeta,
  readSnsMetaNumber,
  writeSnsMeta,
} from './meta'
import { RowsTableSpec, VERSION_COLUMNS, rowsTableName } from './schema'
import { canonicalTableSpecs } from './table-name'
import { rowsTriggerNames } from './triggers'

/* ------------------------------------------------------------------ *
 * 仕掛けの欠け
 * ------------------------------------------------------------------ */

/** 仕掛けの欠けの種類。 */
type RowsMachineryIssueKind =
  | 'missing-rows-table'
  | 'missing-trigger'
  | 'missing-clock-row'
  | 'missing-tick-row'
  | 'missing-tombstone-columns'
  | 'rebuilding-leftover'

/** 見つかった欠け1つ。 */
interface RowsMachineryIssue {
  kind: RowsMachineryIssueKind
  /** その表（表に依らない欠けでは `undefined`） */
  table?: string
  /** 無かったものの名前（トリガー名など） */
  name?: string
  message: string
}

/** {@link checkRowsMachinery} の結果。 */
interface RowsMachineryReport {
  issues: RowsMachineryIssue[]
  /** 何か足りない（`setupSync` で作り直すべき） */
  needsRepair: boolean
  /** `_sns_rebuilding` に行が残っている */
  rebuildingLeftover: boolean
}

/**
 * 仕掛けが揃っているかを見る（設計書 §3.10）。**直しはしない**。
 *
 * ここを黙って通すと、トリガーが消えた DB では**アプリの書き込みが1つも
 * 事実にならない**まま同期が回り続け、他端末から見て「何も変えていない端末」に
 * なる。`_sns_clock` の行が無い場合はアプリの書き込みが NOT NULL で落ちるので
 * 気づけるが、旗の残りは静かなので必ず見る。
 */
export function checkRowsMachinery(
  db: Database.Database,
  tables: (RowsTableSpec | string)[]
): RowsMachineryReport {
  const issues: RowsMachineryIssue[] = []
  // 表の名前は境界で畳む（段階3 からの申し送り）
  const specs = canonicalTableSpecs(db, tables)

  if (!tableExists(db, '_sns_clock') || readClockLamport(db) === null) {
    issues.push({
      kind: 'missing-clock-row',
      message:
        `_sns_clock に行が無い。このままではアプリの書き込みが NOT NULL で落ちる` +
        `（lamport を 0 から数え直さないための形。§3.2）`,
    })
  }

  const triggerNames = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
        .all() as { name: string }[]
    ).map((row) => row.name)
  )
  for (const spec of specs) {
    if (!tableExists(db, rowsTableName(spec.name))) {
      issues.push({
        kind: 'missing-rows-table',
        table: spec.name,
        name: rowsTableName(spec.name),
        message: `${rowsTableName(spec.name)} が無い`,
      })
    }
    for (const name of rowsTriggerNames(spec.name)) {
      if (triggerNames.has(name)) continue
      issues.push({
        kind: 'missing-trigger',
        table: spec.name,
        name,
        message:
          `トリガー ${name} が無い。` +
          `このままではこの表への書き込みが1つも事実にならない`,
      })
    }
    if (!hasTickRow(db, spec.name)) {
      issues.push({
        kind: 'missing-tick-row',
        table: spec.name,
        message:
          `_sns_tick に ${spec.name} の行が無い。` +
          `作り直しの token が立たず、計算のあいだの書き込みを取りこぼす`,
      })
    }
  }

  // `_tombstone` に版の3列が無いと、**アプリの DELETE がその場で落ちる**
  // （トリガーが `_sns_ts` へ書こうとする）。外で `_tombstone` を作り直した
  // DB がこの形になる
  const tombstoneMissing = missingTombstoneColumns(db)
  if (tombstoneMissing.length > 0) {
    issues.push({
      kind: 'missing-tombstone-columns',
      name: tombstoneMissing.join(', '),
      message:
        `_tombstone に版の列 ${tombstoneMissing.join(', ')} が無い。` +
        `このままでは削除のトリガーが落ち、アプリの DELETE ごと失敗する`,
    })
  }

  const rebuildingLeftover = countRebuildingRows(db) > 0
  if (rebuildingLeftover) {
    issues.push({
      kind: 'rebuilding-leftover',
      message:
        `_sns_rebuilding に行が残っている。前回の作り直しが途中で落ちた可能性がある。` +
        `残っている間、アプリの書き込みは1つも事実にならない（§3.10 の I）`,
    })
  }
  return { issues, needsRepair: issues.length > 0, rebuildingLeftover }
}

/**
 * `_sns_rebuilding` の残りを消す（§3.10 の I）。消したら `true`。
 *
 * **トリガーを作る前に**呼ぶこと。旗が立ったままトリガーを作ると、番人が
 * 効いて何も事実にならないまま、警告も出ずに同期が回る。
 */
export function clearRebuildingFlag(db: Database.Database): boolean {
  if (!tableExists(db, '_sns_rebuilding')) return false
  return db.prepare(`DELETE FROM _sns_rebuilding`).run().changes > 0
}

/* ------------------------------------------------------------------ *
 * 復元・巻き戻り・写しの取り合い
 * ------------------------------------------------------------------ */

/** NAS 上の自分の写しの在りか。 */
interface RowsCopyLocation {
  /** NAS の共有ディレクトリ */
  nasPath: string
  /** 自分のクライアント id（写しは `client-<id>.sqlite`） */
  clientId: string
  /** 一時コピーを置くディレクトリ（省略すると `os.tmpdir()` 配下） */
  tmpDir?: string
}

/** 復元・巻き戻りの種類。 */
type RowsRestoreIssueKind =
  'lamport-behind-copy' | 'generation-behind-copy' | 'copy-unreadable'

/** 見つかった巻き戻り1つ。 */
interface RowsRestoreIssue {
  kind: RowsRestoreIssueKind
  message: string
}

/** {@link checkRestoreBeforeImport} の結果。 */
interface RowsRestoreReport {
  issues: RowsRestoreIssue[]
  /** 復元・巻き戻りと判断した（`lamport` か `generation` が写しより後ろ） */
  restored: boolean
  /** 写しがそもそも無かった（初回起動） */
  copyMissing: boolean
  localLamport: number | null
  localGeneration: number | null
  copyLastLamport: number | null
  copyGeneration: number | null
}

/**
 * 復元・巻き戻りを見る（設計書 §3.10）。**その同期回の取り込みより前に呼ぶこと。**
 *
 * 比べる相手は NAS 上の**自分の**写しである。他端末の写しと比べても意味が無い
 * （lamport は端末ごとの数え上げで、大小に意味が無い）。
 *
 * 写しが無ければ何も言わない —— 初回起動がそれで、誤検出してはいけない。
 */
export function checkRestoreBeforeImport(
  db: Database.Database,
  location: RowsCopyLocation
): RowsRestoreReport {
  const report: RowsRestoreReport = {
    issues: [],
    restored: false,
    copyMissing: false,
    localLamport: readClockLamport(db),
    localGeneration: readSnsMetaNumber(db, SNS_META_KEYS.generation),
    copyLastLamport: null,
    copyGeneration: null,
  }
  const filePath = selfCopyPath(location)
  if (!fs.existsSync(filePath)) {
    report.copyMissing = true
    return report
  }
  const handle = openRemoteDbViaLocalCopy(filePath, location.tmpDir)
  if (handle === null) {
    report.issues.push({
      kind: 'copy-unreadable',
      message:
        `NAS 上の自分の写し ${filePath} が読めない。` +
        `巻き戻りの判定ができないので、この回は復元の有無を言えない`,
    })
    return report
  }
  try {
    report.copyLastLamport = readSnsMetaNumber(
      handle.db,
      SNS_META_KEYS.lastLamport
    )
    report.copyGeneration = readSnsMetaNumber(
      handle.db,
      SNS_META_KEYS.generation
    )
  } finally {
    handle.cleanup()
  }

  const local = report.localLamport
  if (
    local !== null &&
    report.copyLastLamport !== null &&
    local < report.copyLastLamport
  ) {
    report.restored = true
    report.issues.push({
      kind: 'lamport-behind-copy',
      message:
        `手元の lamport (${local}) が、NAS 上の自分の写しに残した値 ` +
        `(${report.copyLastLamport}) より小さい。DB が復元されたか、` +
        `外で巻き戻された可能性がある（§3.10）`,
    })
  }
  const generation = report.localGeneration
  if (
    generation !== null &&
    report.copyGeneration !== null &&
    generation < report.copyGeneration
  ) {
    report.restored = true
    report.issues.push({
      kind: 'generation-behind-copy',
      message:
        `手元の sns.generation (${generation}) が、NAS 上の自分の写しの値 ` +
        `(${report.copyGeneration}) より小さい。DB が復元された可能性がある（§3.10）`,
    })
  }
  return report
}

/** {@link checkCopyOwnership} の結果。 */
interface RowsCopyOwnershipReport {
  /** 自分以外が同じファイル名へ書いている */
  taken: boolean
  /** 写しに載っていた `sns.instanceId`（読めなければ `null`） */
  copyInstanceId: string | null
  /** 自分の `sns.instanceId` */
  instanceId: string
  message?: string
}

/**
 * 写しの取り合いを見る（設計書 §3.10）。**その回に自分が写しを書いたあとだけ**呼ぶこと。
 *
 * `instanceId` は `setupSync` のたびに作り直すので、**前回の自分**が書いた写しの
 * `instanceId` はいまの自分と一致しない。書いた直後に読んで初めて、
 * 「同じ `client-<id>.sqlite` へ別の端末が書いている」ことが言える。
 *
 * 取り合いが起きていたら**同期を止める** —— 2台が同じクライアント id を名乗ると、
 * 互いの写しを上書きし合って、どちらの事実も相手へ届かない。
 */
export function checkCopyOwnership(
  db: Database.Database,
  location: RowsCopyLocation,
  instanceId?: string
): RowsCopyOwnershipReport {
  const mine =
    instanceId ??
    readSnsMeta(db, SNS_META_KEYS.instanceId) ??
    readClockInstanceId(db) ??
    ''
  const report: RowsCopyOwnershipReport = {
    taken: false,
    copyInstanceId: null,
    instanceId: mine,
  }
  const filePath = selfCopyPath(location)
  if (!fs.existsSync(filePath)) return report
  const handle = openRemoteDbViaLocalCopy(filePath, location.tmpDir)
  if (handle === null) return report
  try {
    report.copyInstanceId =
      readSnsMeta(handle.db, SNS_META_KEYS.instanceId) ??
      readClockInstanceId(handle.db)
  } finally {
    handle.cleanup()
  }
  if (report.copyInstanceId !== null && report.copyInstanceId !== mine) {
    report.taken = true
    report.message =
      `NAS 上の自分の写し ${filePath} の sns.instanceId が ` +
      `${report.copyInstanceId} になっている（自分は ${mine}）。` +
      `同じクライアント id を名乗る端末が他にある。同期を止めること（§3.10）`
  }
  return report
}

/**
 * 写しを書く直前の印（設計書 §3.1・§4.1 の段階2）。
 *
 * `sns.generation` を +1 し、`sns.lastInstance` / `sns.lastLamport` に
 * 「いま写しへ入る値」を書く。**`copyToNas` の前に**呼ぶこと —— 写しの中に
 * この印が入っていないと、次の起動で比べる相手が無い。
 */
export function markBeforeCopy(
  db: Database.Database,
  instanceId?: string
): { generation: number; lamport: number; instanceId: string } {
  const mine =
    instanceId ??
    readSnsMeta(db, SNS_META_KEYS.instanceId) ??
    readClockInstanceId(db) ??
    ''
  const generation = (readSnsMetaNumber(db, SNS_META_KEYS.generation) ?? 0) + 1
  const lamport = readClockLamport(db) ?? 0
  writeSnsMeta(db, SNS_META_KEYS.generation, generation)
  writeSnsMeta(db, SNS_META_KEYS.lastInstance, mine)
  writeSnsMeta(db, SNS_META_KEYS.lastLamport, lamport)
  return { generation, lamport, instanceId: mine }
}

/* ------------------------------------------------------------------ *
 * 小道具
 * ------------------------------------------------------------------ */

/** NAS 上の自分の写しのパス（`copyToNas` が作る名前と同じ形）。 */
export function selfCopyPath(location: RowsCopyLocation): string {
  return path.join(location.nasPath, `client-${location.clientId}.sqlite`)
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}

function hasTickRow(db: Database.Database, table: string): boolean {
  if (!tableExists(db, '_sns_tick')) return false
  return (
    db.prepare(`SELECT 1 FROM _sns_tick WHERE tableName = ?`).get(table) !==
    undefined
  )
}

/** `_tombstone` に足りない版の列（設計書 §3.1）。表が無ければ空。 */
function missingTombstoneColumns(db: Database.Database): string[] {
  if (!tableExists(db, '_tombstone')) return []
  const existing = new Set(
    (db.pragma(`table_info(_tombstone)`) as { name: string }[]).map(
      (column) => column.name
    )
  )
  return Object.values(VERSION_COLUMNS).filter(
    (column) => !existing.has(column)
  )
}

function countRebuildingRows(db: Database.Database): number {
  if (!tableExists(db, '_sns_rebuilding')) return 0
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${escapeIdentifier('_sns_rebuilding')}`)
    .get() as { n: number | bigint }
  return Number(row.n)
}
