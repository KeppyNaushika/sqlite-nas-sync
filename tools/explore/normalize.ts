/**
 * 案A（`_rows_*` を正とする作り直し。docs/rows-table-design.md）で状態に現れる、
 * **絶対値のままだと状態が際限なく分かれる値**の正規化。
 *
 * ここに置くのは**純粋な関数だけ**にしてある（DBも世界も触らない）。状態の正規化は
 * 「畳みすぎれば反例を見逃し、足りなければ遅いだけ」という非対称な間違いを起こすので、
 * 根拠を関数の単位で書き、{@link runNormalizeUnitTests} で機械的に確かめられるようにする。
 *
 * ## 何を正規化するか
 *
 * | 値 | 正規化 | 理由 |
 * | --- | --- | --- |
 * | `_sync_meta.generation` | 手元と NAS の写しの**新旧関係**だけ | 絶対値は同期のたびに増える。読む箇所は「NAS の写しの方が新しいか」だけ |
 * | `_sns_clock.lamport` / 版の `L` | **最大値からの隔たり**を上限で打ち切った相対の番号 | 絶対値は書き込みのたびに増える。読む箇所は版どうしの大小だけ |
 * | `instanceId` | 字面の順を保った記号（`iid#0`, `iid#1`, …） | 端末ごとの128ビット乱数。字面をそのまま持つと同じ状態が二度と一致しない |
 *
 * @module tools/explore/normalize
 */

/** 手元と NAS の写しの `generation` の関係。 */
export type GenerationRelation =
  'none' | 'local-only' | 'nas-only' | 'local<nas' | 'local=nas' | 'local>nas'

/**
 * `generation` を「手元と NAS の写しの新旧関係」へ畳む。
 *
 * 案A で `generation` を読むのは**復元の判定**（`performSync` の最初で、NAS 上の自分の写しの
 * `generation` が手元より大きければ、手元が巻き戻っているとみて復元する。設計書 §7）だけで、
 * 絶対値は使わない。値のまま状態へ入れると、同期を1回するたびに「前と同じだが generation だけ
 * 1つ大きい」状態が生まれ、重複排除が原理的に効かなくなる。
 *
 * **比べるのは数として。** 設計書では `_sync_meta` の値なので文字列で入るが、`'10'` と `'9'` を
 * 字面で比べると逆転する。数として読めない値が来たら字面で比べる（読める値と読めない値が
 * 混ざる形は、そもそも実装の壊れ方なので、同じと畳まないほうが安全）。
 *
 * @param local - 手元の `_sync_meta.generation`（無ければ null）
 * @param nas - NAS 上の**その端末自身の写し**の `_sync_meta.generation`（写しが無ければ null）
 */
export function generationRelation(
  local: string | null,
  nas: string | null
): GenerationRelation {
  if (local === null && nas === null) return 'none'
  if (nas === null) return 'local-only'
  if (local === null) return 'nas-only'
  const a = Number(local)
  const b = Number(nas)
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return a < b ? 'local<nas' : a > b ? 'local>nas' : 'local=nas'
  }
  return local < nas ? 'local<nas' : local > nas ? 'local>nas' : 'local=nas'
}

