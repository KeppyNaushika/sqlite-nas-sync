/**
 * 「検査器が発行した操作の列」→「版の集合」→ 参照実装 `rows-d1` の見え方。
 *
 * 判定4（設計書 §8.1）の本来の入力は、**性質2 で集めた版**（実装の `_sns_rows_*` から
 * 読み取ったもの）である。しかし案A が入るまでその表は存在しないので、段階0 では
 * **発行した操作の列から版を組み立てて**参照実装に渡す。組み立ての規則は設計書 §1.2.1
 * （`_sns_ts` の引き上げ）・§2.2（アプリの接続で起きた変化はすべて事実）そのままである。
 *
 * ## 決められない列は `null` を返す（＝その状態では突き合わせない）
 *
 * 発行した操作の列だけからは、**同期がどこで挟まったか**が分からない。同期の位置で
 * 事実そのものが変わる形が3つある。
 *
 * 1. **`_sns_ts` の引き上げ**（§1.2.1）: 他の端末から届いた版が手元の `Max` に入っていれば、
 *    そのあとの書き込み・削除の `_sns_ts` はそこまで引き上がる
 * 2. **cascade で消える子**（§2.2）: 親を消したとき一緒に消えるのは「その時点でその端末に
 *    在った子」なので、届いていたかどうかで削除の版の集合が変わる
 * 3. **時刻列を変えない UPDATE**: 版に載る時刻列の値は、そのとき行に入っていた値である
 * 4. **`L`（lamport）の引き上げ**（§4.3・不変条件 C）: 取り込みは `_sns_clock.lamport` を
 *    受け取った版の最大まで引き上げるので、取り込んだあとの書き込みは大きい `L` を名乗る
 *    （{@link tiedAcrossInstances}）
 * 5. **読み替えのあとの削除**（§1.6・§3.3 の `TRUE_ID`）: アプリは表示上の id で消すので、
 *    かぶりに負けて読み替えられた行があると、同じ `DELETE` 文が違う真の id の版を作る
 *    （{@link hasRemap}）
 *
 * 1 については、**ありうる引き上げ方を全部試し、どれでも同じ見え方になるときだけ**答える
 * （場合の数が多すぎるときは `null`）。2・3・4・5 については、その形なら `null` にする。
 * `null` を返すと検査器はその状態を飛ばすので、**見落としはしても誤検出はしない**側に倒れる。
 *
 * ## `iid` について
 *
 * 本物の `instanceId` は 128 ビットの乱数なので、操作の列からは決められない。そこで
 * 端末の並び順を**両方の向き**（`iid-a` ＜ `iid-b` と、その逆）で試し、どちらでも同じ
 * 見え方になるときだけ答える。同着（`_sns_ts` も `L` も等しい）が `iid` の字面で決まる形は、
 * 向きで答えが変わるので `null` になる —— その形の勝敗は設計上も端末の乱数で決まる（§9.6）。
 *
 * @module tools/explore/oracles/from-history
 */
import { History, IssuedOp, Oracle } from '../history'
import { NEW_OP_TABLES, PLAIN_TABLES, Op } from '../ops'
import { DDL } from '../world'
import {
  Derived,
  OracleSchema,
  OracleTable,
  SqlValue,
  ValueOracle,
  Version,
  derive,
  viewJson,
} from './rows-d1'

/** 1つの操作が起こした、アプリの表への書き込み1件。 */
type Event = {
  client: number
  /** その端末での書き込み順（設計書 §1.2 の `L`） */
  lamport: number
  table: string
  id: string
  kind: 'row' | 'delete'
  content?: Record<string, SqlValue>
  /**
   * 行の版のときの、アプリの表の時刻列の新しい値。**格納クラスのまま持つ**
   * （数値の時刻を文字列にすると、設計書 §1.2.3 の群1 が群2 へ移る）
   */
  writtenAt?: SqlValue
}

/** 親の表（子の表から見た親と、子の外部キーの列）。 */
const PARENT_OF: Record<string, { parent: string; column: string }> = {
  tag_profiles: { parent: 'tags', column: 'id' },
  tag_notes: { parent: 'tags', column: 'tagId' },
}

