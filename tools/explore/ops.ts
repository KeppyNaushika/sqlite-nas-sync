/**
 * 端末へ当てる操作と、遷移（＝状態空間の辺）の並べ方。
 *
 * 操作の中身は `__tests__/convergence-properties.test.ts` の `applyOp` /
 * `pruneChangelog` と**同じ振る舞い**にしてある（ローカルの制約違反は「その端末では
 * 起きなかった」ことにする、子を入れる前に親を用意する、`_changelog` はいちばん遅れて
 * いる相手の読み位置の1つ先まで削る）。ここがずれると「性質テストでは落ちるのに
 * 検査器では出ない」形が生まれ、検査器の「反例なし」が性質テストの主張と噛み合わなくなる。
 *
 * ただし**時刻の刻み方だけは違う**（トリガが刻む現在時刻を、世界の時計の値へ
 * 書き換える）。理由は tools/explore/world.ts の「時計」に書いてある。
 *
 * @module tools/explore/ops
 */
import type Database from 'better-sqlite3'
import { ExploreConfig, TABLE_SETS } from './config'

/**
 * 行の時刻の基準。性質テストと同じ値にしてある。
 *
 * **現在より十分に過去であること**が正規化の前提になっている
 * （tools/explore/state.ts の「時刻」）。保持期間（7日）より古いので、
 * この時刻を名乗る changelog エントリは掃除とフルマージの対象外になる ——
 * これも性質テストと同じ条件である。
 */
export const BASE_TIME = Date.UTC(2026, 0, 1)

/**
 * **未来の**行の時刻の基準（`--future-times`）。
 *
 * 削除が刻む時刻（`_tombstone.deletedAt` と、原則2 による削除の版の `_sns_ts`）は実行時の
 * 現在時刻なので、{@link BASE_TIME} から選んだ行の時刻では「削除より新しい書き込み」を作れない
 * （docs/exhaustive-check.md の「保証しないこと」に、性質テストと同じ制限として書いてある）。
 * 削除の版も行の版と同じ順序で比べるので、その形が範囲に要る。
 *
 * **固定の定数にしてある**（`Date.now()` から作らない）。ワーカーは別プロセスで、
 * 各自が設定から時刻の集合を作り直すので、実行時刻に依る値だとワーカーごとに違う値になり、
 * 状態の鍵が噛み合わなくなる。
 *
 * 2099-01-01 は、実行時の現在時刻より十分に後で、かつ時刻の正規化が要求する隔たり
 * （tools/explore/state.ts の TimeLabeler）を満たす。
 */
export const FUTURE_BASE = Date.UTC(2099, 0, 1)

/** 同じ瞬間でも書き手によって書式が違う、という現実をそのまま持ち込む。 */
export function renderTime(ms: number, style: number): string {
  const iso = new Date(ms).toISOString()
  return style === 0 ? iso : iso.replace('T', ' ').replace('.000Z', '')
}

export type Op =
  | { kind: 'upsertTag'; id: string; name: string; at: string }
  | { kind: 'deleteTag'; id: string }
  | {
      kind: 'upsertTagProfile'
      tagId: string
      tagName: string
      memo: string
      at: string
    }
  | { kind: 'deleteTagProfile'; tagId: string }
  | {
      kind: 'upsertTagNote'
      id: string
      tagId: string
      tagName: string
      body: string
      at: string
    }
  | { kind: 'deleteTagNote'; id: string }
  | { kind: 'upsertUser'; id: string; name: string; at: string }
  | { kind: 'deleteUser'; id: string }
  | {
      kind: 'upsertDecision'
      id: string
      cellKey: string
      value: string
      at: string
    }
  | { kind: 'deleteDecision'; id: string }
  | {
      kind: 'upsertAccount'
      id: string
      username: string
      email: string
      at: string
    }
  | { kind: 'deleteAccount'; id: string }
  /**
   * **時刻列を変えない UPDATE**（設計書 docs/rows-table-design.md §8.2 の操作の一覧）。
   *
   * アプリが `updatedAt` を進めずに中身だけ書き換える形。案A では版の `_sns_ts` が
   * 手元の `Max` まで引き上がる（§1.2.1）ので、時刻だけで比べる実装との差が出る
   */
  | { kind: 'updateKeepTime'; table: string; id: string; value: string }
  /**
   * **消してすぐ同じ id で作り直す**（同上）。作り直した版は削除の版の `_sns_ts` まで
   * 引き上がり、`_sns_lamport` で勝つ（アプリが古い時刻を書いても勝つ）
   */
  | {
      kind: 'deleteRecreate'
      table: string
      id: string
      value: string
      at: string
    }
  /** changelog の頭を、いちばん遅れている相手の読み位置の1つ先まで削る（＝フルマージへ落とす） */
  | { kind: 'pruneChangelog' }

