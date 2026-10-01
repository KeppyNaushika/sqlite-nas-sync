/**
 * 状態の正規化。探索の効率と正しさが両方ここに載っている。
 *
 * 状態空間の探索は「同じ状態へ行き着いた列は一度しか展開しない」で桁が変わる。
 * だが**正規化しすぎると別の状態を同じと見て探索を打ち切り、その先の反例を見逃す。**
 * 逆に**正規化が足りないと同じ状態が別物に見えて重複排除が効かない**（こちらは遅いだけで
 * 嘘はつかない）。迷ったら細かい側（含める側）へ倒す。
 *
 * ## 含めるもの（端末ごとの**ローカルDB**と、NAS上の**その端末のコピー**の両方）
 *
 * NAS上のコピーを含めるのは、相手が読むのがこちらだから。ローカルDBが同じでも
 * NASが古ければ、次の同期で相手に届くものが違う。
 *
 * - 同期対象の表の行（全列）を **rowid の順**で。`SELECT *` を `ORDER BY` なしで
 *   読む箇所（`src/rows/rebuild-plan.ts` の `_sns_rows_<表>` の全件走査、
 *   `src/rows/import.ts` の取り込み）は rowid の順に行を処理するので、中身が同じでも
 *   並びが違えば処理の順が変わりうる。主キー順に並べ直すと、その違いを潰してしまう
 * - `_tombstone`（全列、rowid 順。作り直しが `WHERE tableName = ?` で順序指定なしに読む）
 * - `_sns_rows_<表>`（全列、rowid 順。案A の版の正）
 * - `_sns_clock`（`importTick` を除く）・`_sns_shown`・`_sns_hidden`・`_sns_unplaceable`・`_sns_dirty`
 *   （全列、rowid 順）。`_sns_unplaceable` は次の同期の報告（`parentDeleted` / `parentReturned` と
 *   `Unplaceable` の警告）の「前回の状態」になる
 * - `_changelog`（id, tableName, recordId, operation, changedAt。id 順）。`changedAt` は値を持たず、時刻として読めるかだけを残す（下の「振る舞いに効かない値」）
 * - `sqlite_sequence`（次に振られる changelog の id）
 * - `_changelog_prune.prunedThroughId`
 * - `_sync_state`（remoteClientId, lastSeenId）
 * - `_sync_meta`（全行。`sns.generation`・`sns.lastLamport`・`sns.instanceId` など、
 *   復元の判定と版の確認に効く値が入る）
 * - スキーマ（`sqlite_master` の全 SQL の要約）。作り直しはトリガを外して付け直すので、
 *   付け直し損ねた状態を同じと見ないため
 * - NAS ディレクトリにある、端末のコピー以外のファイル名（`.tmp` の残骸など）
 * - 時計 C（tools/explore/world.ts）。どの刻みと等しいか（等しくなければ「fresh」）だけ
 *
 * 読み落とすと「それだけが違う2状態」を同じと見て反例を見逃すので、
 * `src/` が内部の表を増やしたら必ずここに載せること。
 *
 * ## 絶対値を持たない値
 *
 * 次の3つは、値のまま入れると状態が際限なく分かれるので畳む。畳み方と根拠は
 * tools/explore/normalize.ts にある。
 *
 * - `_sync_meta.generation` —— 手元と NAS の写しの**新旧関係**だけ（同期のたびに増える絶対値は要らない）
 * - lamport（`_sns_clock.lamport`・`_sns_lamport`・墓標の `lamport`）—— 最大値からの隔たり。
 *   「残りの深さ + 1」以上で打ち切る
 * - `instanceId`（`_sns_instance` と `_sync_meta.instanceId`）—— 字面の順を保った記号
 *
 * `_sns_tick`（表ごとの書き込み回数）と `_sns_clock.importTick` は含めない（作り直しの計算が
 * 古くないかを見る数え上げで、値そのものは以後の振る舞いを決めない）。
 *
 * ## 含めないもの
 *
 * - SQLite の空きページ・ファイルの大きさ —— 論理的な中身だけが振る舞いに効く
 *
 * ## 振る舞いに効かない値
 *
 * 再生するたびに揺れる値が状態に入ると、同じ列を再生しても違う状態に戻り（`replayMismatches`）、
 * 状態の同一視と順序の畳み込みの前提が崩れる。
 * 揺れる値のうち、ライブラリが読まないか、読んでも答えが状態によらず決まっているものは、状態から外す。
 *
 * - `_changelog.changedAt` —— ライブラリが読むのは掃除（`src/changelog.ts` の `cleanupChangelog` と
 *   `describeChangelogPruneWall`）だけで、見るのは「時刻として読めるか」と「保持期間（7日）より古いか」である。
 *   検査の中の `changedAt` は、操作が刻む時計 C と、取り込みが刻む実行中の現在時刻しか無く、
 *   どちらも保持期間の内側にある（{@link TimeLabeler.assertRuntimeTimes} で毎回確かめる）。
 *   検査器の `pruneChangelog` は id で消すので時刻を見ない。
 *   したがって値の大小も同着も振る舞いに効かない。
 *   値を残すと、1回の同期の中で取り込みが書く2件の通知が同じミリ秒に収まるかどうかで状態が割れる。
 *   他の時刻の順位もずれるので、札を付ける時刻の集合（{@link collectTimes}）からも外す
 *
 * ## 採番値（`_changelog.id` など）は**生のまま**含める
 *
 * 通し番号は「相手の読み位置との大小」だけが効くように見えるので、端末ごとに一定量
 * ずらして畳みたくなる。**だが絶対値が効く箇所がある**:
 *
 * - `hasChangelogGap` は `lastSeenId === 0`、`prunedThroughId > 0` を特別扱いする
 * - 性質テストの `pruneChangelog` は `id <= floor + 1` で消す。読み位置 0 の相手に対しては
 *   「id 1 だけ」を消すので、頭が既に削られていれば何も消えない
 *
 * ずらすと、この違いを持つ2状態を同じと見る。重複排除の効きは少し落ちるが、
 * 嘘をつくよりよいので**ずらさない**。
 *
 * ## 時刻（現在時刻由来の値）は**大小と同着の関係だけ**を残す
 *
 * 時刻は2種類ある。
 *
 * 1. **範囲で決めた行の時刻**（`2026-01-01T00:00:00.000Z` など。書式違いも含む）——
 *    実行をまたいで同じ値なので**字面のまま**持つ
 * 2. **実行中に刻まれる時刻** —— 時計 C（操作が刻んだ `changedAt`・`deletedAt`・削除の版の
 *    `_sns_ts` を C へそろえたもの。tools/explore/world.ts の「時計」）と、同期が刻む
 *    `_changelog.changedAt`。字面を入れると同じ状態が二度と一致せず、重複排除が完全に効かなくなる
 *
 * 時刻として札を付ける列は、名前が `At` で終わる列と `_sns_ts`（{@link isTimeColumn}）。
 * `_sns_ts` には 1 の値（アプリが書いた時刻を引き上げたもの）と 2 の値（削除を実行した時刻）の
 * 両方が入る。1 の値は字面のまま残るので、2 の値だけが順位に置き換わる。
 *
 * 2 は、状態に現れる全ての時刻（1 の値は状態に無くても全部）を `julianday` の順に
 * 並べた**順位**へ置き換える。同じ瞬間は同じ順位、ただし**字面が違えば順位の中で
 * さらに区別する**（`@3.0` / `@3.1`）。書式の違う同じ瞬間を同じ札にしてはいけない ——
 * 字面で比べる箇所があれば振る舞いが変わる（前任の途中成果はここを同じ札にしていた）。
 *
 * この置き換えが振る舞いを保つ理由: ライブラリが時刻を扱うのは
 * (a) `julianday` による2値の大小・同着、(b) 字面の一致、(c) `julianday('now', '-7 days')`
 * との大小、の3つだけで、(a)(b) は順位と字面の区別で保たれる。(c) は、2 の値は
 * すべて「この実行が始まってから」なので常に保持期間内、1 の値はすべて保持期間より
 * 古いので、どちらも状態によらず答えが決まっている。**この前提は毎回確かめ、
 * 崩れていたら例外で止める**（{@link TimeLabeler}）。黙って続けると嘘の「反例なし」になる。
 *
 * @module tools/explore/state
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { ExploreConfig, TABLE_SETS } from './config'
import { BASE_TIME, FUTURE_BASE, clientName, knownTimes } from './ops'
import {
  generationRelation,
  instanceLabels,
  lamportCapForDepth,
  lamportLabels,
} from './normalize'
import type { World } from './world'

type Value = unknown
type Section = { name: string; columns: string[]; rows: Value[][] }

/** 1つのDB（ローカル or NAS上のコピー）から読んだ生の中身。 */
type RawDb = { sections: Section[]; schema: string }