/**
 * lamport（版の通し番号）を、**その状態に現れる最大値からの隔たり**へ畳む。
 *
 * 案A では、各端末が書き込みごとに `_sns_clock.lamport` を1つ進め、その値を版の `L` にする。
 * 取り込みは受け取った版の `L` の最大値まで引き上げる（設計書 §1.3）。ライブラリが `L` を
 * 読むのは**版どうしの大小**（同着の `ts` を破るため）だけなので、絶対値は要らない。
 *
 * 絶対値のまま持つと、同じ形の状態が「全部の番号が1つずつ大きい」だけで別物になる
 * （設計書 §8.2 の実測では状態が最大25倍）。そこで
 *
 * ```
 * 札(v) = 「最大値から v までの隔たり」（ただし cap で打ち切る）
 * ```
 *
 * とする。`cap` 以上離れた版は全部同じ札（`L-<cap>+`）になる。
 *
 * **打ち切ってよい理由と、その限界。** これ以降の遷移で作られる版の `L` は、いまの最大値より
 * 大きい。残りの遷移が `d` 回なら、新しく作られる版は高々 `d` 通りの順位しか持てないので、
 * 「いまの最大値より `d + 1` 以上古い版」どうしは、**これから作られるどの版との比較でも同じ側に
 * 落ちる**。残るのは古い版どうしの前後だが、それは同じ札にしない限り保たれる ——
 * つまり打ち切ってよいのは「これから来る版との比較を変えない」範囲までで、`cap` は
 * **残りの深さ + 1 以上**でなければならない。
 *
 * ただしこの議論は「1回の遷移が lamport を高々1つ進める」を前提にしている。設計書のトリガーは
 * 1つの文で `_sns_clock` を1回だけ進めるが、`ON DELETE CASCADE` で子のトリガーが続けて発火する
 * 形や、子の表の操作が親を用意する形では**1つの遷移で2つ以上進む**。呼び手は
 * {@link lamportCapForDepth} にその分の余裕を渡すこと（既定は表の組によらず安全側へ倒して
 * 「遷移1回あたり4つまで」を見込む）。
 *
 * @param values - その状態に現れる lamport の値（全端末・NAS の写しを込み）
 * @param cap - 打ち切る隔たり。1以上
 */
export function lamportLabels(
  values: Iterable<number>,
  cap: number
): Map<number, string> {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(
      `lamport の打ち切りは1以上の整数（受け取った値: ${String(cap)}）`
    )
  }
  const labels = new Map<number, string>()
  let max: number | null = null
  const seen: number[] = []
  for (const value of values) {
    seen.push(value)
    if (max === null || value > max) max = value
  }
  if (max === null) return labels
  for (const value of seen) {
    const distance = max - value
    labels.set(
      value,
      distance >= cap ? `L-${String(cap)}+` : `L-${String(distance)}`
    )
  }
  return labels
}

/**
 * 1回の遷移で lamport が進みうる数の上限（安全側の見込み）。
 *
 * 設計書のトリガーは文ごとに1つ進めるが、1つの遷移（＝アプリの1操作）が複数の文を
 * 走らせる形がある: 子の表の操作が親を `INSERT … DO NOTHING` で用意する（2文）、
 * `ON DELETE CASCADE` で親と子のトリガーが続けて発火する（親＋子の数）。
 * 範囲にある表の組はどれも親1・子1なので4で足りるが、**足りないと反例を見逃す**側の
 * 間違いなので、表を増やすときはここを見直すこと。
 */
export const LAMPORT_BUMPS_PER_TRANSITION = 4

/** 残りの遷移の数から、{@link lamportLabels} に渡す打ち切りを決める。 */
export function lamportCapForDepth(remainingDepth: number): number {
  return Math.max(1, remainingDepth * LAMPORT_BUMPS_PER_TRANSITION + 1)
}

/**
 * `instanceId`（端末ごとの128ビット乱数。設計書 §3.2）を記号へ畳む。
 *
 * 字面のまま状態へ入れると、実行ごとに違う値になって重複排除が全く効かない。
 * かといって「端末の番号」へ置き換えると、**字面の大小が振る舞いに効く**（同着の `ts` と `L` を
 * 破る最後の鍵が `instanceId` の BINARY 比較）ので、比較の向きを取り違える。
 *
 * そこで**その状態に現れる値を字面の順に並べた順位**を札にする。比較の向きは保たれ、
 * 実行ごとの字面の違いは消える。
 *
 * **限界**: 順位は実行時の乱数の引きで決まるので、1回の実行で調べられるのは
 * 「端末 a の iid が端末 b より小さい」か、その逆かの**片方だけ**である。両方を調べるには
 * `instanceId` を外から与える差し込み口が `src/` 側に要る（報告に書くこと）。
 * 端末の入れ替え（対称性の畳み込み）も、iid の順位が入れ替わらないので実質効かなくなる。
 */