/**
 * 状態空間の辺。
 *
 * - `op`: 端末 `client` のローカルDBへ操作を当てる
 * - `sync`: 端末 `client` が `performSync` する（終わったら時計が進む）
 * - `tick`: 時計を進める（以後の操作は、それまでのどの時刻より後を名乗る）
 */
export type Transition =
  | { kind: 'op'; client: number; op: Op }
  | { kind: 'sync'; client: number }
  | { kind: 'tick' }
  /**
   * 端末 `client` が `performSync` し、**その最中に**同じ端末のアプリが `op` を書く。
   *
   * `performSync` は途中で `await copyToNas(...)`（`localDb.backup()`。非同期にページを写す）を
   * 待つ。その間にアプリが書き込むと、書き込みが NAS のコピーに載るかどうか、自己点検や
   * 取り込みより前か後かが、同期の前後に書いた場合と変わる。この窓で事実が変わる種類の不具合は、
   * この遷移が無いと原理的に出ない。
   *
   * - `before-copy`: `backup()` が呼ばれた直後、写し始める前に書く（書き込みはコピーに載る。
   *   同期の冒頭の自己点検は、この書き込みを見ていない）
   * - `after-copy`: 写し終えた直後、`copyToNas` が戻る前に書く（書き込みはコピーに載らない。
   *   通常の経路ではこのあと取り込みが走り、書き込みを見る）
   *
   * 別の端末への書き込みは、同期する端末が読むのが相手の NAS 上のコピーなので、同期の前か後に
   * 書いた場合と区別が付かない。そこで同期する端末への書き込みだけを持つ
   */
  | {
      kind: 'syncWrite'
      client: number
      op: Op
      point: 'before-copy' | 'after-copy'
    }

/**
 * 新しい操作（`updateKeepTime` / `deleteRecreate`）を当てられる表と、その形。
 *
 * **親を持つ表（`tag_profiles` / `tag_notes`）は入れていない。** 子を作り直すには親を
 * 用意する条件つきの書き込みが要り、1つの遷移が3文になって、状態の数も履歴の読み方も
 * 一段ややこしくなる。範囲の制限として docs/exhaustive-check.md に書く。
 */
export const NEW_OP_TABLES: Record<
  string,
  {
    column: string
    insert: string
    values: (id: string, value: string, at: string) => unknown[]
  }
> = {
  tags: {
    column: 'name',
    insert: 'INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)',
    values: (id, value, at) => [id, value, at],
  },
  users: {
    column: 'name',
    insert: 'INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)',
    values: (id, value, at) => [id, value, at],
  },
  decisions: {
    column: 'cellKey',
    insert:
      'INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (?, ?, ?, ?)',
    values: (id, value, at) => [id, value, 'v1', at],
  },
  accounts: {
    column: 'username',
    insert:
      'INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)',
    values: (id, value, at) => [id, value, 'e1', at],
  },
}

/** 操作がローカルDBの外で読むもの（`pruneChangelog` は相手の `_sync_state` を読む）。 */
export type Peer = { id: string; db: Database.Database }

/**
 * アプリが文を当てて SQLite から受け取る結果を1語で書き留める。
 *
 * - `ok`: 1行以上変えた
 * - `none`: 0行（消す行が無かった・`DO NOTHING` で何もしなかった）
 * - `constraint`: 制約違反（ローカルの制約違反は「その端末では起きなかった」ことにする）
 *
 * これはアプリ自身が受け取る結果で、ライブラリの内部の表は読まない
 * （tools/explore/history.ts の `--schedule-key ops+status`）。
 */