/** 世界ぜんたいから読んだ生の中身。 */
export type RawWorld = {
  local: RawDb[]
  /** NAS上の各端末のコピー。まだ一度も押し出していなければ null */
  nas: (RawDb | null)[]
  /** NAS ディレクトリにある、端末のコピー以外のファイル名 */
  nasExtras: string[]
  clock: string | null
}

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

function readDb(db: Database.Database, dataTables: readonly string[]): RawDb {
  const sections: Section[] = []
  const present = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as { name: string }[]
    ).map((row) => row.name)
  )
  const read = (name: string, sql: string): void => {
    // NAS の写しには、他の端末が読む表しか載っていない（src/nas.ts の copyToNas）。
    // 載っていない表は、その写しの節として持たない
    if (!present.has(name)) return
    const statement = db.prepare(sql).raw(true)
    const columns = statement.columns().map((column) => column.name)
    sections.push({ name, columns, rows: statement.all() as Value[][] })
  }
  for (const table of dataTables) {
    read(table, `SELECT * FROM "${table}" ORDER BY rowid`)
  }
  read('_tombstone', `SELECT * FROM _tombstone ORDER BY rowid`)
  for (const table of dataTables) {
    read(
      `_sns_rows_${table}`,
      `SELECT * FROM "_sns_rows_${table}" ORDER BY rowid`
    )
  }
  for (const name of [
    '_sns_clock',
    '_sns_shown',
    '_sns_hidden',
    '_sns_unplaceable',
    '_sns_dirty',
  ]) {
    read(name, `SELECT * FROM "${name}" ORDER BY rowid`)
  }
  read(
    '_changelog',
    `SELECT id, tableName, recordId, operation, changedAt FROM _changelog ORDER BY id`
  )
  read('sqlite_sequence', `SELECT name, seq FROM sqlite_sequence ORDER BY name`)
  read(
    '_changelog_prune',
    `SELECT prunedThroughId FROM _changelog_prune ORDER BY onlyRow`
  )
  read(
    '_sync_state',
    `SELECT remoteClientId, lastSeenId FROM _sync_state ORDER BY remoteClientId`
  )
  read('_sync_meta', `SELECT key, value FROM _sync_meta ORDER BY key`)
  const schemaRows = db
    .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
    .raw(true)
    .all()
  const schema = crypto
    .createHash('sha1')
    .update(JSON.stringify(schemaRows))
    .digest('base64')
  return { sections, schema }
}

