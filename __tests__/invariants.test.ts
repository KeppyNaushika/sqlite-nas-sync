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
    const setup = fs.readFileSync(path.join(SRC, 'rows', 'schema.ts'), 'utf8')
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
      '`compareTimestamps` を使うこと'
    ).toEqual([])
  })

  it('`julianday` で正規化するのは1か所だけ', () => {
    // 正規化の仕方が2つあると、片方だけ直したときにもう片方が古い意味のまま残る。
    // 時刻を数として比べたい箇所は `sync/timestamp` の `compareTimestamps` を
    // 通ること（`changelog.ts` の掃除は「行を選ぶSQL」で、値どうしの比較ではない）。
    const users = sourceFiles()
      .filter((file) => /julianday\s*\(\s*\?/.test(file.text))
      .map((file) => file.path)
    expect(users, '時刻どうしの比較は `sync/timestamp` に集めること').toEqual([
      path.join('sync', 'timestamp.ts'),
    ])
  })
})

describe('規則: `ON DELETE` の意味を写し取る場所を増やさない', () => {
  it('`ON DELETE` の綴りを読むのは `rows/on-delete.ts` だけ', () => {
    // 「親が置かれていないとき子をどうするか」は SQLite の規則（`CASCADE` /
    // `SET NULL` / `SET DEFAULT` / `NO ACTION` / `RESTRICT`）を写し取る処理で、
    // **写しが増えると必ず片方だけ直る**。旧経路では同じ規則が2か所にあり、
    // 片方だけ実装されていたせいで、消えた親を指す子が素通りして
    // **COMMIT 時の外部キー違反でその相手ぶんの取り込みが恒久的に止まっていた**。
    //
    // 案A では `missingParentAction` の表引き1本に寄せてある。2か所目を足すなら、
    // そこへ寄せるか、共通の道具へ括り出すこと。
    const spelling = /'(CASCADE|SET NULL|SET DEFAULT|NO ACTION|RESTRICT)'/
    const readers = new Set(
      findLines((line) => spelling.test(line)).map(
        (hit) => hit.where.split(':')[0]
      )
    )

    const canonical = path.join('rows', 'on-delete.ts')
    expect(
      [...readers].filter((file) => file !== canonical),
      '`ON DELETE` の意味は `rows/on-delete.ts` に集めること'
    ).toEqual([])
    // 検査対象が0件になったら、この検査自体が壊れている（綴りが変わったか、消えた）
    expect(
      readers.has(canonical),
      '`ON DELETE` の綴りが正本にも見つからない＝この検査が空振りしている'
    ).toBe(true)
  })
})

describe('規則: トリガーが働かない経路で行を変えたら、自分で `_changelog` に載せる', () => {
  it('`_changelog` へ手で書く箇所は、数え上げてある', () => {
    // トリガー以外から `_changelog` へ書くのは、**トリガーが働かない経路の穴を
    // 塞ぐため**だけである。どれも「この端末でしか分からないことを差分経路へ載せる」
    // という同じ理由を持つので、一覧にして読めるようにしておく。
    // 増やすときは、その理由がこの3つのどれかと同じ形になっているか確かめること。
    const handWritten = new Set<string>()
    for (const file of sourceFiles()) {
      const code = withoutComments(file.text)
      if (!/INSERT INTO "?_changelog"?\b/.test(code)) continue
      // トリガーの定義そのものは対象外（これが本来の書き手）
      if (/CREATE TRIGGER/.test(code)) continue
      handWritten.add(file.path)
    }
    expect([...handWritten].sort()).toEqual(
      [
        // 取り込みで `Max` が変わったキーの通知（相手の版を書くのは
        // トリガーの外なので、差分経路へは自分で載せる。§4.3）
        path.join('rows', 'import.ts'),
      ].sort()
    )
  })
})
