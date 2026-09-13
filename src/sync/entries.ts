/**
 * リモートの `_changelog` エントリを1件ずつローカルへ適用する（通常の差分同期）。
 *
 * 操作の種類（INSERT / UPDATE / DELETE）で `conflict` 側の入口を選び、結果を
 * `SyncResult` へ数え上げる。**削除は無条件には適用しない** —— 処理順で勝敗が
 * 変わらないよう、削除時刻を使ったLWWで判断する。
 *
 * @module sync/entries
 * @internal
 */
import Database from 'better-sqlite3'
import { ChangelogEntry, RecordFold, SyncResult, TableConfig } from '../types'
import {
  applyInsert,
  applyMergedDelete,
  applyUpdate,
  isLaterTimestamp,
} from '../conflict'
import type { ResurrectionProbe, TimestampColumnFor } from '../conflict'
import {
  hasIdMerges,
  isFoldRecordStale,
  lookupIdMerge,
  resolveFoldChain,
} from '../conflict/ledger'
import { includesPrimaryKeyColumn, readForeignKeys } from '../conflict/schema'
import { readTombstoneClaim } from '../conflict/tombstone'
import { ensureTombstoneMergedIntoColumn, NOW_SQL } from '../setup'
import { escapeIdentifier, getTableColumns } from './sql'
import {
  getRemoteTombstone,
  makeTableConfigLookup,
  makeResurrectionProbe,
  makeTimestampColumnFor,
  readRemoteRecord,
  resolveFoldTarget,
} from './remote'

/**
 * 畳みの記録を同期結果へ写す。
 *
 * 畳みは**行が1つ消える**ので、削除として数える（畳んだ相手をそもそも持っていなかった
 * 場合は行が消えないため数えない）。件数だけでは「何と何が1つになったか」を利用者へ
 * 説明できないので、中身もそのまま載せる。
 * @internal
 */
export function recordFolds(result: SyncResult, folds: RecordFold[]): void {
  for (const fold of folds) {
    result.folds.push(fold)
    if (fold.removedLocalRow) result.deleted++
  }
}

/**
 * 届いた畳み先が、この端末では**ただ消えた**と分かっているか。分かっていればその死の時刻。
 *
 * 見るのは**鎖の終端**である。届く `mergedInto` は中間の id でありうる
 * （`A→C` と `C→B` がそのまま渡る。{@link resolveFoldChain}）ので、そのまま引くと
 * 「畳みの記録はあるが削除は無い」となって死に気づけない。
 *
 * 「消えた」と答えるのは**畳み先を名乗っていない tombstone** があるときだけ。
 * 畳み先を名乗っている記録は「あの行へまとめられた」の意味で、鎖の途中でしかなく、
 * その先が生きていれば一群は生きている。
 *
 * 作り直しも見る。取り込み元にその削除より新しい行があるなら、その id は作り直された
 * ので死んでいない（{@link ResurrectionProbe} を渡さない呼び出しでは「作り直されて
 * いない」と扱う ——`applyTombstoneDelete` は必ず渡す）。
 *
 * @returns 一群が死んでいればその削除時刻。生きている／分からないなら `null`
 * @internal
 */
function readFoldTargetBurial(
  localDb: Database.Database,
  tableName: string,
  losingId: string,
  mergedInto: string,
  isResurrected: ResurrectionProbe
): string | null {
  const terminal = hasIdMerges(localDb)
    ? resolveFoldChain(localDb, tableName, mergedInto, losingId)
    : mergedInto
  // 終端がこの行自身なら、畳みはもう意味を持たない（向きが反転したあとの後始末）
  if (terminal === losingId) return null

  const claim = readTombstoneClaim(localDb, tableName, terminal)
  if (claim === null || claim.mergedInto !== null) return null
  if (isResurrected(tableName, terminal, claim.deletedAt)) return null
  return claim.deletedAt
}

