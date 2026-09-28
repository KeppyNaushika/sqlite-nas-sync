/**
 * 索引の定義を読み取る（設計書 `docs/rows-table-design.md` §1.5・前提 P8）。
 *
 * かぶった候補の**勝者**は「その候補の表示値の組で一時 DB を引く」ことで決まる。
 * 引くには、索引がどの列（または式）を、どの照合順序で、どんな述語のもとで
 * 一意にしているかが要る。
 *
 * **情報源は `PRAGMA index_list` と `PRAGMA index_xinfo` である。**
 * 【確認】表の中で宣言した UNIQUE（`code TEXT UNIQUE`、`UNIQUE(a,b)`）と、
 * INTEGER でない主キーは `sqlite_master` に `sqlite_autoindex_*` として現れるが、
 * **`sql` は NULL** で `CREATE INDEX` の文が存在しない。`CREATE INDEX` の
 * 字句解析だけを情報源にすると、そういう表がまるごと例外になるか、かぶりの判定から
 * 漏れる。漏れれば「全ての索引と主キーで引き直して勝者を決める」が成り立たない。
 *
 * `PRAGMA` から `origin`（`c` / `u` / `pk`）・`unique`・`partial`・列の `cid`・
 * `desc`・`coll` はすべて得られる。字句解析が要るのは**次の2つだけ**:
 *
 * | 何 | どこから |
 * | --- | --- |
 * | `partial = 1` の索引の `WHERE` 述語 | `sqlite_master.sql` |
 * | `cid = -2` の項（式の索引）の式本体 | 同上 |
 *
 * **読めない形は例外にする。** 「読めなかったので条件から落とす」と、部分索引の
 * 述語を落としたぶんだけ広く引いてしまい、かぶっていない行を勝者に選ぶ。
 * 設計書の前提 P8 は、読めない索引を `setupSync` の時点で断ることにしている。
 *
 * @module rows/index-parse
 * @internal
 */
import Database from 'better-sqlite3'
import { escapeIdentifier } from '../setup/sql'
import { assertDeterministicSql } from './sql-functions'

/** 索引の項（列そのものか、式）。 */
interface IndexTerm {
  /** 索引の項の SQL の字面（列なら `"name"`、式なら `lower("name")` など） */
  expression: string
  /** その項に効く照合順序（`PRAGMA index_xinfo` の `coll`。既定は `BINARY`） */
  collation: string
  /** 降順で並べてあるか（勝者の判定には効かないが、読み取ったことを残す） */
  descending: boolean
}

/** 一意にしている索引1本の定義。 */
export interface UniqueIndexDefinition {
  /** 索引の名前（主キーを表す作り物なら `<表名>.主キー`） */
  name: string
  /** 索引が付いている表 */
  table: string
  /**
   * 出どころ。`c` は `CREATE INDEX`、`u` は表の宣言の `UNIQUE`、
   * `pk` は主キー（`PRAGMA index_list` の `origin` と同じ）
   */
  origin: 'c' | 'u' | 'pk'
  /** 索引の項（宣言の順） */
  terms: IndexTerm[]
  /** 部分索引の述語（`WHERE` のうしろ）。部分索引でなければ null */
  predicate: string | null
}

/**
 * `CREATE INDEX` を読んだ結果。
 *
 * 索引の名前・表・一意かどうか・向きは `PRAGMA` から取るので、ここには持たない。
 */
interface ParsedCreateIndex {
  /** 項の字面（`COLLATE` と `ASC`/`DESC` を落としたもの） */
  expressions: string[]
  /**
   * 項ごとに明示された `COLLATE`（無ければ null）。
   * 導入時の確かめ（`src/setup/rows-preflight.ts`）が、独自に登録された照合順序を断るのに使う
   */
  collations: (string | null)[]
  /** 部分索引の述語。無ければ null */
  predicate: string | null
}

