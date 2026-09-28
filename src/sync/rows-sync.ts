/**
 * 同期1回の流れ（設計書 `docs/rows-table-design.md` §4.1）。
 *
 * 1回の `performSync` はこう進む:
 *
 * | 段階 | 内容 |
 * | --- | --- |
 * | 0 | `writeSchemaVersion`。**取り込みより前**に §3.10 の復元・巻き戻りの判定。仕掛けの欠けの確認と手当て |
 * | 1 | 相手の列挙と、隙間の事前確認 |
 * | 2 | 隙間なし: 印 → 写し → 取り合いの確認 → 相手ごとに取り込み → 作り直し。隙間あり: 取り込み → 作り直し → 印 → 写し → 取り合いの確認 |
 * | 3〜5 | `cleanupChangelog`、`onAfterSync` |
 *
 * **やっても何も変わらない転送はしない**（`sync/idle`）。段階1 で相手のファイルの
 * 素性（`stat`）を見て、前に読んだときのままなら写さない。段階2 で手元の印を見て、
 * 前に上げたときのままなら上げない。段階0 の復元の判定も、NAS 上の自分の写しが
 * 自分の書いたままなら省く。起動直後・前回の失敗・版の変化・一定回数ごとは必ず行う。
 * 相手の写しを手元へ写すのは、**1回の同期で相手1人につき高々1回**である。
 *
 * **取り込みと作り直しは別のトランザクション**である（§4.3・§3.7.2）。取り込みは
 * `_sns_rows_*` などの帳簿にしか書かないのでアプリの制約で失敗しえないが、
 * 作り直しはアプリの表を入れ替えるので失敗しうる。1つにまとめると、作り直しの
 * 失敗が取り込みごと巻き戻し、相手からの事実が永久に入らなくなる。
 *
 * @module sync/rows-sync
 * @internal
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULTS,
  RecordFold,
  SyncConfig,
  SyncResult,
  SyncTransfers,
  TableConfig,
} from '../types'
import {
  cleanupChangelog,
  describeChangelogPruneWall,
  fullMergeCursor,
  hasChangelogGap,
  normalizeRetentionDays,
  readChangelog,
} from '../changelog'
import {
  FileStamp,
  RemoteDbHandle,
  copyToNas,
  ensureDirectory,
  fileSize,
  fileStamp,
  listRemoteClients,
  openRemoteDbViaLocalCopy,
} from '../nas'
import {
  IdleMemory,
  canSkipPush,
  forgetPushIfChanged,
  totalChanges,
  canSkipRemoteRead,
  canSkipRestoreCheck,
  createIdleMemory,
  localMetaFingerprint,
  localPushFingerprint,
  readWouldBeNoOp,
} from './idle'
import { readSchemaVersion, writeSchemaVersion } from '../setup/schema-version'
import { getSyncState, recordSkippedRemote, updateSyncState } from './state'
import { ROWS_FORMAT, RowsImportKey, importFromPeer } from '../rows/import'
import {
  RowsRebuildHooks,
  RowsRebuildState,
  createRebuildState,
  rebuildOnce,
  rebuildOnceInWorker,
} from '../rows/rebuild'
import {
  checkRestoreBeforeImport,
  checkRowsMachinery,
  clearRebuildingFlag,
  checkCopyOwnership,
  markBeforeCopy,
  selfCopyPath,
} from '../rows/restore-detect'
import { migrateToRows } from '../rows/migrate'
import {
  RowsTableSpec,
  VERSION_COLUMNS,
  primaryKeyColumn,
  rowsTableName,
} from '../rows/schema'
import { escapeIdentifier } from '../setup/sql'
import { SNS_META_KEYS, readSnsMeta } from '../rows/meta'

/**
 * `SyncInstance` が全体で1つ持つ記憶（設計書 §3.7.4）。
 *
 * 見送りの回数と、外部キーの違反で対象から外した表を**同期をまたいで**覚える。
 * 毎回作り直すと、見送りがいくら続いても k 回目の合流経路へ入れない。
 */
export interface RowsSyncRuntime {
  /** 作り直しの記憶（見送りの回数・除外の表）。同期をまたいで持ち回る */
  rebuild: RowsRebuildState
  /** この `setupSync` の端末の id（`sns.instanceId`） */
  instanceId?: string
  /** 試験のための差し込み口。作り直しの計算に使うワーカーの位置（省略すると `dist` の隣） */
  workerPath?: string
  /** 試験のための差し込み口。ワーカーを使わず主スレッドで計算する（試験・検査器） */
  forceMainThread?: boolean
  /**
   * 無駄な転送を落とすための覚え（`sync/idle`）。同期をまたいで持ち回る。
   *
   * **渡さなければ毎回まっさらになり、抑制は効かない**（起動直後と同じ扱い）。
   * `setupSync` は `SyncInstance` が1つ持つものを渡す
   */
  idle?: IdleMemory
  /**
   * 試験と網羅検査器のための、作り直しの差し込み口（設計書 §8.2）。
   * **公開 API ではない**ので `SyncConfig` には出さない。
   * 検査器は設計書 §8.1 の判定8・10・13・20・21 をこれで当てる
   */
  hooks?: RowsRebuildHooks
}