/**
 * NAS上のコピーを**副ファイルを作らずに**読む。
 *
 * 読み取り専用で開いても、WAL モードのDBだと SQLite は `-wal` / `-shm` を作る。
 * NAS のディレクトリにそれを残すと、次に `copyToNas` が本体を差し替えたとき、
 * **古い `-wal` が新しい本体へ当てられて**別の中身に見えうる（しかも検査器が
 * 世界を壊したことになる）。そこでファイルをメモリへ読み、ヘッダの
 * 「WAL を使う」印（18・19バイト目 = 2）を旧来のジャーナル（= 1）へ書き換えてから
 * メモリ上のDBとして開く。印を書き換えないと SQLite はメモリ上のDBで WAL を
 * 開こうとして失敗する。ページの中身には触らないので、読める行は同じ。
 */
function readNasCopy(
  filePath: string,
  dataTables: readonly string[]
): RawDb | null {
  if (!fs.existsSync(filePath)) return null
  const buffer = fs.readFileSync(filePath)
  if (buffer.length > 19) {
    buffer[18] = 1
    buffer[19] = 1
  }
  const db = new Database(buffer)
  try {
    return readDb(db, dataTables)
  } finally {
    db.close()
  }
}

/**
 * 世界の中身を読む。
 *
 * **変わっていないDBは読み直さない。** 同期1回で中身が変わるのは、同期した端末の
 * ローカルDBとその NAS 上のコピーだけで、検査の同期では残りを毎回読み直すのが
 * 時間の無駄になる。変わったかどうかは次で見る:
 *
 * - ローカルDB: 同じ接続の `total_changes()`（トリガの分も含めて、この接続が変えた行の数）と
 *   `schema_version`（トリガの付け外しは行の変更に数えられないので別に見る）。
 *   ローカルDBへ書くのはこの接続だけ（ライブラリは渡した接続を使い、バックアップは読むだけ）
 * - NAS 上のコピー: ファイルの inode・更新時刻・大きさ。`copyToNas` は一時ファイルへ
 *   書いてから rename するので、書き直されれば inode が変わる
 *
 * 覚えは世界を開くたびに空になる（{@link World.readCache}）。
 */