/** 操作が触る表（見え方に出す表を決めるのに使う）。 */
function tablesOf(op: Op): string[] {
  switch (op.kind) {
    case 'upsertTag':
    case 'deleteTag':
      return ['tags']
    case 'upsertTagProfile':
    case 'deleteTagProfile':
      return ['tags', 'tag_profiles']
    case 'upsertTagNote':
    case 'deleteTagNote':
      return ['tags', 'tag_notes']
    case 'upsertUser':
    case 'deleteUser':
      return ['users']
    case 'upsertDecision':
    case 'deleteDecision':
      return ['decisions']
    case 'upsertAccount':
    case 'deleteAccount':
      return ['accounts']
    case 'updateKeepTime':
    case 'deleteRecreate':
    case 'upsertPlain':
    case 'deletePlain':
      return [op.table]
    default:
      return []
  }
}

/** 発行した操作の列に出てくる表から、参照実装へ渡すスキーマを作る。 */
function schemaOf(history: History): OracleSchema {
  const names = new Set<string>()
  for (const issued of history) {
    for (const entry of issued) {
      for (const table of tablesOf(entry.op)) names.add(table)
    }
  }
  const tables: OracleTable[] = [...names]
    .sort()
    .map((name) => ({ name, ddl: DDL[name], timeColumn: 'updatedAt' }))
  return { tables }
}

/** `applyOp` が返した結果（`row:ok` など）から、その札の結果を取り出す。 */
function statusOf(entry: IssuedOp, label: string): string | null {
  for (const part of entry.status.split(',')) {
    const [name, value] = part.split(':')
    if (name === label) return value
  }
  return null
}

/**
 * 端末ごとの「自分が書いた行」の写し。cascade で消える子を決めるのに使う
 * （**その端末に在った子**しか消えない。§2.2）。
 */
type LocalRows = Map<string, Map<string, Record<string, SqlValue>>>

function put(
  rows: LocalRows,
  table: string,
  id: string,
  content: Record<string, SqlValue>
): void {
  const perTable = rows.get(table) ?? new Map()
  perTable.set(id, content)
  rows.set(table, perTable)
}

/** 操作が起こした、アプリの表への変化1つ（当てた順に並ぶ）。 */
type Step =
  | {
      kind: 'write'
      table: string
      id: string
      content: Record<string, SqlValue>
    }
  | { kind: 'delete'; table: string; id: string }
  /** 時刻列を変えない UPDATE（版に載る時刻は、そのとき行に入っていた値） */
  | {
      kind: 'keep-time'
      table: string
      id: string
      column: string
      value: SqlValue
    }

