/**
 * 「親が置かれていないときに子をどうするか」を、案A のなかで**1か所に**置く
 * （設計書 `docs/rows-table-design.md` §1.4 の下の表）。
 *
 * `ON DELETE` の意味（`CASCADE` / `RESTRICT` / `NO ACTION` / `SET NULL` /
 * `SET DEFAULT`）は SQLite の規則を写し取る処理で、**写しが増えると必ず片方だけ
 * 直る**。旧経路では同じ規則が2か所に散っており、片方だけ実装されていたせいで
 * 消えた親を指す子が素通りしていた。
 *
 * 段階6 で旧経路を消したので、**綴りを読むのはこのファイルだけ**である
 * （`__tests__/invariants.test.ts` の「`ON DELETE` の意味を写し取る場所を
 * 増やさない」が見張っている）。
 *
 * @module rows/on-delete
 * @internal
 */

/** 親が置かれていないときに、子の外部キー列をどうするか。 */
export type MissingParentAction =
  /** その子は置かない行にする（`CASCADE` / `RESTRICT` / `NO ACTION`） */
  | 'drop'
  /** 外部キー列を NULL にする（NOT NULL を含むなら置かない行） */
  | 'setNull'
  /** 外部キー列を既定値にする（定数でなければ置かない行） */
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