/** 同期を1回行う。 */
export async function performRowsSync(
  localDb: Database.Database,
  config: SyncConfig,
  tables: TableConfig[],
  runtime?: RowsSyncRuntime
): Promise<SyncResult> {
  const state = runtime ?? { rebuild: createRebuildState() }
  const configuredRetentionDays =
    config.changelogRetentionDays ?? DEFAULTS.changelogRetentionDays
  const retentionDays = normalizeRetentionDays(configuredRetentionDays)
  const specs: RowsTableSpec[] = tables.map((table) => ({
    name: table.name,
    timestampColumn: table.timestampColumn,
  }))
  const tableNames = specs.map((spec) => spec.name)

  // 抑制の覚え。渡されなければこの回だけのまっさらなもの（＝起動直後と同じ扱いで、
  // 何も落とさない）
  const idle = state.idle ?? createIdleMemory(config.suppressIdleSync ?? true)
  idle.syncCount += 1

  const transfers: SyncTransfers = {
    uploads: 0,
    uploadsSkipped: 0,
    peerReads: 0,
    peerReadsSkipped: 0,
    selfReads: 0,
    bytes: 0,
  }

  const result: SyncResult = {
    transfers,
    clientsSynced: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    conflictsResolved: 0,
    folds: [],
    restores: [],
    parentDeleted: [],
    parentReturned: [],
    warnings: [],
    skippedRemotes: [],
    hadChangelogGap: false,
  }
  if (retentionDays !== configuredRetentionDays) {
    result.warnings.push(
      `changelogRetentionDays: ${String(configuredRetentionDays)} is not a usable ` +
        `number of days, falling back to ${retentionDays}.`
    )
  }

  /* -------------------------------------------------------------- *
   * 段階 0
   * -------------------------------------------------------------- */
  // `_sync_meta.schemaVersion` は `<アプリの版>;sns-format=rows1` の形で持つ（§3.8）。
  // 相手の見送りの判定は、この**文字列ぜんたい**の一致で行う（§4.2）ので、
  // 比べる値も書く値もここで1つに決める
  const schemaVersion = config.schemaVersion
    ? withRowsFormat(config.schemaVersion)
    : undefined
  if (schemaVersion) writeSchemaVersion(localDb, schemaVersion)

  const location = { nasPath: config.nasPath, clientId: config.clientId }
  // 自分の写しの**素性**（`stat` 1回）。中身は読まない。
  // ここが前に上げたときのままなら、その写しは自分が書いたものだと分かるので
  // 復元の判定は省ける。違っていれば、誰かが同じ名前へ書いている
  const selfPath = selfCopyPath(location)
  const selfStamp = fileStamp(selfPath)
  const selfStampChanged =
    idle.push?.selfStamp != null && idle.push.selfStamp !== selfStamp

  // (H) 取り込みより前に見る。取り込みが lamport を引き上げると証拠が消える
  let restored = false
  if (!canSkipRestoreCheck(idle, selfStamp)) {
    const hadCopy = existsSync(selfPath)
    const restore = checkRestoreBeforeImport(localDb, location)
    if (hadCopy) {
      transfers.selfReads += 1
      transfers.bytes += fileSize(selfPath)
    }
    restored = restore.restored
    for (const issue of restore.issues) result.warnings.push(issue.message)
  }

  const machinery = checkRowsMachinery(localDb, specs)
  if (machinery.needsRepair) {
    // 欠けを1件ずつ並べると、トリガーが消えただけでも表の数×4本ぶんの警告が
    // 出て、他の知らせが埋もれる。**数と代表の1件**にまとめ、静かだと困る
    // 「旗の残り」だけは必ず書く（§3.10 の I）
    const first = machinery.issues[0]
    result.warnings.push(
      `同期の仕組み（内部テーブルの行・トリガー）が ${machinery.issues.length} 件欠けている（例: ${first.message}）`
    )
    if (machinery.rebuildingLeftover) {
      const leftover = machinery.issues.find(
        (issue) => issue.kind === 'rebuilding-leftover'
      )
      if (leftover) result.warnings.push(leftover.message)
    }
    // 旗の残りは**トリガーを作る前に**消す（§3.10 の I）
    clearRebuildingFlag(localDb)
    const migration = migrateToRows(localDb, {
      tables: specs,
      instanceId: state.instanceId,
      appSchemaVersion: appPartOf(config.schemaVersion),
    })
    for (const warning of migration.warnings) result.warnings.push(warning)
    result.warnings.push(
      `欠けていた同期の仕組みを作り直した（${migrationWording(migration.from)}）`
    )
  }
  const instanceId =
    state.instanceId ?? readSnsMeta(localDb, SNS_META_KEYS.instanceId) ?? ''

  // 版が変わったら、相手の覚えを捨てて全員読み直す。
  // 見送りの判定は、これと相手の中身の突き合わせで決まる
  const metaFingerprint = localMetaFingerprint(schemaVersion)
  if (idle.localMeta !== metaFingerprint) {
    idle.peers.clear()
    idle.localMeta = metaFingerprint
  }

  /* -------------------------------------------------------------- *
   * 段階 1 —— 相手の列挙と隙間の事前確認
   *
   * **相手の写しを手元へ写すのは、1回の同期で相手1人につき1回だけ。**
   * ここで開いた写しを段階2 の取り込みまで持ち回る。
   * 隙間の判定と取り込みが同じ写しを読むので、途中で相手が書き直しても、隙間なしと見た相手から隙間のある中身を読むことは無い。
   * -------------------------------------------------------------- */
  ensureDirectory(config.nasPath)
  const remoteClients = listRemoteClients(config.nasPath, config.clientId)
  const peers: PeerSlot[] = []
  let hasAnyGap = false
  try {
    for (const remote of remoteClients) {
      const stamp = fileStamp(remote.filePath)
      const lastSeenId = getSyncState(localDb, remote.clientId)
      if (canSkipRemoteRead(idle, remote.clientId, stamp, lastSeenId)) {
        // 前に読んだときと同じファイル・同じ読み位置。読んでも何も起きないことは
        // そのとき確かめてある（`readWouldBeNoOp`）ので、写さない
        transfers.peerReadsSkipped += 1
        peers.push({
          remote,
          stamp,
          lastSeenId,
          handle: null,
          gap: false,
          skipped: true,
        })
        continue
      }
      const handle = openRemoteDbViaLocalCopy(remote.filePath)
      transfers.peerReads += 1
      transfers.bytes += fileSize(remote.filePath)
      // 読みに行った相手の覚えは捨てる。取り込みまで通ったときだけ覚え直す
      idle.peers.delete(remote.clientId)
      let gap = false
      if (handle !== null && sameSchema(handle.db, schemaVersion)) {
        gap = needsFullMerge(handle.db, lastSeenId)
        if (gap) hasAnyGap = true
      }
      peers.push({ remote, stamp, lastSeenId, handle, gap, skipped: false })
    }
    result.hadChangelogGap = hasAnyGap

    /* ------------------------------------------------------------ *
     * 段階 2
     * ------------------------------------------------------------ */
    const publish = async (): Promise<boolean> => {
      const fingerprint = localPushFingerprint(localDb, schemaVersion)
      const skip = canSkipPush(idle, {
        fingerprint,
        selfCopyExists: selfStamp !== null || existsSync(selfPath),
        restored,
        selfStampChanged,
      })
      if (skip) {
        transfers.uploadsSkipped += 1
        return true
      }
      // 印 → 写し → 取り合いの確認（§3.10）。**印は写しの前**でなければ、
      // 写しの中に次回比べる値が入らない
      markBeforeCopy(localDb, instanceId)
      // 写す中身が決まった瞬間を覚えておく（`PushMemo.changesAtCopy`）。
      // 写している最中の書き込みは「写しに入っていない」側へ倒したいので、
      // `backup()` を呼ぶ**前**に測る
      const changesAtCopy = totalChanges(localDb)
      const written = await copyToNas(localDb, config.nasPath, config.clientId)
      transfers.uploads += 1
      transfers.bytes += fileSize(selfPath)
      // 上げた覚えは**先に捨てる**。ここから先で落ちたら次の回は必ず上げ直す
      idle.push = null
      const nowStamp = fileStamp(selfPath)
      // 取り合いの確認。`rename` は inode を持ち越すので、いま書いた一時ファイルの
      // 印と、置いたあとのファイルの印が同じなら、その実体は**自分が書いたもの**である。
      // そのときだけ、中身を読みに行かずに済ませる（§3.10 の判定は変わらない）
      const mine = written !== null && nowStamp !== null && written === nowStamp
      if (!mine) {
        const ownership = checkCopyOwnership(localDb, location, instanceId)
        transfers.selfReads += 1
        transfers.bytes += fileSize(selfPath)
        if (ownership.taken) {
          result.warnings.push(
            ownership.message ??
              'NAS 上の自分のコピーを、同じ clientId を使う別のクライアントが書いている'
          )
          return false
        }
      }
      idle.push = { fingerprint, selfStamp: nowStamp, changesAtCopy }
      return true
    }

    const hiddenBefore = snapshotHidden(localDb)
    const unplaceableBefore = snapshotUnplaceable(localDb)

    // 隠れた行の差分は**作り直しの直後**に取る。写しの `await` を挟むと、その間に
    // アプリが書いた行まで「統合が解けた」の判定に混ざる。また、写しで止まったときに
    // 差分を載せずに返すと、次の回の「前」はもう新しい状態なので、二度と知らせられない
    if (!hasAnyGap) {
      if (!(await publish())) return stop(localDb, config, result)
      importAll(localDb, peers, schemaVersion, specs, idle, result)
      await rebuild(localDb, config, tableNames, state, result)
      reportHiddenChanges(localDb, hiddenBefore, unplaceableBefore, result)
    } else {
      importAll(localDb, peers, schemaVersion, specs, idle, result)
      await rebuild(localDb, config, tableNames, state, result)
      reportHiddenChanges(localDb, hiddenBefore, unplaceableBefore, result)
      if (!(await publish())) return stop(localDb, config, result)
    }
  } finally {
    for (const peer of peers) peer.handle?.cleanup()
  }

  /* -------------------------------------------------------------- *
   * 段階 3〜5
   * -------------------------------------------------------------- */
  // 案A の `_changelog` は**通知の索引**であって事実そのものではない。
  // 取りこぼした相手は `hasChangelogGap` でフルマージに落ち、相手の
  // `_sns_rows_*` を丸ごと読み直すので、刈っても事実は失われない（§3.9 の G が
  // 「刈らない」と言うのは移行のときの話で、そこでは旧版の端末が `_changelog` の
  // 中身そのものを読んでいた）。刈らずに置くとファイルが際限なく育つので、
  // 通常の運用では従来どおり保持期間で刈る。
  cleanupChangelog(localDb, retentionDays)
  const pruneWall = describeChangelogPruneWall(localDb, retentionDays)
  if (pruneWall) result.warnings.push(pruneWall)

  // 写しを作ってから手元が動いていたら（作り直しが表を入れ替えた、など）、
  // 上げた覚えを捨てて次の回に上げ直す
  forgetPushIfChanged(idle, localDb)

  if (config.onAfterSync) config.onAfterSync(localDb, result)
  return result
}

