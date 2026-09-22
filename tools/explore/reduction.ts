/**
 * 状態を減らす手のうち、**順序の入れ替え**と**対称性**の判定。
 *
 * どちらも「同じ振る舞いをするものを1回だけ調べる」手で、誤ると反例を見逃す。
 * 判定の根拠をここに全部書いておく。重複排除そのもの（訪れた状態の集合）は
 * 親プロセス（tools/explore-convergence.ts）が持つ。
 *
 * ## 順序の入れ替え（partial order reduction）
 *
 * ### どの遷移どうしが可換か
 *
 * | 遷移 x | 遷移 y | 可換か | 理由 |
 * | --- | --- | --- | --- |
 * | 端末 i への操作 | 端末 j への操作（i ≠ j） | **可換** | 操作が書くのは自分のローカルDBだけ。刻む時刻は時計 C で、操作は C を動かさない（world.ts の「時計」）。`pruneChangelog` は相手の `_sync_state` を読むが、操作は `_sync_state` を書かない |
 * | 端末 i への操作 | 端末 i への操作 | 非可換 | changelog の id の並びが変わる |
 * | 何か | 端末 j の同期 | 非可換 | 同期は NAS 上の相手のコピーを読み、自分のコピーと `_sync_state` を書き、時計を進める。`pruneChangelog` は相手の `_sync_state` を読むし、操作が名乗る時刻も同期の前後で変わる |
 * | 何か | `tick` | 非可換 | 時計を進めるので、後の操作が名乗る時刻が変わる |
 *
 * ### どう畳むか
 *
 * 同期と `tick` に挟まれた「操作だけの連なり」の中では、端末の違う操作を自由に
 * 並べ替えられる（同じ端末の操作どうしの前後は保つ）。そこで連なりの中は
 * **端末の順に並んだものだけ**を展開する。各ノードに「次に操作してよい端末の集合」
 * （{@link PorMask}）を持たせ、端末 j へ操作したら、以後その連なりでは
 * 順序 Z で j より前の端末へは操作しない。同期か `tick` で集合は全員に戻る。
 *
 * ### 重複排除と組み合わせても見逃さない理由
 *
 * 「状態が同じなら展開は1回」とだけすると、先に来たノードの集合が狭いときに
 * 後から来た広い集合の枝を失う。そこで**重複排除の単位は (状態, 集合)** とし、
 * 既に訪れたノードの集合が新しい集合を**包む**ときだけ畳む（{@link dominates}）。
 *
 * 証明の骨子（深さについての帰納法）: ノード (s, A) を深さ i で展開したとき、
 * 「操作だけの頭の部分が A の端末だけでできている」任意の列 w について、s·w は深さ
 * i+|w| 以内に訪れられる。頭の操作のうち順序 Z で最小の端末 j のもの t を先に出しても
 * 結果は同じ（上の表）で、t の後の集合 {x ∈ A : x ≧Z j} は残りの頭を包む。
 * 子を包むノードが先に訪れられていれば、そちらで帰納法の仮定を使う。
 * **順序 Z はノードごとに違ってよい**（証明は各ノードの Z しか使わない）ので、
 * 対称性で畳んだ正準な並びに合わせて Z を選んでも崩れない。
 *
 * 挟み方の検査（tools/explore/history.ts）では、ノードの状態に「端末ごとの、発行した操作の列」が
 * 加わる。別々の端末への操作を入れ替えても、端末ごとの列はどれも変わらない（端末 i の列に端末 j の
 * 操作は入らない）ので、上の表の「可換」はそのまま成り立ち、証明も同じ形で通る。全体の並び
 * （どの端末の操作が先か）を列に入れると、入れ替えで列が変わって可換でなくなるので、入れないこと。
 * 同期の最中の書き込み（ops.ts の syncWrite）は同期なので、何とも入れ替えない。
 *
 * ## 対称性
 *
 * ### 畳むもの: 端末の入れ替え（**2台のときだけ**）
 *
 * 端末名が振る舞いに効くのは NAS 上のファイル名、`_sync_state` の鍵、
 * `listRemoteClients` が返す相手の並び（`readdirSync` の順＝取り込む順）だけで、
 * 端末名の大小を比べる箇所は無い（`grep clientId src/` で確認）。2台では相手が1人しか
 * 居ないので並びは効かない。操作の集合も端末について対称。収束の検査は
 * **全ての開始端末から** round-robin を回すので、検査も入れ替えについて対称になる
 * （開始端末を固定すると、入れ替えた側の状態だけ別の順で検査することになり、
 * 畳むと検査が弱くなる）。
 *
 * ### 畳まないもの
 *
 * - **3台での端末の入れ替え**: 相手が2人になり、取り込む順が `readdirSync` の順
 *   （ファイル名の順）で決まる。a⇔b を入れ替えると c から見た取り込み順が逆になるので、
 *   振る舞いを保たない。
 * - **id の入れ替え（g1⇔g2）**: 同着の決着が「主キーの辞書順で小さい方」
 *   （`isPreferredOverRival`、`conflict/ledger.ts`）なので、入れ替えると決着が逆を向く。
 * - **UNIQUE キーの値の入れ替え（t1⇔t2）**: 値の大小を直接比べる箇所は見当たらないが、
 *   (1) 子の表の操作は「g1 の親の名前は t1」と id から名前を決めているので、
 *   操作の集合が入れ替えについて閉じていない（入れ替えた先の操作が範囲に無い）。
 *   (2) SQLite は UNIQUE 索引を覆う問い合わせを索引の順（＝値の順）に返しうるので、
 *   `src/` の全ての問い合わせの実行計画を確かめないと対称とは言い切れない。
 *   確信が持てないので畳まない。
 * - **時刻の書式の入れ替え（ISO-T⇔スペース形式）、時刻の値の入れ替え**: 字面の比較
 *   （`a === b`）や大小が振る舞いに効くので対称ではない。
 *
 * @module tools/explore/reduction
 */

