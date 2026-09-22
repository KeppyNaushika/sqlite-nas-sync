/**
 * 有界網羅検査の「範囲」と「削減手の入り切り」の定義。
 *
 * 検査器の値打ちは「**この範囲には反例が無い**」と言えることにある。
 * 範囲を暗黙にすると、乱数で10回通したのと同じ意味しか残らないので、
 * 範囲は1か所で型として持ち、出力にもそのまま印字する（{@link describeConfig}）。
 *
 * @module tools/explore/config
 */
import * as os from 'os'
import * as path from 'path'

/**
 * 表の組。**組ごとに**選ぶ（表を1つずつ選ばせると、子だけ選んで親が無い、
 * のような意味の無い組を作れてしまう）。
 */
export const TABLE_SETS = {
  /** UNIQUE が1本の親の表だけ（名前のかぶり＝畳みが起きる最小の形。挟み方の検査の最小の反例はここにある） */
  tags: ['tags'],
  /** 親と主キーを共有する1:1の子。親が畳まれると子の id そのものが動く（修理中の族） */
  'tags+tag_profiles': ['tags', 'tag_profiles'],
  /** 親を指す普通の子。親が畳まれると外部キーが付け替わる */
  'tags+tag_notes': ['tags', 'tag_notes'],
  /** UNIQUE の無い、単純な LWW */
  users: ['users'],
  /** セカンダリ UNIQUE が1本 */
  decisions: ['decisions'],
  /** セカンダリ UNIQUE が2本（1回の書き込みが索引ごとに別の相手へぶつかる） */
  accounts: ['accounts'],
  /**
   * **時刻列が INTEGER で、行の時刻が数値**（設計書 §1.2.3 の群1）。
   *
   * `_sns_ts` を型名の無い列ではなく TEXT 列にする壊し方（`--mutant sns-ts-as-text`）は、
   * 時刻列が TEXT の表しか無いと踏めない —— TEXT 親和性を付けても格納クラスが動かないからである。
   * 数値の時刻がこの表を通ると、版が端末をまたぐたびに群1 から群2 へ移る
   */
  epoch_notes: ['epoch_notes'],
  /**
   * **時刻列が `COLLATE NOCASE` で宣言され、行の時刻が大文字小文字だけ違う文字列**
   * （設計書 §1.2.3 の群2）。
   *
   * 比較の `COLLATE BINARY` を外す壊し方（`--mutant no-binary-collation`）は、
   * NOCASE の列と、畳むと同着になる値が無いと踏めない
   */
  nocase_notes: ['nocase_notes'],
} as const

export type TableSetName = keyof typeof TABLE_SETS
export type TableName = (typeof TABLE_SETS)[TableSetName][number]

