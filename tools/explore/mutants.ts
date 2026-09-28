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
   * **駆動できない**壊し方の理由（書き換える箇所が `src/` から消えた、いまの題材では
   * 壊しても結果が変わらない、など）。
   *
   * 当てられなくなった壊し方も**消さずに残す**。どの不具合をどう踏んだかは、検査器が
   * 何を見ているかの記録でもある。`--mutant` で選ばれたら、黙って素通しせずに
   * この文言を添えて止める。
   */
  pending?: string
}

/**
 * 旧方式の経路を戻す壊し方に添える文言。
 */
const REMOVED_OLD_PATH =
  '旧方式（_changelog の LWW による取り込み）の経路は src/ から消えた（8c955b8 と 4140921）ので、' +
  '書き換える箇所が無い。案A で同じ形を踏むなら、版の比較（src/rows/versions.ts）か取り込み' +
  '（src/rows/import.ts）に当たる壊し方を書き直すこと'

/**
 * 時刻列が ISO 8601 の文字列でない表を題材から外した（A 案。同期する表の時刻列には ISO 8601 の
 * 文字列しか入らない）ので、観測できなくなった壊し方に添える文言。
 */
const NEEDS_NON_ISO_TIME =
  '同期する表の時刻列に ISO 8601 の文字列しか入らなくなった（docs/principles.md の付則2、' +
  '設計書 §1.8 の P15）ので、題材から epoch_notes（INTEGER の時刻列）と nocase_notes' +
  '（COLLATE NOCASE の時刻列）を外した。ISO の文字列だけでは、壊しても `_sns_ts` の格納クラスも' +
  '順序も変わらない'