/** 写しの取り合いで止めるときの出口。 */
function stop(
  localDb: Database.Database,
  config: SyncConfig,
  result: SyncResult
): SyncResult {
  if (config.onAfterSync) config.onAfterSync(localDb, result)
  return result
}

/* ------------------------------------------------------------------ *
 * 取り込み（§4.3）
 * ------------------------------------------------------------------ */

/** 相手1人ぶんの、この回の段取り（段階1 で決めて段階2 で使う）。 */
interface PeerSlot {
  remote: { clientId: string; filePath: string }
  /** 段階1 で見たファイルの印 */
  stamp: FileStamp | null
  /** 段階1 で見た手元の読み位置。まだ一度も読んでいない相手は `null` */
  lastSeenId: number | null
  /** 開いた手。写さなかった／開けなかったときは `null` */
  handle: RemoteDbHandle | null
  /** フルマージで読むか */
  gap: boolean
  /** 写さずに済ませた（前に読んだときから何も変わっていない） */
  skipped: boolean
}

function importAll(
  localDb: Database.Database,
  peers: PeerSlot[],
  schemaVersion: string | undefined,
  specs: RowsTableSpec[],
  idle: IdleMemory,
  result: SyncResult
): void {
  for (const peer of peers) {
    const remote = peer.remote
    try {
      if (peer.skipped) {
        // 読んでも何も起きないと分かっている相手。読んだときと同じだけ数える
        result.clientsSynced += 1
        continue
      }
      const handle = peer.handle
      if (handle === null) {
        result.warnings.push(
          `Failed to open remote database: ${remote.clientId}`
        )
        continue
      }
      const peerDb = handle.db

      // `schemaVersion` が違う相手は丸ごと見送る（§4.2）。
      // `schemaVersion` は `sns-format` を含むので、形式の違う相手もここで見送る
      if (!sameSchema(peerDb, schemaVersion)) {
        const remoteVersion = readSchemaVersion(peerDb)
        recordSkippedRemote(
          result,
          remote.clientId,
          appPartOf(remoteVersion ?? undefined) ?? null,
          appPartOf(schemaVersion) ?? '',
          remoteVersion !== null &&
            appPartOf(remoteVersion) === appPartOf(schemaVersion)
        )
        continue
      }

      const lastSeenId = peer.lastSeenId
      let keys: RowsImportKey[] | undefined
      let cursor: number
      if (peer.gap || lastSeenId === null) {
        // フルマージ。範囲は相手の `_sns_rows_*` と `_tombstone` の全部
        keys = undefined
        cursor = fullMergeCursor(peerDb)
      } else {
        const entries = readChangelog(peerDb, lastSeenId)
        if (entries.length === 0) {
          // 何も無かった。**この回の読みは何も起こしていない**ので、同じファイル・
          // 同じ読み位置なら次の回も同じ。写さずに済ませてよいと覚える
          rememberRead(idle, peer, peerDb, lastSeenId, true)
          result.clientsSynced += 1
          continue
        }
        keys = dedupeKeys(entries)
        cursor = entries[entries.length - 1].id
      }

      const imported = importFromPeer(localDb, peerDb, {
        tables: specs,
        keys,
      })
      // **この取り込みが版を1つでも動かしたか。** 動かしていないなら、同じ
      // ファイルを同じ読み位置でもう一度読んでも動かない（下の `rememberRead`）。
      // `_sns_dirty` に表を載せるのは `Max` が動いたキーがあるときだけなので、
      // `changed` が空なら載せた表も無い。
      // `_sns_clock` の token や lamport の引き上げは数えない —— どちらも
      // 二度目は同じ値で、取り込みの答えを変えないから
      const movedNothing =
        imported.status === 'imported' && imported.changed.length === 0
      if (imported.status === 'skipped') {
        result.warnings.push(
          `Skipped remote ${remote.clientId}: ${imported.reason ?? '不明'}`
        )
        continue
      }
      result.skipped += imported.skipped
      result.conflictsResolved += imported.conflicts
      for (const skippedTable of imported.skippedTables) {
        result.warnings.push(
          `Skipped table ${skippedTable.table}: ${skippedTable.reason}`
        )
      }
      // カーソルは取り込みの**あと**に進める。あいだで落ちてももう一度取り込む
      // だけで、`Max` は単調なので二度目は何も変わらない
      updateSyncState(localDb, remote.clientId, cursor)
      result.clientsSynced += 1
      // ここまで通った相手だけを覚える。取り込んだ**そのあとの**読み位置で
      // 「もう一度読んでも何も起きない」ことを、開いている写しに当てて確かめる
      rememberRead(idle, peer, peerDb, cursor, movedNothing)
    } catch (error) {
      // 失敗した相手は覚えない（次の回は必ず読み直す）
      idle.peers.delete(remote.clientId)
      result.warnings.push(
        `Sync failed for client ${remote.clientId}: ${String(error)}`
      )
    }
  }
}

