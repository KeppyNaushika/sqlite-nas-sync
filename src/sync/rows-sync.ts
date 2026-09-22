/**
 * 案A の同期の流れ（設計書 `docs/rows-table-design.md` §4.1）。
 *
 * 1回の `performSync` はこう進む:
 *
 * | 段階 | 内容 |
 * | --- | --- |
 * | 0 | `writeSchemaVersion`。**取り込みより前**に §3.10 の復元・巻き戻りの判定。仕掛けの欠けの確認と手当て |
 * | 1 | 相手の列挙と、隙間の事前確認 |
 * | 2 | 隙間なし: 印 → 写し → 取り合いの確認 → 相手ごとに取り込み → 作り直し。隙間あり: 取り込み → 作り直し → heartbeat → 印 → 写し → 取り合いの確認 |
 * | 3〜5 | heartbeat、`cleanupChangelog`、`onAfterSync` |
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
  getMaxChangelogId,
  hasChangelogGap,
  normalizeRetentionDays,
  readChangelog,
  readChangelogPrunedThroughId,
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
import { readSchemaVersion, writeSchemaVersion } from '../setup'
import { getSyncState, recordSkippedRemote, updateSyncState } from './state'
import { updateHeartbeat } from './state'
import {
  ROWS_FORMAT,
  RowsImportKey,
  importFromPeer,
  readSnsFormat,
} from '../rows/import'
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
import { RowsTableSpec } from '../rows/schema'
import { canonicalTableSpecs } from '../rows/table-name'
import {
  SNS_META_KEYS,
  encodeDeleteProtected,
  readDeleteProtectedRaw,
  readSnsMeta,
  writeDeleteProtected,
} from '../rows/meta'

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
  /** 作り直しの計算に使うワーカーの位置（省略すると `dist` の隣） */
  workerPath?: string
  /** ワーカーを使わず主スレッドで計算する（試験・検査器） */
  forceMainThread?: boolean
  /**
   * 無駄な転送を落とすための覚え（`sync/idle`）。同期をまたいで持ち回る。
   *
   * **渡さなければ毎回まっさらになり、抑制は効かない**（起動直後と同じ扱い）。
   * `setupSync` は `SyncInstance` が1つ持つものを渡す
   */
  idle?: IdleMemory
  /**
   * 作り直しの差し込み口（設計書 §8.2 の `REQUIRED_HOOKS`）。**公開 API ではない**
   * ——`SyncConfig` には出さない。網羅検査器が判定8・10・13・20・21 を
   * 当てるために使う
   */
  hooks?: RowsRebuildHooks
}

