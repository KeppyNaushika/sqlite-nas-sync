/**
 * NASファイル操作を提供するモジュール。
 *
 * ローカルDBのNASへのアトミックコピー、リモートクライアントDB列挙、
 * 読み取り専用でのDBオープンを行う。
 *
 * @module nas
 */
import * as fs from 'fs';
import * as path from 'path';
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
 * リモートDBを読み取り専用で安全にオープンする。
 *
 * 以下の手順で安全性を確保する:
 * 1. `{ readonly: true }` でオープン
 * 2. `PRAGMA query_only = ON` を設定
 * 3. `PRAGMA integrity_check` で整合性を検証
 *
 * オープンまたは整合性チェックに失敗した場合は `null` を返す。
 *
 * @param filePath - オープンするDBファイルのパス
 * @returns データベース接続。失敗時は `null`
 */
export function openRemoteDb(
  filePath: string
): Database.Database | null {
  try {
    const db = new Database(filePath, { readonly: true });
    db.pragma('query_only = ON');

    // 整合性チェック
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
