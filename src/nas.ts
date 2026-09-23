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
 * ローカルDBをNASにアトミックコピーする。
 *
 * better-sqlite3 の `backup()` APIで一時ファイルに書き込み、
 * `fs.renameSync` でアトミックにリネームする。
 * ファイル名は `client-{clientId}.sqlite` となる。
 *
 * @param localDb - バックアップ元のローカルSQLiteデータベース接続
 * @param nasPath - NAS上の共有ディレクトリパス
 * @param clientId - このクライアントの識別子
 * @throws NASへの書き込みに失敗した場合
 */
export async function copyToNas(
  localDb: Database.Database,
  nasPath: string,
  clientId: string
): Promise<FileStamp | null> {
  ensureDirectory(nasPath)

  const destFile = `client-${clientId}.sqlite`
  const destPath = path.join(nasPath, destFile)
  const tempPath = `${destPath}.tmp`

  await localDb.backup(tempPath)
  // **印は rename の前に取る。** rename は inode も更新時刻も大きさも持ち越すので、
  // ここで取った印は「いま書いた中身」の印である。rename のあとに取ると、
  // 割り込んだ別の端末が同じ名前へ書いた**相手の**ファイルを印にしてしまう
  // （それでは写しの取り合いを見抜けない。{@link fileStamp}）
  const stamp = fileStamp(tempPath)
  fs.renameSync(tempPath, destPath)
  return stamp
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

    const clientId = match[1]
    if (clientId === currentClientId) continue

    // .tmp ファイルは除外
    if (file.endsWith('.tmp')) continue

    clients.push({
      clientId,
      filePath: path.join(nasPath, file),
    })
  }

  return clients
}

/** 一時コピーを置く既定のディレクトリ名（`os.tmpdir()` 配下）。 */
const REMOTE_COPY_DIR_NAME = 'sqlite-nas-sync'

/** 一時コピーのファイル名。`remote-<pid>-<時刻ms>-<乱数hex>.sqlite`。 */
const REMOTE_COPY_NAME = /^remote-(\d+)-(\d+)-[0-9a-f]+\.sqlite$/

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

/**
 * 一時コピーの本体と副ファイル（`-wal` / `-shm`）をまとめて消す。
 *
 * **本体だけ消すと副ファイルが残る。** 読み取り専用で開いても、コピー元が
 * WALモードのDBなら SQLite は `-wal` / `-shm` を作る。しかも読み取り専用接続は
 * WALのチェックポイントができないため、`close()` しても SQLite 自身は
 * 副ファイルを片付けられない。本体のみ `unlink` していた結果、同期1回・相手1人ごとに
 * 2ファイルずつ溜まり続けていた（実測: テスト全件で 5,994 個）。
 *
 * 消せなかった場合は黙って諦める。ここでの失敗（既に無い／権限がない）を
 * 例外にすると、同期そのものが止まってしまう。
 */
function removeRemoteCopyFiles(tmpPath: string): void {
  for (const target of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
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
 * @param tmpDir - 掃除するディレクトリ。未指定なら `os.tmpdir()/sqlite-nas-sync`。
 * @param maxAgeMs - PIDが読めない残骸を消す年齢のしきい値。既定24時間。
 * @returns 消した一時コピーの数（本体の数。副ファイルは数えない）
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

  for (const file of files) {
    // 副ファイルは本体と一緒に消すので、ここでは本体だけを見る
    if (!file.startsWith('remote-') || !file.endsWith('.sqlite')) continue

    const fullPath = path.join(dir, file)
    const match = file.match(REMOTE_COPY_NAME)

    if (match) {
      const pid = Number(match[1])
      if (isProcessAlive(pid)) continue
    } else {
      // PIDが読めない → 年齢で判断する。読めないうえに年齢も分からなければ触らない。
      let mtimeMs: number
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs
      } catch {
        continue
      }
      if (now - mtimeMs < maxAgeMs) continue
    }

    removeRemoteCopyFiles(fullPath)
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
 * @param tmpDir - 一時ファイルを置くディレクトリ。未指定なら `os.tmpdir()/sqlite-nas-sync` を使う。
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

    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    tmpPath = path.join(effectiveTmpDir, `remote-${unique}.sqlite`)

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