/** 発行した操作の列を、端末ごとの書き込みの列（`L` つき）へ開く。決められなければ `null`。 */
function eventsOf(history: History): Event[] | null {
  const events: Event[] = []
  const local: LocalRows[] = history.map(() => new Map())
  // 他の端末が書いた子（cascade の巻き添えが決められるかの判定に使う）
  const childrenByParent = new Map<string, Set<number>>()
  // 他の端末が触ったキー（時刻列を変えない UPDATE が決められるかの判定に使う）
  const touchedBy = new Map<string, Set<number>>()
  history.forEach((issued, client) => {
    for (const entry of issued) {
      for (const step of stepsOf(entry)) {
        const key = `${step.table}:${step.id}`
        const who = touchedBy.get(key) ?? new Set<number>()
        who.add(client)
        touchedBy.set(key, who)
        if (step.kind !== 'write') continue
        const parent = PARENT_OF[step.table]
        if (parent === undefined) continue
        const parentId = String(step.content[parent.column] ?? '')
        const parentKey = `${parent.parent}:${parentId}`
        const set = childrenByParent.get(parentKey) ?? new Set<number>()
        set.add(client)
        childrenByParent.set(parentKey, set)
      }
    }
  })

  for (let client = 0; client < history.length; client += 1) {
    let lamport = 0
    for (const entry of history[client]) {
      for (const step of stepsOf(entry)) {
        if (step.kind === 'write') {
          lamport += 1
          events.push({
            client,
            lamport,
            table: step.table,
            id: step.id,
            kind: 'row',
            content: step.content,
            writtenAt: step.content.updatedAt ?? null,
          })
          put(local[client], step.table, step.id, step.content)
          continue
        }
        if (step.kind === 'keep-time') {
          // 版に載る時刻は「そのとき行に入っていた値」。他の端末も触っているキーでは、
          // 同期がどこで挟まったかで変わるので決められない
          const others = touchedBy.get(`${step.table}:${step.id}`)
          if (
            others !== undefined &&
            [...others].some((other) => other !== client)
          ) {
            return null
          }
          const current = local[client].get(step.table)?.get(step.id)
          if (current === undefined) return null
          const content = { ...current, [step.column]: step.value }
          lamport += 1
          events.push({
            client,
            lamport,
            table: step.table,
            id: step.id,
            kind: 'row',
            content,
            writtenAt: content.updatedAt ?? null,
          })
          put(local[client], step.table, step.id, content)
          continue
        }
        // cascade の巻き添え: 他の端末がその親の子を書いていると、届いていたかどうかで
        // 削除の版の集合が変わる（§2.2）ので、決められないことにする
        const others = childrenByParent.get(`${step.table}:${step.id}`)
        if (
          others !== undefined &&
          [...others].some((other) => other !== client)
        ) {
          return null
        }
        for (const victim of cascadeFrom(local[client], step)) {
          lamport += 1
          events.push({
            client,
            lamport,
            table: victim.table,
            id: victim.id,
            kind: 'delete',
          })
          local[client].get(victim.table)?.delete(victim.id)
        }
      }
    }
  }
  return events
}

/** 削除される行と、宣言された `ON DELETE CASCADE` でつながる子（その端末に在る分だけ）。 */
function cascadeFrom(
  rows: LocalRows,
  target: { table: string; id: string }
): { table: string; id: string }[] {
  const victims = [target]
  for (const [childTable, link] of Object.entries(PARENT_OF)) {
    if (link.parent !== target.table) continue
    for (const [childId, content] of rows.get(childTable) ?? []) {
      if (String(content[link.column] ?? '') === target.id) {
        victims.push({ table: childTable, id: childId })
      }
    }
  }
  return victims
}

/**
 * 1つの操作が起こした変化を、**当てた順に**並べる。アプリが「起きた」と受け取ったものだけ
 * （`row:none` や `row:constraint` は何も起こしていない）。
 */