/**
 * `CREATE [UNIQUE] INDEX …` から、**部分索引の述語と、項の式だけ**を取り出す。
 * 読めない形は例外。
 *
 * 列の名前・照合順序・向き・一意かどうかは `PRAGMA` から取るので、ここでは使わない
 * （`PRAGMA` は表の宣言から生えた索引についても答えるが、この文は存在しない）。
 * {@link readUniqueIndexes} がこれを呼ぶのは、その索引が**部分索引であるか、
 * 式の項（`cid = -2`）を持つとき**だけである。
 *
 * 自前の字句解析は最小限にとどめる（設計書の冒頭「自前の字句解析はできるだけ
 * 使わず、判定は SQLite 自身にさせる」）。ここでやるのは
 * **括弧と引用符を数えて、項の切れ目と `WHERE` の位置を見つけること**だけで、
 * 項の中身も述語の中身も、解釈せずに字面のまま SQL へ戻す。
 */
export function parseCreateIndex(sql: string): ParsedCreateIndex {
  const head =
    /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(sql)
  if (head === null) {
    throw new Error(
      `索引の定義を読めない（CREATE INDEX で始まっていない）: ${sql}`
    )
  }
  // 索引の名前と表の名前は、位置を進めるために読むだけで使わない
  let at = head[0].length
  at = readIdentifier(sql, at).end
  const on = /^\s*ON\s+/i.exec(sql.slice(at))
  if (on === null) {
    throw new Error(`索引の定義を読めない（ON が無い）: ${sql}`)
  }
  at += on[0].length
  at = readIdentifier(sql, at).end

  const open = sql.indexOf('(', at)
  if (open < 0 || sql.slice(at, open).trim() !== '') {
    throw new Error(`索引の定義を読めない（列の並びが無い）: ${sql}`)
  }
  const close = findClosingParen(sql, open)
  const body = sql.slice(open + 1, close)

  const tail = sql.slice(close + 1)
  const where = /^\s*WHERE\s+/i.exec(tail)
  let predicate: string | null = null
  if (where !== null) {
    predicate = tail.slice(where[0].length).replace(/;\s*$/, '').trim()
    if (predicate === '') {
      throw new Error(`索引の定義を読めない（WHERE の中身が空）: ${sql}`)
    }
  } else if (tail.replace(/;\s*$/, '').trim() !== '') {
    // `WHERE` 以外の何かが続く形は、この版では読めたことにしない
    throw new Error(`索引の定義を読めない（WHERE 以外が続く）: ${sql}`)
  }

  const expressions: string[] = []
  const collations: (string | null)[] = []
  for (const raw of splitTopLevel(body, sql)) {
    const term = raw.trim()
    if (term === '') {
      throw new Error(`索引の定義を読めない（空の項がある）: ${sql}`)
    }
    const parsed = stripTermSuffixes(term)
    if (parsed.expression === '') {
      throw new Error(`索引の定義を読めない（項の中身が空）: ${sql}`)
    }
    expressions.push(parsed.expression)
    collations.push(parsed.collation)
  }
  if (expressions.length === 0) {
    throw new Error(`索引の定義を読めない（項が1つも無い）: ${sql}`)
  }

  // 索引の式と部分索引の述語は、SQLite が決定性を見てくれない**唯一の置き場所**
  // である（CHECK・生成列・部分索引の WHERE の `datetime('now')` は SQLite 自身が
  // 断るが、索引の式 `date(a,'now')` は通ってしまう）。ここで断る（前提 P8）
  for (const expression of expressions) {
    assertDeterministicSql(expression, '索引の式')
  }
  if (predicate !== null) {
    assertDeterministicSql(predicate, '部分索引の述語')
  }

  return { expressions, collations, predicate }
}

/**
 * 表に効いている「一意にしている索引」を、主キーも含めて全部返す（設計書 §1.5）。
 *
 * `PRAGMA index_list` は **`INTEGER PRIMARY KEY`（rowid そのもの）を索引として
 * 挙げない。** 挙げないからといって主キーの衝突が起きないわけではない
 * （`SQLITE_CONSTRAINT_PRIMARYKEY` で落ちる）ので、挙がっていなければ
 * 主キーの列から作り物の索引を1本足す。**かぶりが UNIQUE と主キーの両方を拾う**のは
 * この足しぶんがあるからである（設計書 §1.5 の穴3）。
 *
 * 照合順序は、式索引でも列の索引でも `PRAGMA index_xinfo` の `coll` を使う。
 * `CREATE INDEX` の字面には現れない「列の宣言に書かれた `COLLATE NOCASE`」も
 * ここには出るので、字面だけを読むより実物に近い。
 */