/** 検査の範囲と実行の設定。既定値は {@link defaultConfig}。 */
export type ExploreConfig = {
  /** 端末の台数（2 または 3） */
  clients: number
  /** 表の組 */
  tableSet: TableSetName
  /** 主キーの種類の数（`g1`, `g2`, …） */
  ids: number
  /** セカンダリ UNIQUE キーの値の種類の数（`t1`, `t2`, …） */
  keys: number
  /** 本文（`memo` / `body` / 利用者名）の種類の数。同時刻で中身違いの行を作るのに使う */
  payloads: number
  /** 行の時刻（基準時刻からのミリ秒）。基準は過去（{@link BASE_TIME}） */
  times: number[]
  /**
   * **未来の**行の時刻（{@link FUTURE_BASE} からのミリ秒）。既定は空。
   *
   * 削除が刻む時刻（`_tombstone.deletedAt`・削除の版の `ts`）は実行時の現在時刻なので、
   * `--times` の値（2026-01-01）からは「削除より新しい書き込み」を作れない。案A では
   * 削除の版も行の版と同じ順序で比べるので、その形を範囲に入れられるようにする
   * （docs/rows-table-design.md §8.2「新しい操作」）
   */
  futureTimes: number[]
  /** 行の時刻の書式。0 = ISO-T、1 = 旧版のスペース形式 */
  formats: number[]
  /** 削除の操作を範囲に入れるか */
  deletes: boolean
  /**
   * **時刻列を変えない UPDATE** を範囲に入れるか（設計書 docs/rows-table-design.md §8.2
   * 「新しい操作」）。既定は入れない（1段の分岐が増える）
   */
  keepTimeUpdates: boolean
  /** **消してすぐ同じ id で作り直す**操作を範囲に入れるか（同上） */
  recreates: boolean
  /** `pruneChangelog`（相手をフルマージへ落とす）を範囲に入れるか */
  prune: boolean
  /**
   * 同期の最中（copyToNas の待ちの間）に書く遷移（ops.ts の syncWrite）をどちらの時点で入れるか。
   * `both` は写し始める前と写し終えた後の両方
   */
  syncWrite: 'both' | 'before' | 'after' | 'none'
  /** 挟み方の検査で「同じ操作」とみなす単位（history.ts） */
  scheduleKey: 'ops' | 'ops+status'
  /** 遷移の回数の上限 */
  depth: number
  /** 収束の検査で、何巡まで同期を回すか（超えたら振動として報告） */
  maxProbeRounds: number
  /** ワーカープロセスの数 */
  workers: number
  /** 重複排除（訪れた状態の集合） */
  dedup: boolean
  /** 順序の入れ替えを畳む（partial order reduction） */
  por: boolean
  /** 端末の入れ替えを畳む（2台のときだけ効く。理由は tools/explore/reduction.ts） */
  symmetry: boolean
  /** 収束の検査の結果を状態ごとに覚えて使い回す（削減手ではなく検査の高速化） */
  probeMemo: boolean
  /**
   * `_sync_meta.generation` を「手元と NAS の写しの新旧関係」へ畳む
   * （tools/explore/normalize.ts）。外すと絶対値のまま状態に入る（倍率の測定用）
   */
  normalizeGeneration: boolean
  /**
   * lamport（`_sns_clock.lamport` と版の `L`）を相対の番号へ畳む
   * （tools/explore/normalize.ts）。外すと絶対値のまま状態に入る（倍率の測定用）
   */
  normalizeLamport: boolean
  /**
   * 無駄な転送の抑制（`src/sync/idle.ts`）を入れたまま探索するか。
   *
   * **入れても状態空間は変わらない**（根拠は tools/explore/world.ts の
   * `idleMemoryFor`）が、抑制が落とすのは「やっても何も変わらない回」だという
   * その根拠そのものを検査に掛けたいので、既定で入れる。`generation` の正規化を
   * 外したときだけ自動で切る（抑制の有無で `sns.generation` の**絶対値**が
   * ずれるため）
   */
  suppressIdleSync: boolean
  /** 時計を進める遷移（`tick`）を入れるか。理由は tools/explore/world.ts の「時計」 */
  tick: boolean
  /**
   * 同じアプリ操作の列なら、同期の挟み方によらず見え方が1つに決まるかを検査する
   * （tools/explore/history.ts）。重複排除の単位に操作の列が加わるので、節は増える
   */
  scheduleCheck: boolean
  /** 見え方を突き合わせる参照実装の名前（tools/explore/history.ts の ORACLES）。null なら突き合わせない */
  oracle: string | null
  /** 反例を1つ見つけたら止めるか（false なら深さの上限まで全部数える） */
  stopAtFirst: boolean
  /** 駆動するライブラリ（コンパイル済み JS のディレクトリ） */
  libDir: string
  /** 既知の不具合を戻した版を駆動する場合、その名前（tools/explore/mutants.ts） */
  mutant: string | null
  /** 作業ディレクトリの置き場所（ワーカーごとにこの下へ専用の場所を作る） */
  workRoot: string
  /** 何秒ごとに進捗を出すか */
  progressSeconds: number
  /** 探索の前に、削減手の前提を何本の列で確かめるか（0 なら確かめない。tools/explore/self-test.ts） */
  selfTest: number
  /**
   * 作業ディレクトリのある場所の空きがこれを割ったら止める（MB）。探索は大量のDBを作っては
   * 捨てるので、消し損ねや別の作業との重なりで空きが尽きると、偽の I/O 失敗が反例に見える
   */
  minFreeMb: number
}

