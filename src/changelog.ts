/**
 * `_changelog` テーブルの読み取り・掃除・ギャップ検出を提供するモジュール。
 *
 * @module changelog
 */
import Database from 'better-sqlite3'
import { ChangelogEntry, DEFAULTS } from './types'
import { NOW_SQL } from './setup/sql'

/**
 * 保持期間の設定値を、SQLへ渡してよい値へ均す。
 *
 * **保持期間はSQLの綴りへ埋め込まれる**（`'-' || ? || ' days'`）。負値を渡すと
 * `--1 days` という解析できない綴りになり、`julianday()` が NULL を返す。
 * NULL との比較は常に偽なので、**掃除は1件も消さず、フルマージは1件も取り込まない**
 * ——どちらも例外にならないまま黙って止まる。`NaN` も同じ（バインドすると NULL になる）。
 *
 * 0へ丸めるのは選ばない。0は「今より古いものは残さない」という**有効な設定**で、
 * 間違いの受け皿にすると、設定を書き損じただけで changelog を全部消し、
 * 相手側の `lastSeenId` まで巻き戻してしまう。壊す側より、既定値へ戻す側を採る。
 *
 * @param value - 設定に書かれた値
 * @returns 0以上の有限な日数。使えない値なら {@link DEFAULTS.changelogRetentionDays}
 * @internal
 */
export function normalizeRetentionDays(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULTS.changelogRetentionDays
}

/**
 * 指定IDより後のchangelogエントリを取得する。
 *
 * @param db - 読み取り対象のSQLiteデータベース接続
 * @param sinceId - この値より大きいIDのエントリを返す。0を指定すると全件。
 * @returns changelogエントリの配列（ID昇順）
 */
export function readChangelog(
  db: Database.Database,
  sinceId: number
): ChangelogEntry[] {
  return db
    .prepare(
      `SELECT id, tableName, recordId, operation, changedAt FROM _changelog WHERE id > ? ORDER BY id`
    )
    .all(sinceId) as ChangelogEntry[]
}

/**
 * `_changelog` テーブルの最大IDを取得する。
 *
 * changelogが空の場合は `0` を返す。
 *
 * @param db - 読み取り対象のSQLiteデータベース接続
 * @returns 最大のchangelog ID。空の場合は `0`
 */
export function getMaxChangelogId(db: Database.Database): number {
  const row = db.prepare(`SELECT MAX(id) as maxId FROM _changelog`).get() as {
    maxId: number | null
  }
  return row.maxId ?? 0
}

/**
 * 「どのidまで掃除したか」を読む。
 *
 * `_changelog_prune` に載っているのは {@link cleanupChangelog} が**実際に消した
 * エントリの最大id**。`prunedThroughId > lastSeenId` なら、読む前に消えた
 * エントリがある＝真の隙間である（{@link hasChangelogGap} の第1の規則）。
 *
 * **読み取りしかしない。** 表が無ければ 0 を返す。取り込み元のDBは
 * `new Database(tmpPath, { readonly: true })` で開かれる（{@link openRemoteDbViaLocalCopy}）
 * ので、ここに「無ければ作る」を持ち込むと例外になり、**その相手ぶんの取り込みが
 * 丸ごと止まる**。表が無いのは相手が旧版というだけなので、従来の `MIN(id)` の
 * 判定へ静かに落ちるのが正しい。
 *
 * @param db - 読み取り対象のSQLiteデータベース接続（読み取り専用でよい）
 * @returns 掃除済みのエントリの最大id。記録が無ければ `0`
 */
export function readChangelogPrunedThroughId(db: Database.Database): number {
  try {
    const row = db
      .prepare(`SELECT prunedThroughId FROM _changelog_prune WHERE onlyRow = 0`)
      .get() as { prunedThroughId: number } | undefined
    return row?.prunedThroughId ?? 0
  } catch {
    // 表が無い（相手が旧版 / setupChangelog を通していないDB）
    return 0
  }
}

/**
 * 「どのidまで掃除したか」を進める。
 *
 * **決して巻き戻さない。** 素朴に `INSERT OR REPLACE` と書くと、あとから
 * 「古いぶんだけを少し消した」掃除が小さい値で上書きし、先に開いた穴が
 * 見えなくなる。`MAX()` を SQL の一文で当てて、読み書きの隙に別の掃除が
 * 割り込んでも下がらないようにする。
 *
 * @param db - 書き込み対象のSQLiteデータベース接続
 * @param prunedThroughId - 今回実際に消したエントリの最大id
 * @internal
 */
