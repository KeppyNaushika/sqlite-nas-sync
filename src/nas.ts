/**
 * NASファイル操作を提供するモジュール。
 *
 * ローカルDBのNASへのアトミックコピー、リモートクライアントDB列挙、
 * 読み取り専用でのDBオープンを行う。
 *
 * @module nas
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import Database from 'better-sqlite3'
import { RemoteClient } from './types'
import { isPublishedTable, quoteLiteral } from './rows/schema'
import { escapeIdentifier, isSameIdentifier } from './setup/sql'

/**
 * ディレクトリが存在しない場合に再帰的に作成する。
 *
 * @param dirPath - 作成するディレクトリパス
 */
export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * ローカルDBの写しを NAS に置く。
 *
 * **写しに載せるのは、他の端末が読む表だけである**（設計書 §3.1。`isPublishedTable`）。
 * アプリの表とトリガーは載せない。どちらも他の端末は読まず、写しの大きさの大半を占める。
 *
 * 1. 手元の一時領域に新しい DB を作り、`localDb` に `ATTACH` する
 * 2. 1つの読み取りトランザクションの中で、載せる表を元と同じ `CREATE` 文と索引で作り、
 *    行と `sqlite_sequence` の値を写す（{@link publishSteps}）。区切りごとにイベントループへ戻る
 * 3. NAS の一時ファイルへ写し、`rename` でアトミックに差し替える
 *
 * 写しの DB を `localDb` に `ATTACH` するのは次の理由である。
 *
 * - `ATTACH` で新しく作る DB の文字コードは main と同じになる。UTF-16 の DB でも写しを作れる
 * - `localDb` はスキーマを読み込み済みなので、元の DB の大きなトリガーの SQL を読み直さない
 * - 元の DB 全体を手元に写さないので、一時領域は写しの大きさで済む
 *
 * 不要な表を `DROP` して作る方法は採らない。アプリの仮想表は、そのモジュールが
 * 登録されていない接続では `DROP` できないからである。
 * ファイル名は `client-{clientId}.sqlite` となる。
 *
 * **`localDb` は、このあいだ他の処理に使わせてはいけない。** 区切りの間も読み取りトランザクションを開いたままなので、
 * 同じ接続で書くとそのトランザクションに入ってしまう。`setupSync` の接続は同期だけが使い、同期は同時に1つしか走らない。
 *
 * @param localDb - 写す元のローカルSQLiteデータベース接続
 * @param nasPath - NAS上の共有ディレクトリパス
 * @param clientId - このクライアントの識別子
 * @param tables - 同期している表。`_sns_rows_<表>` はこの表の分だけを載せる
 * @throws NASへの書き込みに失敗した場合
 */
export async function copyToNas(
  localDb: Database.Database,
  nasPath: string,
  clientId: string,
  tables: readonly string[]
): Promise<FileStamp | null> {
  ensureDirectory(nasPath)

  const destFile = `client-${clientId}.sqlite`
  const destPath = path.join(nasPath, destFile)
  const tempPath = `${destPath}.tmp`

  const tmpDir = defaultTmpDir()
  ensureDirectory(tmpDir)
  const publishedPath = tempCopyPath(tmpDir, 'publish')
  // 大きなファイルの複製・削除・置き換えは、`fs.promises` で別のスレッドに任せる。
  // どれも写しの大きさに比例して時間がかかりうる
  try {
    await writePublishedTables(localDb, publishedPath, tables)
    await fs.promises.copyFile(publishedPath, tempPath)
  } finally {
    // 写しの DB はジャーナルを `MEMORY` にするので、副ファイルは作られない
    await fs.promises.rm(publishedPath, { force: true }).catch(() => {
      /* 消せなければ、次の起動の `sweepStaleRemoteCopies` が消す */
    })
  }
  // **印は rename の前に取る。** rename は inode も更新時刻も大きさも持ち越すので、
  // ここで取った印は「いま書いた中身」の印である。rename のあとに取ると、
  // 割り込んだ別の端末が同じ名前へ書いた**相手の**ファイルを印にしてしまう
  // （それでは写しの取り合いを見抜けない。{@link fileStamp}）
  const stamp = fileStamp(tempPath)
  try {
    await fs.promises.rename(tempPath, destPath)
  } catch (error) {
    // 一時ファイルの名前は clientId で決まるので、同じ clientId の端末が同時に置くと、
    // 先に rename した側がこちらの一時ファイルまで置いてしまう
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `NAS の一時ファイル ${tempPath} が、置く前に無くなった。` +
          `同じ clientId（${clientId}）を使う別のクライアントが、同時に写しを置いた可能性がある`,
        { cause: error }
      )
    }
    throw error
  }
  return stamp
}