export function instanceLabels(values: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(values)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return new Map(
    distinct.map((value, index) => [value, `iid#${String(index)}`])
  )
}

/**
 * この模組の単体テスト。**`__tests__/` には置けない**（vitest の対象は `__tests__/**` だけで、
 * 検査器は vitest を器にしない約束。tools/tsconfig.json の冒頭を参照）ので、
 * 検査器の起動時に必ず走らせ、`npm run explore -- --unit-tests` で単独でも走らせられるようにする。
 *
 * @returns 失敗の説明（空なら全部通った）
 */
export function runNormalizeUnitTests(): string[] {
  const failures: string[] = []
  const check = (name: string, actual: unknown, expected: unknown): void => {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) failures.push(`${name}: 期待 ${b} / 実際 ${a}`)
  }

  // generation: 新旧関係だけが残る
  check('generation 両方なし', generationRelation(null, null), 'none')
  check('generation 手元だけ', generationRelation('3', null), 'local-only')
  check('generation NASだけ', generationRelation(null, '3'), 'nas-only')
  check('generation 同じ', generationRelation('3', '3'), 'local=nas')
  check('generation 手元が古い', generationRelation('3', '4'), 'local<nas')
  check('generation 手元が新しい', generationRelation('4', '3'), 'local>nas')
  // 字面で比べると逆転する組（'10' < '9'）。数として比べること
  check('generation 桁が違う', generationRelation('10', '9'), 'local>nas')
  check(
    'generation 数として読めない',
    generationRelation('x', 'y'),
    'local<nas'
  )
  // 絶対値が違っても関係が同じなら同じ札
  check(
    'generation 絶対値によらない',
    generationRelation('1', '2') === generationRelation('100', '200'),
    true
  )

  // lamport: 最大値からの隔たり。cap 以上は1つに畳む
  check('lamport 空', [...lamportLabels([], 3)], [])
  check(
    'lamport 隔たり',
    [...lamportLabels([7, 6, 5], 3)],
    [
      [7, 'L-0'],
      [6, 'L-1'],
      [5, 'L-2'],
    ]
  )
  check(
    'lamport 打ち切り',
    [...lamportLabels([10, 7, 3], 3)],
    [
      [10, 'L-0'],
      [7, 'L-3+'],
      [3, 'L-3+'],
    ]
  )
  // 全体を平行移動しても同じ札（これが畳みたかった形）
  check(
    'lamport 平行移動で不変',
    JSON.stringify([...lamportLabels([7, 6, 4], 5)].map(([, l]) => l)) ===
      JSON.stringify([...lamportLabels([107, 106, 104], 5)].map(([, l]) => l)),
    true
  )
  // 前後は保つ（畳みすぎない）
  check(
    'lamport 前後を保つ',
    lamportLabels([9, 8], 5).get(9) !== lamportLabels([9, 8], 5).get(8),
    true
  )
  check('lamport 1つだけ', [...lamportLabels([42], 1)], [[42, 'L-0']])
  let threw = false
  try {
    lamportLabels([1], 0)
  } catch {
    threw = true
  }
  check('lamport 打ち切りは1以上', threw, true)
  check('lamport 打ち切りの見込み', lamportCapForDepth(3), 13)
  check('lamport 打ち切りの見込み（残り0）', lamportCapForDepth(0), 1)

  // instanceId: 字面の順を保った記号
  check(
    'iid 字面の順を保つ',
    [...instanceLabels(['b9', 'a1', 'c0'])],
    [
      ['a1', 'iid#0'],
      ['b9', 'iid#1'],
      ['c0', 'iid#2'],
    ]
  )
  check('iid 重複はまとめる', [...instanceLabels(['a', 'a', 'b'])].length, 2)
  check('iid 空', [...instanceLabels([])], [])

  return failures
}
