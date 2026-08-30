/**
 * 「どちらも勝てない食い違い」を言葉にする。
 *
 * @module conflict/stalemate
 * @internal
 */
import { isSameIdentifier } from './schema';

/**
 * 「同じ行なのに、同じ時刻で中身が違う」——どちらも勝てない食い違いを言葉にする。
 *
 * 同一主キーのLWWは**厳密に新しい**ものしか採らないので、両端末が同じ時刻で違う中身を
 * 持つと、互いに相手を拒み続けて動かない。**ライブラリはこれを解けない。**
 * どちらが正しいかはドメインの意味（この採点は同じ採点か、この生徒は同じ生徒か）で、
 * 列の値からは決められないため、勝手に片方を選べば必ずどちらかの編集を消す。
 *
 * **解けないものは、解けないと報告する。** 消えた編集は取り戻せないが、食い違いは
 * 知らせれば人が直せる（どちらかの行に触れば時刻が動いて決着する）。
 *
 * 比較は時刻列を除く全列。**この判定が走るのは時刻が同じで採らないと決めた経路だけ**で、
 * 既に読み込んである2行を突き合わせるだけなのでDBへの問い合わせは増えない。
 *
 * @returns 食い違っていれば利用者へ見せる文言、中身も同じなら null（報告することが無い）。
 *   両側の時刻が空（＝時刻列が読めていない）ときも null —— それは膠着ではない
 * @internal
 */
export function describeStalemate(
  tableName: string,
  recordId: string,
  timestamp: string,
  record: Record<string, unknown>,
  localRecord: Record<string, unknown>,
  columns: string[],
  timestampColumn: string
): string | null {
  // 両側の時刻が**空**なら、それは膠着ではなく「時刻が読めていない」。
  // `timestampColumn` の設定が実際の列とずれていると（明示 `tables:` 設定でのみ起こる。
  // `discoverTables` は実在する列しか選ばない）、両側とも `''` を読んで
  // `isSameTimestamp('', '')` が真になり、**中身が違う行の数だけ**この警告が出る。
  // 出るべきなのは「時刻は同じなのに中身が違う」ときだけなので、ここでは黙る。
  if (timestamp === '') return null;

  const differing = columns.filter((column) => {
    if (isSameIdentifier(column, timestampColumn)) return false;
    return !isSameStoredValue(record[column], localRecord[column]);
  });
  if (differing.length === 0) return null;

  // 列が多い表では全部並べると読めない（実測: 40列で844文字）。人が最初に見るのは
  // 「どの行か」と「どのあたりが違うか」なので、先頭数列だけ挙げて残りは数で畳む。
  const shown = differing.slice(0, STALEMATE_COLUMNS_SHOWN);
  const rest = differing.length - shown.length;
  const where =
    rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');

  return (
    `Stalemate on ${tableName}:${recordId}: both sides are at ${timestamp} ` +
    `but ${where} differ, so neither can win. ` +
    `Edit the row on one side to break the tie.`
  );
}

/**
 * 膠着の報告に挙げる列名の数。
 *
 * これを超えたぶんは件数へ畳む。人が最初に見るのは「どの行か」と「どのあたりが
 * 違うか」で、全列を並べても読めないため（実測: 40列で844文字）。
 * @internal
 */
export const STALEMATE_COLUMNS_SHOWN = 5;


/**
 * 2つの列の値が「同じものが入っている」と言えるか。
 *
 * 片方はローカルDB、もう片方は取り込み元DBから読んだ値で、**同じ列でも表現が
 * 揃うとは限らない**（SQLiteは列の型宣言に関係なく値ごとの型を持つため、
 * 数値 `1` と文字列 `'1'` が同じ列に混在しうる）。BLOB は別インスタンスの
 * `Buffer` になるので参照比較では必ず違うと出る。
 * @internal
 */
export function isSameStoredValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    // 片方だけが空なら違う（両方空は上の === で通っている）
    return (a ?? null) === (b ?? null);
  }
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  return String(a) === String(b);
}