/**
 * 「この相手は、次の回に写さなくてよい」と覚える。
 *
 * 覚えるのは**確かめたときだけ**で、確かめ方は2つある。
 *
 * 1. {@link readWouldBeNoOp} —— 差分が残っておらず、フルマージも要らない。
 *    もう一度読んでも、取り込みの入口にすら届かない
 * 2. `movedNothing` —— この回の取り込みが**版を1つも動かさなかった**
 *    （`Max` が変わったキーが無い）。フルマージへ
 *    落ちる相手（`_changelog` が空の写しを上げた端末など）はこちらに当たる。
 *    同じファイルを同じ読み位置でもう一度読めば、また何も動かない ——
 *    案A の取り込みは版の `Max` を取るだけで、手元の版は**下がらない**ので、
 *    一度負けた相手の版はその後も負け続ける（§4.3）
 *
 * どちらでもない相手は覚えない。印が同じでも差分が残っている相手を落とすと、
 * 事実が届かなくなる。
 */
function rememberRead(
  idle: IdleMemory,
  peer: PeerSlot,
  peerDb: Database.Database,
  lastSeenId: number,
  movedNothing: boolean
): void {
  if (peer.stamp === null) return
  if (!movedNothing && !readWouldBeNoOp(peerDb, lastSeenId, needsFullMerge)) {
    return
  }
  idle.peers.set(peer.remote.clientId, {
    stamp: peer.stamp,
    lastSeenId,
    verified: true,
  })
}

