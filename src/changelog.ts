/**
 * `_changelog` テーブルの読み取り・掃除・ギャップ検出を提供するモジュール。
 *
 * @module changelog
 */
import Database from 'better-sqlite3'
import { ChangelogEntry, DEFAULTS } from './types'

/**
 * 保持期間の設定値を、SQLへ渡してよい値へ均す。
 *
 * **保持期間はSQLの綴りへ埋め込まれる**（`'-' || ? || ' days'`）。
 * 負値を渡すと `--1 days` という解析できない綴りになり、`julianday()` が NULL を返す。
 * NULL との比較は常に偽なので、{@link cleanupChangelog} は期限切れでないエントリを1件も見つけられず、例外にならないまま **changelog を全部消す**。
 * `NaN` も同じ（バインドすると NULL になる）。
 *
 * 0へ丸めるのは選ばない。
 * 0は「今より古いものは残さない」という**有効な設定**である。
 * 間違いの受け皿にすると、設定を書き損じただけで changelog を全部消し、このクライアントを読む全員をフルマージに落とす。
 * 壊す側より、既定値へ戻す側を採る。
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
      `SELECT id, tableName, recordId FROM _changelog WHERE id > ? ORDER BY id`
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
 * `_changelog` がこれまでに振った最大の id（`sqlite_sequence` の値）を読む。
 *
 * `_changelog` は `AUTOINCREMENT` なので、行を消してもこの値は下がらない。
 * 取り消した書き込み（ロールバック）はこの値も戻すので、振られた id は 1 から途切れずに並ぶ。
 * つまり「振られたのに `_changelog` に無い id」は、何かが消した id である。
 * 例外は旧版からの移行（`src/rows/migrate.ts`）で、旧版の id を穴ごと写す。
 * その穴は一度だけ隙間と判断されてフルマージになり、カーソルが振った最大の id へ進むので、二度目は無い。
 * {@link hasChangelogGap} はこれを使って、掃除の記録に載らない消え方（生の `DELETE`）も見抜く。
 *
 * **読み取りしかしない**（{@link readChangelogPrunedThroughId} と同じ理由）。
 *
 * @param db - 読み取り対象のSQLiteデータベース接続（読み取り専用でよい）
 * @returns 振った最大の id。まだ1件も振っていない、または読めないなら `null`
 */