function stepsOf(entry: IssuedOp): Step[] {
  const op = entry.op
  const steps: Step[] = []
  // 子の操作が親を用意する `INSERT … DO NOTHING` は、挿入したときだけ版になる
  if (
    (op.kind === 'upsertTagProfile' || op.kind === 'upsertTagNote') &&
    statusOf(entry, 'parent') === 'ok'
  ) {
    steps.push({
      kind: 'write',
      table: 'tags',
      id: op.tagId,
      content: { id: op.tagId, name: op.tagName, updatedAt: op.at },
    })
  }
  const rowOk = statusOf(entry, 'row') === 'ok'
  switch (op.kind) {
    case 'upsertTag':
      if (rowOk) {
        steps.push({
          kind: 'write',
          table: 'tags',
          id: op.id,
          content: { id: op.id, name: op.name, updatedAt: op.at },
        })
      }
      break
    case 'upsertTagProfile':
      if (rowOk) {
        steps.push({
          kind: 'write',
          table: 'tag_profiles',
          id: op.tagId,
          content: { id: op.tagId, memo: op.memo, updatedAt: op.at },
        })
      }
      break
    case 'upsertTagNote':
      if (rowOk) {
        steps.push({
          kind: 'write',
          table: 'tag_notes',
          id: op.id,
          content: {
            id: op.id,
            tagId: op.tagId,
            body: op.body,
            updatedAt: op.at,
          },
        })
      }
      break
    case 'upsertUser':
      if (rowOk) {
        steps.push({
          kind: 'write',
          table: 'users',
          id: op.id,
          content: { id: op.id, name: op.name, updatedAt: op.at },
        })
      }
      break
    case 'upsertDecision':
      if (rowOk) {
        steps.push({
          kind: 'write',
          table: 'decisions',
          id: op.id,
          content: {
            id: op.id,
            cellKey: op.cellKey,
            value: op.value,
            updatedAt: op.at,
          },
        })
      }
      break
    case 'upsertAccount':
      if (rowOk) {
        steps.push({
          kind: 'write',
          table: 'accounts',
          id: op.id,
          content: {
            id: op.id,
            username: op.username,
            email: op.email,
            updatedAt: op.at,
          },
        })
      }
      break
    case 'deleteTag':
      if (rowOk) steps.push({ kind: 'delete', table: 'tags', id: op.id })
      break
    case 'deleteTagProfile':
      if (rowOk) {
        steps.push({ kind: 'delete', table: 'tag_profiles', id: op.tagId })
      }
      break
    case 'deleteTagNote':
      if (rowOk) steps.push({ kind: 'delete', table: 'tag_notes', id: op.id })
      break
    case 'deleteUser':
      if (rowOk) steps.push({ kind: 'delete', table: 'users', id: op.id })
      break
    case 'upsertPlain':
      if (rowOk) {
        steps.push({
          kind: 'write',
          table: op.table,
          id: op.id,
          content: {
            id: op.id,
            [PLAIN_TABLES[op.table].column]: op.name,
            // **数値のまま持つ**（文字列にすると設計書 §1.2.3 の群1 が群2 へ移り、
            // 参照実装が本物と違う順序で比べることになる）
            updatedAt: op.at,
          },
        })
      }
      break
    case 'deletePlain':
      if (rowOk) steps.push({ kind: 'delete', table: op.table, id: op.id })
      break
    case 'deleteDecision':
      if (rowOk) steps.push({ kind: 'delete', table: 'decisions', id: op.id })
      break
    case 'deleteAccount':
      if (rowOk) steps.push({ kind: 'delete', table: 'accounts', id: op.id })
      break
    case 'updateKeepTime':
      if (rowOk) {
        steps.push({
          kind: 'keep-time',
          table: op.table,
          id: op.id,
          column: NEW_OP_TABLES[op.table].column,
          value: op.value,
        })
      }
      break
    case 'deleteRecreate': {
      // 消してから、同じ id で入れ直す（この順に事実になる。§2.4 (4)）
      if (rowOk) steps.push({ kind: 'delete', table: op.table, id: op.id })
      if (statusOf(entry, 'recreate') === 'ok') {
        const shape = NEW_OP_TABLES[op.table]
        const content: Record<string, SqlValue> = {
          id: op.id,
          [shape.column]: op.value,
          updatedAt: op.at,
        }
        if (op.table === 'decisions') content.value = 'v1'
        if (op.table === 'accounts') content.email = 'e1'
        steps.push({ kind: 'write', table: op.table, id: op.id, content })
      }
      break
    }
    default:
      break
  }
  return steps
}

/**
 * ありうる `_sns_ts` の付け方（設計書 §1.2.1）を全部作る。
 *
 * ある書き込みの `_sns_ts` は「アプリが書いた時刻列の値」と「その端末の手元の `Max`」の
 * 大きい方である。手元の `Max` には他の端末から届いた版が入りうるので、候補は
 * 「そのキーに現れる時刻のうち、自分の値以上のもの」になる。**ありうる組み合わせを全部**
 * 作り、どれでも同じ見え方になるときだけ答える。
 *
 * @returns 版の集合の候補。場合の数が多すぎれば `null`
 */
