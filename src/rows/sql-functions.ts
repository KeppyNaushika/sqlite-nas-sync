/**
 * SQL の字面から「関数呼び出しの位置に現れた名前」を拾う（設計書
 * `docs/rows-table-design.md` §1.8 の前提 P8）。
 *
 * 同期する表の `CREATE TABLE` と索引の定義に**決定的でない関数**が現れると、
 * 同じ行が端末や時刻によって置ける・置けないに分かれ、補題2と定理1が破れる。
 * SQLite は生成列と CHECK の `datetime('now')` こそ断るが、
 * `CHECK (a <> abs(random()))` も索引の式 `date(a,'now')` も通してしまうので、
 * こちらで名前を見て断るしかない。
 *
 * **名前の部分一致で見てはいけない。** `date`・`time`・`changes` は列名として
 * 普通に使われ、文字列リテラルにもコメントにも現れる。部分一致で実装すると、
 * まともなスキーマを例外で拒む。ここでは字句に分けてから、
 * **直後に `(` が来た名前**だけを関数呼び出しとして拾う。
 *
 * @module rows/sql-functions
 * @internal
 */

import { foldIdentifier } from '../setup/sql'

/** 拾った関数呼び出し1つ。 */
interface FunctionCall {
  /**
   * 関数の名前（引用符を外し、{@link foldIdentifier} で畳んだもの）。
   *
   * 畳むのは ASCII の A–Z だけ。`toLowerCase()` は全 Unicode を畳むので、
   * SQLite にとっては別の識別子である組（`K` U+212A と `k`）を同じものと答える
   */
  name: string
  /** 引数に現れた文字列リテラルの中身（入れ子の中のものも含む） */
  literals: string[]
  /** 引数が空（`date()` のように何も渡していない）か */
  empty: boolean
}

/**
 * どこに現れても断る関数（設計書 §1.8 の一覧）。
 *
 * 日付の関数はここに入れない。**引数に `'now'`・`'localtime'`・`'utc'` を
 * 含む使い方だけ**が決定的でないので、{@link TIME_FUNCTIONS} で別に見る。
 */
const NON_DETERMINISTIC_FUNCTIONS = new Set([
  'random',
  'randomblob',
  'changes',
  'last_insert_rowid',
  'total_changes',
  'sqlite_version',
  'sqlite_source_id',
  'sqlite_compileoption_used',
  'sqlite_compileoption_get',
])

/** 引数しだいで決定的でなくなる、日付の関数。 */
const TIME_FUNCTIONS = new Set([
  'date',
  'time',
  'datetime',
  'julianday',
  'unixepoch',
  'strftime',
])

/** 日付の関数を決定的でなくする修飾子。 */
const TIME_MODIFIERS = /\b(now|localtime|utc)\b/i

/** 字句1つ。 */
interface Token {
  kind: 'name' | 'string' | 'symbol'
  value: string
}

/**
 * SQL を字句に分ける。
 *
 * 見分けるのは**名前・文字列リテラル・記号**だけで、文法は見ない。
 * 行コメント（`--`）、ブロックコメントの囲み、引用符つきの識別子
 * （`"x"` / `` `x` `` / `[x]`）、`''` で書いた引用符を正しく飛ばす。
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < sql.length) {
    const character = sql[at]
    if (/\s/.test(character)) {
      at += 1
      continue
    }
    if (character === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at)
      at = end < 0 ? sql.length : end + 1
      continue
    }
    if (character === '/' && sql[at + 1] === '*') {
      const end = sql.indexOf('*/', at + 2)
      at = end < 0 ? sql.length : end + 2
      continue
    }
    if (character === "'") {
      let value = ''
      let cursor = at + 1
      while (cursor < sql.length) {
        if (sql[cursor] === "'") {
          if (sql[cursor + 1] === "'") {
            value += "'"
            cursor += 2
            continue
          }
          break
        }
        value += sql[cursor]
        cursor += 1
      }
      tokens.push({ kind: 'string', value })
      at = cursor + 1
      continue
    }
    if (character === '"' || character === '`' || character === '[') {
      const closing = character === '[' ? ']' : character
      let value = ''
      let cursor = at + 1
      while (cursor < sql.length) {
        if (sql[cursor] === closing) {
          if (character !== '[' && sql[cursor + 1] === closing) {
            value += closing
            cursor += 2
            continue
          }
          break
        }
        value += sql[cursor]
        cursor += 1
      }
      tokens.push({ kind: 'name', value })
      at = cursor + 1
      continue
    }
    const name = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(
      sql.slice(at)
    )
    if (name !== null) {
      tokens.push({ kind: 'name', value: name[0] })
      at += name[0].length
      continue
    }
    const number = /^\d+(\.\d*)?([eE][+-]?\d+)?|^\.\d+/.exec(sql.slice(at))
    if (number !== null) {
      tokens.push({ kind: 'symbol', value: number[0] })
      at += number[0].length
      continue
    }
    tokens.push({ kind: 'symbol', value: character })
    at += 1
  }
  return tokens
}