/** 既定の範囲。**数分で終わる**大きさにしてある（端末2・id 2・深さ3）。 */
export function defaultConfig(): ExploreConfig {
  return {
    clients: 2,
    tableSet: 'tags+tag_profiles',
    ids: 2,
    keys: 2,
    payloads: 1,
    times: [0, 1000],
    futureTimes: [],
    formats: [0],
    deletes: true,
    keepTimeUpdates: false,
    recreates: false,
    prune: true,
    syncWrite: 'both',
    scheduleKey: 'ops',
    depth: 3,
    maxProbeRounds: 8,
    workers: Math.max(1, os.availableParallelism()),
    dedup: true,
    por: true,
    symmetry: true,
    probeMemo: true,
    normalizeGeneration: true,
    normalizeLamport: true,
    suppressIdleSync: true,
    tick: true,
    scheduleCheck: true,
    oracle: null,
    stopAtFirst: true,
    // `npm run explore` が tools と一緒に src をここへコンパイルする
    // （tools/tsconfig.json の outDir と揃えること。ずれると古い版を黙って駆動する）
    libDir: path.resolve(__dirname, '..', '..', 'src'),
    mutant: null,
    workRoot: path.join(os.tmpdir(), 'sqlite-nas-sync-explore'),
    progressSeconds: 5,
    selfTest: 0,
    minFreeMb: 3072,
  }
}

/** 使い方の文言（`--help`）。 */
export function usage(): string {
  return [
    '有界網羅検査器 — 範囲を有限に区切り、その中を乱数なしで漏れなく試す',
    '',
    '  npm run explore -- [引数]',
    '',
    '範囲:',
    '  --clients N         端末の台数 2|3（既定 2）',
    `  --tables NAME       表の組（既定 tags+tag_profiles）: ${Object.keys(TABLE_SETS).join(' | ')}`,
    '  --ids N             主キーの種類の数（既定 2）',
    '  --keys N            UNIQUE キーの値の種類の数（既定 2）',
    '  --payloads N        本文の種類の数（既定 1）',
    '  --times a,b         行の時刻。基準（2026-01-01）からのミリ秒（既定 0,1000）。',
    '                      epoch_notes / nocase_notes では個数だけを採る（値は表ごとに決まっている）',
    '  --future-times a,b  未来の行の時刻。2099-01-01 からのミリ秒（既定 なし）。',
    '                      削除が刻む現在時刻より後なので、「削除より新しい書き込み」を作れる',
    '  --formats 0,1       行の時刻の書式。0=ISO-T 1=スペース形式（既定 0。混在は 0,1）',
    '  --depth N           遷移の回数の上限（既定 3）',
    '  --max-probe-rounds N  収束の検査で回す巡数の上限（既定 8）',
    '  --no-tick           時計を進める遷移を入れない（同期の間の操作が全部同じ瞬間になる）',
    '  --no-delete         削除の操作を範囲に入れない',
    '  --keep-time-updates 時刻列を変えない UPDATE を範囲に入れる（案A の新しい操作）',
    '  --recreate          消してすぐ同じ id で作り直す操作を範囲に入れる（案A の新しい操作）',
    '  --no-prune          pruneChangelog（相手をフルマージへ落とす）を範囲に入れない',
    '  --sync-write WHEN   同期の最中（copyToNas の待ちの間）に書く遷移: both|before|after|none（既定 both）',
    '',
    '実行:',
    '  --workers N         ワーカーの数（既定 os.availableParallelism()）',
    '  --all               反例が出ても止めず、深さの上限まで数える',
    '  --mutant NAME       既知の不具合を戻した版を駆動する（--list-mutants で一覧）',
    '  --list-mutants      戻せる既知の不具合を一覧する',
    '  --unit-tests        正規化の関数の単体テストだけ走らせて終わる（探索の起動時にも必ず走る）',
    '  --lib DIR           駆動するライブラリ（コンパイル済み JS）を差し替える',
    '  --work-root DIR     作業ディレクトリの置き場所',
    '  --progress SEC      進捗を出す間隔（既定 5）',
    '  --min-free-mb N     作業ディレクトリの場所の空きがこれを割ったら止める（既定 3072）',
    '  --self-test N       探索の前に、削減手の前提（別々の端末への操作の可換性・端末の対称性）を',
    '                      範囲の中の列 N 本で実際に確かめる。崩れていたら探索しない',
    '',
    '削減手の入り切り（効果の測定と、削減手が反例を消していないことの確認に使う）:',
    '  --no-dedup          重複排除を外す（木として全部たどる。対称性も外れる）',
    '  --no-por            順序の入れ替えを畳まない',
    '  --no-symmetry       端末の入れ替えを畳まない',
    '  --no-probe-memo     収束の検査の結果を使い回さない',
    '  --raw-generation    _sync_meta.generation を絶対値のまま状態に含める（案A の倍率の測定用）',
    '  --no-suppress-idle  変わっていないときの転送の抑制（src/sync/idle.ts）を切って駆動する',
    '  --raw-lamport       lamport を絶対値のまま状態に含める（案A の倍率の測定用）',
    '',
    '検査の入り切り:',
    '  --no-schedule-check 「同じアプリ操作の列なら同期の挟み方によらず見え方が1つ」を検査しない',
    '                      （「全端末の一致」の検査は常に行う）',
    '  --schedule-key K    挟み方の検査で「同じ操作」とみなす単位: ops|ops+status（既定 ops。history.ts）',
    '  --oracle NAME       見え方を参照実装と突き合わせる（登録は tools/explore/history.ts）',
    '',
  ].join('\n')
}