/** 相手の `_changelog` の行から `(表, 真の id)` の集合を作る（重複は1つに）。 */
function dedupeKeys(
  entries: { tableName: string; recordId: string }[]
): RowsImportKey[] {
  const seen = new Set<string>()
  const keys: RowsImportKey[] = []
  for (const entry of entries) {
    const token = `${entry.tableName}\u0000${entry.recordId}`
    if (seen.has(token)) continue
    seen.add(token)
    keys.push({ table: entry.tableName, key: entry.recordId })
  }
  return keys
}

/**
 * その相手をフルマージで読むか（§4.3 の「隙間あり」）。
 *
 * `hasChangelogGap` の規則に加えて、**まだ一度も読んでいない相手は必ずフルマージにする。**
 * まだ読んでいないことは、`_sync_state` に行が無い（`lastSeenId` が `null`）ことで判断する。
 *
 * 差分の範囲は「相手の `_changelog` の `id > lastSeenId`」だが、相手の
 * `_changelog` は**事実そのものではなく通知の索引**で、掃除でも移行でも短くなる。
 * とくに §3.9 の移行は `_changelog` を作り直すので、移行した端末は
 * 「`_sns_rows_*` には行があるのに、それを知らせるエントリが1つも無い」状態に
 * なりうる。空の `_changelog` を「言うことが無い」と読むと、その端末の行は
 * **誰にも届かないまま**になる（3端末の性質テストが踏んだ）。
 *
 * 一度も読んでいない相手からはどのみち全部要るので、初回をフルマージにすればこの穴は閉じる。
 * 一度読めば `_sync_state` に行ができるので、2回目以降は `hasChangelogGap` の判定に戻る。
 * 一度も書いていない相手は `_changelog` が空で `prunedThroughId` も 0 なので、フルマージのあともカーソルは 0 のままになる。
 * そのため、カーソルが 0 であることを「まだ読んでいない」の印にはできない。
 * 印にすると、その相手を読むたびにフルマージを繰り返す。
 *
 * 行の有無で分けると、「0 まで読んだ相手が、そのあと書いた行の `_changelog` を読まれる前に失った」形は
 * `hasChangelogGap` が拾わなければならない。
 * `_changelog` が空で `prunedThroughId` も 0 のままだと、一度も書いていない相手と見分けが付かない。
 * そのため `hasChangelogGap` は、相手が振った最大の id（`sqlite_sequence`）と残っている id の数も比べる。
 */