/** 案A の同期を1回行う。 */
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
  const heartbeatEnabled = config.heartbeatEnabled ?? DEFAULTS.heartbeatEnabled
  const specs: RowsTableSpec[] = tables.map((table) => ({
    name: table.name,
    timestampColumn: table.timestampColumn,
    deleteProtected: table.deleteProtected,
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
  if (!canSkipRestoreCheck(idle, selfStamp).skip) {
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
    // 欠けを1件ずつ並べると、旧方式から移る最初の1回で表の数×4本ぶんの警告が
    // 出て、他の知らせが埋もれる。**数と代表の1件**にまとめ、静かだと困る
    // 「旗の残り」だけは必ず書く（§3.10 の I）
    const first = machinery.issues[0]
    result.warnings.push(
      `案A の仕掛けが ${machinery.issues.length} 件欠けている（例: ${first.message}）`
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
      `仕掛けが欠けていたので作り直した（${migration.from === 'legacy' ? '旧方式から移行' : '取り付け直し'}）`
    )
  }
  const instanceId =
    state.instanceId ?? readSnsMeta(localDb, SNS_META_KEYS.instanceId) ?? ''

  // `deleteProtected` の設定を DB に書き残す（§3.1 の鍵）。
  //
  // 1. 作り直しの計算はここから読む（ワーカーで計算しても同じ答えになる形は
  //    これ1つである）
  // 2. 写しにそのまま載るので、相手との食い違いを取り込みのときに見つけられる
  //
  // **設定が変わったら全表を `_sns_dirty` に載せる。** 載せないと、版が1つも
  // 動かない限り作り直しが走らず、設定を外しても削除がいつまでも効かない
  const previousProtected = readDeleteProtectedRaw(localDb)
  const currentProtected = encodeDeleteProtected(specs)
  writeDeleteProtected(localDb, specs)
  if (previousProtected !== null && previousProtected !== currentProtected) {
    const mark = localDb.prepare(
      `INSERT INTO "_sns_dirty" ("tableName") VALUES (?)
         ON CONFLICT ("tableName") DO NOTHING`
    )
    // `_sns_dirty.tableName` は `sqlite_master` の綴りでなければ引けない
    for (const spec of canonicalTableSpecs(localDb, specs)) mark.run(spec.name)
    result.warnings.push(
      `deleteProtected の設定が変わった（${previousProtected === '' ? '(無し)' : previousProtected}` +
        ` → ${currentProtected === '' ? '(無し)' : currentProtected}）ので、全表を作り直す`
    )
  }

  // 版と `deleteProtected` が変わったら、相手の覚えを捨てて全員読み直す。
  // 見送りの判定も食い違いの警告も、この2つと相手の中身の突き合わせで決まる
  const metaFingerprint = localMetaFingerprint(localDb, schemaVersion)
  if (idle.localMeta !== metaFingerprint) {
    idle.peers.clear()
    idle.localMeta = metaFingerprint
  }

  /* -------------------------------------------------------------- *
   * 段階 1 —— 相手の列挙と隙間の事前確認
   *
   * **相手の写しを手元へ写すのは、1回の同期で相手1人につき1回だけ。** 以前は
   * ここで写して隙間を調べ、`importAll` でもう一度写していた（相手2人なら
   * 1回の同期で4回）。開いた手を段階2 の取り込みまで持ち回って1回にする。
   * 持ち回っても見えるものは変わらない —— どちらも「その瞬間の写し」を読むので、
   * 途中で相手が書き直しても、以前の形ではその2回が食い違いえた
   * （隙間なしと見て、取り込みでは隙間のある中身を読む）。1回にすると、その
   * 食い違いごと無くなる。
   * -------------------------------------------------------------- */
  ensureDirectory(config.nasPath)
  const remoteClients = listRemoteClients(config.nasPath, config.clientId)
  const peers: PeerSlot[] = []
  let hasAnyGap = false
  try {
    for (const remote of remoteClients) {
      const stamp = fileStamp(remote.filePath)
      const { lastSeenId } = getSyncState(localDb, remote.clientId)
      const decision = canSkipRemoteRead(
        idle,
        remote.clientId,
        stamp,
        lastSeenId
      )
      if (decision.skip) {
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
      }).skip
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
            ownership.message ?? '写しの取り合いが起きている'
          )
          return false
        }
      }
      idle.push = { fingerprint, selfStamp: nowStamp, changesAtCopy }
      return true
    }

    const hiddenBefore = snapshotHidden(localDb)
    const unplaceableBefore = snapshotUnplaceable(localDb)

    if (!hasAnyGap) {
      if (!(await publish())) return stop(localDb, config, result)
      importAll(localDb, peers, config, schemaVersion, specs, idle, result)
      await rebuild(localDb, config, tableNames, state, result)
    } else {
      importAll(localDb, peers, config, schemaVersion, specs, idle, result)
      await rebuild(localDb, config, tableNames, state, result)
      if (heartbeatEnabled) updateHeartbeat(localDb)
      if (!(await publish())) return stop(localDb, config, result)
    }

    reportHiddenChanges(localDb, hiddenBefore, unplaceableBefore, result)
  } finally {
    for (const peer of peers) peer.handle?.cleanup()
  }

  /* -------------------------------------------------------------- *
   * 段階 3〜5
   * -------------------------------------------------------------- */
  if (!hasAnyGap && heartbeatEnabled) updateHeartbeat(localDb)

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
  /** 段階1 で見た手元の読み位置 */
  lastSeenId: number
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
  config: SyncConfig,
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

      // 版が違う相手は丸ごと見送る。`sns-format` が `rows1` でない相手も同じ（§4.2）
      if (!sameSchema(peerDb, schemaVersion)) {
        recordSkippedRemote(
          result,
          remote.clientId,
          readSchemaVersion(peerDb),
          schemaVersion ?? ''
        )
        continue
      }
      const format = readSnsFormat(peerDb)
      if (format !== ROWS_FORMAT) {
        recordSkippedRemote(
          result,
          remote.clientId,
          readSchemaVersion(peerDb),
          schemaVersion ?? ''
        )
        result.warnings.push(
          `Skipped remote ${remote.clientId}: sns-format=${format ?? '(無し)'}` +
            `（こちらは ${ROWS_FORMAT}）`
        )
        continue
      }

      // `deleteProtected` は全端末で同じである前提（前提 P4）。違うと同じ版の
      // 集合から端末ごとに違う見え方が出るので、見送りはせずに**警告だけ**出す
      // （見送ると、設定を直すための版すら届かなくなる）
      const mineProtected = encodeDeleteProtected(specs)
      const peerProtected = readDeleteProtectedRaw(peerDb)
      if (peerProtected !== null && peerProtected !== mineProtected) {
        result.warnings.push(
          `deleteProtected が ${remote.clientId} と食い違っている` +
            `（相手: ${peerProtected === '' ? '(無し)' : peerProtected}` +
            `／こちら: ${mineProtected === '' ? '(無し)' : mineProtected}）。` +
            `全端末で同じにしないと、端末ごとに見え方が変わる`
        )
      }

      const { lastSeenId } = getSyncState(localDb, remote.clientId)
      const gap = peer.gap
      let keys: RowsImportKey[] | undefined
      let cursor: number
      if (gap) {
        // フルマージ。範囲は相手の `_sns_rows_*` と `_tombstone` の全部
        keys = undefined
        cursor = Math.max(
          getMaxChangelogId(peerDb),
          readChangelogPrunedThroughId(peerDb)
        )
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
      // **この取り込みが事実を1つでも動かしたか。** 動かしていないなら、同じ
      // ファイルを同じ読み位置でもう一度読んでも動かない（下の `rememberRead`）。
      // `_sns_clock` の token や lamport の引き上げは数えない —— どちらも
      // 二度目は同じ値で、取り込みの答えを変えないから
      const movedNothing =
        imported.status === 'imported' &&
        imported.changed.length === 0 &&
        imported.dirtyTables.length === 0
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
 * 2. `movedNothing` —— この回の取り込みが**事実を1つも動かさなかった**
 *    （`Max` が変わったキーも `_sns_dirty` に載せた表も無い）。フルマージへ
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
 * `hasChangelogGap` の規則に加えて、**まだ一度も読んでいない相手
 * （`lastSeenId === 0`）は必ずフルマージにする。**
 *
 * 差分の範囲は「相手の `_changelog` の `id > lastSeenId`」だが、相手の
 * `_changelog` は**事実そのものではなく通知の索引**で、掃除でも移行でも短くなる。
 * とくに §3.9 の移行は `_changelog` を作り直すので、移行した端末は
 * 「`_sns_rows_*` には行があるのに、それを知らせるエントリが1つも無い」状態に
 * なりうる。空の `_changelog` を「言うことが無い」と読むと、その端末の行は
 * **誰にも届かないまま**になる（3端末の性質テストが踏んだ）。
 *
 * 一度も読んでいない相手からはどのみち全部要るので、初回をフルマージにすれば
 * この穴は閉じる。2回目以降は `lastSeenId > 0` なので通常の差分に戻る。
 */
function needsFullMerge(
  peerDb: Database.Database,
  lastSeenId: number
): boolean {
  if (lastSeenId === 0) return true
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

/** アプリの版に `;sns-format=rows1` を付けた形にする（§3.8）。 */
function withRowsFormat(schemaVersion: string): string {
  return `${appPartOf(schemaVersion) as string};sns-format=${ROWS_FORMAT}`
}

/** `<アプリの版>;sns-format=rows1` からアプリの版だけを取り出す。 */
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

function snapshotUnplaceable(db: Database.Database): Map<string, string> {
  const seen = new Map<string, string>()
  if (!tableExists(db, '_sns_unplaceable')) return seen
  for (const row of db
    .prepare(`SELECT tableName, trueId, reason FROM _sns_unplaceable`)
    .all() as { tableName: string; trueId: string; reason: string | null }[]) {
    seen.set(`${row.tableName}\u0000${row.trueId}`, row.reason ?? '')
  }
  return seen
}

/**
 * `_sns_hidden` と `_sns_unplaceable` の**差分だけ**を結果へ載せる（§4.4）。
 *
 * 全部載せると、隠れたままの行が同期のたびに何度も知らされる。
 */
function reportHiddenChanges(
  db: Database.Database,
  hiddenBefore: Map<string, string | null>,
  unplaceableBefore: Map<string, string>,
  result: SyncResult
): void {
  const hiddenAfter = snapshotHidden(db)
  for (const [token, winnerId] of hiddenAfter) {
    if (hiddenBefore.has(token)) continue
    result.folds.push(foldOf(token, winnerId))
  }
  for (const [token, winnerId] of hiddenBefore) {
    if (hiddenAfter.has(token)) continue
    result.restores?.push(foldOf(token, winnerId))
  }
  const unplaceableAfter = snapshotUnplaceable(db)
  for (const [token, reason] of unplaceableAfter) {
    if (unplaceableBefore.has(token)) continue
    const [tableName, trueId] = token.split('\u0000')
    result.warnings.push(`Unplaceable ${tableName}:${trueId}: ${reason}`)
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