/**
 * 引数を読む。
 *
 * **知らない引数は例外にする。** 綴りを間違えた `--dpeth 6` を黙って無視すると、
 * 既定の深さで「反例なし」と出て、広い範囲を調べた気になる。
 */
export function parseArgs(
  argv: string[]
): ExploreConfig | 'help' | 'list-mutants' | 'unit-tests' {
  const config = defaultConfig()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${flag} に値が要る`)
      index += 1
      return value
    }
    const nextInt = (min: number): number => {
      const raw = next()
      const value = Number(raw)
      if (!Number.isInteger(value) || value < min) {
        throw new Error(
          `${flag} は ${String(min)} 以上の整数（受け取った値: ${raw}）`
        )
      }
      return value
    }
    const nextList = (): number[] =>
      next()
        .split(',')
        .filter((part) => part !== '')
        .map((part) => {
          const value = Number(part)
          if (!Number.isFinite(value)) {
            throw new Error(`${flag} には数の並びを渡すこと（${part}）`)
          }
          return value
        })

    switch (flag) {
      case '--help':
      case '-h':
        return 'help'
      case '--list-mutants':
        return 'list-mutants'
      case '--unit-tests':
        return 'unit-tests'
      case '--clients':
        config.clients = nextInt(2)
        break
      case '--tables': {
        const name = next()
        if (!(name in TABLE_SETS)) {
          throw new Error(
            `知らない表の組: ${name}（使えるのは ${Object.keys(TABLE_SETS).join(', ')}）`
          )
        }
        config.tableSet = name as TableSetName
        break
      }
      case '--ids':
        config.ids = nextInt(1)
        break
      case '--keys':
        config.keys = nextInt(1)
        break
      case '--payloads':
        config.payloads = nextInt(1)
        break
      case '--times':
        config.times = nextList()
        break
      case '--future-times':
        config.futureTimes = nextList()
        break
      case '--formats':
        config.formats = nextList()
        break
      case '--depth':
        config.depth = nextInt(0)
        break
      case '--max-probe-rounds':
        config.maxProbeRounds = nextInt(1)
        break
      case '--workers':
        config.workers = nextInt(1)
        break
      case '--all':
        config.stopAtFirst = false
        break
      case '--mutant':
        config.mutant = next()
        break
      case '--lib':
        config.libDir = path.resolve(next())
        break
      case '--work-root':
        config.workRoot = path.resolve(next())
        break
      case '--progress':
        config.progressSeconds = nextInt(1)
        break
      case '--self-test':
        config.selfTest = nextInt(0)
        break
      case '--min-free-mb':
        config.minFreeMb = nextInt(1)
        break
      case '--no-dedup':
        config.dedup = false
        break
      case '--no-por':
        config.por = false
        break
      case '--no-symmetry':
        config.symmetry = false
        break
      case '--no-probe-memo':
        config.probeMemo = false
        break
      case '--raw-generation':
        config.normalizeGeneration = false
        break
      case '--no-suppress-idle':
        config.suppressIdleSync = false
        break
      case '--raw-lamport':
        config.normalizeLamport = false
        break
      case '--no-tick':
        config.tick = false
        break
      case '--no-delete':
        config.deletes = false
        break
      case '--keep-time-updates':
        config.keepTimeUpdates = true
        break
      case '--recreate':
        config.recreates = true
        break
      case '--no-prune':
        config.prune = false
        break
      case '--sync-write': {
        const value = next()
        if (!['both', 'before', 'after', 'none'].includes(value)) {
          throw new Error(
            `--sync-write は both|before|after|none（受け取った値: ${value}）`
          )
        }
        config.syncWrite = value as ExploreConfig['syncWrite']
        break
      }
      case '--schedule-key': {
        const value = next()
        if (value !== 'ops' && value !== 'ops+status') {
          throw new Error(
            `--schedule-key は ops|ops+status（受け取った値: ${value}）`
          )
        }
        config.scheduleKey = value
        break
      }
      case '--no-schedule-check':
        config.scheduleCheck = false
        break
      case '--oracle':
        config.oracle = next()
        break
      default:
        throw new Error(`知らない引数: ${flag}（--help を参照）`)
    }
  }
  if (config.clients > 3) {
    // 3台を超えると NAS 上の並び（readdir の順）が取り込み順に効く組が増え、
    // 1段の分岐も手に負えなくなる。広げるなら状態の定義から見直すこと
    throw new Error('--clients は 2 か 3')
  }
  for (const style of config.formats) {
    if (style !== 0 && style !== 1) throw new Error('--formats は 0 と 1 だけ')
  }
  if (
    config.times.length + config.futureTimes.length === 0 ||
    config.formats.length === 0
  ) {
    throw new Error(
      '行の時刻（--times か --future-times）と --formats は1つ以上'
    )
  }
  // 重複排除を外すと、対称性で畳むものが無い（対称性は「同じと見なす」重複排除そのもの）
  if (!config.dedup) config.symmetry = false
  return config
}

/**
 * 対称性の畳み込みが実際に効くか。
 *
 * **案A では常に効かない。** 端末の入れ替えが対称なのは「端末名の大小が振る舞いに効かない」
 * ときだけだが、案A は同着の最後の鍵が `instanceId` のバイト列の比較（設計書 §1.2.5）で、
 * 検査器は端末ごとに `iid-client-a` / `iid-client-b` を固定して与える（world.ts の `instanceIdFor`）。
 * すると「自分の iid が相手より小さい端末が書いた」状態と「大きい端末が書いた」状態は、
 * 入れ替えても同じにならない ——**後の同着の決着が逆になる**。`--self-test` はこれを
 * 実際に検出する（素の `src/` で、1回の書き込みだけの列でも鏡写しにならない）。
 *
 * 正準化は「入れ替えの候補の中で直列化がいちばん小さいもの」を鍵にするので、鏡写しでない
 * 状態どうしが畳まれることは無い（＝いまも健全）。ただし畳めるものが無いので、**効かないことを
 * 明示して外す**。逆向き（b の iid が小さい側）を調べるには `instanceIdFor` を逆順にして
 * 走らせ直すこと。
 *
 * 3台でも効かせない（理由は reduction.ts）。
 */
const SYMMETRY_IS_SOUND = false

export function symmetryActive(config: ExploreConfig): boolean {
  return (
    SYMMETRY_IS_SOUND && config.symmetry && config.dedup && config.clients === 2
  )
}

/** 人が読める範囲の要約。**反例なしの報告には必ずこれを添える。** */
export function describeConfig(config: ExploreConfig): string {
  return [
    `端末 ${String(config.clients)}台`,
    `表 ${config.tableSet}`,
    `id ${String(config.ids)}種`,
    `UNIQUEキー ${String(config.keys)}種`,
    `本文 ${String(config.payloads)}種`,
    `時刻 ${config.times.length === 0 ? 'なし' : `+${config.times.join(',+')}ms`}`,
    ...(config.futureTimes.length === 0
      ? []
      : [`未来の時刻 2099-01-01+${config.futureTimes.join(',+')}ms`]),
    `書式 ${config.formats.map((style) => (style === 0 ? 'ISO-T' : 'スペース')).join('+')}`,
    `深さ ${String(config.depth)}`,
    `削除 ${config.deletes ? 'あり' : 'なし'}`,
    `時刻を変えない UPDATE ${config.keepTimeUpdates ? 'あり' : 'なし'}`,
    `消して作り直す ${config.recreates ? 'あり' : 'なし'}`,
    `pruneChangelog ${config.prune ? 'あり' : 'なし'}`,
    `同期の最中の書き込み ${config.syncWrite}`,
    `時計の遷移 ${config.tick ? 'あり' : 'なし'}`,
    `収束検査 最大${String(config.maxProbeRounds)}巡×全ての開始端末`,
    `挟み方の検査 ${config.scheduleCheck ? `あり（単位 ${config.scheduleKey}）` : 'なし'}`,
    ...(config.oracle === null ? [] : [`参照実装 ${config.oracle}`]),
    `駆動する版 ${config.mutant === null ? 'src（現在の作業ツリー）' : `mutant:${config.mutant}`}`,
  ].join(' / ')
}

/**
 * この設定で、無駄な転送の抑制（`src/sync/idle.ts`）を入れて駆動するか。
 *
 * `generation` を絶対値のまま状態に入れる設定では**切る**。抑制は上げる回数を
 * 変えるので、`sns.generation` の絶対値は抑制の有無でずれる ——
 * 正規化していれば「手元と NAS の新旧関係」しか残らないので影響しないが、
 * 生のままだと、同じ振る舞いの2状態を別物と見て探索が無駄に広がる。
 */
export function idleSuppressionActive(config: ExploreConfig): boolean {
  return config.suppressIdleSync && config.normalizeGeneration
}

/** 削減手の入り切りの要約。 */
export function describeReductions(config: ExploreConfig): string {
  const onOff = (value: boolean): string => (value ? 'ON' : 'OFF')
  return [
    `重複排除 ${onOff(config.dedup)}`,
    `順序の畳み込み ${onOff(config.por)}`,
    `対称性 ${symmetryActive(config) ? 'ON' : 'OFF（案A では端末の入れ替えは対称でない。iid が同着の鍵）'}`,
    `検査結果の使い回し ${onOff(config.probeMemo)}`,
    `generation の正規化 ${onOff(config.normalizeGeneration)}`,
    `lamport の正規化 ${onOff(config.normalizeLamport)}`,
    `無駄な転送の抑制 ${onOff(idleSuppressionActive(config))}`,
  ].join(' / ')
}