export function recordChangelogPruned(
  db: Database.Database,
  prunedThroughId: number
): void {
  db.prepare(
    `INSERT INTO _changelog_prune (onlyRow, prunedThroughId, prunedAt)
     VALUES (0, ?, ${NOW_SQL})
     ON CONFLICT(onlyRow) DO UPDATE SET
       prunedThroughId = MAX(_changelog_prune.prunedThroughId, excluded.prunedThroughId),
       prunedAt        = ${NOW_SQL}`
  ).run(prunedThroughId)
}

/**
 * changelogにギャップ（欠落）があるかを判定する。
 *
 * 定期的な掃除（{@link cleanupChangelog}）により古いエントリが削除されると、
 * `lastSeenId` が指す位置より前のエントリが存在しなくなる。
 * この場合、changelog差分ベースの同期ができないため、
 * フルテーブルスキャンへのフォールバックが必要になる。
 *
 * @param db - チェック対象のSQLiteデータベース接続
 * @param lastSeenId - 前回同期時に記録した最後のchangelog ID
 * @returns ギャップがある場合は `true`
 *
 * 判定は**独立した2つの物差しのOR**である。片方だけでは足りない:
 *
 * 1. **掃除済みの位置**（{@link readChangelogPrunedThroughId}）。
 *    `prunedThroughId > lastSeenId` なら、読む前に消えたエントリがある＝真の隙間。
 *    `prunedThroughId <= lastSeenId` なら、消えたのは既読ぶんだけ＝隙間なし。
 *    **途中だけが欠けた形を見抜けるのはこちらだけ**（`MIN(id)` は残っている頭を
 *    見るので、頭が残っていれば穴に気づけない）。
 * 2. **`MIN(id)`**（下の `@remarks`）。掃除を経由しない消え方——利用者やテストの
 *    生の `DELETE FROM _changelog`、ファイルの差し替え、旧版が書いたDB——は
 *    記録に載らないので、記録を信じるだけでは何も見えない。第2の検出器として要る。
 *
 * @remarks
 * - 境界は `minId === lastSeenId + 1`。**これはギャップではない**（`lastSeenId` は
 *   {@link readChangelog} が `id > ?` で使う「読み終えた位置」なので、次に読むべき
 *   エントリがそこに在るということ）。ここを `minId > lastSeenId` と書くと、掃除が
 *   既読ぶんだけを消した通常の運用で毎回フルマージに落ちる。
 * - `lastSeenId === 0`（初回同期）にも同じ物差しを当てる。`minId === 1` なら
 *   相手の changelog は頭から残っているので隙間なし、`minId` がそれより大きければ
 *   **相手が長く走っていて古いぶんが掃除済み**ということなので、隙間として扱う。
 *   ここを「初回は常に隙間なし」と特別扱いすると、**新しい端末は相手の保持期間に
 *   残っていた窓のぶんしか受け取れず**、それより前に最後に触られた行が
 *   誰にも知らされないまま抜け落ちる（`pullNormal` に初回同期の特例は無い）。
 * - `_changelog` が空のときだけは、`lastSeenId === 0` を隙間と呼ばない。
 *   空は「掃除で全部消えた」とも「まだ何も起きていない」とも読めて区別が付かず、
 *   一律に隙間とすると**相手が何かするまで毎回フルマージを繰り返す**（相手の
 *   `lastSeenId` は0のままなので、次も同じ判断になる）。相手が1件でも書けば
 *   `minId > 1` となって上の規則が隙間を拾い、そこで取りこぼしは埋まる。
 *   読み終えた位置を持っている（`lastSeenId > 0`）のに空、という形は
 *   紛れもない全掃除なので、こちらは隙間として扱う。
 *
 * **まだ見抜けない形がある。** 見抜けるのは「{@link cleanupChangelog} が消した」
 * ぶんだけである。掃除を経由しない消え方——利用者やテストが直に打つ
 * `DELETE FROM _changelog`、DBファイルの差し替え、`_changelog_prune` を持たない
 * 旧版が開けた穴——は記録に載らないので、途中だけが欠けていても分からない。
 * その形は `MIN(id)` の規則が頭の欠けを拾えたときにだけ見つかる。
 *
 * なお「掃除が途中に穴を開ける」こと自体は {@link cleanupChangelog} が
 * **接頭辞しか刈らない**ようにして止めてある。こちらの規則は、旧版が刈った
 * DBを読む場合や、記録と実体がずれた場合の受け皿である。
 */
