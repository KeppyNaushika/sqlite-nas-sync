/**
 * 既知の不具合を「戻した」版を作る。検査器が**反例を見逃さないこと**を確かめるための道具。
 *
 * 見逃す検査器は「この範囲に反例は無い」と嘘をつくので、無いほうがましである。
 * そこで、このリポジトリで実際に直した不具合を1か所だけ戻した版を駆動し、
 * 検査器が反例を出すことを確かめる（受け入れ条件）。
 *
 * **`src/` には触らない。** `src/` を作業ディレクトリへ写し、写しの1か所だけを
 * 書き換えてコンパイルする。書き換える箇所が見つからない（`src/` 側が修理で
 * 変わった）ときは例外で止める —— 黙って壊さずに走らせると、「壊した版でも
 * 反例が出なかった」という誤った結論になる。
 *
 * @module tools/explore/mutants
 */
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/** 1か所の書き換え。`find` は対象のファイルにちょうど1回現れること。 */
export type Edit = {
  /** `src/` からの相対パス */
  file: string
  find: string
  replace: string
}

export type Mutant = {
  name: string
  /** 何を戻したか、どう壊れるはずか */
  description: string
  /** 検査器で出すための範囲の目安（docs と報告に載せる） */
  suggestedArgs: string
  /** 1つの不具合が複数の箇所にまたがることがある（同じ判定を2つの経路が持つ場合） */
  edits: Edit[]
  /**
   * **まだ駆動できない**壊し方の理由（案A の実装がまだ `src/` に無い、など）。
   *
   * 登録だけ先にしておくのは、実装を書き終えてから壊し方を考えると、
   * 「実装に都合のよい壊し方」しか思いつかなくなるからである。`--mutant` で選ばれたら、
   * 黙って素通しせずにこの文言を添えて止める。
   */
  pending?: string
}

/**
 * 段階6 で旧経路が消えたので、もう当てられない壊し方に添える文言。
 *
 * **消さずに残す。** どの不具合をどう踏んだかは、検査器が何を見ているかの記録でもある。
 * `pending` にしておけば `--mutant` で選ばれたときに黙って素通ししない。
 */
const REMOVED_IN_STAGE6 =
  '旧方式（_changelog の LWW による取り込み）が段階6 で src/ から消えたので、書き換える箇所が無い。' +
  '案A で同じ形を踏むなら、版の比較（src/rows/versions.ts）か取り込み（src/rows/import.ts）に ' +
  '当たる壊し方を書き直すこと'