function assignmentsOf(
  events: Event[],
  values: ValueOracle
): Version[][] | null {
  // キーごとに現れる時刻（引き上げ先の候補）
  const timesByKey = new Map<string, SqlValue[]>()
  for (const event of events) {
    if (event.writtenAt === undefined) continue
    const key = `${event.table}:${event.id}`
    const list = timesByKey.get(key) ?? []
    if (
      !list.some(
        (value) => values.compareTs(value, event.writtenAt as SqlValue) === 0
      )
    ) {
      list.push(event.writtenAt)
    }
    timesByKey.set(key, list)
  }

  // 各書き込みの候補
  const choices: SqlValue[][] = events.map((event) => {
    const key = `${event.table}:${event.id}`
    const times = timesByKey.get(key) ?? []
    if (event.kind === 'delete') {
      // 削除の版は「手元の Max の _sns_ts」。そのキーに現れるどの時刻にもなりうる
      return times.length === 0 ? [null] : times
    }
    const own = event.writtenAt as SqlValue
    return times.filter((value) => values.compareTs(value, own) >= 0)
  })

  const total = choices.reduce(
    (product, list) => product * Math.max(1, list.length),
    1
  )
  if (total > 64) return null

  const assignments: Version[][] = []
  const walk = (index: number, chosen: SqlValue[]): void => {
    if (index === events.length) {
      const versions = buildVersions(events, chosen, values)
      if (versions !== null) assignments.push(versions)
      return
    }
    for (const value of choices[index]) walk(index + 1, [...chosen, value])
  }
  walk(0, [])
  return assignments.length === 0 ? null : assignments
}

/**
 * 仮に置く `instanceId`。**同着（`_sns_ts` も `L` も等しい）の最後の鍵**なので、
 * 向きを両方試して、どちらでも同じ見え方になるときだけ答える（{@link rowsD1Oracle}）。
 */
let reverseInstances = false

function instanceLabel(client: number, events: Event[]): string {
  const clients = Math.max(...events.map((event) => event.client)) + 1
  const index = reverseInstances ? clients - 1 - client : client
  return `iid-${String.fromCharCode(97 + index)}`
}

/**
 * 選んだ `_sns_ts` の組から版の集合を作る。**同じ端末の同じキーで `_sns_ts` が
 * 弱くなる組は、引き上げの規則と矛盾する**ので捨てる（`null` を返す）。
 */
function buildVersions(
  events: Event[],
  chosen: SqlValue[],
  values: ValueOracle
): Version[] | null {
  const last = new Map<string, SqlValue>()
  const versions: Version[] = []
  for (const [index, event] of events.entries()) {
    const ts = chosen[index]
    const key = `${event.client}|${event.table}|${event.id}`
    const previous = last.get(key)
    if (previous !== undefined && values.compareTs(ts, previous) < 0)
      return null
    last.set(key, ts)
    versions.push({
      table: event.table,
      id: event.id,
      kind: event.kind,
      ts,
      lamport: event.lamport,
      instance: instanceLabel(event.client, events),
      ...(event.content === undefined ? {} : { content: event.content }),
    })
  }
  return versions
}

/**
 * **`L`（lamport）の引き上げで答えが変わる形か。**
 *
 * `L` に載るのは「その端末での書き込み順」だけではない。取り込みは `_sns_clock.lamport` を
 * 受け取った版の最大まで引き上げる（設計書 §4.3・不変条件 C）ので、**他の端末の版を取り込んだ
 * あとの書き込みは、取り込んでいなかった場合より大きい `L` を名乗る**。どこで取り込んだかは
 * 発行した操作の列からは決められない。
 *
 * `L` が効くのは `_sns_ts` が同着のときだけ（順序は `( _sns_ts, L, iid )` の辞書順）で、
 * 同じ端末の中では引き上げがあっても書き込み順は保たれる。したがって危ないのは
 * **違う端末の版が、同着の `_sns_ts` で並ぶ**形である。その形は突き合わせない。
 *
 * **キーごとではなく表ごとに見る。** 同着の `L` が効くのは同じキーの `Max` を決めるときだけでなく、
 * **かぶりの勝者を決めるとき**（§1.5。同じ表の違うキーの版どうしを比べる）もあるからである。
 *
 * これを入れる前は、次の2つの列で誤検出した（実測。案A の実装はどちらも設計どおりだった）:
 *
 * - a が同期の最中に `tag_profiles` の g1 を作り（親の `tags` も作る）、b が同期の最中に
 *   その g1 を消す。b は消す前に a の版を取り込んでいるので `L` が引き上がり、**削除が勝つ**。
 *   端末ごとの書き込み順だけで `L` を振ると、削除の `L` は 1 のままで a の版（`L` は 2）に負ける
 * - a が `tags` の g1 を t2(T0) → t1(T1) と書き、b が同期の最中に g2 を t1(T1) で作る。名前 t1 が
 *   かぶり、どちらの `_sns_ts` も T1 なので `L` で決まる。b は取り込みで `L` が引き上がっているので
 *   **g2 が勝つ**。端末ごとの書き込み順だけだと、g1（`L` は 2）が g2（`L` は 1）に勝つ
 */