/**
 * 関数呼び出しの位置に現れた名前を全部拾う。
 *
 * `abs(random ())` も `abs("random"())` も拾える（空白と引用符は字句の段階で
 * 落ちている）。`CHECK (…)` や `IN (…)` のような、名前に `(` が続くだけの形も
 * 拾ってしまうが、断る名前の一覧に入っていないので害は無い。
 */
function functionCalls(sql: string): FunctionCall[] {
  const tokens = tokenize(sql)
  const calls: FunctionCall[] = []
  for (let at = 0; at < tokens.length; at += 1) {
    if (tokens[at].kind !== 'name') continue
    const next = tokens[at + 1]
    if (next === undefined || next.kind !== 'symbol' || next.value !== '(') {
      continue
    }
    const literals: string[] = []
    let depth = 0
    let empty = false
    for (let cursor = at + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor]
      if (token.kind === 'symbol' && token.value === '(') {
        depth += 1
        if (depth === 1) {
          const after = tokens[cursor + 1]
          empty =
            after !== undefined &&
            after.kind === 'symbol' &&
            after.value === ')'
        }
        continue
      }
      if (token.kind === 'symbol' && token.value === ')') {
        depth -= 1
        if (depth === 0) break
        continue
      }
      if (token.kind === 'string') literals.push(token.value)
    }
    calls.push({ name: foldIdentifier(tokens[at].value), literals, empty })
  }
  return calls
}

/**
 * SQL の字面に決定的でない関数が現れていたら例外（設計書 §1.8 の P8 の検査）。
 *
 * @param sql 見る SQL（`CREATE TABLE` 文、索引の式、部分索引の述語）
 * @param where どこで見つけたかを、例外の文に添えるための言葉
 * @param customFunctions その接続に**独自に登録された**関数の名前（小文字）
 */
export function assertDeterministicSql(
  sql: string,
  where: string,
  customFunctions: ReadonlySet<string> = new Set()
): void {
  for (const call of functionCalls(sql)) {
    if (NON_DETERMINISTIC_FUNCTIONS.has(call.name)) {
      throw new Error(
        `決定的でない関数 ${call.name}() が ${where} に現れている（前提 P8）: ${sql}`
      )
    }
    if (customFunctions.has(call.name)) {
      throw new Error(
        `独自に登録された関数 ${call.name}() が ${where} に現れている（前提 P8）: ${sql}`
      )
    }
    if (!TIME_FUNCTIONS.has(call.name)) continue
    // 日付の関数は引数しだい。`'now'` を含む使い方は、CHECK・生成列・部分索引の
    // WHERE では SQLite 自身が断るので、ここで捕まえるのは主に**索引の式**である
    if (call.empty) {
      throw new Error(
        `引数の無い日付の関数 ${call.name}() が ${where} に現れている（前提 P8）: ${sql}`
      )
    }
    const modifier = call.literals.find((literal) =>
      TIME_MODIFIERS.test(literal)
    )
    if (modifier !== undefined) {
      throw new Error(
        `評価のたびに変わる日付の関数 ${call.name}('${modifier}') が ${where} に現れている（前提 P8）: ${sql}`
      )
    }
  }
}