export function readChangelogSequence(db: Database.Database): number | null {
  try {
    const row = db
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = '_changelog'`)
      .get() as { seq: number } | undefined
    return row?.seq ?? null
  } catch {
    // `sqlite_sequence` が無い（AUTOINCREMENT の表が1つも無いDB）
    return null
  }
}

/**
 * フルマージで相手を読み終えたあとの読み位置。
 *
 * 相手の `_changelog` の最大 id・掃除済みの位置・振った最大の id のうち最も大きいもの。
 * 振った最大の id まで進めないと、末尾が消えていた相手（{@link hasChangelogGap} の第2の規則）を
 * 読むたびに隙間ありと判断し、フルマージを繰り返す。
 *
 * @param db - 相手のDB（読み取り専用でよい）
 */
export function fullMergeCursor(db: Database.Database): number {
  return Math.max(
    getMaxChangelogId(db),
    readChangelogPrunedThroughId(db),
    readChangelogSequence(db) ?? 0
  )
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
    // 表が無い（相手が旧版 / 案A の取り付けを通していないDB）
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
    `INSERT INTO _changelog_prune (onlyRow, prunedThroughId)
     VALUES (0, ?)
     ON CONFLICT(onlyRow) DO UPDATE SET
       prunedThroughId = MAX(_changelog_prune.prunedThroughId, excluded.prunedThroughId)`
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
 * 判定は**独立した3つの物差しのOR**である。どれか1つでは足りない:
 *
 * 1. **掃除済みの位置**（{@link readChangelogPrunedThroughId}）。
 *    `prunedThroughId > lastSeenId` なら、読む前に消えたエントリがある＝真の隙間。
 *    `prunedThroughId <= lastSeenId` なら、掃除が消したのは既読ぶんだけ。
 * 2. **振った id の数**（{@link readChangelogSequence}）。`lastSeenId` より後ろに振った id が
 *    `sequence - lastSeenId` 個あるのに、残っている数がそれより少なければ、未読の id が消えている。
 *    掃除を経由しない消え方——利用者やテストの生の `DELETE FROM _changelog`——は
 *    `_changelog_prune` に載らないが、`sqlite_sequence` は下がらないのでこちらで見える。
 *    頭・途中・末尾・全部のどれが消えても拾う。
 *    また、`lastSeenId` が振った最大の id も掃除済みの位置も追い越しているなら、
 *    相手の id が振り直されている（ファイルの差し替え・表の作り直し）ので隙間とする。
 * 3. **`MIN(id)`**（下の `@remarks`）。`sqlite_sequence` を読めないDB（`_changelog` に
 *    1件も振っていない、旧版が書いた）の受け皿。
 *
 * @remarks
 * - 境界は `minId === lastSeenId + 1`。**これはギャップではない**（`lastSeenId` は
 *   {@link readChangelog} が `id > ?` で使う「読み終えた位置」なので、次に読むべき
 *   エントリがそこに在るということ）。ここを `minId > lastSeenId` と書くと、掃除が
 *   既読ぶんだけを消した通常の運用で毎回フルマージに落ちる。
 * - まだ一度も読んでいない相手は、呼び出し元（`performSync`）がこの関数を呼ばずにフルマージで読む。
 *   したがってここへ来る `lastSeenId === 0` は「前回 0 まで読んだ」相手であり、同じ物差しを当てる。
 * - `_changelog` が空で、1件も振っていない（`sqlite_sequence` に行が無い）ときは、`lastSeenId === 0` を隙間と呼ばない。
 *   一律に隙間とすると、一度も書いていない相手を読むたびにフルマージを繰り返す。
 *   **0 まで読んだあとで相手が書き、その `_changelog` が読まれる前に直に消えた形**も
 *   `_changelog` は空・`prunedThroughId` は 0 で同じに見えるが、`sqlite_sequence` が 1 以上なので第2の規則が拾う。
 * - どの規則も、フルマージのあとのカーソル（{@link fullMergeCursor}）に対しては偽になる。
 *   そうでないと、同じ相手を読むたびにフルマージを繰り返す。
 *
 * **まだ見抜けない形がある。** `sqlite_sequence` ごと書き換えられた場合
 * （DBファイルを、振った id がちょうど同じ別のファイルへ差し替えた、など）は見えない。
 * `_changelog` に1件も振っていないDBで途中だけが欠けることは無い。
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

  // 規則2: 振った id の数と、残っている id の数を比べる（掃除を経由しない消え方の受け皿）。
  // `lastSeenId` より後ろに振った id は `sequence - lastSeenId` 個で、途切れずに並ぶ
  // （{@link readChangelogSequence}）。残っている数がそれより少なければ、未読の id が消えている。
  // 頭・途中・末尾のどこが消えても、全部消えても拾える。
  const sequence = readChangelogSequence(db)
  if (sequence !== null && sequence > lastSeenId) {
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM _changelog WHERE id > ?`)
      .get(lastSeenId) as { n: number }
    if (remaining.n < sequence - lastSeenId) return true
  }
  // 読み位置が、相手の振った最大の id も掃除済みの位置も追い越している。
  // 相手のファイルが差し替わった・`_changelog` が作り直されたなどで id が振り直された形で、
  // これから振られる id は読み位置以下になり、差分では読めない。
  // フルマージのあとのカーソル（{@link fullMergeCursor}）は相手の値へ戻るので、繰り返さない。
  if (sequence !== null && Math.max(sequence, prunedThroughId) < lastSeenId) {
    return true
  }

  // 規則3: 残っている頭の位置から見る（`sqlite_sequence` を読めないDBの受け皿）
  const row = db.prepare(`SELECT MIN(id) as minId FROM _changelog`).get() as {
    minId: number | null
  }

  // 空の changelog（上記）。
  if (row.minId === null) {
    // 振った最大の id が分かるなら、未読の id が消えた形も id の振り直しも上の規則が拾った。
    // ここへ来たのは、消えたのが既読ぶんだけの形である
    if (sequence !== null) return false
    // 1件も振っていない。掃除済みの位置が分かっているなら、そちらを信じる。
    // ここまで来たということは `prunedThroughId <= lastSeenId`、つまり**消えたのは
    // 既読ぶんだけ**と分かっているので隙間ではない。記録を見ずに「空 かつ
    // `lastSeenId > 0` なら隙間」とだけ答えると、changelog を全部掃除した相手に対して
    // **フルマージの直後も隙間ありのまま**になる（フルマージはカーソルを
    // 掃除済みの位置まで進めるので `lastSeenId > 0` になる）——毎回フルマージを繰り返す。
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
 * 消す**ことになり、changelog の途中に穴が開く。案A では `_changelog` に載るのは
 * 自分の書き込みと取り込みの結果だけで、`changedAt` はどちらも書いた瞬間の
 * `NOW_SQL` だが、**壁時計が巻き戻れば id順（`AUTOINCREMENT`）と時刻順はずれる**
 * ——端末の時刻合わせは揃っているとは限らない。接頭辞しか刈らなければ、
 * ずれていても穴は開かない。
 *
 * 接頭辞刈りを選ぶ理由は3つ:
 *
 * 1. **掃除済みの位置を読めない旧版の相手も守られる。** これは書き手側の振る舞い
 *    なので、読む側の版に依らない。
 * 2. **`prunedThroughId` の跳ね上がりを防ぐ。** 記録（{@link recordChangelogPruned}）
 *    だけに頼ると、時刻のずれた高いidが次の掃除で即消えて `prunedThroughId` が
 *    跳ね上がり、**その端末を読む全端末が一度フルマージに落ちる**。
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
  // 呼び出し元（`performSync`）でも同じ関数を通しているが、試験などから直に呼ばれる経路でも同じ答えになるようにしておく。
  //
  // **接頭辞刈りでは、均し忘れの被害が以前より大きい。** 綴りが `--1 days` になると
  // `julianday()` が NULL を返し、「期限切れでないエントリ」が1件も見つからない。
  // すると下の COALESCE が `MAX(id) + 1` へ落ちて、**changelog を全部消す**。
  // 以前（時刻で1行ずつ判定していた頃）は1件も消えないという止まり方だった。
  const days = normalizeRetentionDays(retentionDays)

  // 「境目を決める」「消す」「消したと書き残す」を1つの区切りに入れる。
  // **別々の区切りにしてはいけない**——
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
