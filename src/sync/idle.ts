/**
 * 変わっていないときに転送をしない判断（無駄な転送の抑制）。
 *
 * 既定では30秒ごとに同期する。変更が1つも無くても、以前は毎回
 *
 * 1. NAS 上の**自分の写し**を手元へ写して復元・巻き戻りを見る
 * 2. 自分の DB 全体を NAS へ上げる
 * 3. 上げた自分の写しをもう一度手元へ写して、取り合いを見る
 * 4. 相手ごとに、写して隙間を調べ、**もう一度写して**取り込む
 *
 * を行っていた。相手が2人なら1回の同期で7回のファイル全体の複写である。
 * ここは、そのうち**やっても何も変わらない回**を落とす判断だけを持つ。
 *
 * ## 落としてよいと言える根拠
 *
 * | 抑制 | 落としてよい条件 | なぜ何も変わらないか |
 * | --- | --- | --- |
 * | 相手を読まない | 相手のファイルの印（{@link fileStamp}）が前に読んだときと同じで、かつ手元の `lastSeenId` もあのときのまま | 前の回の取り込みの直後に、**同じ手元の位置でもう一度読んでも何も起きない**ことを実際に確かめて（{@link RemoteReadMemo.verified}）から覚えている。同じファイル・同じ位置なら答えも同じ |
 * | 自分を上げない | 手元の印（{@link localPushFingerprint}）が前に上げたときと同じ | 上げ直しても、写しの中身は generation が1つ進む以外に違いが無い。相手が読むのは事実であって generation ではない |
 * | 自分の写しを読まない（復元の判定） | NAS 上の自分の写しの印が、自分が最後に上げたときのままである | その写しは自分が書いたものだと分かっている。`lamport` は手元で単調なので、写しに残した値より小さくなりようが無い |
 * | 取り合いの確認で読まない | 上げた直後の自分の写しの印が、いま自分が書いた一時ファイルの印と同じ | `rename` は inode を持ち越す。印が同じならその実体は**自分が書いたもの**であり、`sns.instanceId` を読むまでもなく自分のものである |
 *
 * ## 見逃し（変わったのに気づかない）への備え
 *
 * 印は inode・大きさ・更新時刻である。`copyToNas` は一時ファイルへ書いてから
 * `rename` するので、書き直されれば inode が変わる。それでも次の穴が残る:
 *
 * - **inode を持たないファイルシステム**（一部の SMB/NFS）。`fileStamp` は
 *   inode 0 を `null`（分からない）にし、分からなければ必ず読む
 * - **inode の使い回し**。`rename` で空いた番号が次のファイルへ回ることはありうる。
 *   大きさと更新時刻も同時に一致する必要があるので確率は低いが、0 ではない
 * - **更新時刻の粗さ**。1秒精度のファイルシステムでは、同じ秒の中の書き換えを
 *   取りこぼしうる（inode が変わるので、rename 経由なら気づく）
 *
 * そこで**一定回数ごとに必ず読む・必ず上げる**（{@link FORCE_EVERY}）。
 * 既定の30秒間隔で10分に1回にあたる。加えて、次の場合は条件抜きで読む・上げる:
 *
 * - **起動直後**（この覚えはプロセスの中にしか無いので、自動的にそうなる）
 * - 前回の読み・書きが失敗した相手（覚えを捨てるので次は読む）
 * - フルマージが要る相手（「もう一度読んでも何も起きない」が確かめられない）
 * - 版（`schemaVersion`）が変わったとき
 * - NAS 上の自分の写しが消えているとき
 * - 復元・巻き戻りを見つけたとき
 *
 * @module sync/idle
 * @internal
 */
import Database from 'better-sqlite3'
import {
  getMaxChangelogId,
  readChangelogPrunedThroughId,
  readChangelog,
} from '../changelog'
import { FileStamp } from '../nas'
import { readClockLamport } from '../rows/meta'

/**
 * 印が同じでも必ず読み直す（上げ直す）間隔。
 *
 * 30秒間隔なら10分に1回。**この回だけは印を信じない**ので、印の見逃し
 * （inode の使い回し・更新時刻の粗さ）が残っても、10分で自力で直る。
 */
export const FORCE_EVERY = 20