/** 写しの DB を `localDb` に `ATTACH` するときのスキーマ名。 */
const PUBLISH_SCHEMA = 'sns_publish'

/** 写しを作る処理を、イベントループへ戻らずに続ける時間の目安（ミリ秒）。 */
const STEP_MS = 10

/**
 * `localDb` から、NAS の写しに載せる表だけを `destPath` の新しい DB へ写す。
 *
 * **写しは1時点のものである。** 写す処理は `BEGIN` から `COMMIT` までの1つのトランザクションで、
 * main には読むだけなので、最初に読んだ時点のスナップショットを最後まで読む。
 * 行の版・`_changelog`・`sqlite_sequence` の値がその時点で揃う。
 *
 * **区切りの間にイベントループへ戻るのは、main が WAL のときだけである。**
 * WAL では読み取りトランザクションがアプリの書き込みを止めないので、
 * 区切りの間にアプリは書ける。その書き込みは写しに載らず、次の写しに載る。
 * WAL でないときに戻ると、読み取りトランザクションの共有ロックがアプリの書き込みの `COMMIT` を
 * `busy_timeout` まで待たせる。そこで、戻らずに続けて写す。
 * `setupSync` は DB を WAL にするので、WAL でないのはアプリが後から変えたときである。
 *
 * 写しの DB はジャーナルを `MEMORY` にし、`synchronous` を切る。
 * 失敗したら捨てるファイルなので、ジャーナルのファイルも `COMMIT` の `fsync` も要らない。
 * `COMMIT` のあと、`DETACH` の前に、別のスレッドでファイルを記憶装置へ書き出す（{@link flushFile}）。
 */
async function writePublishedTables(
  localDb: Database.Database,
  destPath: string,
  tables: readonly string[]
): Promise<void> {
  const yieldsBetweenSteps =
    localDb.pragma('main.journal_mode', { simple: true }) === 'wal'
  const schema = escapeIdentifier(PUBLISH_SCHEMA)
  localDb.exec(`ATTACH DATABASE ${quoteLiteral(destPath)} AS ${schema}`)
  try {
    localDb.pragma(`${schema}.journal_mode = MEMORY`)
    localDb.pragma(`${schema}.synchronous = OFF`)
    localDb.exec('BEGIN')
    try {
      let resumed = performance.now()
      const steps = publishSteps(localDb, tables)
      for (let step = steps.next(); step.done !== true; step = steps.next()) {
        if (!yieldsBetweenSteps || performance.now() - resumed < STEP_MS) {
          continue
        }
        await new Promise((resolve) => setImmediate(resolve))
        resumed = performance.now()
      }
      localDb.exec('COMMIT')
      await flushFile(destPath)
    } catch (error) {
      if (localDb.inTransaction) localDb.exec('ROLLBACK')
      throw error
    }
  } finally {
    localDb.exec(`DETACH DATABASE ${schema}`)
  }
}

/**
 * ファイルに書いた内容を、別のスレッドで記憶装置へ書き出す。
 *
 * 記憶装置へ書き出していないページの多いファイルは、閉じる呼び出しが長くかかることがある。
 * macOS の SSD で 285 MB の写しを `DETACH` したとき 50〜125 ms かかり、
 * 先にこれで書き出すと 1 ms 未満になった。
 *
 * **書き込みのできる形（`r+`）で開く。** Windows の `FlushFileBuffers` は書き込みの権限を持つ
 * ハンドルでなければ `ERROR_ACCESS_DENIED` を返し、Node はそれを `EPERM` として投げる。
 * 読み取り専用（`r`）で開くと、macOS と Linux では通るが Windows では**写しを置くたびに必ず**失敗する。
 */
