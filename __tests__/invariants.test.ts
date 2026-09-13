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

/**
 * コメントを落とす。JSDoc の中には SQL の綴りが引用されている（説明のため）ので、
 * 字面を数える検査はコメントを混ぜると**説明文に当たって**落ちる。
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n')
}

/** バッククォートで囲まれた文を、位置つきで切り出す。 */
function statementsOf(text: string): { sql: string; end: number }[] {
  const found: { sql: string; end: number }[] = []
  const pattern = /`[^`]*`/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    found.push({ sql: match[0], end: match.index + match[0].length })
  }
  return found
}

/**
 * 文の直後にある値渡し（`.run(...)` / `.all(...)` / `.get(...)`）の引数を読む。
 * 括弧の対応を数えるので `f(g(x))` のような入れ子も丸ごと取れる。
 */
function bindArgsAfter(text: string, from: number): string | undefined {
  const call = /\.(?:run|all|get|pluck)\s*\(/.exec(text.slice(from, from + 400))
  if (!call) return undefined
  let index = from + call.index + call[0].length
  let depth = 1
  const start = index
  for (; index < text.length && depth > 0; index++) {
    if (text[index] === '(') depth++
    else if (text[index] === ')') depth--
  }
  return text.slice(start, index - 1)
}

/**
 * `at` の位置を含む、いちばん内側の `db.transaction(...)` の本体を切り出す。
 *
 * 「同じ区切りの中で行っているか」を字面で見るための道具。括弧の対応を数えるので、
 * 中に入れ子の呼び出しがあっても丸ごと取れる。`at` がその区切りの外に居れば
 * （＝手前で閉じている別のトランザクションだった）`null` を返す。
 */
function enclosingTransaction(code: string, at: number): string | null {
  const opener = code.lastIndexOf('.transaction(', at)
  if (opener === -1) return null

  let index = opener + '.transaction('.length
  let depth = 1
  for (; index < code.length && depth > 0; index++) {
    if (code[index] === '(') depth++
    else if (code[index] === ')') depth--
  }
  return index > at ? code.slice(opener, index) : null
}

describe('規則: 日数を SQL の綴りへ埋め込むなら、必ず均してから渡す', () => {
  it("`'-' || ? || ' days'` を組み立てる文は `normalizeRetentionDays` を通った値を受け取る", () => {
    // 保持期間は**SQLの綴りへ埋め込まれる**（`'-' || ? || ' days'`）。負値を渡すと
    // `--1 days` という解析できない綴りになり、`julianday()` が NULL を返す。
    // NULL との比較は常に偽なので、掃除は1件も消さず、フルマージは1件も取り込まない
    // ——どちらも例外にならないまま黙って止まる。
    //
    // 実際に踏んだ形: この綴りは今2箇所にある（`changelog.ts` の `cleanupChangelog` と
    // `sync/full-merge.ts` の `mergeChangelog`）。前者だけを直して**後者を数え落とした**。
    // 「規則の側から数える」と書いておいて、字面の2箇所目を見落としたので、
    // 3箇所目が素の値を渡したらここで落ちるようにする。
    const offenders: string[] = []
    let checked = 0

    // 日数をSQL式へ組み立てている綴り（`||` で `?` を挟み、`days` を継ぐ形）
    const daySpelling = /\|\|\s*\?\s*\|\|\s*'[^']*\bdays?\b/
    for (const file of sourceFiles()) {
      const code = withoutComments(file.text)
      let embedded = 0
      for (const statement of statementsOf(code)) {
        if (!daySpelling.test(statement.sql)) continue
        embedded++
        checked++

        const args = bindArgsAfter(code, statement.end)
        if (args === undefined) {
          offenders.push(
            `${file.path}: 日数を埋め込む文の値渡しが見つからない\n${statement.sql}`
          )
          continue
        }
        // その場で通しているか、`normalizeRetentionDays` から受けた変数を渡しているか
        const normalizedHere = /\bnormalizeRetentionDays\s*\(/.test(args)
        const normalizedVariable = [...args.matchAll(/[A-Za-z_$][\w$]*/g)].some(
          (name) =>
            new RegExp(
              `(?:const|let|var)\\s+${name[0]}\\s*(?::[^=]*)?=\\s*normalizeRetentionDays\\s*\\(`
            ).test(code)
        )
        if (!normalizedHere && !normalizedVariable) {
          offenders.push(
            `${file.path}: 日数は \`normalizeRetentionDays\` を通してから渡すこと\n渡している値: ${args.trim()}`
          )
        }
      }

      // 文の外（JSの文字列連結など）で同じ綴りを組み立てていないか。
      // 上の検査はバッククォートの中しか見ないので、外に出た瞬間に空振りする。
      const all = code.match(new RegExp(daySpelling.source, 'g')) ?? []
      if (all.length > embedded) {
        offenders.push(
          `${file.path}: 日数を埋め込むSQLは、値渡しと並べて（テンプレートリテラルで）書くこと`
        )
      }
    }

    expect(offenders).toEqual([])
    // 検査対象が0件になったら、この検査自体が壊れている（綴りが変わったか、消えた）
    expect(
      checked,
      '日数を埋め込む文が1つも見つからない＝この検査が空振りしている'
    ).toBeGreaterThan(0)
  })

  it('`changelog` の時刻を SQL で比べるときは `julianday()` で包む', () => {
    // 同じ意味のSQL断片が2箇所以上で組み立てられるなら、綴りも揃っていなければ
    // ならない。`changedAt` は 0.19.0 以降ミリ秒までのISO-T形式だが、それ以前に
    // 書かれた行は秒精度のスペース形式で、**文字列のままでは比べられない**
    // （' '(0x20) < 'T'(0x54) なので、同じ日でも古い書式の方が常に小さく出る）。
    // 片方だけ `julianday()` で包むと、掃除とフルマージが**違う範囲**を指す。
    //
    // **検査するのは `changedAt` を大小で比べている文だけ。** 列として並べるだけの
    // `SELECT … changedAt …` や、`id` で絞る文は対象ではない。
    const offenders: string[] = []
    let checked = 0

    for (const file of sourceFiles()) {
      for (const statement of statementsOf(withoutComments(file.text))) {
        const compared =
          /changedAt\s*\)?\s*(?:<=|>=|<|>)/.test(statement.sql) ||
          /(?:<=|>=|<|>)\s*(?:julianday\s*\(\s*)?changedAt\b/.test(
            statement.sql
          )
        if (!compared) continue

        checked++
        if (!/julianday\s*\(\s*changedAt\s*\)/.test(statement.sql)) {
          offenders.push(
            `${file.path}: 時刻としてそろえてから比べること\n${statement.sql}`
          )
        }
      }
    }

    expect(offenders).toEqual([])
    expect(
      checked,
      '`changedAt` を大小で比べる文が1つも見つからない＝この検査が空振りしている'
    ).toBeGreaterThan(0)
  })
})

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
    // 書き込みが1つも見つからないなら、この検査は「許した2箇所」も含めて何も見て
    // いない（正規表現が当たっていないか、列名が変わった）。規則4と同じ空振りである。
    expect(
      writers.length,
      '`mergedInto` への書き込みが1つも見つからない＝この検査が空振りしている'
    ).toBeGreaterThan(0)
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
    // この検査は「素の比較が無いこと」しか見ないので、正しい側が消えても黙って通る。
    // 名前を突き合わせる箇所が `isSameIdentifier` を1つも呼んでいないなら、
    // 比較はこの検査の知らない別の書き方に移っている＝規則が守られている証拠が無い。
    expect(
      findLines((line) => /\bisSameIdentifier\s*\(/.test(line)).length,
      '`isSameIdentifier` の呼び出しが1つも無い＝この検査が空振りしている'
    ).toBeGreaterThan(0)
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
    const index = /new Map<\s*string\s*,\s*TableConfig\s*>/
    const offenders: string[] = []
    let canonical = 0
    for (const file of sourceFiles()) {
      if (file.path === path.join('sync', 'remote.ts')) {
        if (index.test(file.text)) canonical++ // 正本
        continue
      }
      if (index.test(file.text)) {
        offenders.push(`${file.path}: \`makeTableConfigLookup\` を使うこと`)
      }
    }
    expect(offenders).toEqual([])
    // この検査は「索引の作り方の字面」を1つだけ知っている。正本がその字面を
    // 使わなくなったら（`Record<string, TableConfig>` へ変える、など）、
    // **他所で同じ間違いを書いても当たらない**。正本に当たることを確かめておく。
    expect(
      canonical,
      '正本が `new Map<string, TableConfig>` で索引を作っていない＝この検査が空振りしている'
    ).toBe(1)
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
    // 上と同じ理由。表名からキーを作る箇所が `foldIdentifier` を1つも呼んでいない
    // なら、畳み方はこの検査の知らない書き方に移っている。
    expect(
      findLines((line) => /\bfoldIdentifier\s*\(/.test(line)).length,
      '`foldIdentifier` の呼び出しが1つも無い＝この検査が空振りしている'
    ).toBeGreaterThan(0)
  })
})