/**
 * tombstoneに基づく削除をローカルに適用する。
 *
 * - ローカル `_tombstone` に max(deletedAt) と畳み先を記録する（以降の挿入/更新による
 *   復活を抑止する根拠となる。{@link applyInsert} がこれを参照する）。
 * - **畳み先（`mergedInto`）がある場合**は、消す前に子を畳み先へ付け替える
 *   （{@link applyMergedDelete}）。この分岐が無いと、競合を経験していないクライアントが
 *   敗者行をただ消し、自分の子をカスケードで失い、その削除がさらに他クライアントの
 *   付け替え済みの子まで殺す。畳みは「衝突していた版より新しい行には及ばせない」という
 *   LWWだけを見る（削除ではなくユニーク制約が強制する統合なので、削除保護の対象外）。
 * - 畳み先が無い（＝利用者操作による普通の削除）場合は、ローカル行が存在し
 *   `deletedAt` がその `updatedAt` より新しいときだけ削除する。
 *
 * 無条件削除ではなくLWWで判定するため、クライアントの処理順に依存せず
 * 「最新の更新 > 最新の削除なら存続、さもなくば削除」へ決定論的に収束する。
 * 比較はフォーマット差（ISO-T vs スペース形式）を吸収する {@link isLaterTimestamp} で行う。
 * @internal
 */