function tiedAcrossInstances(
  versions: Version[],
  values: ValueOracle
): boolean {
  const byTable = new Map<string, Version[]>()
  for (const version of versions) {
    const list = byTable.get(version.table) ?? []
    list.push(version)
    byTable.set(version.table, list)
  }
  for (const list of byTable.values()) {
    for (const a of list) {
      for (const b of list) {
        if (a.instance === b.instance) continue
        if (values.compareTs(a.ts, b.ts) === 0) return true
      }
    }
  }
  return false
}

/**
 * **読み替え（`Res_p(k) ≠ k`）が起きているか。**
 *
 * かぶりに負けた行は、勝った行の主キーで表示される（設計書 §1.6）。アプリはその**表示上の id** で
 * 消すので、同じ `DELETE` 文が、いつ同期を挟んだかによって**違う真の id の版**を作る
 * （トリガーは `_sns_shown` を引いて真の id を記録する。§3.3 の `TRUE_ID`）。
 * 発行した操作の列からは、削除がどの真の id に当たったかを決められない。
 *
 * これを入れる前は、次の列で誤検出した（実測。案A の実装は設計どおりだった）:
 * a が `tags` の g1 を t2(T1) で作り、b が `tag_profiles` の g2 を作って親 `tags` の g2 を t2(T0) で
 * 作る。b は同期で a の g1 を取り込み、名前 t2 のかぶりで自分の g2 が負けるので、1:1 の子は
 * **g1 として表示される**。そこへ `DELETE FROM tag_profiles WHERE id = 'g1'` が当たると、
 * 消えるのは真の id が g2 の版である。操作の列だけを見ると「g1 を消した」としか読めない。
 */
function hasRemap(derived: Derived): boolean {
  for (const [, byId] of derived.res) {
    for (const [trueId, shown] of byId) {
      if (shown === null) continue
      if (String(shown) !== trueId) return true
    }
  }
  return false
}

/** 表示上の id を指す削除（`deleteRecreate` を含む）が列にあるか。 */
function hasDelete(history: History): boolean {
  return history.some((issued) =>
    issued.some((entry) => entry.op.kind.startsWith('delete'))
  )
}

/**
 * 参照実装 `rows-d1`。検査器には `--oracle rows-d1` で選ばせる
 * （登録は {@link module:tools/explore/history} の `ORACLES`）。
 */
export const rowsD1Oracle: Oracle = {
  name: 'rows-d1',
  description:
    '設計書 docs/rows-table-design.md §1・§2（案A）の定義どおりに計算した、アプリの表の見え方',
  expectedView: (history: History): string | null => {
    const schema = schemaOf(history)
    if (schema.tables.length === 0) return null
    const events = eventsOf(history)
    if (events === null) return null
    const deletes = hasDelete(history)
    const values = new ValueOracle()
    const views = new Set<string>()
    for (const order of [false, true]) {
      reverseInstances = order
      const built = assignmentsOf(events, values)
      if (built === null) return null
      for (const versions of built) {
        if (tiedAcrossInstances(versions, values)) return null
        const derived = derive(versions, schema)
        // 読み替えが起きている列で削除があると、削除がどの真の id に当たったかが決められない
        if (deletes && hasRemap(derived)) return null
        views.add(viewJson(derived, schema))
        // 引き上げ方や iid の向きで答えが変わる列は突き合わせない
        if (views.size > 1) return null
      }
    }
    return [...views][0]
  },
}