function needsFullMerge(
  peerDb: Database.Database,
  lastSeenId: number | null
): boolean {
  if (lastSeenId === null) return true
  return hasChangelogGap(peerDb, lastSeenId)
}

/** 相手の `schemaVersion` が自分と文字列として一致するか（§4.2）。 */
function sameSchema(
  peerDb: Database.Database,
  schemaVersion: string | undefined
): boolean {
  if (!schemaVersion) return true
  return readSchemaVersion(peerDb) === schemaVersion
}

/** 仕組みを作り直したときの知らせに添える、作り直す前の DB の形。 */
function migrationWording(from: 'legacy' | 'fresh' | 'refresh'): string {
  if (from === 'legacy') return '以前のバージョンのライブラリの形式から移行した'
  if (from === 'fresh') return '同期の内部テーブルが無かったので新しく作った'
  return '付け直した'
}

/** アプリの版に `;sns-format=rows1` を付けた形にする（§3.8）。 */
function withRowsFormat(schemaVersion: string): string {
  return `${appPartOf(schemaVersion) as string};sns-format=${ROWS_FORMAT}`
}

/**
 * `<アプリの版>;sns-format=rows1` からアプリの版だけを取り出す。
 *
 * 利用者に見せる版（`SkippedRemote`）はこちらにする。
 * `;sns-format=…` はライブラリの内部の印で、利用者が渡した値でも自動で計算した値でもない。
 */
function appPartOf(schemaVersion: string | undefined): string | undefined {
  if (schemaVersion === undefined) return undefined
  const at = schemaVersion.indexOf(';sns-format=')
  return at < 0 ? schemaVersion : schemaVersion.slice(0, at)
}

/* ------------------------------------------------------------------ *
 * 作り直し（§3.7）
 * ------------------------------------------------------------------ */