export const MUTANTS: Mutant[] = [
  {
    name: 'stalemate-by-literal',
    pending: REMOVED_IN_STAGE6,
    description:
      '同じ id の LWW で「同時刻か」を、時刻としての比較（isSameTimestamp）から字面の === へ' +
      '戻す（src/conflict/update.ts と src/conflict/insert.ts の2経路）。同じ瞬間・違う書式で' +
      '中身の違う行は、どちらも勝てないのに膠着と気づかれず、local_wins として黙って' +
      '捨て続けられる（src/conflict/timestamp.ts の isSameTimestamp のコメントにある不具合）。',
    suggestedArgs: '--tables users --ids 1 --formats 0,1 --depth 2',
    edits: [
      {
        file: 'conflict/update.ts',
        find: `const sameTimestamp = isSameTimestamp(
    localDb,
    remoteUpdatedAt,
    localUpdatedAt
  )`,
        replace: 'const sameTimestamp = remoteUpdatedAt === localUpdatedAt',
      },
      {
        file: 'conflict/insert.ts',
        find: `const sameTimestamp = isSameTimestamp(
          localDb,
          remoteUpdatedAt,
          localUpdatedAt
        )`,
        replace: 'const sameTimestamp = remoteUpdatedAt === localUpdatedAt',
      },
    ],
  },
  {
    name: 'no-stalemate-report',
    pending: REMOVED_IN_STAGE6,
    description:
      '「どちらも勝てない食い違い」を報告しない形へ戻す（src/conflict/stalemate.ts の' +
      'describeStalemate が常に null を返す）。同時刻で中身の違う行は解けないまま残るのに' +
      '誰にも知らされない ——「解けないものは解かずに報告する」を入れる前の振る舞い。',
    suggestedArgs: '--tables users --ids 1 --depth 2',
    edits: [
      {
        file: 'conflict/stalemate.ts',
        find: 'if (differing.length === 0) return null',
        replace: 'if (differing.length >= 0) return null',
      },
    ],
  },
  {
    name: 'asymmetric-by-name',
    pending:
      '案A では端末の入れ替えの畳み込みそのものを外した（config.ts の symmetryActive）。' +
      '対称性の自己検査が回らないので、この人工の壊し方で確かめるものが無い。' +
      '端末名で振る舞いが変わる形を見たいなら、まず symmetryActive を戻すこと',
    description:
      '【既知の不具合ではない。自己検査（--self-test）が前提の崩れを見抜けるかを確かめるための' +
      '人工の壊し方】端末 client-a だけ `_changelog` を掃除しない（src/sync/rows-sync.ts）。端末名で' +
      '振る舞いが変わるので、端末の入れ替えは対称でなくなる。--self-test はこれを検出して探索を止めること。' +
      '（元は「client-a だけ _heartbeat を書かない」だった。_heartbeat は廃止したので、' +
      '同じく端末名で終状態が変わる掃除の有無へ差し替えてある）',
    suggestedArgs: '--self-test 10 --depth 2',
    edits: [
      {
        file: 'sync/rows-sync.ts',
        find: 'cleanupChangelog(localDb, retentionDays)',
        replace:
          "if (config.clientId !== 'client-a') cleanupChangelog(localDb, retentionDays)",
      },
    ],
  },
  {
    name: 'tie-by-literal',
    pending: REMOVED_IN_STAGE6,
    description:
      'isPreferredOverRival（src/conflict/timestamp.ts）の同着判定を、時刻としての比較' +
      '（isSameTimestamp）から字面の !== へ戻す。同じ瞬間・違う書式の2行は「差がある」と' +
      '判断されるのに isLaterTimestamp は両向きとも false を返すので、2端末が互いに相手を' +
      '勝たせる。当時の src/ でも、畳む向きの食い違いを conflict/merged-delete.ts の決着が' +
      '後から拾うので、端末2台・書式混在・深さ3まで（20,755状態）の範囲では表に出なかった' +
      '（検査器で確認済み）。**その後 isPreferredOverRival そのものが消えた**（案A の勝ち負けは' +
      'src/rows/versions.ts の版の順序が決める）ので、`edits` の指す conflict/timestamp.ts は無い。',
    suggestedArgs: '--formats 0,1 --depth 3',
    edits: [
      {
        file: 'conflict/timestamp.ts',
        find: 'if (!isSameTimestamp(db, rowTimestamp, rivalTimestamp)) {',
        replace: 'if (rowTimestamp !== rivalTimestamp) {',
      },
    ],
  },
  {
    name: 'no-self-check',
    pending: REMOVED_IN_STAGE6,
    description:
      'performSync（src/sync.ts）の冒頭の dropLocalWritesLostToDeletion を外す。' +
      'アプリがローカルへ「相手が既に受け取った削除より古い時刻」で書いた行は、相手が規則どおり' +
      '採らないので、書いた端末だけが持ち続けて黙って食い違う。表に出すには、削除のあとに' +
      '削除より古い時刻で書き直す列と、相手へ削除が届く経路（フルマージ）が要るので深い。',
    suggestedArgs: '--tables users --ids 1 --keys 1 --depth 5',
    edits: [
      {
        file: 'sync.ts',
        find: 'dropLocalWritesLostToDeletion(localDb, tables, primaryKey, result)',
        replace: 'void dropLocalWritesLostToDeletion',
      },
    ],
  },
  {
    name: 'dedup-by-id',
    pending: REMOVED_IN_STAGE6,
    description:
      'deduplicateEntries（旧 src/sync/state.ts）が同じ行のエントリから「最後の id」を採る形へ' +
      '戻す。フルマージは相手のエントリを元の changedAt のまま新しい id で写すので、id 順と' +
      '時刻順がねじれ、同じ瞬間の削除が写された INSERT に覆い隠されて届かなくなる。' +
      '**その関数はもう src/ に無い**（案A では取り込みの入口が版の Max だけになり、' +
      '_changelog のエントリで他端末の見え方が決まる経路が消えたので、死んだコードとして落とした）。',
    suggestedArgs: '--tables users --ids 1 --keys 1 --depth 5',
    edits: [
      {
        file: 'sync/state.ts',
        find: '  const present = hasRow(candidate.tableName, candidate.recordId)',
        replace:
          '  if (candidate.id !== kept.id) return candidate.id > kept.id\n' +
          '  const present = hasRow(candidate.tableName, candidate.recordId)',
      },
    ],
  },
  // ---- ここから下は案A（docs/rows-table-design.md）の実装が入ってから効く ----
  {
    name: 'sns-ts-as-text',
    description:
      '`_sns_ts` を「型名を書かない列」ではなく TEXT 列にする（`_sns_rows_<表>` と `_tombstone` の' +
      '両方）。エポックのミリ秒（INTEGER）を時刻列に使うアプリでは、版が端末をまたぐたびに' +
      '数値が文字列へ化け、値の種類の順序（設計書 §1.2.3）で群1 から群2/3 へ移る。' +
      '**`--tables epoch_notes` で踏む**（時刻列が INTEGER で、行の時刻が数値の表。' +
      '既定の題材は時刻列がどれも TEXT なので、TEXT 親和性を付けても格納クラスが動かず、何も起きない）。' +
      '**実測（2026-09-16）: 判定4（参照実装との一致）が深さ2 で捕まえる。** ' +
      '全端末が同じ壊れ方をするので、判定1（全端末の一致）でも判定5（同じ鍵なら同じ中身）でも出ない —— ' +
      '値の種類が端末をまたいで変わるのではなく、**全端末で群1 が群2 へ移り、数の順序が字面の順序に' +
      '置き換わる**からである。字面の順序と数の順序が食い違う値（tools/explore/ops.ts の EPOCH_TIMES）と、' +
      '順序が表示に出る形（同じ名前で `UNIQUE` がぶつかる2つの id ＝ `--ids 2 --keys 1`）が要る。',
    suggestedArgs:
      '--tables epoch_notes --ids 2 --keys 1 --depth 2 --oracle rows-d1',
    edits: [
      {
        file: 'rows/schema.ts',
        find: '  declarations.push(escapeIdentifier(VERSION_COLUMNS.ts))',
        replace:
          "  declarations.push(escapeIdentifier(VERSION_COLUMNS.ts) + ' TEXT')",
      },
      {
        file: 'rows/schema.ts',
        find: '      `ALTER TABLE _tombstone ADD COLUMN ${escapeIdentifier(VERSION_COLUMNS.ts)}`',
        replace:
          '      `ALTER TABLE _tombstone ADD COLUMN ${escapeIdentifier(VERSION_COLUMNS.ts)} TEXT`',
      },
    ],
  },
  {
    name: 'no-binary-collation',
    description:
      '版の比較（src/rows/versions.ts）で、順序用の時刻の群2・群4、`instanceId`、真の id の' +
      '正規形を UTF-8 のバイト列ではなく **NOCASE 相当**（小文字へ畳んでから）で比べる。' +
      '`COLLATE NOCASE` で宣言された時刻列では `ABC` と `abc` が同着になり、値が違うのに' +
      '前後が付かない（設計書 §1.2.3 の穴4）。判定1（全端末の一致）・4（参照実装との一致）で出ること' +
      '（**判定11 では出ない**。あれは検査器側の参照実装 `rows-d1` の順序を総当たりで見るもので、' +
      '駆動しているライブラリの比較は見ていない）。' +
      '**`--tables nocase_notes` で踏む**（時刻列を `COLLATE NOCASE` で宣言し、行の時刻を' +
      '大文字小文字だけ違う `TS-A` / `ts-a` にした表）。' +
      '**実測（2026-09-16）: 判定1（黙った食い違い）が深さ2 で捕まえる**（畳んで同着になった2つの版で、' +
      '端末ごとに違う勝者が残り、黙って食い違う）。',
    suggestedArgs:
      '--tables nocase_notes --ids 2 --keys 1 --depth 2 --oracle rows-d1',
    edits: [
      {
        file: 'rows/versions.ts',
        find: '        return Buffer.compare(toBytes(a), toBytes(b))',
        replace: '        return compareFolded(String(a), String(b))',
      },
      {
        file: 'rows/versions.ts',
        find: `    const byInstance = Buffer.compare(
      Buffer.from(a.instance, 'utf8'),
      Buffer.from(b.instance, 'utf8')
    )`,
        replace: '    const byInstance = compareFolded(a.instance, b.instance)',
      },
      {
        file: 'rows/versions.ts',
        find: `    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))`,
        replace: '    return compareFolded(a, b)',
      },
      {
        file: 'rows/versions.ts',
        find: 'function compareNumbers(a: number, b: number): number {',
        replace:
          'function compareFolded(a: string, b: string): number {\n' +
          '  const x = a.toLowerCase()\n' +
          '  const y = b.toLowerCase()\n' +
          '  return x < y ? -1 : x > y ? 1 : 0\n' +
          '}\n\n' +
          'function compareNumbers(a: number, b: number): number {',
      },
    ],
  },
  {
    name: 'primary-key-clash-unplaceable',
    description:
      '主キーの衝突（`SQLITE_CONSTRAINT_PRIMARYKEY`）を「隠れた行」ではなく「置かない行」に' +
      '落とす（src/rows/derive.ts の白紙のリストとかぶりのリストを入れ替える）。1:1 の表で' +
      '読み替えた主キーがぶつかる形（設計書 §1.4）で、勝者が決まらず行が消える。' +
      '判定13（置かない行の逆向きの検査）と判定4・10 で出ること。',
    suggestedArgs: '--tables tags+tag_profiles --ids 2 --keys 1 --depth 3',
    edits: [
      {
        file: 'rows/derive.ts',
        find: "  'SQLITE_MISMATCH',\n])",
        replace: "  'SQLITE_MISMATCH',\n  'SQLITE_CONSTRAINT_PRIMARYKEY',\n])",
      },
      {
        file: 'rows/derive.ts',
        find: "  'SQLITE_CONSTRAINT_PRIMARYKEY',\n  'SQLITE_CONSTRAINT_ROWID',",
        replace: "  'SQLITE_CONSTRAINT_ROWID',",
      },
    ],
  },
  // ---- 段階6 の完了条件 (3) の3つ（設計書 §8.4） ----
  {
    name: 'no-rebuilding-guard',
    description:
      '4本のトリガーの番人（`GUARD`。src/rows/triggers.ts）を外す。作り直しの適用は' +
      'アプリの表から行を消して入れ直すので、番人が無いと**適用そのものが削除の版を作り**、' +
      '他端末のその行を消す（設計書 §3.7.2・§3.10 の軽微15）。判定2（同期が事実を作らない）・' +
      '判定17（適用で lamport・_tombstone・_sns_dirty が増えない）・判定1 で出ること。',
    suggestedArgs: '--tables tags --ids 2 --keys 1 --depth 2',
    edits: [
      {
        file: 'rows/triggers.ts',
        find: 'const GUARD = `NOT EXISTS (SELECT 1 FROM "_sns_rebuilding")`',
        replace: 'const GUARD = `1`',
      },
    ],
  },
  {
    name: 'no-ts-raise',
    description:
      '行の版の `_sns_ts` の引き上げ（設計書 §1.2.1。src/rows/triggers.ts の rowTsSql）を' +
      'やめ、アプリが書いた時刻列の値そのままにする。消してから同じ id で作り直した行が' +
      '削除の版に勝てず（§2.3 の場面4）、取り込んだ強い版より古い時刻の書き込みが' +
      '手元でだけ見えて広まらない。**実測（2026-09-16）: 判定4（参照実装との一致）が' +
      '`--recreate` つきの深さ3 で捕まえる**。',
    suggestedArgs: '--tables tags --ids 1 --keys 1 --depth 3 --recreate',
    edits: [
      {
        file: 'rows/triggers.ts',
        find: `  return maxTsSql([
    written,
    rowsValueSql(parts, VERSION_COLUMNS.ts, trueId),
    tombstoneValueSql(parts, VERSION_COLUMNS.ts, keyText),
  ])`,
        replace: '  return written',
      },
    ],
  },
  {
    name: 'import-rewrites-lamport',
    description:
      '取り込み（src/rows/import.ts の writeRow）が、受け取った版の `_sns_lamport` を' +
      '**自分の `_sns_clock.lamport` で上書き**する。設計書 §4.3 の「受け取った版をそのまま' +
      '格納する」の破れで、同じ版が端末をまたぐたびに別の版になる（3端末で中継すると、' +
      '鍵と中身の対応が壊れて勝者が端末ごとに変わる）。**実測（2026-09-16）: 判定5（同じ版の鍵なら' +
      '同じ中身）が3端末・深さ2 で捕まえる**（判定19 の中身はこれである）。**3端末（`--clients 3`）で踏む**。',
    suggestedArgs: '--clients 3 --tables tags --ids 1 --keys 2 --depth 3',
    edits: [
      {
        file: 'rows/import.ts',
        find: `    const row = claim.row as Record<string, SqlValue>
    statement.run(
      ...([...table.columns, ...Object.values(VERSION_COLUMNS)].map(
        (column) => row[column] ?? null
      ) as never[])
    )`,
        replace: `    const row = claim.row as Record<string, SqlValue>
    statement.run(
      ...([...table.columns, ...Object.values(VERSION_COLUMNS)].map((column) =>
        column === VERSION_COLUMNS.lamport
          ? readLamport(this.db)
          : (row[column] ?? null)
      ) as never[])
    )`,
      },
    ],
  },
]

