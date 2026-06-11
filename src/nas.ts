/**
 * NASファイル操作を提供するモジュール。
 *
 * ローカルDBのNASへのアトミックコピー、リモートクライアントDB列挙、
 * 読み取り専用でのDBオープンを行う。
 *
 * @module nas
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { RemoteClient } from './types';

/**
 * ディレクトリが存在しない場合に再帰的に作成する。
 *
 * @param dirPath - 作成するディレクトリパス
 */
export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
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
): Promise<void> {
  ensureDirectory(nasPath);

  const destFile = `client-${clientId}.sqlite`;
  const destPath = path.join(nasPath, destFile);
  const tempPath = `${destPath}.tmp`;

  await localDb.backup(tempPath);
  fs.renameSync(tempPath, destPath);
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
    return [];
  }

  const files = fs.readdirSync(nasPath);
  const clients: RemoteClient[] = [];

  for (const file of files) {
    const match = file.match(/^client-(.+)\.sqlite$/);
    if (!match) continue;

    const clientId = match[1];
    if (clientId === currentClientId) continue;

    // .tmp ファイルは除外
    if (file.endsWith('.tmp')) continue;

    clients.push({
      clientId,
      filePath: path.join(nasPath, file),
    });
  }

  return clients;
}

/**
 * リモートDBへの安全なハンドル。
 *
 * `cleanup()` を必ず呼び出して、開いた接続と一時ファイルを解放すること。
 */
export interface RemoteDbHandle {
  /** 読み取り専用でオープンされたデータベース接続。 */
  db: Database.Database;
  /** 接続を閉じ、ローカル一時ファイル（あれば）を削除する。 */
  cleanup: () => void;
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
  const effectiveTmpDir = tmpDir ?? path.join(os.tmpdir(), 'sqlite-nas-sync');
  let tmpPath: string | null = null;

  try {
    ensureDirectory(effectiveTmpDir);

    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    tmpPath = path.join(effectiveTmpDir, `remote-${unique}.sqlite`);

    fs.copyFileSync(filePath, tmpPath);

    const db = new Database(tmpPath, { readonly: true });
    db.pragma('query_only = ON');

    const integrity = db.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      try { db.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return null;
    }

    const fileToCleanup = tmpPath;
    return {
      db,
      cleanup: () => {
        try { db.close(); } catch { /* ignore */ }
        try { fs.unlinkSync(fileToCleanup); } catch { /* ignore */ }
      },
    };
  } catch {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    return null;
  }
}

/**
 * リモートDBを読み取り専用でオープンする（旧API）。
 *
 * @deprecated v0.9.0 以降は {@link openRemoteDbViaLocalCopy} を使うこと。
 *   NAS上のファイルを直接開くと、書き込み中の他クライアントとの衝突で
 *   I/Oエラーが発生し、changelog 暴走の原因になる。
 *
 * 互換性のため残しているが、内部からは利用していない。
 */
export function openRemoteDb(
  filePath: string
): Database.Database | null {
  try {
    const db = new Database(filePath, { readonly: true });
    db.pragma('query_only = ON');

    const result = db.pragma('integrity_check', { simple: true }) as string;
    if (result !== 'ok') {
      db.close();
      return null;
    }

    return db;
  } catch {
    return null;
  }
}