async function rebuild(
  localDb: Database.Database,
  config: SyncConfig,
  tableNames: string[],
  runtime: RowsSyncRuntime,
  result: SyncResult
): Promise<void> {
  const workerPath =
    runtime.workerPath ?? join(__dirname, '..', 'rows', 'rebuild-worker.js')
  // ワーカーの入口が組み上がっていない（TypeScript のまま走らせている・
  // 束ねられている）ときは、主スレッドで計算する。黙って落ちるより、
  // 遅くても作り直しが進むほうがよい
  const useWorker = runtime.forceMainThread !== true && existsSync(workerPath)
  const options = {
    tables: tableNames,
    state: runtime.rebuild,
    dbPath: config.dbPath,
    workerPath,
    hooks: runtime.hooks,
  }
  const outcome = useWorker
    ? await rebuildOnceInWorker(localDb, options)
    : rebuildOnce(localDb, options)

  result.inserted += outcome.counts.inserted
  result.updated += outcome.counts.updated
  result.deleted += outcome.counts.deleted
  if (outcome.status === 'deferred') {
    result.warnings.push(
      `Rebuild deferred: ${outcome.reason ?? '不明'}（見送り ${outcome.skips} 回目）`
    )
  }
  if (outcome.status === 'excluded') {
    result.warnings.push(`Rebuild failed: ${outcome.reason ?? '不明'}`)
  }
}

/* ------------------------------------------------------------------ *
 * 隠れた行・置かない行の知らせ（§4.4）
 * ------------------------------------------------------------------ */

function snapshotHidden(db: Database.Database): Map<string, string | null> {
  const seen = new Map<string, string | null>()
  if (!tableExists(db, '_sns_hidden')) return seen
  for (const row of db
    .prepare(`SELECT tableName, trueId, winnerId FROM _sns_hidden`)
    .all() as {
    tableName: string
    trueId: string
    winnerId: string | null
  }[]) {
    seen.set(`${row.tableName}\u0000${row.trueId}`, row.winnerId)
  }
  return seen
}

/** `_sns_unplaceable` の1行。`cause` は親が削除されているときの大元の削除（原則4）。 */
interface UnplaceableEntry {
  reason: string
  cause: { table: string; id: string } | null
}

function snapshotUnplaceable(
  db: Database.Database
): Map<string, UnplaceableEntry> {
  const seen = new Map<string, UnplaceableEntry>()
  if (!tableExists(db, '_sns_unplaceable')) return seen
  for (const row of db
    .prepare(
      `SELECT tableName, trueId, reason, causeTable, causeId FROM _sns_unplaceable`
    )
    .all() as {
    tableName: string
    trueId: string
    reason: string | null
    causeTable: string | null
    causeId: string | null
  }[]) {
    seen.set(`${row.tableName}\u0000${row.trueId}`, {
      reason: row.reason ?? '',
      cause:
        row.causeTable === null || row.causeId === null
          ? null
          : { table: row.causeTable, id: row.causeId },
    })
  }
  return seen
}

/**
 * 前回との差だけを結果へ載せる（§4.4）。前回の状態は、前回の作り直しが書いた
 * `_sns_hidden` と `_sns_unplaceable` である。
 *
 * 全部載せると、隠れたままの行や入らないままの行が同期のたびに何度も知らされる。
 * 差で出すので、同じ行が他のクライアントから再び届いても、状態が変わらなければ出ない。
 *
 * `restores`（統合が解けた行）に載せるのは、`_sns_hidden` から外れ、**かつ
 * いまアプリの表に置かれている**行だけである。`_sns_hidden` は作り直しのたびに
 * 丸ごと書き直されるので、外れた理由は「統合が解けた」だけではない。
 * 統合した行を `DELETE` すると両方の主キーに削除の版が付き（原則3）、負けていた側も
 * 隠れる対象でなくなって `_sns_hidden` から外れる。ほかに、置けなくなった
 * （`_sns_unplaceable`）場合も外れる。どれもアプリの表には入っていないので、
 * `restores` に載せると事実と食い違う。
 *
 * 親が削除されているので置かない行（原則4）は、`Unplaceable` の警告ではなく
 * `parentDeleted` に出す。そうでなくなってアプリの表に置かれた行は `parentReturned` に出す。
 */