export function findMutant(name: string): Mutant {
  const mutant = MUTANTS.find((candidate) => candidate.name === name)
  if (mutant === undefined) {
    throw new Error(
      `知らない mutant: ${name}（使えるのは ${MUTANTS.map((m) => m.name).join(', ')}）`
    )
  }
  return mutant
}

/**
 * 不具合を戻した版をコンパイルし、その JS のディレクトリを返す。
 *
 * @param repoRoot - リポジトリの根（`src/` と `node_modules/` を持つ）
 * @param buildRoot - 写しと成果物を置く場所（毎回作り直す）
 */
export function buildMutant(
  mutant: Mutant,
  repoRoot: string,
  buildRoot: string
): string {
  if (mutant.pending !== undefined) {
    throw new Error(
      `mutant ${mutant.name} はまだ駆動できない: ${mutant.pending}（登録だけしてある）`
    )
  }
  const root = path.join(buildRoot, mutant.name)
  const srcCopy = path.join(root, 'src')
  const outDir = path.join(root, 'out')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.cpSync(path.join(repoRoot, 'src'), srcCopy, { recursive: true })

  for (const edit of mutant.edits) {
    const target = path.join(srcCopy, edit.file)
    const text = fs.readFileSync(target, 'utf8')
    const occurrences = text.split(edit.find).length - 1
    if (occurrences !== 1) {
      throw new Error(
        `mutant ${mutant.name}: 書き換える箇所が ${edit.file} に ${String(occurrences)} 個ある（1個であること）。` +
          `src/ が変わったので mutants.ts を直すこと`
      )
    }
    fs.writeFileSync(target, text.replace(edit.find, edit.replace))
  }

  // 本番の tsconfig.json と同じ設定で、写しだけをコンパイルする
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'node16',
      moduleResolution: 'node16',
      lib: ['ES2020'],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      declaration: false,
      rootDir: './src',
      outDir: './out',
      typeRoots: [path.join(repoRoot, 'node_modules', '@types')],
    },
    include: ['src/**/*'],
  }
  const tsconfigPath = path.join(root, 'tsconfig.json')
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2))
  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '-p', tsconfigPath], {
    encoding: 'utf8',
  })
  if (!fs.existsSync(path.join(outDir, 'sync.js'))) {
    throw new Error(
      `mutant ${mutant.name} のコンパイルに失敗した:\n${result.stdout}\n${result.stderr}`
    )
  }
  return outDir
}