export function hasChangelogGap(
  db: Database.Database,
  lastSeenId: number
): boolean {
  const prunedThroughId = readChangelogPrunedThroughId(db)

  // 規則1: 読む前に消えたエントリがあるか（掃除した側の記録）
  if (prunedThroughId > lastSeenId) {
    return true
  }

  // 規則2: 残っている頭の位置から見る（掃除を経由しない消え方の受け皿）
  const row = db.prepare(`SELECT MIN(id) as minId FROM _changelog`).get() as {
    minId: number | null
  }

  // 空の changelog（上記）。ただし掃除済みの位置が分かっているなら、そちらを信じる。
  // ここまで来たということは `prunedThroughId <= lastSeenId`、つまり**消えたのは
  // 既読ぶんだけ**と分かっているので隙間ではない。記録を見ずに「空 かつ
  // `lastSeenId > 0` なら隙間」とだけ答えると、changelog を全部掃除した相手に対して
  // **フルマージの直後も隙間ありのまま**になる（`pullFullMerge` はカーソルを
  // 掃除済みの位置まで進めるので `lastSeenId > 0` になる）——毎回フルマージを繰り返す。
  if (row.minId === null) {
    if (prunedThroughId > 0) return false
    return lastSeenId > 0
  }

  // `lastSeenId + 1` が残っていれば、間に消えたものは無い。
  return row.minId > lastSeenId + 1
}

/**
 * 保持期間を過ぎた古いchangelogエントリを削除する。
 *
 * **接頭辞しか刈らない。** 「保持期間を過ぎていない、いちばん小さいid」より前だけを
 * 消す。期限切れでも、そこより後ろのidに居るエントリは残す。
 *
 * 時刻だけを見て消すと、id順と時刻順がねじれている場所で**若いidを残して大きいidを
 * 消す**ことになり、changelog の途中に穴が開く。ねじれは机上の話ではない:
 * {@link mergeChangelog} が取り込んだ相手のエントリを**元の `changedAt` のまま、
 * 新しく採番したidで**書くため（`_changelog.id` は AUTOINCREMENT）、
 * フルマージの直後は必ずこの形になる。
 *
 * 接頭辞刈りを選ぶ理由は3つ:
 *
 * 1. **掃除済みの位置を読めない旧版の相手も守られる。** これは書き手側の振る舞い
 *    なので、読む側の版に依らない。
 * 2. **フルマージ直後の跳ね上がりを防ぐ。** 記録（{@link recordChangelogPruned}）
 *    だけに頼ると、取り込んだ古い `changedAt` の高いidが次の掃除で即消えて
 *    `prunedThroughId` が跳ね上がり、**その端末を読む全端末が一度フルマージに落ちる**。
 * 3. `lastSeenId` は接頭辞（「ここまで読んだ」）の意味を持つ。刈る側も接頭辞に
 *    揃えるのが構造に合う。
 *
 * 膨らみは有界である。余分に残るのは、壁より後ろに紛れた高々保持期間ぶんの
 * エントリだけ（{@link describeChangelogPruneWall} が言う「永久の壁」を除く）。
 *
 * 消した行の最大idは `_changelog_prune` に記録する。**DELETE と記録は1つの区切りで
 * 行う**（途中で落ちると「消えたのに記録が無い」＝検出できない穴が永久に残る）。
 *
 * @param db - 操作対象のSQLiteデータベース接続
 * @param retentionDays - エントリを保持する日数。使えない値は
 *   {@link normalizeRetentionDays} が既定値へ均す
 * @returns 削除されたエントリ数
 */