async function flushFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r+')
  try {
    await handle.datasync()
  } finally {
    await handle.close()
  }
}

/**
 * 写しを作る処理。区切りごとに `yield` する。
 *
 * 表ごとに、表と索引を作ってから行を写す。索引を後から作ると、
 * 大きな表の索引作りが区切れない1回の処理になるからである。
 */
function* publishSteps(
  db: Database.Database,
  tables: readonly string[]
): Generator<void, void, void> {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql FROM main.sqlite_master
        WHERE type IN ('table', 'index') AND sql IS NOT NULL
        ORDER BY type = 'index', rowid`
    )
    .all() as {
    type: 'table' | 'index'
    name: string
    tableName: string
    sql: string
  }[]
  const published: string[] = []
  for (const table of objects) {
    if (table.type !== 'table' || !isPublishedTable(table.name, tables)) {
      continue
    }
    db.exec(inPublishSchema(table.sql))
    for (const index of objects) {
      if (index.type !== 'index') continue
      if (!isSameIdentifier(index.tableName, table.name)) continue
      db.exec(inPublishSchema(index.sql))
    }
    published.push(table.name)
    yield
    yield* copyRows(db, table.name)
  }
  copySequence(db, published)
}

/**
 * 表の行を、rowid の順に区切って写す。
 *
 * rowid も元のまま写す。写した最後の rowid を写しの側の `MAX(rowid)` で引けるので、
 * 区切りの境目を探すために元の表を読み直さずに済む。
 * 区切りの行数は、1つの区切りが {@link STEP_MS} に収まるように増減する。
 * 載せる表はどれもライブラリが作る rowid の表である。rowid は 2^53 を超えうるので BigInt で持つ。
 */
function* copyRows(
  db: Database.Database,
  table: string
): Generator<void, void, void> {
  const name = escapeIdentifier(table)
  const columns = (db.pragma(`main.table_info(${name})`) as { name: string }[])
    .map((column) => escapeIdentifier(column.name))
    .join(', ')
  const target = `${escapeIdentifier(PUBLISH_SCHEMA)}.${name}`
  const copy = db.prepare(
    `INSERT INTO ${target} (rowid, ${columns})
     SELECT rowid, ${columns} FROM main.${name}
      WHERE rowid > ? ORDER BY rowid LIMIT ?`
  )
  const lastCopied = db
    .prepare(`SELECT MAX(rowid) FROM ${target}`)
    .pluck()
    .safeIntegers(true)
  // 最初の区切りの下限。どの rowid よりも小さい
  let after: bigint | number = -Infinity
  let rows = 256
  for (;;) {
    const started = performance.now()
    const copied = copy.run(after, rows).changes
    if (copied < rows) return
    after = lastCopied.get() as bigint
    const elapsed = performance.now() - started
    if (elapsed < STEP_MS / 2) rows *= 2
    else if (elapsed > STEP_MS) rows = Math.max(1, Math.floor(rows / 2))
    yield
  }
}

/**
 * `sqlite_master.sql` の `CREATE` 文を、写しの DB に作る文にする。
 *
 * SQLite は `sqlite_master.sql` の先頭を `CREATE TABLE ` / `CREATE INDEX ` /
 * `CREATE UNIQUE INDEX ` にそろえ、スキーマ名を取り除いて持つ。その直後にスキーマ名を足す。
 */
function inPublishSchema(sql: string): string {
  const head = /^CREATE (?:TABLE|INDEX|UNIQUE INDEX) /.exec(sql)
  if (head === null) {
    throw new Error(`写しに載せる表の定義を読めない: ${sql}`)
  }
  return `${head[0]}${escapeIdentifier(PUBLISH_SCHEMA)}.${sql.slice(head[0].length)}`
}

/**
 * `AUTOINCREMENT` の値（`sqlite_sequence`）を、写した表の分だけ元のまま写す。
 *
 * `_changelog` の隙間の判定がこの値を読むので、行から数え直した値（いま残っている最大の id）にしてはいけない。
 */
function copySequence(db: Database.Database, tables: readonly string[]): void {
  const hasSequence = (schema: string): boolean =>
    db
      .prepare(
        `SELECT 1 FROM ${schema}.sqlite_master
          WHERE type = 'table' AND name = 'sqlite_sequence'`
      )
      .get() !== undefined
  const target = escapeIdentifier(PUBLISH_SCHEMA)
  // 写した表に `AUTOINCREMENT` が1つも無ければ、写すものも無い
  if (!hasSequence(target) || !hasSequence('main')) return
  db.exec(`DELETE FROM ${target}.sqlite_sequence`)
  const insert = db.prepare(
    `INSERT INTO ${target}.sqlite_sequence (name, seq)
     SELECT name, seq FROM main.sqlite_sequence WHERE name = ?`
  )
  for (const table of tables) insert.run(table)
}

/**
 * ファイルの素性の印（inode・大きさ・更新時刻）。
 *
 * 「前に見たときからこのファイルは変わったか」を**中身を読まずに**答えるために使う。
 * `copyToNas` は一時ファイルへ書いてから `rename` するので、書き直されれば
 * **必ず inode が変わる**（同じ名前に新しい実体が入る）。大きさと更新時刻は
 * その補強である。
 *
 * **inode が 0 のときは `null` を返す。** 一部のネットワークファイルシステムは
 * inode を持たず 0 を返す。そこで印を信じると、大きさの変わらない書き換えを
 * 更新時刻の粗さ（SMB では1秒〜2秒）で取りこぼしうる。素性が分からないときは
 * 「分からない」と言い、呼び手には必ず読ませる。
 */
export function fileStamp(filePath: string): FileStamp | null {
  try {
    const stat = fs.statSync(filePath)
    if (stat.ino === 0) return null
    return `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}`
  } catch {
    return null
  }
}

/** {@link fileStamp} が返す印。字面の一致だけに意味がある。 */
export type FileStamp = string

/** ファイルの大きさ（バイト）。読めなければ 0。 */
export function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

/**
 * NAS上の他クライアントのDBファイルを列挙する。
 *
 * `client-{id}.sqlite` パターンのファイルを検索し、
 * 自分自身（`currentClientId`）のファイルは除外する。
 *
 * @param nasPath - NAS上の共有ディレクトリパス
 * @param currentClientId - 除外する自分自身のクライアント識別子
 * @returns リモートクライアント情報の配列。NASが存在しない場合は空配列。
 */
export function listRemoteClients(
  nasPath: string,
  currentClientId: string
): RemoteClient[] {
  if (!fs.existsSync(nasPath)) {
    return []
  }

  const files = fs.readdirSync(nasPath)
  const clients: RemoteClient[] = []

  for (const file of files) {
    const match = file.match(/^client-(.+)\.sqlite$/)
    if (!match) continue

    // 書き込み途中の `client-<id>.sqlite.tmp` は、上の正規表現（末尾が `.sqlite`）で弾かれる
    const clientId = match[1]
    if (clientId === currentClientId) continue

    clients.push({
      clientId,
      filePath: path.join(nasPath, file),
    })
  }

  return clients
}

/** 一時コピーを置く既定のディレクトリ名（`os.tmpdir()` 配下）。 */
const REMOTE_COPY_DIR_NAME = 'sqlite-nas-sync'

/**
 * 一時コピーのファイル名。`<種類>-<pid>-<時刻ms>-<乱数hex>.sqlite`。
 *
 * 種類は、相手の写しを読むための `remote` と、自分の写しを作るための `publish` の2つ。
 */
const REMOTE_COPY_NAME = /^(?:remote|publish)-(\d+)-(\d+)-[0-9a-f]+\.sqlite$/

/** 一時コピーの置き場所を1つ決める（ファイルはまだ作らない）。 */
function tempCopyPath(tmpDir: string, kind: 'remote' | 'publish'): string {
  const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  return path.join(tmpDir, `${kind}-${unique}.sqlite`)
}

/**
 * 既定の一時ディレクトリを解決する。
 *
 * `os.tmpdir()` は呼ぶたびに環境変数（`TMPDIR` 等）を見るので、
 * ここで固定値にキャッシュしてはいけない（テストが `TMPDIR` を差し替えて
 * 隔離できなくなる）。
 */
function defaultTmpDir(): string {
  return path.join(os.tmpdir(), REMOTE_COPY_DIR_NAME)
}

/** 一時コピーの副ファイルの接尾辞。 */
const SIDE_FILE_SUFFIXES = ['-wal', '-shm', '-journal'] as const

/**
 * 一時コピーの本体と副ファイル（`-wal` / `-shm` / `-journal`）をまとめて消す。
 *
 * **本体だけ消すと副ファイルが残る。** 読み取り専用で開いても、コピー元が
 * WALモードのDBなら SQLite は `-wal` / `-shm` を作る。しかも読み取り専用接続は
 * WALのチェックポイントができないため、`close()` しても SQLite 自身は
 * 副ファイルを片付けられない。本体のみ `unlink` していた結果、同期1回・相手1人ごとに
 * 2ファイルずつ溜まり続けていた（実測: テスト全件で 5,994 個）。
 * `-journal` は、0.21.0 が写しを作る途中で落ちたときに残る。
 *
 * 消せなかった場合は黙って諦める。ここでの失敗（既に無い／権限がない）を
 * 例外にすると、同期そのものが止まってしまう。
 */
function removeRemoteCopyFiles(tmpPath: string): void {
  for (const target of [
    tmpPath,
    ...SIDE_FILE_SUFFIXES.map((suffix) => `${tmpPath}${suffix}`),
  ]) {
    try {
      fs.unlinkSync(target)
    } catch {
      /* 無ければそれでよい */
    }
  }
}

/**
 * そのPIDのプロセスがまだ生きているか。
 *
 * `process.kill(pid, 0)` はシグナルを送らずに存在確認だけを行う。
 * `EPERM` は「居るが自分の権限では触れない」なので**生きている**扱いにする
 * （他ユーザーのプロセスが使っている最中の一時コピーを消さないため）。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 一時領域に取り残された古いコピーを掃除する。
 *
 * `cleanup()` の呼び忘れは塞いだが、`SIGKILL` や停電でプロセスが落ちれば
 * どんな `finally` も走らない。その残骸を回収する保険がこれで、
 * 起動時（`setupRowsLedgers`）から1回呼ばれる。
 *
 * **使用中のファイルを消してはいけない。** 同じ機械で複数のクライアントが
 * 動く想定があるため、判定はファイル名に埋め込まれたPIDで行う:
 *
 * - PIDが生きている → **消さない**（自分自身のものも含む）
 * - PIDが死んでいる → 残骸なので消す
 * - 名前からPIDが読めない → `maxAgeMs` より古いものだけ消す
 *   （素性が分からないものを即座に消すと、将来命名を変えたときに
 *   動作中の別バージョンのファイルを消しうる）
 *
 * PIDは再利用されるので、死んだPIDの残骸を「生きている」と誤判定して
 * 残すことはある。溜まり続けはしない（次の起動でまた見る）ので許容する。
 *
 * @param tmpDir - 掃除するディレクトリ。未指定なら `os.tmpdir()/sqlite-nas-sync`。本番の呼び出し（`setupRowsLedgers`）は渡さない。試験のための差し込み口。
 * @param maxAgeMs - PIDが読めない残骸を消す年齢のしきい値。既定24時間。本番の呼び出しは渡さない。試験のための差し込み口。
 * @returns 消した一時コピーの数（本体の名前の数。副ファイルは数えない）
 */
export function sweepStaleRemoteCopies(
  tmpDir?: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000
): number {
  const dir = tmpDir ?? defaultTmpDir()
  let removed = 0

  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    // ディレクトリが無ければ掃除すべきものも無い
    return 0
  }

  const now = Date.now()

  // 副ファイルは本体と一緒に消すので、本体の名前ごとに1回だけ見る。
  // 本体が無く副ファイルだけが残っていることもある。0.21.0 の掃除は `-journal` を消さなかった
  const copies = new Map<string, string>()
  for (const file of files) {
    const suffix = SIDE_FILE_SUFFIXES.find((side) => file.endsWith(side))
    const body = suffix === undefined ? file : file.slice(0, -suffix.length)
    if (
      !(body.startsWith('remote-') || body.startsWith('publish-')) ||
      !body.endsWith('.sqlite')
    )
      continue
    if (!copies.has(body) || suffix === undefined) copies.set(body, file)
  }

  for (const [body, seen] of copies) {
    const match = body.match(REMOTE_COPY_NAME)

    if (match) {
      const pid = Number(match[1])
      if (isProcessAlive(pid)) continue
    } else {
      // PIDが読めない → 年齢で判断する。読めないうえに年齢も分からなければ触らない。
      let mtimeMs: number
      try {
        mtimeMs = fs.statSync(path.join(dir, seen)).mtimeMs
      } catch {
        continue
      }
      if (now - mtimeMs < maxAgeMs) continue
    }

    removeRemoteCopyFiles(path.join(dir, body))
    removed++
  }

  return removed
}

/**
 * リモートDBへの安全なハンドル。
 *
 * `cleanup()` を必ず呼び出して、開いた接続と一時ファイルを解放すること。
 */
export interface RemoteDbHandle {
  /** 読み取り専用でオープンされたデータベース接続。 */
  db: Database.Database
  /**
   * 接続を閉じ、ローカル一時ファイルを削除する。
   * 本体だけでなく WAL の副ファイル（`-wal` / `-shm`）も消す。
   */
  cleanup: () => void
}

/**
 * NAS上のリモートDBファイルをローカル一時領域にコピーしてから読み取り専用で開く。
 *
 * NAS（SMB/NFS等）上のSQLiteファイルを直接 `better-sqlite3` で開くと、
 * 他クライアントによる atomic copy 中の rename と読み取りが衝突して
 * I/Oエラーや「database is locked」となることがある。
 * これを避けるため、まずローカル領域（`os.tmpdir()` 配下）にコピーし、
 * そのローカルコピーを開く。
 *
 * 戻り値の `cleanup()` を呼ぶことで、接続のクローズと一時ファイルの削除が行われる。
 * 呼び忘れると一時ファイルが残り続けるため、必ず `try/finally` で囲むこと。
 *
 * @param filePath - NAS上のオリジナルDBファイルパス
 * @param tmpDir - 一時ファイルを置くディレクトリ。未指定なら `os.tmpdir()/sqlite-nas-sync` を使う。本番の同期は渡さない。試験のための差し込み口。
 * @returns ハンドル。コピー失敗・オープン失敗・整合性NG時は `null`。
 */
export function openRemoteDbViaLocalCopy(
  filePath: string,
  tmpDir?: string
): RemoteDbHandle | null {
  const effectiveTmpDir = tmpDir ?? defaultTmpDir()
  let tmpPath: string | null = null

  try {
    ensureDirectory(effectiveTmpDir)

    tmpPath = tempCopyPath(effectiveTmpDir, 'remote')

    fs.copyFileSync(filePath, tmpPath)

    const db = new Database(tmpPath, { readonly: true })
    db.pragma('query_only = ON')

    const integrity = db.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      removeRemoteCopyFiles(tmpPath)
      return null
    }

    const fileToCleanup = tmpPath
    return {
      db,
      cleanup: () => {
        // 順序が大事: 先に接続を閉じる。開いたまま消すと、SQLiteが
        // その後で副ファイルを作り直して残ることがある。
        try {
          db.close()
        } catch {
          /* ignore */
        }
        removeRemoteCopyFiles(fileToCleanup)
      },
    }
  } catch {
    if (tmpPath) {
      removeRemoteCopyFiles(tmpPath)
    }
    return null
  }
}
