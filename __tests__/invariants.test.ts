/**
 * **コードが守るべき規則**そのものを検査する。
 *
 * このライブラリには「呼ぶ側が守る約束」が何本かある。約束が構造ではなく規約なので、
 * 書き足すたびに破れる —— 実際、同じ形の不具合が**別の箇所で4度**見つかった
 * （`readTombstoneClaim` は直したのに `lookupIdMerge` は直っていない、
 * `recordTombstoneMerge` は判断の下に入れたのに `applyTombstoneDelete` は素通り、など）。
 *
 * 症状が出た箇所を直すだけでは、次に同じ規則を破った箇所が見つかるだけである。
 * **規則の側から全箇所を数える**テストをここに置く。新しい書き込みや読み取りを
 * 足したときに、規則を思い出せないまま通ることが無いようにするため。
 *
 * ここでソースの字面を読むのは行儀の良い方法ではないが、
 * 「呼ぶ側が守る約束」を型で表せない以上、数え落としを見つける手立てが他に無い。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.join(__dirname, '..', 'src')

/** `src/` 以下の `.ts` を全部読む。 */
function sourceFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts'))
        files.push({
          path: path.relative(SRC, full),
          text: fs.readFileSync(full, 'utf8'),
        })
    }
  }
  walk(SRC)
  return files
}

/** 行ごとに（コメント行を除いて）述語に当たる箇所を集める。 */
function findLines(
  predicate: (line: string) => boolean
): { where: string; line: string }[] {
  const hits: { where: string; line: string }[] = []
  for (const file of sourceFiles()) {
    file.text.split('\n').forEach((line, index) => {
      const code = line.trim()
      if (
        code.startsWith('//') ||
        code.startsWith('*') ||
        code.startsWith('/*')
      ) {
        return
      }
      if (predicate(line))
        hits.push({ where: `${file.path}:${index + 1}`, line: code })
    })
  }
  return hits
}