/** 相手1人ぶんの「前に読んだときのこと」。 */
interface RemoteReadMemo {
  /** そのとき読んだファイルの印 */
  stamp: FileStamp
  /** 読み終えたあとの手元の `lastSeenId` */
  lastSeenId: number
  /**
   * 「同じ印・同じ `lastSeenId` でもう一度読んでも何も起きない」ことを、
   * 読んだその場で確かめたか（{@link readWouldBeNoOp}）。
   *
   * 確かめていない相手は覚えない。**推測で落とすと事実が届かなくなる**。
   */
  verified: true
}

/** 自分が最後に NAS へ上げたときのこと。 */
export interface PushMemo {
  /** そのときの手元の印（{@link localPushFingerprint}） */
  fingerprint: string
  /** 上げた直後の、NAS 上の自分の写しの印。読めなければ `null` */
  selfStamp: FileStamp | null
  /**
   * 写しへ入る中身を決めた瞬間の `total_changes()`（この接続が変えた行の総数）。
   *
   * **これが要る理由**: {@link localPushFingerprint} は「相手が読むもの」しか見ない
   * ので、**作り直し**がアプリの表や `_sns_shown` / `_sns_hidden` / `_sns_dirty` を
   * 入れ替えても動かない（作り直しの書き込みは版を作らないので lamport も
   * `_sns_tick` も進まない）。それを見落とすと、NAS 上の写しだけが古いアプリの表を
   * 抱えたまま残る。相手はその部分を読まないので実害は無いが、**手元と写しが
   * 食い違った状態**が積み上がるのは望ましくない（網羅検査の状態も割れる）。
   *
   * 同期の終わりにこの値と突き合わせ、動いていたら覚えを捨てて次の回に上げ直す。
   * 測るのは `backup()` を呼ぶ**直前**である —— 写している最中の書き込みは
   * 写しに入ったか分からないので、「入っていない」側（＝上げ直す側）へ倒す
   */
  changesAtCopy: number
}

/**
 * 抑制の覚え。**プロセスの中にしか無い**（DB にも NAS にも書かない）。
 *
 * DB へ書かない理由は2つある。
 *
 * 1. 「起動直後は必ず読む・必ず上げる」が**自動的に**満たされる。覚えを DB に
 *    置くと、復元された DB から古い覚えが蘇り、上げるべき回を落としうる
 * 2. 覚えは**振る舞いを変えない**（上の表の根拠）。状態空間の網羅検査は
 *    「同じ状態は一度しか展開しない」で成り立っているので、振る舞いを変えない
 *    値を状態に足すと、探索が無駄に広がるだけになる（tools/explore/state.ts）
 */
export interface IdleMemory {
  /** 抑制そのものの入り切り（`SyncConfig.suppressIdleSync`） */
  enabled: boolean
  /** この覚えができてからの同期の回数 */
  syncCount: number
  /** 前に上げたときのこと。まだ一度も上げていなければ `null` */
  push: PushMemo | null
  /** 相手ごとの、前に読んだときのこと */
  peers: Map<string, RemoteReadMemo>
  /** 前に見た版。変わったら全員を読み直す */
  localMeta: string | null
}

/** まっさらな覚えを作る。 */
export function createIdleMemory(enabled = true): IdleMemory {
  return {
    enabled,
    syncCount: 0,
    push: null,
    peers: new Map(),
    localMeta: null,
  }
}

/**
 * この回は印を信じず、必ず読む・必ず上げるか。
 *
 * `syncCount` は同期の**はじめ**に1つ進めるので、1回目（＝起動直後）は
 * 必ず `true` になる。
 */
function forcedRound(memory: IdleMemory): boolean {
  return memory.syncCount % FORCE_EVERY === 1 || FORCE_EVERY <= 1
}