function runStatement(
  results: string[],
  label: string,
  run: () => Database.RunResult
): boolean {
  try {
    const info = run()
    results.push(`${label}:${info.changes > 0 ? 'ok' : 'none'}`)
    return true
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
    results.push(`${label}:constraint`)
    return false
  }
}

/**
 * 子を作る前に親を用意する。
 *
 * 親が居ないまま子を入れると外部キー違反で**必ず**落ち、子の操作が全部
 * 「何も起きなかった」に潰れる（＝子を持つ親を畳む形が一度も踏めない）。
 *
 * @returns 親が居るか
 */
function ensureTag(
  db: Database.Database,
  results: string[],
  tagId: string,
  tagName: string,
  at: string
): boolean {
  runStatement(results, 'parent', () =>
    db
      .prepare(
        `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(tagId, tagName, at)
  )
  return db.prepare(`SELECT 1 FROM tags WHERE id = ?`).get(tagId) !== undefined
}

/**
 * この端末の changelog の頭を削り、**まだ誰も読んでいない位置まで**巻き込む。
 *
 * 既読ぶんだけを消しても隙間にはならない（`hasChangelogGap` の境界は
 * `minId === lastSeenId + 1`）。相手が次に読むはずだった1件まで消して、はじめて
 * 相手はフルマージへ落ちる。基準は**いちばん遅れている相手**。
 *
 * **`id <= floor + 1` は絶対値である。** 読み位置が 0 の相手に対しては「id 1 だけ」を
 * 消す。状態の正規化で changelog の id を相対値へずらしてはいけない理由の1つがこれ
 * （tools/explore/state.ts）。
 */
function pruneChangelog(
  db: Database.Database,
  selfId: string,
  peers: Peer[]
): void {
  let floor = Number.POSITIVE_INFINITY
  for (const peer of peers) {
    const state = peer.db
      .prepare(`SELECT lastSeenId FROM _sync_state WHERE remoteClientId = ?`)
      .get(selfId) as { lastSeenId: number } | undefined
    floor = Math.min(floor, state?.lastSeenId ?? 0)
  }
  if (!Number.isFinite(floor)) floor = 0
  db.prepare(`DELETE FROM _changelog WHERE id <= ?`).run(floor + 1)
}

/**
 * 1つの操作をローカルDBへ当てる（時刻の書き換えは呼び手＝world.ts が行う）。
 *
 * @returns アプリが SQLite から受け取った結果（{@link runStatement}）を並べた1行
 */
export function applyOp(
  db: Database.Database,
  selfId: string,
  peers: Peer[],
  op: Op
): string {
  const results: string[] = []
  const run = (sql: string, ...args: unknown[]): void => {
    runStatement(results, 'row', () => db.prepare(sql).run(...args))
  }
  switch (op.kind) {
    case 'upsertTag':
      run(
        `INSERT INTO tags (id, name, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt`,
        op.id,
        op.name,
        op.at
      )
      break
    case 'deleteTag':
      run(`DELETE FROM tags WHERE id = ?`, op.id)
      break
    case 'upsertTagProfile':
      if (!ensureTag(db, results, op.tagId, op.tagName, op.at)) break
      run(
        `INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET memo = excluded.memo, updatedAt = excluded.updatedAt`,
        op.tagId,
        op.memo,
        op.at
      )
      break
    case 'deleteTagProfile':
      run(`DELETE FROM tag_profiles WHERE id = ?`, op.tagId)
      break
    case 'upsertTagNote':
      if (!ensureTag(db, results, op.tagId, op.tagName, op.at)) break
      run(
        `INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tagId = excluded.tagId, body = excluded.body, updatedAt = excluded.updatedAt`,
        op.id,
        op.tagId,
        op.body,
        op.at
      )
      break
    case 'deleteTagNote':
      run(`DELETE FROM tag_notes WHERE id = ?`, op.id)
      break
    case 'upsertUser':
      run(
        `INSERT INTO users (id, name, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt`,
        op.id,
        op.name,
        op.at
      )
      break
    case 'deleteUser':
      run(`DELETE FROM users WHERE id = ?`, op.id)
      break
    case 'upsertDecision':
      run(
        `INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cellKey = excluded.cellKey, value = excluded.value, updatedAt = excluded.updatedAt`,
        op.id,
        op.cellKey,
        op.value,
        op.at
      )
      break
    case 'deleteDecision':
      run(`DELETE FROM decisions WHERE id = ?`, op.id)
      break
    case 'upsertAccount':
      run(
        `INSERT INTO accounts (id, username, email, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, email = excluded.email, updatedAt = excluded.updatedAt`,
        op.id,
        op.username,
        op.email,
        op.at
      )
      break
    case 'deleteAccount':
      run(`DELETE FROM accounts WHERE id = ?`, op.id)
      break
    case 'updateKeepTime': {
      const shape = NEW_OP_TABLES[op.table]
      run(
        `UPDATE "${op.table}" SET "${shape.column}" = ? WHERE id = ?`,
        op.value,
        op.id
      )
      break
    }
    case 'deleteRecreate': {
      const shape = NEW_OP_TABLES[op.table]
      run(`DELETE FROM "${op.table}" WHERE id = ?`, op.id)
      runStatement(results, 'recreate', () =>
        db.prepare(shape.insert).run(...shape.values(op.id, op.value, op.at))
      )
      break
    }
    case 'pruneChangelog':
      pruneChangelog(db, selfId, peers)
      results.push('prune')
      break
  }
  return results.join(',')
}

/** 範囲の中の行の時刻を全部並べる（時刻×書式）。過去の時刻のあとに未来の時刻。 */
export function knownTimes(config: ExploreConfig): string[] {
  return [
    ...config.times.map((delta) => BASE_TIME + delta),
    ...config.futureTimes.map((delta) => FUTURE_BASE + delta),
  ].flatMap((ms) => config.formats.map((style) => renderTime(ms, style)))
}

const numbered = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1)}`)

/**
 * 範囲の中にある操作を全部並べる。
 *
 * **子の表の「親の名前」と「どの親を指すか」は id から1つに決めてある**
 * （`g1` の子は `t1` という名前の `g1` を親に取る）。ここも振ると1段の分岐が
 * 数倍になり、深さを1段削るほうが損になる。名前の衝突（＝統合）は `upsertTag` が
 * 全ての名前を振るので、子を持つ親が統合される形は踏める。これは範囲の制限なので
 * 報告に書く（docs/exhaustive-check.md）。
 */
export function enumerateOps(config: ExploreConfig): Op[] {
  const tables: readonly string[] = TABLE_SETS[config.tableSet]
  const ats = knownTimes(config)
  const ids = numbered('', config.ids)
  const keys = numbered('', config.keys)
  const payloads = numbered('', config.payloads)
  const ops: Op[] = []

  if (tables.includes('tags')) {
    for (const i of ids) {
      for (const k of keys) {
        for (const at of ats) {
          ops.push({ kind: 'upsertTag', id: `g${i}`, name: `t${k}`, at })
        }
      }
      ops.push({ kind: 'deleteTag', id: `g${i}` })
    }
  }
  if (tables.includes('tag_profiles')) {
    ids.forEach((i, index) => {
      for (const p of payloads) {
        for (const at of ats) {
          ops.push({
            kind: 'upsertTagProfile',
            tagId: `g${i}`,
            tagName: `t${keys[index % keys.length]}`,
            memo: `m${p}`,
            at,
          })
        }
      }
      ops.push({ kind: 'deleteTagProfile', tagId: `g${i}` })
    })
  }
  if (tables.includes('tag_notes')) {
    ids.forEach((i, index) => {
      for (const p of payloads) {
        for (const at of ats) {
          ops.push({
            kind: 'upsertTagNote',
            id: `n${i}`,
            tagId: `g${i}`,
            tagName: `t${keys[index % keys.length]}`,
            body: `b${p}`,
            at,
          })
        }
      }
      ops.push({ kind: 'deleteTagNote', id: `n${i}` })
    })
  }
  if (tables.includes('users')) {
    // users には UNIQUE が無い。名前の種類は --keys で振る（同時刻で名前違い を作る）
    for (const i of ids) {
      for (const k of keys) {
        for (const at of ats) {
          ops.push({ kind: 'upsertUser', id: `u${i}`, name: `name${k}`, at })
        }
      }
      ops.push({ kind: 'deleteUser', id: `u${i}` })
    }
  }
  if (tables.includes('decisions')) {
    for (const i of ids) {
      for (const k of keys) {
        for (const p of payloads) {
          for (const at of ats) {
            ops.push({
              kind: 'upsertDecision',
              id: `d${i}`,
              cellKey: `c${k}`,
              value: `v${p}`,
              at,
            })
          }
        }
      }
      ops.push({ kind: 'deleteDecision', id: `d${i}` })
    }
  }
  if (tables.includes('accounts')) {
    for (const i of ids) {
      for (const k of keys) {
        for (const k2 of keys) {
          for (const at of ats) {
            ops.push({
              kind: 'upsertAccount',
              id: `a${i}`,
              username: `u${k}`,
              email: `e${k2}`,
              at,
            })
          }
        }
      }
      ops.push({ kind: 'deleteAccount', id: `a${i}` })
    }
  }

  // 時刻列を変えない UPDATE と、消してすぐ作り直す操作（設計書 §8.2）。既定では入れない（1段の分岐が増えるので、範囲を指定して使う）
  for (const table of tables) {
    if (!(table in NEW_OP_TABLES)) continue
    const prefix =
      table === 'tags'
        ? 'g'
        : table === 'users'
          ? 'u'
          : table === 'decisions'
            ? 'd'
            : 'a'
    const label =
      table === 'users'
        ? 'name'
        : table === 'decisions'
          ? 'c'
          : table === 'accounts'
            ? 'u'
            : 't'
    for (const i of ids) {
      for (const k of keys) {
        if (config.keepTimeUpdates) {
          ops.push({
            kind: 'updateKeepTime',
            table,
            id: `${prefix}${i}`,
            value: `${label}${k}`,
          })
        }
        if (config.recreates) {
          for (const at of ats) {
            ops.push({
              kind: 'deleteRecreate',
              table,
              id: `${prefix}${i}`,
              value: `${label}${k}`,
              at,
            })
          }
        }
      }
    }
  }

  if (config.prune) ops.push({ kind: 'pruneChangelog' })
  // 削除を外す指定なら、ここでまとめて落とす（表ごとの分岐に入れると、表を足すたびに書き忘れる）
  return config.deletes
    ? ops
    : ops.filter((op) => !op.kind.startsWith('delete'))
}

/** 範囲の中の遷移を全部並べる。**並びは決定的であること**（ワーカー間で添字を共有する）。 */
export function enumerateTransitions(config: ExploreConfig): Transition[] {
  const ops = enumerateOps(config)
  const transitions: Transition[] = []
  for (let client = 0; client < config.clients; client += 1) {
    for (const op of ops) transitions.push({ kind: 'op', client, op })
  }
  for (let client = 0; client < config.clients; client += 1) {
    transitions.push({ kind: 'sync', client })
  }
  if (config.tick) transitions.push({ kind: 'tick' })
  const points: ('before-copy' | 'after-copy')[] =
    config.syncWrite === 'both'
      ? ['before-copy', 'after-copy']
      : config.syncWrite === 'before'
        ? ['before-copy']
        : config.syncWrite === 'after'
          ? ['after-copy']
          : []
  for (const point of points) {
    for (let client = 0; client < config.clients; client += 1) {
      // 記録の掃除（pruneChangelog）はアプリの書き込みではないので、同期の最中には当てない
      for (const op of ops.filter(
        (candidate) => candidate.kind !== 'pruneChangelog'
      )) {
        transitions.push({ kind: 'syncWrite', client, op, point })
      }
    }
  }
  return transitions
}

/** 履歴の鍵に使う、操作の表現（中身そのもの。時刻は範囲で決めた値なので実行によらない）。 */
export function describeOpForHistory(op: Op): string {
  return JSON.stringify(op)
}

/** 端末の名前（`client-a`, `client-b`, …）。 */
export function clientName(index: number): string {
  return `client-${String.fromCharCode(97 + index)}`
}

/** 人が読める1行。**そのまま決定的テストへ書き下せる粒度**にする。 */
export function describeTransition(transition: Transition): string {
  if (transition.kind === 'tick') {
    return '時計を進める（以後の操作は、これまでのどの時刻より後を名乗る）'
  }
  const who = clientName(transition.client)
  if (transition.kind === 'sync') {
    return `${who}: await performSync(${who}.db, ${who}.config, TABLES)`
  }
  if (transition.kind === 'syncWrite') {
    const when =
      transition.point === 'before-copy'
        ? 'copyToNas の localDb.backup() が呼ばれた直後、写し始める前に（書き込みは NAS のコピーに載る）'
        : 'copyToNas の localDb.backup() が写し終えた直後に（書き込みは NAS のコピーに載らない）'
    return (
      `${who}: await performSync(${who}.db, ${who}.config, TABLES) の最中、${when} ` +
      describeOp(who, transition.op)
    )
  }
  return describeOp(who, transition.op)
}

/** 操作1つを、そのまま決定的テストへ書き下せる1行にする。 */
function describeOp(who: string, op: Op): string {
  const q = (value: string): string => `'${value}'`
  switch (op.kind) {
    case 'upsertTag':
      return `${who}: INSERT INTO tags (id, name, updatedAt) VALUES (${q(op.id)}, ${q(op.name)}, ${q(op.at)}) ON CONFLICT(id) DO UPDATE …`
    case 'deleteTag':
      return `${who}: DELETE FROM tags WHERE id = ${q(op.id)}`
    case 'upsertTagProfile':
      return `${who}: （tags に ${q(op.tagId)} が無ければ INSERT INTO tags VALUES (${q(op.tagId)}, ${q(op.tagName)}, ${q(op.at)})、UNIQUE で失敗したら何もしない）INSERT INTO tag_profiles (id, memo, updatedAt) VALUES (${q(op.tagId)}, ${q(op.memo)}, ${q(op.at)}) ON CONFLICT(id) DO UPDATE …`
    case 'deleteTagProfile':
      return `${who}: DELETE FROM tag_profiles WHERE id = ${q(op.tagId)}`
    case 'upsertTagNote':
      return `${who}: （tags に ${q(op.tagId)} が無ければ INSERT INTO tags VALUES (${q(op.tagId)}, ${q(op.tagName)}, ${q(op.at)})、UNIQUE で失敗したら何もしない）INSERT INTO tag_notes (id, tagId, body, updatedAt) VALUES (${q(op.id)}, ${q(op.tagId)}, ${q(op.body)}, ${q(op.at)}) ON CONFLICT(id) DO UPDATE …`
    case 'deleteTagNote':
      return `${who}: DELETE FROM tag_notes WHERE id = ${q(op.id)}`
    case 'upsertUser':
      return `${who}: INSERT INTO users (id, name, updatedAt) VALUES (${q(op.id)}, ${q(op.name)}, ${q(op.at)}) ON CONFLICT(id) DO UPDATE …`
    case 'deleteUser':
      return `${who}: DELETE FROM users WHERE id = ${q(op.id)}`
    case 'upsertDecision':
      return `${who}: INSERT INTO decisions (id, cellKey, value, updatedAt) VALUES (${q(op.id)}, ${q(op.cellKey)}, ${q(op.value)}, ${q(op.at)}) ON CONFLICT(id) DO UPDATE …`
    case 'deleteDecision':
      return `${who}: DELETE FROM decisions WHERE id = ${q(op.id)}`
    case 'upsertAccount':
      return `${who}: INSERT INTO accounts (id, username, email, updatedAt) VALUES (${q(op.id)}, ${q(op.username)}, ${q(op.email)}, ${q(op.at)}) ON CONFLICT(id) DO UPDATE …`
    case 'deleteAccount':
      return `${who}: DELETE FROM accounts WHERE id = ${q(op.id)}`
    case 'updateKeepTime':
      return `${who}: UPDATE ${op.table} SET ${NEW_OP_TABLES[op.table].column} = ${q(op.value)} WHERE id = ${q(op.id)}（時刻列は変えない）`
    case 'deleteRecreate':
      return `${who}: DELETE FROM ${op.table} WHERE id = ${q(op.id)}; そのうえで ${NEW_OP_TABLES[op.table].insert} に (${q(op.id)}, ${q(op.value)}, …, ${q(op.at)}) を入れる（消してすぐ同じ id で作り直す）`
    case 'pruneChangelog':
      return `${who}: DELETE FROM _changelog WHERE id <= (相手の _sync_state.lastSeenId の最小値 + 1)（相手をフルマージへ落とす）`
  }
}