describe('規則: 帳簿（`_id_merge` / `_tombstone`）を id で引くときは、綴り違いに備える', () => {
  it('1件引きの文は、大小を畳んだうえで新しい方を採る', () => {
    // 引くときは `COLLATE NOCASE` だが `PRIMARY KEY` は BINARY で照合されるので、
    // `('Users','A')` と `('users','A')` は同居できる。走査順まかせにすると
    // 古い記録を拾い、遅れて届いた子が死んだ id へ読み替えられる。
    //
    // **検査するのは「1件引きの文」だけ。** 意図的な全件スキャン（起動時の掃除や
    // フルマージ）には `WHERE` が無く、この規則の対象ではない。ファイル単位で
    // 判定すると、同じファイルに1件引きを足しただけで無関係な正しい文が落ちる。
    const offenders: string[] = []
    let checked = 0

    for (const file of sourceFiles()) {
      // バッククォートを跨がない範囲で1文ずつ切り出す
      const statements = file.text.match(
        /`[^`]*FROM (?:_id_merge|_tombstone)[^`]*`/g
      )
      for (const statement of statements ?? []) {
        // 1件を引く文か（id で絞っているか）。全件スキャンは対象外
        if (!/\b(recordId|losingId)\s*=\s*\?/.test(statement)) continue
        // 存在確認（`SELECT 1`）は重複しても答えが変わらない
        if (/SELECT\s+1\b/.test(statement)) continue
        // 書き込み（DELETE / UPDATE）は「両方に当てる」のが正しいので対象外
        if (/^`\s*(DELETE|UPDATE|INSERT)/.test(statement)) continue

        checked++
        if (!statement.includes('COLLATE NOCASE')) {
          offenders.push(
            `${file.path}: 表名は COLLATE NOCASE で引くこと\n${statement}`
          )
        }
        if (!/ORDER BY|LIMIT 1/.test(statement)) {
          offenders.push(
            `${file.path}: 綴り違いの2行がありうるので、新しい方を採ること\n${statement}`
          )
        }
      }
    }

    expect(offenders).toEqual([])
    // 検査対象が0件になったら、この検査自体が壊れている（正規表現が当たっていない）
    expect(
      checked,
      '1件引きの文が1つも見つからない＝この検査が空振りしている'
    ).toBeGreaterThan(0)
  })

  it('`_tombstone.mergedInto` を書くのは、判断を通る経路だけ', () => {
    // 「この主張を受け入れるか」は `foldClaimWins` が2つの帳簿を見て一度だけ決める。
    // 別の場所で `mergedInto` を書くと、その判断を飛び越えて帳簿が食い違う。
    // SQL の中の代入だけを見る（`const mergedInto = …` のような変数宣言は別物）
    const writers = findLines(
      (line) =>
        /mergedInto\s*=[^=]/.test(line) &&
        !/^\s*(const|let|var)\s/.test(line) &&
        !/mergedInto\s*[:?]/.test(line)
    ).map((hit) => hit.where.split(':')[0])

    const allowed = new Set([
      // 判断を通した書き込み（`recordMerge` → ここ）
      path.join('conflict', 'tombstone.ts'),
      // 起動時の帳簿の手当て（`_id_merge` と辻褄を合わせるための書き換え）
      path.join('setup', 'id-merge-repair.ts'),
    ])
    const unexpected = [...new Set(writers)].filter(
      (file) => !allowed.has(file)
    )
    expect(
      unexpected,
      '`_tombstone.mergedInto` を書くなら `foldClaimWins` を通すこと'
    ).toEqual([])
  })
})

describe('規則: 識別子（表名・列名）の比較は大小を畳む', () => {
  it('設定由来の名前と `PRAGMA` 由来の名前を、字面で突き合わせない', () => {
    // `PRAGMA` は宣言どおりの綴りを返し、設定は利用者が書いた綴りを持つ。
    // 素の比較にすると、綴りが違うだけで判断が丸ごと素通りする。
    const bare = findLines((line) =>
      /(!==|===)\s*(primaryKey|timestampColumn)\b|\b(col|column|candidate)\.name\s*(!==|===)/.test(
        line
      )
    )
    expect(
      bare.map((hit) => `${hit.where}: ${hit.line}`),
      '`isSameIdentifier` を使うこと'
    ).toEqual([])
  })
})

describe('規則: 表名をキーに設定を引くときは大小を畳む', () => {
  it('`TableConfig` を素の Map で引かない', () => {
    // `_changelog` / `_tombstone` のエントリが名乗る表名は**相手の設定どおりの綴り**。
    // 素の `Map` で引くと全エントリが素通りし、しかもカーソルは進むので失われる。
    //
    // **変数名では検査しない。** 以前この検査は `tableConfigMap.get(` という
    // 字面を探していたが、その呼び出しが消えたあとは0件に当たって**決して落ちなく
    // なっていた**（別の変数名で同じ間違いを書けば素通りする）。「表名で
    // `TableConfig` を引く索引を、`makeTableConfigLookup` 以外で作っていないか」を見る。
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      if (file.path === path.join('sync', 'remote.ts')) continue // 正本
      if (/new Map<\s*string\s*,\s*TableConfig\s*>/.test(file.text)) {
        offenders.push(`${file.path}: \`makeTableConfigLookup\` を使うこと`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('正本（`makeTableConfigLookup`）は畳んで引いている', () => {
    // 上の検査は「他所で作っていないこと」しか見ない。正本が畳んでいなければ
    // 規則そのものが成り立たないので、こちらも押さえる。
    const remote = fs.readFileSync(path.join(SRC, 'sync', 'remote.ts'), 'utf8')
    const body = remote.slice(
      remote.indexOf('export function makeTableConfigLookup')
    )
    expect(body.slice(0, body.indexOf('\n}'))).toContain('foldIdentifier')
  })
})

describe('規則: 識別子を畳むのは1か所だけ（ASCII の A–Z のみ）', () => {
  it('`isSameIdentifier` の定義は1つ', () => {
    // 同じ規則の実装が2つあると、片方だけ直したときにもう片方が古い意味のまま残る。
    const definitions = findLines((line) =>
      /export function isSameIdentifier/.test(line)
    )
    expect(definitions.map((hit) => hit.where)).toHaveLength(1)
  })

  it('表名からキーを作るときも、比較と同じ畳み方を使う', () => {
    // `toLowerCase()` は全 Unicode を畳むので、SQLite にとっては**別の識別子**である
    // 組（`K` U+212A と `k`）を同じものと答える。キーの作り方と比較の仕方が
    // 食い違うと「マップでは同じ、比較では別」というねじれが生まれる。
    const offenders = findLines((line) =>
      /\b(tableName|table|name)\b[^\n]*\.toLowerCase\(\)/.test(line)
    )
    expect(
      offenders.map((hit) => `${hit.where}: ${hit.line}`),
      '`foldIdentifier` を使うこと'
    ).toEqual([])
  })
})