export function readWorld(world: World, config: ExploreConfig): RawWorld {
  const dataTables = TABLE_SETS[config.tableSet]
  const cached = <T>(key: string, stamp: string, read: () => T): T => {
    const hit = world.readCache.get(key)
    if (hit !== undefined && hit.stamp === stamp) return hit.value as T
    const value = read()
    world.readCache.set(key, { stamp, value })
    return value
  }
  const local = world.clients.map((client) => {
    const changes = (
      client.db.prepare(`SELECT total_changes() AS n`).get() as { n: number }
    ).n
    const schemaVersion = client.db.pragma('schema_version', { simple: true })
    return cached(
      `local:${client.id}`,
      `${String(changes)}:${String(schemaVersion)}`,
      () => readDb(client.db, dataTables)
    )
  })
  const nas = world.clients.map((client) => {
    const filePath = path.join(world.nasDir, `client-${client.id}.sqlite`)
    let stamp = 'absent'
    try {
      const stat = fs.statSync(filePath)
      stamp = `${String(stat.ino)}:${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      // まだ一度も押し出していない
    }
    return cached(`nas:${client.id}`, stamp, () =>
      readNasCopy(filePath, dataTables)
    )
  })
  const expected = new Set(
    world.clients.map((client) => `client-${client.id}.sqlite`)
  )
  const nasExtras = fs.existsSync(world.nasDir)
    ? fs
        .readdirSync(world.nasDir)
        .filter((file) => !expected.has(file))
        .sort()
    : []
  return { local, nas, nasExtras, clock: world.clock }
}

/**
 * 時刻の札を付ける道具。範囲で決めた行の時刻（{@link knownTimes}）を覚えておき、
 * それ以外の時刻を順位へ置き換える。
 */
export class TimeLabeler {
  private readonly julian = new Map<string, number>()
  private readonly lookup: Database.Statement
  private readonly known: Set<string>
  /** 過去の行の時刻（`--times`）のうち、いちばん新しいもの。無ければ -Infinity */
  private readonly pastMaxJulian: number
  /** 未来の行の時刻（`--future-times`）のうち、いちばん古いもの。無ければ +Infinity */
  private readonly futureMinJulian: number

  constructor(config: ExploreConfig) {
    // julianday は SQLite のものを使う（ライブラリが比べるのと同じ解釈。JS の Date.parse は
    // スペース形式を地方時として読むので、ここで使うと順序を取り違える）
    this.lookup = new Database(':memory:').prepare(`SELECT julianday(?) AS j`)
    this.known = new Set(knownTimes(config))
    // 行の時刻は「実行中に刻まれる時刻」から**どちらかへ十分に離れている**こと。
    //
    // - 過去側は保持期間（7日）より古いこと。そうでないと、その時刻を名乗る changelog
    //   エントリが掃除やフルマージの対象になるかどうかが**実行した日によって**変わり、
    //   正規化の前提（上の (c)）が崩れる
    // - 未来側（`--future-times`）は、この実行が終わるより後であること。実行中に刻まれる
    //   時刻が追い越すと、順位の付き方が実行ごとに変わる。1日の余裕を要求する
    //
    // 間に落ちる時刻（いまから -8日〜+1日）は、どちらの前提も成り立たないので拒む。
    const retentionEdge = this.julianOf(
      new Date(Date.now() - 8 * 86400000).toISOString()
    )
    const futureEdge = this.julianOf(
      new Date(Date.now() + 86400000).toISOString()
    )
    if (retentionEdge === null || futureEdge === null) {
      throw new Error('julianday が現在時刻を読めなかった')
    }
    let pastMax = -Infinity
    let futureMin = Infinity
    for (const value of this.known) {
      const j = this.julianOf(value)
      if (j === null) continue
      if (j < retentionEdge) {
        pastMax = Math.max(pastMax, j)
      } else if (j > futureEdge) {
        futureMin = Math.min(futureMin, j)
      } else {
        throw new Error(
          `行の時刻 ${value} が実行中の時刻に近すぎる（保持期間（7日）より古くもなく、` +
            `未来側にも1日以上離れていない）。基準は --times が ${new Date(BASE_TIME).toISOString()}、` +
            `--future-times が ${new Date(FUTURE_BASE).toISOString()}。時刻の正規化の前提が崩れるので止める`
        )
      }
    }
    this.pastMaxJulian = pastMax
    this.futureMinJulian = futureMin
  }

  private julianOf(value: string): number | null {
    const cached = this.julian.get(value)
    if (cached !== undefined) return cached
    const j = (this.lookup.get(value) as { j: number | null }).j
    if (j !== null) {
      if (this.julian.size > 200000) this.julian.clear()
      this.julian.set(value, j)
    }
    return j
  }

  /**
   * 札を付けない時刻（`_changelog.changedAt`）が、実行中に刻まれた時刻の範囲にあることを確かめる。
   *
   * 範囲で決めた行の時刻と同じ字面なら確かめない（前提が崩れていないので）。
   * 崩れていれば、値を捨てたことで振る舞いの違う2状態を同じと見るおそれがあるので例外で止める。
   */
  assertRuntimeTimes(values: Iterable<string>): void {
    for (const value of values) {
      if (this.known.has(value)) continue
      const j = this.julianOf(value)
      if (j === null) continue
      if (j <= this.pastMaxJulian || j >= this.futureMinJulian) {
        throw new Error(
          `時刻の正規化の前提が崩れている: 状態から外した changedAt ${value} が、` +
            `実行中に刻まれた時刻の範囲に無い`
        )
      }
    }
  }

  /** 状態に現れた時刻の集合から、字面 → 札 の対応を作る。 */
  labels(values: Iterable<string>): Map<string, string> {
    const universe = new Set<string>(this.known)
    for (const value of values) universe.add(value)
    const parsed: { value: string; j: number }[] = []
    const labels = new Map<string, string>()
    for (const value of universe) {
      const j = this.julianOf(value)
      if (j === null) {
        // 時刻として読めない値は字面のまま（掃除の「壁」になる形がある）
        labels.set(value, `raw:${value}`)
        continue
      }
      parsed.push({ value, j })
    }
    parsed.sort((a, b) =>
      a.j !== b.j
        ? a.j - b.j
        : a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0
    )
    let group = -1
    let previous: number | null = null
    let members: { value: string; j: number }[] = []
    const flush = (): void => {
      members.forEach((member, index) => {
        if (this.known.has(member.value)) {
          labels.set(member.value, member.value)
        } else {
          if (member.j <= this.pastMaxJulian) {
            throw new Error(
              `時刻の正規化の前提が崩れている: 実行中に刻まれた時刻 ${member.value} が、` +
                `範囲で決めた過去の行の時刻より過去にある`
            )
          }
          if (member.j >= this.futureMinJulian) {
            throw new Error(
              `時刻の正規化の前提が崩れている: 実行中に刻まれた時刻 ${member.value} が、` +
                `範囲で決めた未来の行の時刻に追いついた`
            )
          }
          labels.set(
            member.value,
            members.length > 1
              ? `@${String(group)}.${String(index)}`
              : `@${String(group)}`
          )
        }
      })
    }
    for (const item of parsed) {
      if (previous === null || item.j !== previous) {
        flush()
        group += 1
        members = []
        previous = item.j
      }
      members.push(item)
    }
    flush()
    return labels
  }
}

/**
 * 時刻として札を付ける列か。名前が `At` で終わる列（`updatedAt`・`deletedAt`・`changedAt`）と、
 * 版の順序用の時刻 `_sns_ts`。
 *
 * `_sns_ts` を外すと、削除の版に入る実行時刻（C の値）が生の字面のまま状態の鍵に入り、
 * 同じ形の状態が実行ごとに別物になって重複排除が効かなくなる。
 */
function isTimeColumn(column: string): boolean {
  return column.endsWith('At') || column === '_sns_ts'
}

function stampValues(raw: RawWorld): Set<string> {
  return new Set(collectTimes(raw))
}

/**
 * 値を持たない時刻の列か（`_changelog.changedAt`）。
 *
 * 札を付けず、時刻として読めるかだけを残す（冒頭の「振る舞いに効かない値」）。
 */
function isUnvaluedTime(section: string, column: string): boolean {
  return section === '_changelog' && column === 'changedAt'
}

/** 値を持たない時刻の列の中身を集める（前提の確かめに使う）。 */
function collectUnvaluedTimes(raw: RawWorld): string[] {
  const values: string[] = []
  const visit = (db: RawDb | null): void => {
    if (db === null) return
    for (const section of db.sections) {
      section.columns.forEach((column, index) => {
        if (!isUnvaluedTime(section.name, column)) return
        for (const row of section.rows) {
          const value = row[index]
          if (typeof value === 'string' && TIME_PATTERN.test(value)) {
            values.push(value)
          }
        }
      })
    }
  }
  raw.local.forEach(visit)
  raw.nas.forEach(visit)
  return values
}

/** 状態に現れる、札を付ける対象の時刻を集める。 */
export function collectTimes(raw: RawWorld): string[] {
  const values: string[] = []
  const visit = (db: RawDb | null): void => {
    if (db === null) return
    for (const section of db.sections) {
      section.columns.forEach((column, index) => {
        if (!isTimeColumn(column)) return
        if (isUnvaluedTime(section.name, column)) return
        for (const row of section.rows) {
          const value = row[index]
          if (typeof value === 'string' && TIME_PATTERN.test(value)) {
            values.push(value)
          }
        }
      })
    }
  }
  raw.local.forEach(visit)
  raw.nas.forEach(visit)
  return values
}

/** 案A の値の正規化の入り切りと、lamport の打ち切り（tools/explore/normalize.ts）。 */
export type NormalizeOptions = {
  generation: boolean
  lamport: boolean
  /** lamport を「最大値からいくつ離れているか」で打ち切る上限 */
  lamportCap: number
}

/**
 * 設定から正規化の指定を作る。
 *
 * 打ち切りは**残りの深さ**から決めたいが、状態の正準化は節の深さを知らない場所からも
 * 呼ばれる（tools/explore/probe.ts の収束の検査）。そこで**探索の深さの上限**から決める
 * ——どの節でも「残りの深さ ≦ 深さの上限」なので、これは安全側（畳みすぎない側）の見積もりである。
 * 節ごとの残りの深さを渡せるようにすれば、もう少し畳める。
 */
export function normalizeOptionsFrom(config: ExploreConfig): NormalizeOptions {
  return {
    generation: config.normalizeGeneration,
    lamport: config.normalizeLamport,
    lamportCap: lamportCapForDepth(config.depth),
  }
}

/** lamport の値が入る列（案A。`_sns_clock.lamport`、版の `_sns_lamport`、墓標の `lamport`）。 */
const LAMPORT_COLUMNS = new Set(['lamport', '_sns_lamport'])
/** 端末ごとの乱数の id が入る列（案A）。 */
const INSTANCE_COLUMNS = new Set(['instanceId', '_sns_instance'])
/**
 * 状態に含めない列。
 *
 * `_sns_clock.importTick` は作り直しの計算が古くないかを見る数え上げ（設計書 §3.7.1 の token）で、
 * 値そのものは以後の振る舞いを決めない。取り込みのたびに1つ進むので、含めたままだと
 * 同期するたびに「前と同じだが importTick だけ違う」状態が生まれ、**不動点に永久に達しない**
 * （判定9 の偽の反例になる）。
 */
const DROPPED_COLUMNS: Record<string, Set<string>> = {
  _sns_clock: new Set(['importTick']),
}

/** `_sync_meta` の鍵のうち、端末ごとの乱数の id が入るもの（`src/rows/meta.ts`）。 */
const INSTANCE_META_KEYS = new Set(['sns.instanceId', 'sns.lastInstance'])
/** `_sync_meta` の鍵のうち、lamport の値が入るもの。 */
const LAMPORT_META_KEYS = new Set(['sns.lastLamport'])
/** `_sync_meta` の鍵のうち、`generation` が入るもの。 */
const GENERATION_META_KEY = 'sns.generation'

/** `_sync_meta` の1つのキーの値を読む（無ければ null）。 */
function metaValue(db: RawDb | null, key: string): string | null {
  if (db === null) return null
  const section = db.sections.find((item) => item.name === '_sync_meta')
  if (section === undefined) return null
  const keyIndex = section.columns.indexOf('key')
  const valueIndex = section.columns.indexOf('value')
  if (keyIndex < 0 || valueIndex < 0) return null
  for (const row of section.rows) {
    if (row[keyIndex] === key) {
      const value = row[valueIndex]
      return value === null || value === undefined ? null : String(value)
    }
  }
  return null
}

function generationOf(db: RawDb | null): string | null {
  return metaValue(db, GENERATION_META_KEY)
}

/** 世界ぜんたいに現れた lamport の値と instanceId の字面を集める。 */
function collectNormalizable(raw: RawWorld): {
  lamports: number[]
  instances: string[]
} {
  const lamports: number[] = []
  const instances: string[] = []
  const visit = (db: RawDb | null): void => {
    if (db === null) return
    for (const section of db.sections) {
      section.columns.forEach((column, index) => {
        const isLamport = LAMPORT_COLUMNS.has(column)
        const isInstance = INSTANCE_COLUMNS.has(column)
        if (!isLamport && !isInstance) return
        for (const row of section.rows) {
          const value = row[index]
          if (isLamport && typeof value === 'number') lamports.push(value)
          if (isInstance && typeof value === 'string') instances.push(value)
        }
      })
    }
    const section = db.sections.find((item) => item.name === '_sync_meta')
    if (section !== undefined) {
      const keyIndex = section.columns.indexOf('key')
      const valueIndex = section.columns.indexOf('value')
      if (keyIndex >= 0 && valueIndex >= 0) {
        for (const row of section.rows) {
          const key = String(row[keyIndex])
          const value = row[valueIndex]
          if (value === null || value === undefined) continue
          if (INSTANCE_META_KEYS.has(key)) instances.push(String(value))
          if (LAMPORT_META_KEYS.has(key)) {
            const parsed = Number(value)
            if (Number.isFinite(parsed)) lamports.push(parsed)
          }
        }
      }
    }
  }
  raw.local.forEach(visit)
  raw.nas.forEach(visit)
  return { lamports, instances }
}

/**
 * 正規化した状態を1本の文字列にする。
 *
 * 端末の並びは入れ替えない（案A では端末の入れ替えは対称でない。tools/explore/reduction.ts）。
 *
 * @param options - 案A の値（`generation`・lamport）の畳み方
 */
export function serializeState(
  raw: RawWorld,
  labels: Map<string, string>,
  options: NormalizeOptions
): string {
  const { lamports, instances } = collectNormalizable(raw)
  // instanceId は端末ごとの乱数で、字面をそのまま持つと同じ状態が二度と一致しない。
  // 正規化の入り切りを設けていないのは、**外す意味が無い**（外すと重複排除が全く効かない）から
  const instanceMap = instanceLabels(instances)
  const lamportMap = options.lamport
    ? lamportLabels(lamports, options.lamportCap)
    : new Map<number, string>()
  // generation は「手元と NAS の写しの新旧関係」だけを残す（端末ごとに1つ）
  const generationLabels = raw.local.map((local, index) =>
    options.generation
      ? `gen ${generationRelation(generationOf(local), generationOf(raw.nas[index]))}`
      : null
  )
  const serializeDb = (
    db: RawDb | null,
    generationLabel: string | null
  ): string => {
    if (db === null) return 'absent'
    const parts: string[] = [`schema ${db.schema}`]
    for (const section of db.sections) {
      const dropped = DROPPED_COLUMNS[section.name]
      const keptColumns = section.columns
        .map((column, index) => ({ column, index }))
        .filter(({ column }) => dropped === undefined || !dropped.has(column))
      const keyIndex = section.columns.indexOf('key')
      const rows = section.rows.map((row) =>
        keptColumns.map(({ column, index }) => {
          const value = row[index]
          // 案A: lamport は最大値からの隔たり、instanceId は字面の順を保った記号へ
          if (LAMPORT_COLUMNS.has(column) && typeof value === 'number') {
            return lamportMap.get(value) ?? value
          }
          if (INSTANCE_COLUMNS.has(column) && typeof value === 'string') {
            return instanceMap.get(value) ?? value
          }
          if (section.name === '_sync_meta' && column === 'value') {
            const key = keyIndex < 0 ? null : String(row[keyIndex])
            if (
              key !== null &&
              key === GENERATION_META_KEY &&
              generationLabel !== null
            ) {
              return generationLabel
            }
            if (
              key !== null &&
              INSTANCE_META_KEYS.has(key) &&
              typeof value === 'string'
            ) {
              return instanceMap.get(value) ?? value
            }
            if (key !== null && LAMPORT_META_KEYS.has(key)) {
              const parsed = Number(value)
              if (Number.isFinite(parsed)) {
                return lamportMap.get(parsed) ?? value
              }
            }
          }
          if (isUnvaluedTime(section.name, column)) {
            // 時刻として読めるかだけを残す（読めない値は掃除の「壁」になる）
            return typeof value === 'string' && TIME_PATTERN.test(value)
              ? 'time'
              : value
          }
          if (typeof value === 'string' && isTimeColumn(column)) {
            return labels.get(value) ?? value
          }
          return value
        })
      )
      parts.push(`${section.name} ${JSON.stringify(rows)}`)
    }
    return parts.join('\n')
  }

  // 時計は「どの刻みと等しいか」だけが効く。等しい刻みが無ければ（印のまま、または
  // 名乗った操作が何も書かなかった）以後の操作は全ての刻みより後なので、印と同じに扱う
  const clockValue = raw.clock
  const clockLabel =
    clockValue !== null && stampValues(raw).has(clockValue)
      ? (labels.get(clockValue) ?? clockValue)
      : 'fresh'
  const lines: string[] = [`clock ${clockLabel}`]
  raw.local.forEach((local, index) => {
    // generation の札は「その端末の手元と NAS の写しの関係」なので、両側へ同じものを置く
    const generationLabel = generationLabels[index]
    lines.push(
      `## local ${clientName(index)}\n${serializeDb(local, generationLabel)}`
    )
    lines.push(
      `## nas ${clientName(index)}\n${serializeDb(raw.nas[index], generationLabel)}`
    )
  })
  lines.push(`nasExtras ${JSON.stringify(raw.nasExtras)}`)
  return lines.join('\n')
}