describe('規則: `_changelog` から行を消すなら、消した位置を必ず記録する', () => {
  it('`DELETE FROM _changelog` は、掃除済み位置の記録と同じ区切りの中にある', () => {
    // `hasChangelogGap` は2つの物差しで隙間を見る。うち「途中だけが欠けた形」を
    // 見抜けるのは `_changelog_prune` の記録だけである。消した側が書き残さなければ、
    // 読む側は残っているぶんだけを読んでカーソルを進め、**穴に入っていた変更は
    // 二度と差分経路に現れない**（相手が共有から居なくなると届かない）。
    //
    // **同じ区切り（トランザクション）の中にあること**まで見る。別々の区切りで
    // 行うと、途中で落ちたときに「消えたのに記録が無い」＝検出できない穴が
    // 永久に残る。
    const marker = 'DELETE FROM _changelog'
    const offenders: string[] = []
    let checked = 0

    for (const file of sourceFiles()) {
      const code = withoutComments(file.text)
      // `_changelog_prune` を消す文は対象外（記録そのものを畳む操作）
      const pattern = /DELETE FROM _changelog(?!_)/g
      let match: RegExpExecArray | null
      while ((match = pattern.exec(code)) !== null) {
        checked++
        const body = enclosingTransaction(code, match.index)
        if (body === null) {
          offenders.push(
            `${file.path}: \`${marker}\` は区切り（\`db.transaction\`）の中で行うこと`
          )
          continue
        }
        if (!body.includes('recordChangelogPruned')) {
          offenders.push(
            `${file.path}: \`${marker}\` と同じ区切りで \`recordChangelogPruned\` を呼ぶこと`
          )
        }
      }
    }

    expect(offenders).toEqual([])
    // 検査対象が0件になったら、この検査自体が壊れている（綴りが変わったか、消えた）
    expect(
      checked,
      '`DELETE FROM _changelog` を打つ箇所が1つも見つからない＝この検査が空振りしている'
    ).toBeGreaterThan(0)
  })

  it('`_changelog.id` は AUTOINCREMENT のまま', () => {
    // AUTOINCREMENT を外すと、SQLite は空いた最大id（消えたぶん）を**使い回す**。
    // `lastSeenId`（ここまで読んだ）も `prunedThroughId`（ここまで消した）も
    // 「idは単調に増える」ことに乗っているので、再利用が起きた瞬間に
    // 両方が意味を失う ——「読んだ位置より小さいid」で新しい変更が現れ、
    // 差分経路がそれを永久に飛ばす。
    const setup = fs.readFileSync(path.join(SRC, 'setup', 'index.ts'), 'utf8')
    const create = /CREATE TABLE IF NOT EXISTS _changelog\s*\(([^)]*)\)/.exec(
      setup
    )
    expect(create, '`_changelog` の CREATE TABLE が見つからない').not.toBeNull()
    expect(create?.[1]).toMatch(/id\s+INTEGER PRIMARY KEY AUTOINCREMENT/)
  })
})