export function readUniqueIndexes(
  db: Database.Database,
  table: string
): UniqueIndexDefinition[] {
  const list = db.pragma(`index_list(${escapeIdentifier(table)})`) as {
    name: string
    unique: number
    origin: string
    partial: number
  }[]
  const definitions: UniqueIndexDefinition[] = []
  let hasPrimaryKeyIndex = false

  for (const entry of list) {
    if (Number(entry.unique) !== 1) continue
    const origin = entry.origin as 'c' | 'u' | 'pk'
    if (origin === 'pk') hasPrimaryKeyIndex = true
    const keyColumns = (
      db.pragma(`index_xinfo(${escapeIdentifier(entry.name)})`) as {
        cid: number
        name: string | null
        coll: string
        desc: number
        key: number
      }[]
    ).filter((column) => Number(column.key) === 1)

    // 字句解析するのは、部分索引の述語と、式の項（`cid = -2`）だけ
    const partial = Number(entry.partial) === 1
    const hasExpression = keyColumns.some((column) => Number(column.cid) === -2)
    const parsed =
      partial || hasExpression
        ? parseCreateIndex(indexSql(db, entry.name))
        : null
    if (parsed !== null && parsed.expressions.length !== keyColumns.length) {
      throw new Error(
        `索引の定義を読めない（項の数が PRAGMA と合わない）: ${entry.name}`
      )
    }
    if (partial && parsed?.predicate === null) {
      throw new Error(
        `索引の定義を読めない（部分索引なのに WHERE が読めない）: ${entry.name}`
      )
    }

    definitions.push({
      name: entry.name,
      table,
      origin,
      terms: keyColumns.map((column, at) => ({
        expression:
          Number(column.cid) === -2
            ? (parsed as ParsedCreateIndex).expressions[at]
            : escapeIdentifier(namedColumn(column, entry.name)),
        collation: column.coll,
        descending: Number(column.desc) === 1,
      })),
      predicate: partial ? (parsed as ParsedCreateIndex).predicate : null,
    })
  }

  if (!hasPrimaryKeyIndex) {
    const primaryKey = primaryKeyColumns(db, table)
    if (primaryKey.length > 0) {
      definitions.push({
        name: `${table}.主キー`,
        table,
        origin: 'pk',
        terms: primaryKey.map((column) => ({
          expression: escapeIdentifier(column.name),
          collation: column.collation,
          descending: false,
        })),
        predicate: null,
      })
    }
  }
  return definitions
}

/** `sqlite_master` に載っている索引の文（無ければ例外）。 */
function indexSql(db: Database.Database, name: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { sql: string | null } | undefined
  if (row === undefined || row.sql === null) {
    throw new Error(
      `索引の定義を読めない（sqlite_master に CREATE INDEX が無い）: ${name}`
    )
  }
  return row.sql
}

/** 列の索引の項（`cid >= 0`）の列名。無ければ例外。 */
function namedColumn({ name }: { name: string | null }, index: string): string {
  if (name === null) {
    throw new Error(`索引の定義を読めない（項の列名が読めない）: ${index}`)
  }
  return name
}

/** 表の主キーの列（宣言の順）。 */
export function primaryKeyColumns(
  db: Database.Database,
  table: string
): { name: string; collation: string }[] {
  const info = db.pragma(`table_xinfo(${escapeIdentifier(table)})`) as {
    name: string
    pk: number
    hidden: number
  }[]
  const names = info
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
  if (names.length === 0) return []
  // 列に宣言された照合順序は `table_xinfo` に出ないので、1列だけの索引を
  // 一時に作って `index_xinfo` から読む……ということはせず、`BINARY` を既定にする。
  // `INTEGER PRIMARY KEY` にしかこの筋は来ないので、文字列の照合順序は関わらない
  return names.map((name) => ({ name, collation: 'BINARY' }))
}

/* ------------------------------------------------------------------ *
 * 字面を読む小道具（括弧と引用符を数えるだけ）
 * ------------------------------------------------------------------ */