export function applyTombstoneDelete(
  localDb: Database.Database,
  remoteDb: Database.Database,
  tableName: string,
  primaryKey: string,
  timestampColumn: string,
  columns: string[],
  recordId: string,
  deletedAt: string,
  mergedInto: string | null,
  result: SyncResult,
  isResurrected: ResurrectionProbe,
  timestampColumnFor: TimestampColumnFor
): void {
  const hasTombstone = localDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tombstone'`
    )
    .get()
  // **畳み先が分かっている削除は、`deletedAt` もここでは書かない。**
  //
  // 「この畳みの主張を受け入れるか」は `foldClaimWins` が2つの帳簿を見て一度だけ
  // 決める。`mergedInto` だけを判断の下へ移しても、`deletedAt` を先に進めてしまうと
  // **主張の半分だけが公開される**。実測: 手元が `(deletedAt: 1月, mergedInto: W1)` の
  // ところへ `(deletedAt: 6月, mergedInto: W2)` が届き、W2 の鎖が動いていて
  // `applyMergedDelete` が見送ると、手元は `(6月, W1)` になる —— **新しい削除時刻と
  // 古い判断の畳み先の組**で、これがそのまま全端末へ渡る。畳み先が元々無ければ
  // 「6月にただ消された」となり、受け取った側は畳まずに DELETE して子を道連れにする。
  //
  // 畳みとして届いた削除の記録は、まるごと `applyMergedDelete` に任せる。
  if (mergedInto !== null && mergedInto !== recordId) {
    // **畳み先の一群が、こちらでは既に「ただ消えた」と分かっていることがある。**
    //
    // 畳みが決まったあとに、勝ち残った行ごと利用者が消す形である。そのまま
    // `applyMergedDelete` へ渡すと、手元に無い勝者行を取り込み元から読んで**入れて
    // しまう** —— `isShadowedByTombstone` を通る経路ではないので、削除済みの id が
    // 復活する。実測（3端末・`accounts`）: B が `a1` を消したあと、A の畳み
    // `a3→a1` が届いて B が `a1` を作り直し、次の `performSync` で
    // `dropLocalWritesLostToDeletion` が同じ行を消し、**B だけ全部の行を失った**。
    // 逆に「畳み先が見つからない」として敗者行を残すと、その行は**届く見込みの無い
    // 勝者を永久に待つ**（A/C は `a2` を持ち続け、B は持たない）。
    //
    // どちらでもない。畳まれた先が死んでいるなら、この行も**その一群の死をもって**
    // 消える。しきい値に畳みの時刻ではなく一群の死の時刻を使うのが要点で、
    // 畳みの時刻は敗者行の版と同着になりうる（同着の畳みでは勝者行の版＝敗者行の版）
    // ため、端末によって消える・消えないが分かれる。
    //
    // 判断は各端末が**自分で導く**（この結論を作り直して配り合わない）。一群の死も
    // 畳みの主張もどちらも全端末へ渡るので、同じ2つの事実から同じ答えに達する。
    const groupBuriedAt = readFoldTargetBurial(
      localDb,
      tableName,
      recordId,
      mergedInto,
      isResurrected
    )

    if (groupBuriedAt === null) {
      // 畳み先は生きている（か、生死が分からない）。畳みとして適用する。
      // 消す前に子を引き取る。`deletedAt` を渡すのは、畳みより後に更新された行にまで
      // 及ばせないため（判断は {@link applyMergedDelete} 側で行う）。
      const { folds, warnings } = applyMergedDelete(
        localDb,
        tableName,
        primaryKey,
        recordId,
        mergedInto,
        readRemoteRecord(remoteDb, tableName, primaryKey, mergedInto),
        columns,
        timestampColumn,
        deletedAt,
        isResurrected,
        timestampColumnFor
      )
      recordFolds(result, folds)
      result.warnings.push(...warnings)
      return
    }

    // 一群の死をこの行の死として扱い、以降は**ただの削除**の経路をそのまま通す
    // （畳み先はもう誰も生かせないので、畳み先を名乗り続ける意味が無い）。
    deletedAt = groupBuriedAt
  }

  // ここから先は**畳み先の無い、ただの削除**。
  // 「この id は消えた」という事実は畳みの判断とは独立なので、新しいときだけ進める
  // （既存の畳み先には触らないので消えない）。
  if (hasTombstone) {
    ensureTombstoneMergedIntoColumn(localDb)
    localDb
      .prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(tableName, recordId) DO UPDATE SET
           deletedAt = CASE
             WHEN COALESCE(
                    julianday(excluded.deletedAt) > julianday(_tombstone.deletedAt),
                    excluded.deletedAt > _tombstone.deletedAt
                  )
             THEN excluded.deletedAt
             ELSE _tombstone.deletedAt
           END`
      )
      .run(tableName, recordId, deletedAt)
  }

  const escapedTable = escapeIdentifier(tableName)
  const escapedPk = escapeIdentifier(primaryKey)
  const escapedTs = escapeIdentifier(timestampColumn)

  // 届いた id が、こちらでは**動いた先の id**になっていることがある
  // （{@link resolveMovedId}）。消すのはその行。
  const targetId = resolveMovedId(
    localDb,
    tableName,
    primaryKey,
    recordId,
    deletedAt,
    timestampColumnFor
  )
  if (targetId !== recordId && hasTombstone) {
    // 動いた先の id についても「消えた」を記録する。この経路はフルマージからも
    // 呼ばれ、そのときトリガーは外れているので、消すだけでは記録が残らない
    // （記録が無いと、他端末の古い版がこの行として復活する）。
    localDb
      .prepare(
        `INSERT INTO _tombstone (tableName, recordId, deletedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(tableName, recordId) DO UPDATE SET
           deletedAt = CASE
             WHEN COALESCE(
                    julianday(excluded.deletedAt) > julianday(_tombstone.deletedAt),
                    excluded.deletedAt > _tombstone.deletedAt
                  )
             THEN excluded.deletedAt
             ELSE _tombstone.deletedAt
           END`
      )
      .run(tableName, targetId, deletedAt)
  }

  const localRecord = localDb
    .prepare(
      `SELECT ${escapedTs} AS ts FROM ${escapedTable} WHERE ${escapedPk} = ?`
    )
    .get(targetId) as { ts: unknown } | undefined
  if (!localRecord) return

  const localUpdatedAt = String(localRecord.ts ?? '')
  if (isLaterTimestamp(localDb, deletedAt, localUpdatedAt)) {
    localDb
      .prepare(`DELETE FROM ${escapedTable} WHERE ${escapedPk} = ?`)
      .run(targetId)
    result.deleted++
    return
  }

  // 削除を採らなかった ＝ **こちらの行の方が新しい**。相手はその行を持っていないので、
  // こちらから名乗り直さないと永久に食い違う（{@link advertiseLocalRow}）。
  advertiseLocalRow(localDb, tableName, targetId)
}

/**
 * 届いた削除の id を、**こちらで動いた先の id**へ読み替える。
 *
 * 親と主キーを共有する1:1の子（`tag_profiles` のような表）は、親が畳まれると
 * **その子の主キーそのものが動く**（`repointChild`）。1行が名前を変えただけなので、
 * その行への削除は動いた先へ届かなければならない。読み替えないと、動かした端末では
 * 消すべき行が残り、動かしていない端末（先に消した端末）では消えている ——
 * **その行の存在そのものが永久に食い違う**（実測: `tag_profiles` を消した端末だけが
 * 消えたままになった）。
 *
 * **読み替えてよいのはこの形の表だけである。** ふつうの畳み（別々の2行が1行に
 * まとまる形）で敗者idの削除を勝者へ向けると、**敗者行の削除が勝者行の削除に化ける**。
 * 主キーが外部キーを兼ねているかで振り分ける（`includesPrimaryKeyColumn` ——
 * `conflict/remap.ts` が「1:1の形」を見分けるのと同じ物差し）。
 *
 * 実測（性質テスト）: この振り分けを外して「敗者idへの削除は一群への削除」にすると、
 * 利用者が消したのは敗者idの行だけなのに、その削除が**別に作られた勝者行**まで殺す
 * （`tags:g2` を消したあと `tags:g1` を作ると、g2→g1 を畳んだ端末で g1 が消えた）。
 * どちらの意味なのかは**利用者が何を消したつもりか**で決まり、公開されている
 * 事実からは分けられない。片方の意味へ寄せると、もう片方が黙って壊れる。
 *
 * **時刻も見る。** 読み替えるのは削除が移動より**厳密に新しい**ときだけ。
 * 移動の方が新しければ、その削除は移動前の姿についての古い主張であり、
 * 動いた先の行はそれより新しい（採らないのが正しい）。
 *
 * **記録が古い判断になっていないかも見る**（{@link isFoldRecordStale}）。畳まれた
 * id は死んだままとは限らず、**畳みより新しい版で作り直せば生き返る**
 * （`isShadowedByTombstone` がそれを通す）。作り直された id の行は動いていないので、
 * 読み替えると**別の行を消す**。実測（3端末）: 畳まれた `tags:g2` が 00:02 で
 * 作り直されたあと `tag_profiles:g2` を消したら、古い記録に従って全端末で
 * **`tag_profiles:g1` の方が消えた**。
 *
 * @returns 読み替え先の id。読み替えないなら `recordId` そのまま
 * @internal
 */
function resolveMovedId(
  localDb: Database.Database,
  tableName: string,
  primaryKey: string,
  recordId: string,
  deletedAt: string,
  timestampColumnFor: TimestampColumnFor
): string {
  if (!hasIdMerges(localDb)) return recordId

  // その id の行が手元に在るなら、id は動いていない（消すのはその行）
  const stillHere = localDb
    .prepare(
      `SELECT 1 FROM ${escapeIdentifier(tableName)}
        WHERE ${escapeIdentifier(primaryKey)} = ?`
    )
    .get(recordId)
  if (stillHere !== undefined) return recordId

  // **主キーが外部キーを兼ねている表だけが、親の帳簿を引いてよい。** この形の表では、
  // 親が畳まれると子の主キーそのものが動くため、親の畳みの記録が子の移動そのものに
  // なる。そうでない表で親の記録を引く意味は無い（親が畳まれても子の id は動かない）。
  const parentTables = readForeignKeys(localDb, tableName, primaryKey)
    .filter((foreignKey) =>
      includesPrimaryKeyColumn(
        localDb,
        tableName,
        foreignKey.columns.map((column) => column.childColumn)
      )
    )
    .map((foreignKey) => foreignKey.parentTable)
  if (parentTables.length === 0) return recordId

  // 引く帳簿は**2つ**ある。
  //
  // 1. **この表の記録。** 手元にその行が在るときに畳んだ場合は、`repointChild` や
  //    `foldRowInto` が `recordMerge` でここへ書く。
  // 2. **親の表の記録。** 主キーを外部キーが兼ねる1:1の子が後から届いた場合、
  //    動かすのは `repointChild` ではなく `remapMergedForeignKeys` で、**そちらは
  //    記録を書かない**（書き換えているのは届いた行の外部キーの列であって、手元の行を
  //    動かしたわけではない）。それでも主キーを兼ねる列なので**行の id は動いている**。
  //    親の畳みの記録が、その移動そのものである。
  //
  // 2. を忘れると、子が後から届いた端末でだけ削除が届かない（実測: `tag_profiles`）。
  for (const ledgerTable of [tableName, ...parentTables]) {
    const moved = lookupIdMerge(localDb, ledgerTable, recordId)
    if (moved === null || moved.winningId === recordId) continue
    // 移動の方が新しければ、その削除は移動前の姿についての古い主張である
    if (!isLaterTimestamp(localDb, deletedAt, moved.mergedAt)) continue
    // **親ごと消えたときの巻き添えは、移動した行への削除ではない。**
    // 親を消せば子はカスケードで消え、その削除が「子の古い id」として渡ってくる。
    // 親の死と同じ時刻なら、それはその死の巻き添えであって、動いた先の行
    // （生きている親の子）を消してよい根拠にはならない。実測: 畳みの敗者だった
    // 親を消した端末の巻き添えが、**勝ち残った親の子**を全端末から消した。
    if (ledgerTable !== tableName) {
      const parentClaim = readTombstoneClaim(localDb, ledgerTable, recordId)
      if (
        parentClaim !== null &&
        !isLaterTimestamp(localDb, deletedAt, parentClaim.deletedAt)
      ) {
        continue
      }
    }
    // その id が作り直されていれば、記録はもう古い判断（行は動いていない）
    if (
      isFoldRecordStale(
        localDb,
        ledgerTable,
        primaryKey,
        recordId,
        moved.mergedAt,
        timestampColumnFor(ledgerTable)
      )
    ) {
      continue
    }
    // 記録は鎖になりうる（`A→C` のあとに `C→B`）。終端まで辿る
    const target = resolveFoldChain(
      localDb,
      ledgerTable,
      moved.winningId,
      recordId
    )
    if (target === recordId) continue

    // **親の帳簿から導いた読み替えは、その行が手元に在るときだけ採る。**
    //
    // 親の記録が言っているのは「親の id が動いた」ことだけで、「古い id に在った子が
    // 今この id に在る」はこちらの推測である。動いた先の席は**別の子がもともと
    // 持っていた**ことがあり、そのときこの推測は外れる。手元にその行が無いなら
    // 外れたかどうかを確かめる術が無く、それでも死を記録すると、**あとから届く
    // 無関係な行を、誰にも伝わらないローカルの墓標だけで永久に拒む**。
    //
    // 実測（3端末・`tag_profiles`）: C が `tags:g2` を作り `tag_profiles:g2` を作って
    // 消し、そのあと `tag_profiles:g1` を作った。A/B は `tags:g2→g1` を畳んでいたので
    // `tag_profiles:g2` の削除を `g1` へ読み替え、**行を持っていないまま**
    // `tag_profiles:g1` の墓標を現在時刻で立てた。C の `g1`（00:00）はその墓標に
    // 負けて二度と入らず、C だけがその行を持ち続けた（膠着としても報告されない）。
    //
    // 行が手元に在る場合は、読み替えた先を実際に消す。その DELETE はトリガから
    // `_changelog` と `_tombstone` へ載って**全端末へ渡る**ので、推測が当たっていた
    // ことも外れていたことも、そこから先は同じ1つの事実として共有される。
    //
    // この表自身の記録（1.）にはこの条件を課さない。そちらは「この端末がこの行を
    // 畳んだ」という手元で起きた事実なので、一群の同定に推測が混じらない。
    if (ledgerTable !== tableName) {
      const targetHere = localDb
        .prepare(
          `SELECT 1 FROM ${escapeIdentifier(tableName)}
            WHERE ${escapeIdentifier(primaryKey)} = ?`
        )
        .get(target)
      if (targetHere === undefined) continue
    }

    return target
  }

  return recordId
}

/**
 * 「こちらの版が新しいので採らなかった」を、相手へ届く形にする。
 *
 * **採らなかっただけでは収束しない。** 相手はこちらの `_changelog` を
 * `lastSeenId` より後ろだけ読む。こちらの新しい版のエントリがその位置より**手前**に
 * あると（＝相手は一度それを読んでいる）、こちらが黙って採らないかぎり、
 * 相手は古い版を持ったまま二度と直らない。
 *
 * 実測（3端末）: A が `accounts:a2` を 00:01 で作り、全端末がそれを受け取ったあと、
 * C のアプリが同じ行を 00:00 で書き直した。A は LWW どおり採らず（`local_wins`）、
 * C は A のエントリを読み終えているので 00:01 が二度と届かない —— **C だけが
 * 00:00 を持ち続けた**（膠着でもないので報告もされない）。
 *
 * そこで、採らなかった側が自分の版を `_changelog` へ1行名乗り直す。次に相手が
 * 読みに来たときに新しい版として届き、そこで収束する。
 *
 * 止まる（振動しない）理由: 相手がこちらの版を採ると、両者の時刻は同じになる。
 * 同時刻の到着は `local_wins` にならない（膠着として扱われ、中身も同じなら何も
 * 起きない）ので、名乗り直しはそこで終わる。
 *
 * 名乗り直すのは**差分経路とtombstone経路だけ**。フルマージ
 * （{@link performFullMergeData}）は相手の全行を突き合わせるので、こちらが新しい行
 * すべてが「採らなかった」になり、名乗り直すと**表ぜんたいぶんのエントリ**が
 * `_changelog` へ入る。フルマージへ落ちているのは相手側であり、その相手は
 * こちらの全行を見ているので、そこで既に追いついている。
 *
 * 行が無ければ何もしない（名乗るものが無い）。`_changelog` を持たないDBでも何もしない。
 * @internal
 */
function advertiseLocalRow(
  localDb: Database.Database,
  tableName: string,
  recordId: string
): void {
  const exists = localDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_changelog'`
    )
    .get()
  if (!exists) return

  localDb
    .prepare(
      `INSERT INTO _changelog (tableName, recordId, operation, changedAt)
       SELECT ?, ?, 'UPDATE', ${NOW_SQL}`
    )
    .run(tableName, recordId)
}