/** 次に操作してよい端末の集合（ビット j = 端末 j）。 */
export type PorMask = number

export function fullMask(clients: number): PorMask {
  return (1 << clients) - 1
}

/**
 * 端末の入れ替えの候補（恒等を含む）。`permutation[元の添字] = 新しい添字`。
 */
export function symmetryGroup(clients: number, active: boolean): number[][] {
  const identity = Array.from({ length: clients }, (_, index) => index)
  if (!active || clients !== 2) return [identity]
  return [identity, [1, 0]]
}

/**
 * ノードの順序 Z（端末の添字を優先順に並べたもの）を、正準な並びから決める。
 *
 * 正準な並びで端末 0, 1, … になる順に並べる。自己対称な状態では候補の最初を使う
 * （Z はノードごとに自由に選んでよい。モジュール冒頭の証明の骨子）。
 */
export function porOrder(permutation: number[]): number[] {
  return permutation
    .map((to, from) => ({ to, from }))
    .sort((a, b) => a.to - b.to)
    .map((entry) => entry.from)
}

/** 端末 `client` へ操作したあとの集合。 */
export function maskAfterOp(
  mask: PorMask,
  order: number[],
  client: number
): PorMask {
  const rank = order.indexOf(client)
  let next = 0
  order.forEach((candidate, index) => {
    if (index >= rank && (mask & (1 << candidate)) !== 0) next |= 1 << candidate
  })
  return next
}

/** 集合を入れ替えた並びへ写す。 */
export function permuteMask(mask: PorMask, permutation: number[]): PorMask {
  let mapped = 0
  permutation.forEach((to, from) => {
    if ((mask & (1 << from)) !== 0) mapped |= 1 << to
  })
  return mapped
}

/**
 * 正準な並びでの集合（重複排除の鍵に使う）。自己対称な状態では、候補の並びの中で
 * 数として最大のものを採る（広い側に寄せるほど、あとで包まれて畳まれやすい。
 * どれを採っても同じ軌道の同じ集合なので健全さは変わらない）。
 */
export function canonicalMask(
  mask: PorMask,
  permutations: number[][]
): PorMask {
  let best = -1
  for (const permutation of permutations) {
    best = Math.max(best, permuteMask(mask, permutation))
  }
  return best
}

/** 既に訪れた集合 `seen` が、新しい集合 `mask` を包むか。 */
export function dominates(seen: PorMask, mask: PorMask): boolean {
  return (seen & mask) === mask
}