describe('規則: 時刻の比較は「時刻として」行う', () => {
  it('時刻の値を字面で突き合わせない', () => {
    // 比べる値は書き手によって書式が違う（アプリが書くISO-T形式と、0.19.0 以前の
    // `datetime('now')` による秒精度のスペース形式）。同じ瞬間でも字面は揃わない。
    //
    // 実際に踏んだ形: `isPreferredOverRival` が同着かどうかを `!==` で見ていた。
    // 書式が違うだけで「差がある」と判断して主キーによる同着決着へ降りず、
    // `isLaterTimestamp` は両向きとも false を返すため、**2端末が互いに相手を
    // 勝たせて**どちらも自分の行を残し、永久に収束しなかった。
    //
    // 見るのは「時刻として読んだ値」どうしの比較だけ。列名や書式の綴りを
    // 突き合わせる `=== 'updatedAt'` のような比較は対象ではない。
    const offenders = findLines((line) =>
      /\b\w*(?:[tT]imestamp|updatedAt|deletedAt|changedAt|mergedAt|foldedAt)\w*\s*(?:!==|===)\s*\w*(?:[tT]imestamp|updatedAt|deletedAt|changedAt|mergedAt|foldedAt)\w*\b/.test(
        line
      )
    )
    expect(
      offenders.map((hit) => `${hit.where}: ${hit.line}`),
      '`isSameTimestamp` / `isLaterTimestamp` を使うこと'
    ).toEqual([])
  })

  it('`julianday` で正規化するのは1か所だけ', () => {
    // 正規化の仕方が2つあると、片方だけ直したときにもう片方が古い意味のまま残る。
    // 時刻を数として比べたい箇所は `conflict/timestamp` の2つを通ること
    // （`changelog.ts` の掃除は「行を選ぶSQL」で、値どうしの比較ではない）。
    const users = sourceFiles()
      .filter((file) => /julianday\s*\(\s*\?/.test(file.text))
      .map((file) => file.path)
    expect(
      users,
      '時刻どうしの比較は `conflict/timestamp` に集めること'
    ).toEqual([path.join('conflict', 'timestamp.ts')])
  })
})

describe('規則: `ON DELETE` の意味を写し取る場所を増やさない', () => {
  it('`ON DELETE` の綴りで分岐するのは、決まった2か所だけ', () => {
    // 「親が消えたとき子をどうするか」は SQLite の規則（`CASCADE` / `SET NULL` /
    // `SET DEFAULT` / `NO ACTION` / `RESTRICT`）を写し取る処理で、**写しが増えると
    // 必ず片方だけ直る**。実際、畳みで読み替えた先が消えた場合（`conflict/remap.ts`）
    // には規則が実装されていたのに、畳みが絡まない普通の削除で消えた親を指す子は
    // 素通しで、**COMMIT 時の外部キー違反でその相手ぶんの取り込みが恒久的に
    // 止まっていた**（同じ規則の別の抜け）。
    //
    // 3か所目を足すなら、既存のどちらかへ寄せるか、共通の道具へ括り出すこと。
    const branching = new Set(
      findLines((line) =>
        /(===|!==|case)\s*'(CASCADE|SET NULL|SET DEFAULT|NO ACTION|RESTRICT)'|'(CASCADE|SET NULL|SET DEFAULT|NO ACTION|RESTRICT)'\s*(===|!==)/.test(
          line
        )
      ).map((hit) => hit.where.split(':')[0])
    )

    const allowed = new Set([
      // 届いた行の外部キーの後始末（読み替えた先が消えた場合と、普通に消えた場合）
      path.join('conflict', 'remap.ts'),
      // 畳みで敗者行を消すときの、子の引き取り
      path.join('conflict', 'child-carry.ts'),
    ])
    expect(
      [...branching].filter((file) => !allowed.has(file)),
      '`ON DELETE` の意味は `conflict/remap.ts` と `conflict/child-carry.ts` に集めること'
    ).toEqual([])
    // 検査対象が0件になったら、この検査自体が壊れている
    expect(
      branching.size,
      '`ON DELETE` で分岐する箇所が1つも見つからない＝この検査が空振りしている'
    ).toBeGreaterThan(0)
  })

  it('親が消えたことの判断は `isKnownDeleted` を通る', () => {
    // 「ローカルに無い」と「消えたと分かっている」は違う。取り込みは外部キーの検査を
    // トランザクション終端まで遅らせているので、**親がこのあと同じ取り込みで届く**のは
    // 普通に起きる。証拠（tombstone）が無いのに子を捨てると、順番が違うだけの行を殺す。
    // `_tombstone` を直に引いてこの判断を書くと、作り直された親を「消えている」と
    // 誤って答える（`isKnownDeleted` は取り込み元を見て作り直しを除いている）。
    const offenders = findLines(
      (line) =>
        /parentRowExists\s*\(/.test(line) && !/isKnownDeleted/.test(line)
    ).filter((hit) => !hit.where.startsWith(path.join('conflict', 'remap.ts')))
    expect(
      offenders.map((hit) => `${hit.where}: ${hit.line}`),
      '親の不在から子を捨てるなら `isKnownDeleted` を通すこと'
    ).toEqual([])
  })
})

describe('規則: トリガーが働かない経路で行を変えたら、自分で `_changelog` に載せる', () => {
  it('畳みで id が動いたら、消えた id と動いた先の id の**両方**を載せる', () => {
    // 親と主キーを共有する1:1の子は、親が畳まれると**その子のidそのものが動く**。
    // ふだんは UPDATEトリガが動いた先の1行を記録するが、**フルマージはトリガーを
    // 外して走る**ので何も残らない。動いた先の行は「相手からもらった行」ではなく
    // この端末でidが動いて生まれた姿なので、載せないと他端末はその中身を
    // どこからも知れない（送り主から届くのは「古いidは畳まれた」という削除だけ）。
    //
    // 実測（3端末）: `tag_profiles` が、フルマージした端末にだけ残り、増分同期の
    // 相手へは永久に届かなかった（警告も例外も出ない）。**片側だけを載せるのが
    // 落とし穴**なので、両方そろっていることを数える。
    const fold = withoutComments(
      fs.readFileSync(path.join(SRC, 'conflict', 'fold.ts'), 'utf8')
    )
    const guard = fold.indexOf('previousId !== nextId')
    expect(
      guard,
      '`conflict/fold.ts` に「idが動いた」の分岐が見つからない＝この検査が空振りしている'
    ).toBeGreaterThan(-1)

    // 分岐の本体（`{` から対応する `}` まで）を切り出す
    const open = fold.indexOf('{', guard)
    let index = open + 1
    let depth = 1
    for (; index < fold.length && depth > 0; index++) {
      if (fold[index] === '{') depth++
      else if (fold[index] === '}') depth--
    }
    const body = fold.slice(open, index)

    expect(
      body.includes('writeFoldDeletion('),
      '動いた先が埋まった id の DELETE を `_changelog` へ載せること'
    ).toBe(true)
    expect(
      body.includes('writeFoldMove('),
      '動いた先の id の書き込みを `_changelog` へ載せること'
    ).toBe(true)
  })

  it('`_changelog` へ手で書く箇所は、数え上げてある', () => {
    // トリガー以外から `_changelog` へ書くのは、**トリガーが働かない経路の穴を
    // 塞ぐため**だけである。どれも「この端末でしか分からないことを差分経路へ載せる」
    // という同じ理由を持つので、一覧にして読めるようにしておく。
    // 増やすときは、その理由がこの3つのどれかと同じ形になっているか確かめること。
    const handWritten = new Set<string>()
    for (const file of sourceFiles()) {
      const code = withoutComments(file.text)
      if (!/INSERT INTO _changelog\b/.test(code)) continue
      // トリガーの定義そのものは対象外（これが本来の書き手）
      if (/CREATE TRIGGER/.test(code)) continue
      handWritten.add(file.path)
    }
    expect([...handWritten].sort()).toEqual(
      [
        // 畳みで消えた id / 動いた先の id（フルマージ中はトリガーが外れている）
        path.join('conflict', 'fold-changelog.ts'),
        // 相手のエントリの中継（A が居なくなっても B 経由で C へ届くように）
        path.join('sync', 'full-merge.ts'),
        // 「こちらの版が新しいので採らなかった」の名乗り直し
        path.join('sync', 'entries.ts'),
      ].sort()
    )
  })
})