/**
 * 手元の印。**これが前に上げたときと同じなら、上げ直しても写しの中身は変わらない。**
 *
 * 見るのは、案A の仕組みから確実に分かるものだけである:
 *
 * | 値 | これが拾うもの |
 * | --- | --- |
 * | `_sns_clock.lamport` | アプリの書き込み・取り込み・作り直しが作った**すべての版**。案A では版が1つでも増えれば lamport が進む（§3.2） |
 * | `_sns_tick` の合計 | 表ごとの書き込みの数え上げ。lamport と重なるが、片方だけが進む壊れ方を早く見つけるために足しておく |
 * | `_changelog` の最大 id | lamport を進めない通知。相手はこの id で差分の範囲を決めるので、増えたら知らせなければならない |
 * | `_changelog_prune.prunedThroughId` | 掃除した位置。相手の隙間の判定がこれを読む |
 * | 版（`schemaVersion`） | 相手が見送りの判定に使う。lamport を進めずに変わりうる |
 *
 * 逆に**入れてはいけない**のが `sns.generation` と `sns.lastLamport` である。
 * どちらも上げるたびに変わるので、入れると「上げたから次も上げる」が永久に続く。
 */
export function localPushFingerprint(
  db: Database.Database,
  schemaVersion: string | undefined
): string {
  const lamport = readClockLamport(db) ?? -1
  const tick = readTickSummary(db)
  const changelogId = getMaxChangelogId(db)
  const pruned = readChangelogPrunedThroughId(db)
  return [
    `L${String(lamport)}`,
    `T${tick}`,
    `C${String(changelogId)}`,
    `P${String(pruned)}`,
    localMetaFingerprint(schemaVersion),
  ].join('|')
}

/**
 * 版（`schemaVersion`）の印。
 *
 * 相手の振る舞い（見送り）を決めるのに、**手元の書き込みとは独立に**
 * 変わりうる値なので、別に取り出せるようにしてある。変わったときは
 * 上げ直すだけでなく、相手も読み直す（見送りの判定をやり直すため）。
 */
export function localMetaFingerprint(
  schemaVersion: string | undefined
): string {
  return `V${schemaVersion ?? ''}`
}