export function hashString(text: string): string {
  return crypto.createHash('sha1').update(text).digest('base64')
}

/** 正規化の結果。 */
export type CanonicalState = {
  /** 重複排除の鍵（正規化した状態の直列化のハッシュ） */
  key: string
}

/** 状態の鍵を作る。 */
export function canonicalize(
  raw: RawWorld,
  labeler: TimeLabeler,
  options: NormalizeOptions
): CanonicalState {
  const labels = labeler.labels(collectTimes(raw))
  labeler.assertRuntimeTimes(collectUnvaluedTimes(raw))
  return { key: hashString(serializeState(raw, labels, options)) }
}

type Row = Record<string, unknown>

/**
 * 比較のために、同期対象の中身だけを取り出す（帳簿や changelog は端末ごとに違ってよい）。
 *
 * `updatedAt` は**時刻として**正規化する（`__tests__/convergence-properties.test.ts` の
 * `snapshot` と同じ扱い）。同じ瞬間でも書式は端末ごとに違い、LWW は同着の行を
 * 書き換えないので字面は揃わない。これは中身の食い違いではない。
 */
export function snapshotData(
  db: Database.Database,
  tables: readonly string[]
): Map<string, Row> {
  const toJulian = db.prepare(`SELECT julianday(?) AS j`)
  const rows = new Map<string, Row>()
  for (const table of tables) {
    for (const row of db
      .prepare(`SELECT * FROM "${table}" ORDER BY id`)
      .all() as Row[]) {
      const normalized: Row = { ...row }
      normalized.updatedAt =
        (toJulian.get(String(row.updatedAt)) as { j: number | null }).j ??
        String(row.updatedAt)
      rows.set(`${table}:${String(row.id)}`, normalized)
    }
  }
  return rows
}

/** 全端末の総当たりで食い違っている行のキー（`表:id`）を挙げる。 */
export function allDifferingKeys(
  world: World,
  config: ExploreConfig
): { keys: string[]; describe: (keys: string[]) => string } {
  const tables = TABLE_SETS[config.tableSet]
  const snapshots = world.clients.map((client) =>
    snapshotData(client.db, tables)
  )
  const keys = new Set<string>()
  for (let i = 0; i < snapshots.length; i += 1) {
    for (let j = i + 1; j < snapshots.length; j += 1) {
      const union = new Set([...snapshots[i].keys(), ...snapshots[j].keys()])
      for (const key of union) {
        if (
          JSON.stringify(snapshots[i].get(key)) !==
          JSON.stringify(snapshots[j].get(key))
        ) {
          keys.add(key)
        }
      }
    }
  }
  return {
    keys: [...keys].sort(),
    describe: (selected) =>
      selected
        .map((key) =>
          [
            `  ${key}`,
            ...world.clients.map(
              (client, index) =>
                `    ${client.id}: ${JSON.stringify(snapshots[index].get(key) ?? null)}`
            ),
          ].join('\n')
        )
        .join('\n'),
  }
}
