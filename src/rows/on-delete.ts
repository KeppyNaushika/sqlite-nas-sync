/**
 * 「親が置かれていないときに子をどうするか」を、案A のなかで**1か所に**置く
 * （設計書 `docs/rows-table-design.md` §1.4 の下の表、原則4・付則3）。
 *
 * `ON DELETE` の意味（`CASCADE` / `RESTRICT` / `NO ACTION` / `SET NULL` / `SET DEFAULT`）は SQLite の規則を写し取る処理で、同じ規則を2か所に書くと片方だけ直ったときに食い違う。
 * そのため、**綴りを読むのはこのファイルだけ**にしてある（`__tests__/invariants.test.ts` の「`ON DELETE` の意味を写し取る場所を増やさない」が見張っている）。
 *
 * 使うのは2か所である。
 * 作り直しの計算（`src/rows/derive.ts`）は、同期する表の子の表示値をこれで決める。
 * 作り直しの適用（`src/rows/rebuild.ts`）は、同期しない表の子をこれで始末する。
 *
 * @module rows/on-delete
 * @internal
 */

/**
 * 親が置かれていないときに、子の外部キー列をどうするか。
 *
 * 同期する表の子では、どれを選んでも子のバージョンは `_sns_rows_<表>` に残る。
 * 決めるのはユーザーテーブルに入れるかどうかと、入れるときの形だけである。
 * 親が削除されているために入らない子は、親が書き直されれば元の形で入る（付則3）。
 * 同期しない表の子にはバージョンが無いので、「入れない」はその行を消すことになる（`src/rows/rebuild.ts` の後始末）。
 */
type MissingParentAction =
  /** その子はユーザーテーブルに入れない（`CASCADE` / `RESTRICT` / `NO ACTION`） */
  | 'drop'
  /** 外部キー列を NULL にして入れる（NOT NULL の列を含むなら入れない） */
  | 'setNull'
  /** 外部キー列を既定値にして入れる（既定値が定数でないか、その値が指す親が無ければ入れない） */
  | 'setDefault'

/**
 * `PRAGMA foreign_key_list` の `on_delete` の綴りを、上の3つへ写す。
 *
 * 表引きにしてあるのは、綴りの写しを式の中へ散らさないため（規則の写しが
 * `if` の連なりになると、1つ足し忘れても黙って既定へ落ちる）。
 * 知らない綴りは `drop` —— **置くよりは置かない方が安全**である
 * （置けば宣言された外部キーを破るが、置かなければ表示が欠けるだけで済む）。
 */
const ACTIONS: Readonly<Record<string, MissingParentAction>> = {
  CASCADE: 'drop',
  RESTRICT: 'drop',
  'NO ACTION': 'drop',
  'SET NULL': 'setNull',
  'SET DEFAULT': 'setDefault',
}

/** 親が置かれていないときの扱いを答える。 */
export function missingParentAction(onDelete: string): MissingParentAction {
  return ACTIONS[onDelete.trim().toUpperCase()] ?? 'drop'
}