export function cleanupChangelog(
  db: Database.Database,
  retentionDays: number
): number {
  // 使えない値（負値・NaN）は既定値へ。理由は {@link normalizeRetentionDays}。
  // 呼び出し元（`performSync`）でも同じ関数を通しているが、この関数は公開APIなので
  // 直に呼ばれる経路でも同じ答えになるようにしておく。
  //
  // **接頭辞刈りでは、均し忘れの被害が以前より大きい。** 綴りが `--1 days` になると
  // `julianday()` が NULL を返し、「期限切れでないエントリ」が1件も見つからない。
  // すると下の COALESCE が `MAX(id) + 1` へ落ちて、**changelog を全部消す**。
  // 以前（時刻で1行ずつ判定していた頃）は1件も消えないという止まり方だった。
  const days = normalizeRetentionDays(retentionDays)

  // 「境目を決める」「消す」「消したと書き残す」を1つの区切りに入れる。
  // **別々の区切りにしてはいけない**（`runInSavepoint` と同じ理由）——
  // 途中で落ちると「消えたのに記録が無い」＝検出できない穴が永久に残る。
  // 境目の読み取りも同じ区切りに入れておくと、読んでから消すまでの間に
  // 割り込んだ書き込みで境目が古くなることも無い。
  return db.transaction((): number => {
    // 刈ってよい範囲の境目。「期限切れでない、いちばん小さいid」であり、
    // 1件も残らないなら `MAX(id) + 1`（＝全部消してよい）。
    //
    // 時刻としてそろえてから比べる。`changedAt` は 0.19.0 以降ミリ秒までのISO-T形式だが、
    // それ以前に書かれた行は秒精度のスペース形式で、**文字列のままでは比べられない**
    // （' '(0x20) < 'T'(0x54) なので、同じ日でも古い書式の方が常に小さく出る）。
    // 解析できない値（`julianday()` が NULL）は「期限切れでない」側へ数える。
    // 消せないものを黙って消すより残す方が安全側だが、その代わりそこが壁になる
    // （{@link describeChangelogPruneWall}）。
    const boundary = db
      .prepare(
        `SELECT COALESCE(
           (SELECT MIN(id) FROM _changelog
             WHERE julianday(changedAt) IS NULL
                OR julianday(changedAt) >= julianday('now', '-' || ? || ' days')),
           (SELECT MAX(id) + 1 FROM _changelog)) AS boundaryId`
      )
      .get(days) as { boundaryId: number | null }

    // changelog が空なら境目も決まらない（どちらの副問い合わせも NULL）
    if (boundary.boundaryId === null) return 0
    const boundaryId = boundary.boundaryId

    // 記録するのは**実際に消した行の最大id**。ここを「1件でも消したら MAX(id)」と
    // 書くと、既読ぶんだけを消した通常の運用で全端末が毎回フルマージに落ちる。
    const pruned = db
      .prepare(`SELECT MAX(id) AS maxId FROM _changelog WHERE id < ?`)
      .get(boundaryId) as { maxId: number | null }

    const result = db
      .prepare(`DELETE FROM _changelog WHERE id < ?`)
      .run(boundaryId)

    // 1件も消していないなら記録は動かさない（動かすと、既読の相手まで
    // 隙間ありと判定されうる）
    if (result.changes > 0 && pruned.maxId !== null) {
      recordChangelogPruned(db, pruned.maxId)
    }
    return result.changes
  })()
}

/**
 * 「時刻として読めない `changedAt`」が掃除の壁になっていれば、その旨を述べる。
 *
 * {@link cleanupChangelog} は接頭辞しか刈らず、解析できない `changedAt` は
 * 「期限切れでない」側に数える。つまりそういう行は**永久の壁**になり、
 * そこから先は保持期間を過ぎても刈られない。
 *
 * **壁の行を消して解決したことにはしない。** 消せばそれは changelog の穴で、
 * 穴の向こうの変更は相手が共有から居なくなると届かなくなる。行は残したまま、
 * 持ち主へ知らせる（`performSync` が `result.warnings` へ載せる）。
 *
 * @param db - 読み取り対象のSQLiteデータベース接続
 * @param retentionDays - 掃除に使う保持期間（判定を掃除と揃えるために受ける）
 * @returns 壁が実際に何かを塞いでいれば説明文。そうでなければ `null`
 */
export function describeChangelogPruneWall(
  db: Database.Database,
  retentionDays: number
): string | null {
  const days = normalizeRetentionDays(retentionDays)

  const wall = db
    .prepare(
      `SELECT id, changedAt FROM _changelog
        WHERE julianday(changedAt) IS NULL
        ORDER BY id LIMIT 1`
    )
    .get() as { id: number; changedAt: string } | undefined
  if (!wall) return null

  // 壁より後ろに、保持期間を過ぎているのに刈れないエントリが居るか。
  // 居なければ黙っている（壁があること自体は害ではなく、塞いでいることが害）。
  const blocked = db
    .prepare(
      `SELECT COUNT(*) AS blockedCount FROM _changelog
        WHERE id > ?
          AND julianday(changedAt) < julianday('now', '-' || ? || ' days')`
    )
    .get(wall.id, days) as { blockedCount: number }
  if (blocked.blockedCount === 0) return null

  return (
    `_changelog id=${wall.id} has an unparseable changedAt (${JSON.stringify(wall.changedAt)}), ` +
    `blocking cleanup of ${blocked.blockedCount} expired entries after it. ` +
    `The row is kept on purpose: removing it would open a changelog gap. ` +
    `Fix or rewrite that changedAt to let cleanup continue.`
  )
}