/**
 * changelogエントリをローカルDBに適用する。
 *
 * 各エントリのoperationに応じてINSERT/UPDATE/DELETEを実行し、
 * 結果カウンターを更新する。
 *
 * @internal
 */
export function processChangelogEntries(
  localDb: Database.Database,
  remoteDb: Database.Database,
  entries: ChangelogEntry[],
  primaryKey: string,
  configTables: TableConfig[],
  result: SyncResult
): void {
  // テーブルごとのカラム情報をキャッシュ
  const columnCache = new Map<string, string[]>()
  // テーブル名 → TableConfig のマップ
  // 表名は**相手の設定どおりの綴り**で届く。大小を畳んで引く
  // （{@link makeTableConfigLookup}）
  const tableConfigFor = makeTableConfigLookup(configTables)
  // 表をまたいで時刻列を引く手続きと、作り直し判定。**取り込み1回につき1つ**
  // （レコードごとに作り直すと、表ごとの `prepare` が毎回やり直しになる）
  const timestampColumnFor = makeTimestampColumnFor(configTables)
  const isResurrected = makeResurrectionProbe(
    remoteDb,
    primaryKey,
    timestampColumnFor
  )

  for (const entry of entries) {
    // _heartbeat エントリは特別扱い: 直接適用
    if (entry.tableName === '_heartbeat') {
      if (entry.operation === 'DELETE') continue
      const remoteRecord = remoteDb
        .prepare(`SELECT * FROM _heartbeat WHERE id = ?`)
        .get(entry.recordId) as Record<string, unknown> | undefined
      if (!remoteRecord) continue

      const columns =
        columnCache.get('_heartbeat') ?? getTableColumns(localDb, '_heartbeat')
      columnCache.set('_heartbeat', columns)

      applyUpdate(
        localDb,
        '_heartbeat',
        'id',
        remoteRecord,
        columns,
        'updatedAt'
      )
      continue
    }

    // config.tables に含まれないテーブルはスキップ
    const tableConfig = tableConfigFor(entry.tableName)
    if (!tableConfig) continue

    // **ここから先は、こちらの設定どおりの綴りだけを使う。**
    // `entry.tableName` は**相手の設定どおりの綴り**（相手のトリガが自分の設定を
    // 埋め込む）。そのまま帳簿へ書くと、綴りが違う相手が増えるたびに
    // `_id_merge` / `_tombstone` の重複行が増える（引く側の `COLLATE NOCASE` と
    // `ORDER BY` は、その後始末をしているにすぎない）。入口で自分の綴りへ揃えれば、
    // 重複はそもそも生まれない。
    const table = tableConfig.name

    const timestampColumn = tableConfig.timestampColumn ?? 'updatedAt'

    let columns = columnCache.get(table)
    if (!columns) {
      columns = getTableColumns(localDb, table)
      columnCache.set(table, columns)
    }

    if (entry.operation === 'DELETE') {
      // 無条件削除は処理順により「削除 vs より新しい更新」の勝敗が変わる（非決定的）。
      // 削除時刻（_tombstone優先・無ければchangelogのchangedAt）を用いたLWWで適用する。
      // tombstoneに畳み先が載っていれば、削除ではなく畳みとして適用される。
      const remoteTombstone = getRemoteTombstone(
        remoteDb,
        table,
        entry.recordId
      )
      const mergedInto = resolveFoldTarget(
        entry.recordId,
        remoteTombstone?.mergedInto
      )

      // deleteProtected は「利用者操作による削除を適用しない」ための設定。
      // 畳みはユニーク制約が強制する統合であって削除ではないので、その対象外とする。
      // 見送っても行は救えない — 勝者行が届いた時点で applyInsert が同じ畳みを行うだけで、
      // それまでのあいだ子が宙に浮き、両者が同じユニークキーを送り合い続ける。
      if (tableConfig.deleteProtected && mergedInto === null) continue

      applyTombstoneDelete(
        localDb,
        remoteDb,
        table,
        primaryKey,
        timestampColumn,
        columns,
        entry.recordId,
        remoteTombstone?.deletedAt ?? entry.changedAt,
        mergedInto,
        result,
        isResurrected,
        timestampColumnFor
      )
    } else {
      // INSERT or UPDATE: リモートからレコード取得
      const escapedTable = escapeIdentifier(table)
      const escapedPk = escapeIdentifier(primaryKey)
      const remoteRecord = remoteDb
        .prepare(`SELECT * FROM ${escapedTable} WHERE ${escapedPk} = ?`)
        .get(entry.recordId) as Record<string, unknown> | undefined

      if (!remoteRecord) continue // レコードがリモートに存在しない（後続のDELETEで消えた等）

      if (entry.operation === 'INSERT') {
        const { action, conflict, folds, warnings } = applyInsert(
          localDb,
          table,
          primaryKey,
          remoteRecord,
          columns,
          timestampColumn,
          isResurrected,
          timestampColumnFor
        )
        if (action === 'inserted') result.inserted++
        if (action === 'skipped') result.skipped++
        // 畳みは「消えた行」でもある。届いた行を採用しなかった場合でも、同じPKの
        // ローカル行が畳まれて消えていることがある（UPDATE 側と同じ数え方）。
        // `upserted` 自体が畳みを伴うこともあるので、二重には数えない。
        if (action === 'upserted' || folds.length > 0)
          result.conflictsResolved++
        recordFolds(result, folds)
        result.warnings.push(...warnings)
        if (conflict) {
          result.warnings.push(
            `Conflict on ${table}:${entry.recordId} resolved as ${conflict.resolution}`
          )
          // 採らなかったのは**こちらの版が新しい**から。相手は古い版を持ったままで、
          // こちらのエントリは相手の読み終えた位置より手前にありうる。名乗り直す
          // （{@link advertiseLocalRow}）。id は競合が名乗るもの —— 畳みで勝ち残った
          // のが別の行なら、相手が知らないのはその行である。
          if (conflict.resolution === 'local_wins') {
            advertiseLocalRow(localDb, table, conflict.recordId)
          }
        }
      } else {
        // UPDATE
        const { action, conflict, folds, warnings } = applyUpdate(
          localDb,
          table,
          primaryKey,
          remoteRecord,
          columns,
          timestampColumn,
          isResurrected,
          timestampColumnFor
        )
        result.warnings.push(...warnings)
        if (action === 'updated') result.updated++
        if (action === 'inserted') result.inserted++
        if (action === 'skipped') result.skipped++
        // 畳みは「消えた行」でもある。届いた更新を採用しなかった場合でも、
        // 更新対象の行が畳まれて消えていることがある（skipped だけでは実態に合わない）。
        if (folds.length > 0) result.conflictsResolved++
        recordFolds(result, folds)
        if (conflict) {
          result.warnings.push(
            `Conflict on ${table}:${entry.recordId} resolved as ${conflict.resolution}`
          )
          // 採らなかったのは**こちらの版が新しい**から。相手は古い版を持ったままで、
          // こちらのエントリは相手の読み終えた位置より手前にありうる。名乗り直す
          // （{@link advertiseLocalRow}）。id は競合が名乗るもの —— 畳みで勝ち残った
          // のが別の行なら、相手が知らないのはその行である。
          if (conflict.resolution === 'local_wins') {
            advertiseLocalRow(localDb, table, conflict.recordId)
          }
        }
      }
    }
  }
}