export const MUTANTS: Mutant[] = [
  {
    name: 'stalemate-by-literal',
    pending: REMOVED_OLD_PATH,
    description:
      '同じ id の LWW で「同時刻か」を、時刻としての比較（isSameTimestamp）から字面の === へ' +
      '戻す（当時の src/conflict/update.ts と src/conflict/insert.ts の2経路）。同じ瞬間・違う書式で' +
      '中身の違う行は、どちらも勝てないのに膠着と気づかれず、local_wins として黙って' +
      '捨て続けられる（当時の src/conflict/timestamp.ts の isSameTimestamp のコメントにある不具合）。',
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
    pending: REMOVED_OLD_PATH,
    description:
      '「どちらも勝てない食い違い」を報告しない形へ戻す（当時の src/conflict/stalemate.ts の' +
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
      '端末の入れ替えの畳み込みを検査器から外した（案A では健全でない。tools/explore/reduction.ts の' +
      '「畳まないもの」）。自己検査も端末の入れ替えを確かめなくなったので、この人工の壊し方で' +
      '確かめるものが無い',
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
    pending: REMOVED_OLD_PATH,
    description:
      '当時の isPreferredOverRival（src/conflict/timestamp.ts）の同着判定を、時刻としての比較' +
      '（isSameTimestamp）から字面の !== へ戻す。同じ瞬間・違う書式の2行は「差がある」と' +
      '判断されるのに isLaterTimestamp は両向きとも false を返すので、2端末が互いに相手を' +
      '勝たせる。当時の src/ でも、畳む向きの食い違いを conflict/merged-delete.ts の決着が' +
      '後から拾うので、端末2台・書式混在・深さ3まで（20,755状態）の範囲では表に出なかった' +
      '（検査器で確認済み）。案A の勝ち負けは src/rows/versions.ts の版の順序が決めるので、' +
      '`edits` の指す conflict/timestamp.ts はもう無い。',
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
    pending: REMOVED_OLD_PATH,
    description:
      '当時の performSync（src/sync.ts）の冒頭の dropLocalWritesLostToDeletion を外す。' +
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
    pending:
      'deduplicateEntries は src/ から消えた（391aed2。案A では取り込みの入口が版の Max だけになり、' +
      '_changelog のエントリで他端末の見え方が決まる経路が無くなったので、死んだコードとして落とした）。' +
      'いまの src/sync/state.ts は別の中身で、下の `edits` の find は当たらない',
    description:
      '当時の deduplicateEntries（src/sync/state.ts）が同じ行のエントリから「最後の id」を採る形へ' +
      '戻す。フルマージは相手のエントリを元の changedAt のまま新しい id で写すので、id 順と' +
      '時刻順がねじれ、同じ瞬間の削除が写された INSERT に覆い隠されて届かなくなる。',
    suggestedArgs: '--tables users --ids 1 --keys 1 --depth 5',
    edits: [
      {
        // 記録として残す。当時のファイルの中身に対する書き換え
        file: 'sync/state.ts',
        find: '  const present = hasRow(candidate.tableName, candidate.recordId)',
        replace:
          '  if (candidate.id !== kept.id) return candidate.id > kept.id\n' +
          '  const present = hasRow(candidate.tableName, candidate.recordId)',
      },
    ],
  },
  // ---- 案A（docs/rows-table-design.md）の壊し方 ----
  {
    name: 'sns-ts-as-text',
    pending: NEEDS_NON_ISO_TIME,
    description:
      '`_sns_ts` を「型名を書かない列」ではなく TEXT 列にする（`_sns_rows_<表>` と `_tombstone` の' +
      '両方）。エポックのミリ秒（INTEGER）を時刻列に使うアプリでは、版が端末をまたぐたびに' +
      '数値が文字列へ化け、値の種類の順序（設計書 §1.2.3）で群1 から群2/3 へ移る。' +
      '**実測（2026-09-16）: 判定4（参照実装との一致）が、時刻列が INTEGER の表（epoch_notes）の' +
      '深さ2 で捕まえた。** 全端末が同じ壊れ方をするので、判定1（全端末の一致）でも判定5' +
      '（同じ鍵なら同じ中身）でも出ない —— 全端末で群1 が群2 へ移り、数の順序が字面の順序に' +
      '置き換わるからである。',
    suggestedArgs: '（題材が無い）',
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
      '大文字小文字だけが違う2つの `instanceId` が同着になり、`_sns_ts` も `_sns_lamport` も等しい' +
      '2つの版の勝ち負けが決まらない。検査器は端末 a と b に `iid-X` と `iid-x` を与える' +
      '（tools/explore/world.ts の instanceIdFor）ので、同じ瞬間に同じ時刻で同じ行を書けば踏める。' +
      '判定1（黙った食い違い）で出ること（判定11 では出ない。あれは検査器側の参照実装の順序を' +
      '総当たりで見るもので、駆動しているライブラリの比較は見ていない）。' +
      '**実測（2026-09-24）: 遷移2回で黙った食い違いが出る**（a と b が同じ瞬間に u1 を同じ時刻・' +
      '違う名前で書く）。壊していない `src/` では同じ範囲の深さ2 まで反例なし。' +
      '時刻の群2・群4 の比較は、同期する表の時刻列に ISO 8601 の文字列しか入らなくなったので踏めない。',
    suggestedArgs: '--tables users --ids 1 --keys 2 --times 0 --depth 2',
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
      '読み替えた主キーがぶつかる形（設計書 §1.3〜1.7 の表示値）で、勝者が決まらず行が消える。' +
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
  // ---- 設計書 §8.4 の壊し方のうちの3つ ----
  {
    name: 'no-rebuilding-guard',
    description:
      '4本のトリガーの番人（`GUARD`。src/rows/triggers.ts）を外す。作り直しの適用は' +
      'アプリの表から行を消して入れ直すので、番人が無いと**適用そのものが削除の版を作り**、' +
      '他端末のその行を消す（設計書 §3.7.2 の旗 `_sns_rebuilding`）。判定2（同期が事実を作らない）・' +
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
      '削除の版に勝てず（§1.2.1 の (3)）、取り込んだ強い版より古い時刻の書き込みが' +
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
  // ---- 原則2〜4（docs/principles.md）を入れたときに直した不具合 ----
  {
    name: 'no-delete-exec-time',
    description:
      '削除の版の順序用の時刻に、削除を実行した時刻を使わない（src/rows/triggers.ts の deletedAtSql が' +
      '常に NULL を返す）。削除の版の `_sns_ts` は手元の Max（消した行の時刻）のままになり、' +
      'その時刻より新しい他端末の編集に負けて、消したはずの行が戻る（原則2 を入れる前の振る舞い）。' +
      '統合で隠れていた側の墓標（原則3）も同じ時刻を使うので、一緒に壊れる。' +
      '全端末が同じ規則で比べるので一致の検査では出ず、参照実装も実行時刻が操作の列に載らないので' +
      '突き合わせを見送る。捕まえるのは、操作ごとの原則2 の確かめ' +
      '（tools/explore/judgments.ts の checkDeletionPrinciples）である。' +
      '**実測（2026-09-24）: 遷移2回で原則2 の違反が出る**（書いた行を同期の最中に消す）。' +
      '壊していない `src/` では同じ範囲の深さ2 まで反例なし。',
    suggestedArgs: '--tables users --ids 1 --keys 1 --times 0 --depth 2',
    edits: [
      {
        file: 'rows/triggers.ts',
        find: 'function deletedAtSql(parts: TableParts): string {',
        replace:
          "function deletedAtSql(_parts: TableParts): string {\n  return 'NULL'\n}\n\n" +
          '// 壊した版では使わない（元の本体を残すための入れ物）\n' +
          'export function originalDeletedAtSql(parts: TableParts): string {',
      },
    ],
  },
  {
    name: 'no-merged-tombstone',
    description:
      '統合した行を消したとき、隠れていた側の主キーに削除の版を書かない（src/rows/triggers.ts の' +
      'BEFORE DELETE から mergedTombstoneSql を外す）。隠れていた行は次の作り直しで**中身の違う行として' +
      '現れる**（原則3 を入れる前の振る舞い）。全端末で同じように現れるので一致の検査では出ず、' +
      '何が隠れていたかは取り込みの位置で変わるので参照実装も突き合わせを見送る。捕まえるのは、' +
      '操作ごとの原則3 の確かめ（tools/explore/judgments.ts の checkDeletionPrinciples）である。' +
      '統合を作るには、一方が書いて写しを上げ、もう一方が同じ UNIQUE の値で書いてから取り込む必要が' +
      'あるので、同期の最中の書き込み（写す前）で1手縮める。' +
      '**実測（2026-09-24）: 遷移3回で原則3 の違反が出る**（b が同期の最中に g2 を t1 で書いて上げ、' +
      'a が g1 を t1 で書き、a が同期の最中に取り込んだあとで g2 を消す）。' +
      '壊していない `src/` では同じ範囲の深さ4 まで反例なし。',
    suggestedArgs:
      '--tables tags --ids 2 --keys 1 --times 0 --no-prune --no-tick --sync-write before --depth 3',
    edits: [
      {
        file: 'rows/triggers.ts',
        find: '${mergedTombstoneSql(parts, keyText)}',
        replace: '',
      },
    ],
  },
  {
    name: 'drop-parent-deleted-versions',
    description:
      '親が削除されている子のバージョンを `_sns_rows_<表>` から捨てる（src/rows/rebuild.ts の applyPlan に、' +
      '直す前の dropDiscardedVersions と同じ処理を戻す）。捨てるかどうかがその端末がその時点で何を' +
      '知っていたかで決まるので、各端末のバージョンの集合が併合の外で変わる。' +
      '親を消した端末が子を取り込んで捨てたあとで親を同じ主キーで書き直すと、その端末には子が無く、' +
      '他の端末には子が残ったまま一致しない（docs/exhaustive-check.md の「原則4 で子のバージョンを' +
      '捨てていた形」）。直す前と同じく `_sns_unplaceable` からも外すので、判定13 では出ない。' +
      '**実測（2026-09-25）: 遷移3回で判定6 の違反**（一度見えたキーの版が消えた）。' +
      '`--all` で深さ4 まで走らせると、黙った食い違いも出る。',
    suggestedArgs:
      '--tables tags+tag_notes --ids 1 --keys 1 --times 0 --no-prune --no-tick --sync-write before --depth 4',
    edits: [
      {
        file: 'rows/rebuild.ts',
        find: "import { RowsColumn } from './schema'",
        replace:
          "import { RowsColumn, primaryKeyColumn, rowsTableName } from './schema'",
      },
      {
        file: 'rows/rebuild.ts',
        find: `  if (violations.length > 0) {
    return { applied, touched, violations, counts }
  }
`,
        replace: `  if (violations.length > 0) {
    return { applied, touched, violations, counts }
  }
  for (const entry of plan.unplaceable) {
    if (entry.causeTable === null) continue
    if (!applied.some((name) => foldIdentifier(name) === foldIdentifier(entry.table))) continue
    const primaryKey = primaryKeyColumn(db, entry.table).name
    db.prepare(
      \`DELETE FROM \${escapeIdentifier(rowsTableName(entry.table))}
        WHERE CAST(\${escapeIdentifier(primaryKey)} AS TEXT) = ?\`
    ).run(entry.trueId)
    db.prepare(
      \`DELETE FROM "_sns_unplaceable" WHERE "tableName" = ? AND "trueId" = ?\`
    ).run(entry.table, entry.trueId)
  }
`,
      },
    ],
  },
  {
    name: 'place-while-parent-deleted',
    description:
      '親が削除されている間も、子を元の形でアプリの表に入れる（src/rows/derive.ts の displayValues で、' +
      '親が削除されているときに置かない行にせず表示値をそのまま返す）。子が削除された親を指したまま' +
      '置かれる。' +
      '**実測（2026-09-25）: 遷移3回で判定8 の違反**（確定した直後にもう1回作り直すと差が出る）。',
    suggestedArgs:
      '--tables tags+tag_notes --ids 1 --keys 1 --times 0 --no-prune --no-tick --sync-write before --depth 3',
    edits: [
      {
        file: 'rows/derive.ts',
        find: ": { kind: 'parentDeleted', cause }",
        replace: ": { kind: 'values', display }",
      },
    ],
  },
  {
    name: 'sticky-parent-delete',
    description:
      '親が同じ主キーで書き直されても、一度でも削除のバージョンがあった親の子を入れない' +
      '（src/rows/derive.ts で、Max でなく「削除のバージョンがあるか」で親が削除されていると決め、' +
      '親が置かれていても先にそれを見る）。付則3 の「親行が書き直されれば、元の形でユーザーテーブルに' +
      '入る」に反する。全端末が同じ規則で壊れるので一致の検査では出ない。' +
      '**実測（2026-09-25）: 遷移3回で判定10 と判定13 の違反**。',
    suggestedArgs:
      '--tables tags+tag_notes --ids 1 --keys 1 --times 0 --no-prune --no-tick --sync-write before --depth 3',
    edits: [
      {
        file: 'rows/derive.ts',
        find: 'const max = new Map<string, Map<string, RowVersion>>()',
        replace:
          "const max = new Map<string, Map<string, RowVersion>>()\n  const everDeleted = new Set<string>()\n  for (const version of versions) {\n    if (version.kind === 'delete') everDeleted.add(`${version.table}:${values.idKey(version.id)}`)\n  }",
      },
      {
        file: 'rows/derive.ts',
        find: "if (version.kind === 'row') living.push(version)",
        replace:
          "if (version.kind === 'row') {\n        living.push(version)\n        if (everDeleted.has(`${name}:${key}`)) tableGone.set(key, `${name}:${key}`)\n      }",
      },
      {
        file: 'rows/derive.ts',
        find: 'const resolved = resolveParent(values, key, trueValues, res)',
        replace:
          'const resolved =\n      goneParent(values, key, trueValues, gone) !== null\n        ? null\n        : resolveParent(values, key, trueValues, res)',
      },
    ],
  },
  {
    name: 'no-parent-deleted-cause',
    description:
      '親が削除されているかを見ない（src/rows/derive.ts の goneParent が常に null を返す）。' +
      '親が削除されている子は「親が届いていない」置かない行になり、`_sns_unplaceable` に原因の親が入らず、' +
      '`SyncResult.parentDeleted` に出ずに `Unplaceable` の警告になる。アプリの表の見え方は同じなので' +
      '判定4・10 では出ない。捕まえるのは判定13 の後半（本物の `_sns_unplaceable` の原因の親が参照実装と違う）である。' +
      '**実測（2026-09-25）: 遷移3回で判定13 の違反**。',
    suggestedArgs:
      '--tables tags+tag_notes --ids 1 --keys 1 --times 0 --no-prune --no-tick --sync-write before --depth 3',
    edits: [
      {
        file: 'rows/derive.ts',
        find: 'const root = gone.get(key.parentTable)?.get(parentKey)',
        replace:
          'const root: string | undefined = [\n    gone.get(key.parentTable)?.get(parentKey),\n  ].find(() => false)',
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
    throw new Error(`mutant ${mutant.name} は駆動できない: ${mutant.pending}`)
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