/** 識別子（`"x"` / `[x]` / `` `x` `` / 素の語）を1つ読む。 */
function readIdentifier(
  sql: string,
  from: number
): { value: string; end: number } {
  let at = from
  while (at < sql.length && /\s/.test(sql[at])) at += 1
  const quote = sql[at]
  const closing = quote === '[' ? ']' : quote
  if (quote === '"' || quote === '`' || quote === '[') {
    let value = ''
    let cursor = at + 1
    while (cursor < sql.length) {
      if (sql[cursor] === closing) {
        // `""` は引用符そのもの（`[` … `]` には二重書きが無い）
        if (quote !== '[' && sql[cursor + 1] === closing) {
          value += closing
          cursor += 2
          continue
        }
        return { value, end: cursor + 1 }
      }
      value += sql[cursor]
      cursor += 1
    }
    throw new Error(`索引の定義を読めない（引用符が閉じていない）: ${sql}`)
  }
  const bare = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(
    sql.slice(at)
  )
  if (bare === null) {
    throw new Error(`索引の定義を読めない（名前が読めない）: ${sql}`)
  }
  return { value: bare[0], end: at + bare[0].length }
}

/** `open` の位置の `(` に対応する `)` の位置。引用符の中は数えない。 */
function findClosingParen(sql: string, open: number): number {
  let depth = 0
  let at = open
  while (at < sql.length) {
    const character = sql[at]
    if (character === "'" || character === '"' || character === '`') {
      at = skipQuoted(sql, at)
      continue
    }
    if (character === '[') {
      const end = sql.indexOf(']', at)
      if (end < 0) {
        throw new Error(`索引の定義を読めない（[ が閉じていない）: ${sql}`)
      }
      at = end + 1
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth === 0) return at
    }
    at += 1
  }
  throw new Error(`索引の定義を読めない（括弧が閉じていない）: ${sql}`)
}

/** 引用符で囲まれた部分を飛ばし、その次の位置を返す。 */
function skipQuoted(sql: string, from: number): number {
  const quote = sql[from]
  let at = from + 1
  while (at < sql.length) {
    if (sql[at] === quote) {
      if (sql[at + 1] === quote) {
        at += 2
        continue
      }
      return at + 1
    }
    at += 1
  }
  throw new Error(`索引の定義を読めない（引用符が閉じていない）: ${sql}`)
}

/** いちばん外側のカンマで切る。 */
function splitTopLevel(body: string, sql: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let at = 0
  while (at < body.length) {
    const character = body[at]
    if (character === "'" || character === '"' || character === '`') {
      at = skipQuoted(body, at)
      continue
    }
    if (character === '[') {
      const end = body.indexOf(']', at)
      if (end < 0) {
        throw new Error(`索引の定義を読めない（[ が閉じていない）: ${sql}`)
      }
      at = end + 1
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(body.slice(start, at))
      start = at + 1
    }
    at += 1
  }
  parts.push(body.slice(start))
  return parts
}

/**
 * 項の末尾から `ASC` / `DESC` と `COLLATE <名前>` を剥がす。
 *
 * 剥がすのは**引用符と括弧の外にある**ものだけ。`lower(a) || 'DESC'` の `DESC` は
 * 文字列の中なので剥がさない。
 */
function stripTermSuffixes(term: string): {
  expression: string
  collation: string | null
} {
  let expression = term
  let collation: string | null = null
  const direction = /\s+(ASC|DESC)\s*$/i.exec(expression)
  if (direction !== null && isOutsideQuotes(expression, direction.index)) {
    expression = expression.slice(0, direction.index)
  }
  const collate =
    /\s+COLLATE\s+("[^"]*"|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(
      expression
    )
  if (collate !== null && isOutsideQuotes(expression, collate.index)) {
    collation = collate[1].replace(/^["[]|["\]]$/g, '')
    expression = expression.slice(0, collate.index)
  }
  return { expression: expression.trim(), collation }
}

/** `at` の位置が引用符と括弧の外か。 */
function isOutsideQuotes(term: string, at: number): boolean {
  let depth = 0
  let cursor = 0
  while (cursor < at) {
    const character = term[cursor]
    if (character === "'" || character === '"' || character === '`') {
      cursor = skipQuoted(term, cursor)
      if (cursor > at) return false
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    cursor += 1
  }
  return depth === 0
}