function reportHiddenChanges(
  db: Database.Database,
  hiddenBefore: Map<string, string | null>,
  unplaceableBefore: Map<string, UnplaceableEntry>,
  result: SyncResult
): void {
  const hiddenAfter = snapshotHidden(db)
  for (const [token, winnerId] of hiddenAfter) {
    if (hiddenBefore.has(token)) continue
    result.folds.push(foldOf(token, winnerId))
  }
  const placed = placedLookup(db)
  for (const [token, winnerId] of hiddenBefore) {
    if (hiddenAfter.has(token)) continue
    const [tableName, trueId] = token.split('\u0000')
    if (!placed(tableName, trueId)) continue
    result.restores.push(foldOf(token, winnerId))
  }
  const unplaceableAfter = snapshotUnplaceable(db)
  const content = contentLookup(db)
  for (const [token, entry] of unplaceableAfter) {
    const before = unplaceableBefore.get(token)
    const [tableName, trueId] = token.split('\u0000')
    if (entry.cause !== null) {
      // 親が削除されているので入らない。前回もそうだったなら出さない
      if (before !== undefined && before.cause !== null) continue
      result.parentDeleted.push({
        tableName,
        recordId: trueId,
        content: content(tableName, trueId),
        causeTable: entry.cause.table,
        causeId: entry.cause.id,
      })
      continue
    }
    // 前回もこの行が同じ筋で入らなかったなら、警告はもう出してある
    if (before !== undefined && before.cause === null) continue
    result.warnings.push(`Unplaceable ${tableName}:${trueId}: ${entry.reason}`)
  }
  for (const [token, entry] of unplaceableBefore) {
    if (entry.cause === null) continue
    const now = unplaceableAfter.get(token)
    if (now !== undefined && now.cause !== null) continue
    const [tableName, trueId] = token.split('\u0000')
    // 親が戻っても、別の理由で入らない（置かない行・隠れた行）なら出さない
    if (!placed(tableName, trueId)) continue
    result.parentReturned.push({
      tableName,
      recordId: trueId,
      content: content(tableName, trueId),
      causeTable: entry.cause.table,
      causeId: entry.cause.id,
    })
  }
}

/**
 * 真の id の行の内容を `_sns_rows_<表>` から読む関数を作る（報告に載せる内容）。
 *
 * 版の順序の3列は載せない。行の版が無ければ空のオブジェクトを返す。
 */
function contentLookup(
  db: Database.Database
): (tableName: string, trueId: string) => Record<string, unknown> {
  const hidden = new Set<string>(Object.values(VERSION_COLUMNS))
  const statements = new Map<string, Database.Statement>()
  return (tableName, trueId) => {
    const rows = rowsTableName(tableName)
    if (!tableExists(db, rows)) return {}
    let statement = statements.get(tableName)
    if (statement === undefined) {
      const primaryKey = escapeIdentifier(primaryKeyColumn(db, tableName).name)
      statement = db.prepare(
        `SELECT * FROM ${escapeIdentifier(rows)}
          WHERE CAST(${primaryKey} AS TEXT) = ? LIMIT 1`
      )
      statements.set(tableName, statement)
    }
    const row = statement.get(trueId) as Record<string, unknown> | undefined
    const picked: Record<string, unknown> = {}
    for (const [column, value] of Object.entries(row ?? {})) {
      if (!hidden.has(column)) picked[column] = value
    }
    return picked
  }
}

/**
 * 真の id の行が、いまアプリの表に置かれているかを答える関数を作る。
 *
 * アプリの表の主キーは**表示している id** である。1:1 の表では真の id と違うことが
 * あり、その対応は `_sns_shown` にある（作り直しの結果）。
 *
 * - `_sns_shown` に真の id の行があれば、その `shownId` の行がアプリの表にあるか
 * - 無ければ真の id そのものの行があるか。ただし、その id を**別の真の id が**
 *   表示に使っている（`_sns_shown.shownId` に載っている）なら、それは別の行である
 *
 * id の突き合わせは `CAST(主キー AS TEXT)` で行う。真の id の正規形がこの形である
 * （`ValueOrdering.idKey`）。
 */
function placedLookup(
  db: Database.Database
): (tableName: string, trueId: string) => boolean {
  const shownOf = db.prepare(
    `SELECT "shownId" FROM "_sns_shown" WHERE "tableName" = ? AND "trueId" = ?`
  )
  const shownByOther = db.prepare(
    `SELECT 1 FROM "_sns_shown" WHERE "tableName" = ? AND "shownId" = ?`
  )
  const rowExists = new Map<string, Database.Statement>()
  return (tableName, trueId) => {
    if (!tableExists(db, tableName)) return false
    let exists = rowExists.get(tableName)
    if (exists === undefined) {
      const primaryKey = escapeIdentifier(primaryKeyColumn(db, tableName).name)
      exists = db.prepare(
        `SELECT 1 FROM ${escapeIdentifier(tableName)}
          WHERE CAST(${primaryKey} AS TEXT) = ? LIMIT 1`
      )
      rowExists.set(tableName, exists)
    }
    const shown = shownOf.get(tableName, trueId) as
      { shownId: string } | undefined
    if (shown !== undefined) return exists.get(shown.shownId) !== undefined
    if (shownByOther.get(tableName, trueId) !== undefined) return false
    return exists.get(trueId) !== undefined
  }
}

function foldOf(token: string, winnerId: string | null): RecordFold {
  const [tableName, trueId] = token.split('\u0000')
  // 案A では敗者の**事実は消えない**。アプリの表に置かれないだけである
  return { tableName, losingId: trueId, winningId: winnerId ?? '' }
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}