/** `_sns_tick` の「表の数と tick の合計」。表が無ければ `-`。 */
function readTickSummary(db: Database.Database): string {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(tick), 0) AS total
                  FROM _sns_tick`
      )
      .get() as { n: number | bigint; total: number | bigint }
    return `${String(Number(row.n))}/${String(Number(row.total))}`
  } catch {
    return '-'
  }
}

/**
 * 「いまの `lastSeenId` でこの相手をもう一度読んでも、何も起きない」か。
 *
 * **読んだその場で、開いている相手の写しに対して確かめる。** 落とす根拠は
 * 推測ではなくこの1行である。
 *
 * - フルマージが要る（隙間がある・まだ一度も読んでいない）なら、読めば起きる
 * - 差分が1件でも残っていれば、読めば起きる
 *
 * どちらでもなければ、`performSync` の取り込みは `entries.length === 0` の枝で
 * 何も書かずに戻る（`clientsSynced` を1つ数えるだけで、それは読まなくても数えられる）。
 *
 * @param needsFullMerge - `performSync` が使っているのと同じ判定
 */
export function readWouldBeNoOp(
  peerDb: Database.Database,
  lastSeenId: number,
  needsFullMerge: (db: Database.Database, lastSeenId: number) => boolean
): boolean {
  if (needsFullMerge(peerDb, lastSeenId)) return false
  return readChangelog(peerDb, lastSeenId).length === 0
}

/** この接続がこれまでに変えた行の数（トリガーの分も入る）。 */
export function totalChanges(db: Database.Database): number {
  const row = db.prepare(`SELECT total_changes() AS n`).get() as {
    n: number | bigint
  }
  return Number(row.n)
}

/**
 * 写しを作ってから手元が動いていたら、上げた覚えを捨てる（同期の終わりに呼ぶ）。
 *
 * 捨てると次の回は必ず上げ直す。動いていなければ、写しは手元そのものである。
 */
export function forgetPushIfChanged(
  memory: IdleMemory,
  db: Database.Database
): void {
  if (memory.push === null) return
  if (totalChanges(db) !== memory.push.changesAtCopy) memory.push = null
}

/** {@link canSkipRemoteRead} が返す答え（落とす／読む理由つき）。 */
interface SkipDecision {
  skip: boolean
  /** 読むことにした理由（`skip` が `true` のときは空） */
  reason?: string
}

/**
 * この相手を、この回は読まずに済ませてよいか。
 *
 * @param stamp - いまの相手のファイルの印。`null`（素性が分からない）なら読む
 * @param lastSeenId - いまの手元の読み位置
 */
export function canSkipRemoteRead(
  memory: IdleMemory,
  clientId: string,
  stamp: FileStamp | null,
  lastSeenId: number
): SkipDecision {
  if (!memory.enabled) return { skip: false, reason: '抑制が切ってある' }
  if (forcedRound(memory)) {
    return { skip: false, reason: `${String(FORCE_EVERY)} 回に1度は必ず読む` }
  }
  if (stamp === null) {
    return { skip: false, reason: 'ファイルの素性が読めない' }
  }
  const memo = memory.peers.get(clientId)
  if (memo === undefined) {
    return { skip: false, reason: 'この相手をまだ読んでいない' }
  }
  if (memo.stamp !== stamp) {
    return { skip: false, reason: '相手のファイルが変わっている' }
  }
  if (memo.lastSeenId !== lastSeenId) {
    return { skip: false, reason: '手元の読み位置が動いている' }
  }
  return { skip: true }
}

/** {@link canSkipPush} に渡す、抑制を外す事情。 */
interface PushContext {
  /** いまの手元の印 */
  fingerprint: string
  /** NAS 上に自分の写しがあるか */
  selfCopyExists: boolean
  /** 復元・巻き戻りを見つけた */
  restored: boolean
  /**
   * NAS 上の自分の写しが、自分が最後に上げたものではなくなっている。
   *
   * **上げない回でも写しの取り合いを見つけられるのは、この1行のためである。**
   * 印（inode）だけを見るので費用は `stat` 1回。誰かが同じ名前へ書いていれば
   * 必ず印が変わるので、その回は上げ直し、上げた直後の
   * `checkCopyOwnership` が相手の `sns.instanceId` を突き止める
   */
  selfStampChanged: boolean
}

/** この回は、上げずに済ませてよいか。 */
export function canSkipPush(
  memory: IdleMemory,
  context: PushContext
): SkipDecision {
  if (!memory.enabled) return { skip: false, reason: '抑制が切ってある' }
  if (forcedRound(memory)) {
    return { skip: false, reason: `${String(FORCE_EVERY)} 回に1度は必ず上げる` }
  }
  if (memory.push === null) {
    return {
      skip: false,
      reason: 'まだ一度も上げていない（起動直後・前回失敗）',
    }
  }
  if (!context.selfCopyExists) {
    return { skip: false, reason: 'NAS 上の自分の写しが無い' }
  }
  if (context.restored) {
    return { skip: false, reason: '復元・巻き戻りを見つけた' }
  }
  if (context.selfStampChanged) {
    return { skip: false, reason: '自分の写しを自分以外が書いている' }
  }
  if (memory.push.fingerprint !== context.fingerprint) {
    return { skip: false, reason: '前に上げてから手元が変わっている' }
  }
  return { skip: true }
}

/**
 * NAS 上の自分の写しを読まずに、復元の判定を省いてよいか。
 *
 * 省けるのは「その写しは自分が最後に上げたそのものである」と言えるときだけ。
 * 印が一致すれば、中身は自分が書いたものであり、そこに載っている
 * `sns.lastLamport` は自分が書いた値、`sns.generation` も自分が書いた値である。
 * 手元の `lamport` と `generation` はそこから減らないので、判定は必ず「異常なし」になる。
 */
export function canSkipRestoreCheck(
  memory: IdleMemory,
  currentSelfStamp: FileStamp | null
): SkipDecision {
  if (!memory.enabled) return { skip: false, reason: '抑制が切ってある' }
  if (forcedRound(memory)) {
    return { skip: false, reason: `${String(FORCE_EVERY)} 回に1度は必ず読む` }
  }
  if (memory.push === null || memory.push.selfStamp === null) {
    return { skip: false, reason: 'この起動でまだ上げていない' }
  }
  if (currentSelfStamp === null) {
    return { skip: false, reason: '自分の写しの素性が読めない' }
  }
  if (memory.push.selfStamp !== currentSelfStamp) {
    return { skip: false, reason: '自分の写しが自分の知らない間に変わっている' }
  }
  return { skip: true }
}
