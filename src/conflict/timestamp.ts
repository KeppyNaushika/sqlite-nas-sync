/**
 * 時刻の比較と、時刻にまつわる決め事。
 *
 * LWW（Last-Write-Wins）の物差しをここへ集める。書式の違う時刻をどう比べるか、
 * どの列を時刻として読むか、同時刻をどう決着させるか。
 *
 * @module conflict/timestamp
 * @internal
 */
import Database from 'better-sqlite3';
import { getTableColumns } from './schema';

/**
 * 2つのタイムスタンプを「時刻」として比較する。
 *
 * 比べる値は書き手によって書式が違う。`updatedAt` はアプリが書くISO-T形式
 * （例: `2026-05-13T23:17:35.111+00:00`）。`_tombstone.deletedAt` /
 * `_changelog.changedAt` は 0.19.0 以降 {@link NOW_SQL} による同じ精度のISO-T形式だが、
 * **それ以前に書かれた行は `datetime('now')` による秒精度のスペース形式**
 * （例: `2026-05-02 02:19:56`）で残っており、両者は混在する。
 * 書式が違うと文字列としては比較できない
 * （同日でも ' '(0x20) < 'T'(0x54) となり古い書式の側が常に小さく扱われる）。
 * SQLiteの `julianday()` で正規化して数値比較し、解析不能時のみ文字列比較に
 * フォールバックする。
 *
 * @returns `a` が `b` より後（新しい）なら true
 * @internal
 */
export function isLaterTimestamp(
  db: Database.Database,
  a: string,
  b: string
): boolean {
  const row = db
    .prepare(`SELECT julianday(?) AS ja, julianday(?) AS jb`)
    .get(a, b) as { ja: number | null; jb: number | null };
  if (row.ja != null && row.jb != null) return row.ja > row.jb;
  return a > b;
}


/**
 * 2つのタイムスタンプが**同じ時刻を指しているか**。
 *
 * 文字列としての一致ではない。比べる値は書き手によって書式が違い
 * （ISO-T形式と、旧版が残した秒精度のスペース形式）、同じ瞬間でも字面は揃わない。
 * 「どちらも勝てない」という判定を字面で行うと、書式の違う端末どうしでは膠着に
 * 気づけないまま片方が `local_wins` として黙って捨て続けることになる。
 * {@link isLaterTimestamp} と同じく `julianday()` で正規化し、
 * 解析できないときだけ文字列比較へ落とす。
 * @internal
 */
export function isSameTimestamp(
  db: Database.Database,
  a: string,
  b: string
): boolean {
  if (a === b) return true;
  const row = db
    .prepare(`SELECT julianday(?) AS ja, julianday(?) AS jb`)
    .get(a, b) as { ja: number | null; jb: number | null };
  if (row.ja != null && row.jb != null) return row.ja === row.jb;
  return false;
}

/**
 * 表の名前から、その表の時刻列（`TableConfig.timestampColumn`）を答える手続き。
 *
 * **時刻列は表ごとに違いうる。** 子の設定を親の表に当てると、列名が違うだけで
 * 「時刻が読めない」と答えることになり、その先の判断（畳みの記録がまだ有効か、
 * 親が作り直されたか）が**黙って既定値に落ちる**。表をまたいで時刻を読む場面では、
 * 呼び出し元の設定をここから引くこと。
 *
 * 渡されない場合（公開APIを直接呼ぶ場合）は、呼び出し元が持っている列名を使う。
 * @internal
 */
export type TimestampColumnFor = (tableName: string) => string;

/**
 * LWW比較に使うタイムスタンプ列を決める。
 *
 * 畳んだ親の設定（`timestampColumn`）を優先し、子テーブルにその列が無ければ
 * ライブラリ既定の `updatedAt` を使う。どちらも無ければ null（時刻では決められない）。
 * @internal
 */
export function resolveTimestampColumn(
  db: Database.Database,
  tableName: string,
  preferred: string
): string | null {
  const columns = getTableColumns(db, tableName);
  if (columns.includes(preferred)) return preferred;
  if (columns.includes('updatedAt')) return 'updatedAt';
  return null;
}


/**
 * 行が名乗っている時刻を、畳みの記録に刻む値として取り出す。
 *
 * 列が無い・値が空なら undefined（＝「畳みが確定した時刻は分からない」）。
 * その場合だけ記録は現在時刻に落ちるので、**呼び出し元は列名を必ず
 * {@link resolveTimestampColumn} で解決してから渡すこと** — 親の列名をそのまま
 * 子テーブルへ持ち込むと、列名が違うだけで黙って現在時刻になる。
 * @internal
 */
export function foldTimestampOf(
  row: Record<string, unknown>,
  timestampColumn: string | null
): string | undefined {
  if (!timestampColumn) return undefined;
  const value = row[timestampColumn];
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text === '' ? undefined : text;
}


/**
 * 2つの行のうち、どちらを生かすかをLWWで決める。
 *
 * タイムスタンプ列が無い（または同時刻の）場合は主キーの辞書順で決める。
 * どの端末で解決しても同じ側が残るように、端末ごとに異なる情報は使わない。
 *
 * **同点を主キーで決められるのは、主キーが端末をまたいで一意（uuid等）だから。**
 * 両端末が同じ2つのidを見て同じ答えに達するので、判定は対称で決定的になる
 * （前提そのものは {@link SyncConfig.primaryKey} に書いてある）。時刻で決まらない
 * ぶんを端末ごとに違う向きで決めると、互いに相手を畳んで生き残るidが毎周入れ替わり、
 * 永久に収束しない。**親（この行）と子（付け替えた先）で同じ規則を使うこと。**
 * @internal
 */
export function isPreferredOverRival(
  db: Database.Database,
  row: Record<string, unknown>,
  rival: Record<string, unknown>,
  timestampColumn: string | null,
  primaryKey: string
): boolean {
  if (timestampColumn) {
    const rowTimestamp = String(row[timestampColumn] ?? '');
    const rivalTimestamp = String(rival[timestampColumn] ?? '');
    if (rowTimestamp !== rivalTimestamp) {
      return isLaterTimestamp(db, rowTimestamp, rivalTimestamp);
    }
  }
  return String(row[primaryKey]) < String(rival[primaryKey]);
}

