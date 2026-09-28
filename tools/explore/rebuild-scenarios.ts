/**
 * 判定20・21（設計書 `docs/rows-table-design.md` §8.1）を当てる筋書き。
 *
 * | # | 判定 | 当て方 |
 * | --- | --- | --- |
 * | 20 | 作り直しの計算は**1つの快照**から読む | `duringCompute` で計算と適用のあいだに書き込みを差し込み、その作り直しが**見送りになる**こと（古い計画を当てて、差し込んだ書き込みを消さないこと）を見る |
 * | 21 | `SQLITE_BUSY` の見送りと、k 回での合流経路 | `beginImmediate` を `SQLITE_BUSY` で失敗させ、見送りが k 回（既定3回）続いたら**合流経路**へ落ちること、落ちたら前へ進むことを見る |
 *
 * **探索の中では当てられない。** 検査器は端末ごとに接続を1本しか開かないので、
 * ロックの取り合いも「計算中の書き込み」も自然には起きない（設計書 §8.2）。
 * そこで、素の DB を1つ仕立てて筋書きを直に踏む。探索を始める前の
 * 単体テストの段で走らせる（tools/explore-convergence.ts）。
 *
 * **駆動するのは `libDir` のライブラリ**である（`src/` を import しない）。
 * 壊した版（tools/explore/mutants.ts）でもそのまま当たる。
 *
 * @module tools/explore/rebuild-scenarios
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { DDL, Library } from './world'

/** 筋書きで使う表（1つあれば足りる。外部キーは判定20・21 に効かない）。 */
const TABLE = 'users'

/** `SQLITE_BUSY` を名乗る例外（`src/rows/rebuild.ts` の `isBusy` が見るのは `code` だけ）。 */
function busyError(): Error {
  const error = new Error(
    'database is locked（検査器が beginImmediate を失敗させた）'
  )
  ;(error as Error & { code: string }).code = 'SQLITE_BUSY'
  return error
}

/**
 * 判定20・21 を当てる。
 *
 * @param lib 駆動するライブラリ
 * @returns 違反の説明（空なら全部通った）
 */
export function runRebuildScenarios(lib: Library): string[] {
  const api = lib.rebuild
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-explore-scenario-'))
  try {
    return [...judgment20(api, dir), ...judgment21(api, dir)]
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 案A の仕掛けを取り付けた、行が1つある DB を作る。 */
function freshDatabase(
  api: Library['rebuild'],
  dir: string,
  name: string
): Database.Database {
  const db = new Database(path.join(dir, `${name}.sqlite`))
  db.pragma('journal_mode = WAL')
  db.exec(DDL[TABLE])
  api.migrateToRows(db, {
    tables: [{ name: TABLE }],
    instanceId: 'iid-scenario',
  })
  db.prepare(
    `INSERT INTO "${TABLE}" (id, name, updatedAt) VALUES (?, ?, ?)`
  ).run('u1', 'first', '2026-01-01T00:00:00.000Z')
  return db
}

function nameOf(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT name FROM "${TABLE}" WHERE id = 'u1'`)
    .get() as { name: string } | undefined
  return row?.name ?? null
}

/**
 * 判定20: 計算と適用のあいだの書き込みを、古い計画で踏み潰さないこと。
 *
 * `rebuildOnce` は計算を済ませてから適用に入る。その窓で書き込みが起きると
 * `_sns_tick` が進むので、適用は token の不一致で**見送り**になる。見送らずに
 * 当てると、差し込んだ書き込みが黙って消える（アプリが書いた行が戻る）。
 */
function judgment20(api: Library['rebuild'], dir: string): string[] {
  const failures: string[] = []
  const db = freshDatabase(api, dir, 'judgment20')
  try {
    let committed = 0
    const outcome = api.rebuildOnce(db, {
      tables: [TABLE],
      state: api.createRebuildState(),
      hooks: {
        duringCompute: (inner): void => {
          inner
            .prepare(
              `UPDATE "${TABLE}" SET name = ?, updatedAt = ? WHERE id = 'u1'`
            )
            .run('second', '2026-02-01T00:00:00.000Z')
        },
        onRebuildCommitted: (): void => {
          committed += 1
        },
      },
    })
    if (outcome.status !== 'deferred') {
      failures.push(
        `判定20 違反: 計算のあとに書き込みを差し込んだのに ${outcome.status} になった（見送るはず）`
      )
    }
    if (committed !== 0) {
      failures.push(
        `判定20 違反: 見送るはずの作り直しが ${String(committed)} 回確定した`
      )
    }
    const after = nameOf(db)
    if (after !== 'second') {
      failures.push(
        `判定20 違反: 差し込んだ書き込みが古い計画に踏み潰された（いまの値: ${String(after)}）`
      )
    }
    // 差し込まなければ、同じ作り直しは通る（＝上の見送りが「いつでも見送る」ではない）
    const again = api.rebuildOnce(db, {
      tables: [TABLE],
      state: api.createRebuildState(),
    })
    if (again.status !== 'applied') {
      failures.push(
        `判定20 違反: 差し込まない作り直しまで ${again.status} になった（筋書きが効いていない）`
      )
    }
  } finally {
    db.close()
  }
  return failures
}

/**
 * 判定21: `SQLITE_BUSY` は見送りとして数えられ、k 回続いたら合流経路へ落ちること。
 *
 * 見送りが増えるだけで前へ進まない形（設計書 §3.7.4）を捕まえる。
 */
function judgment21(api: Library['rebuild'], dir: string): string[] {
  const failures: string[] = []
  const db = freshDatabase(api, dir, 'judgment21')
  try {
    const state = api.createRebuildState()
    const busy = {
      beginImmediate: (): void => {
        throw busyError()
      },
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = api.rebuildOnce(db, {
        tables: [TABLE],
        state,
        hooks: busy,
      })
      if (outcome.status !== 'deferred') {
        failures.push(
          `判定21 違反: ${String(attempt)} 回目の SQLITE_BUSY が ${outcome.status} になった（見送るはず）`
        )
      }
      if (outcome.skips !== attempt) {
        failures.push(
          `判定21 違反: ${String(attempt)} 回目の見送りで skips が ${String(outcome.skips)} だった`
        )
      }
      if (outcome.mode !== 'normal') {
        failures.push(
          `判定21 違反: ${String(attempt)} 回目で早くも ${outcome.mode} へ落ちた（k = 3 のはず）`
        )
      }
    }
    // 4回目は合流経路。ロックが取れれば前へ進む
    const merged = api.rebuildOnce(db, { tables: [TABLE], state })
    if (merged.mode !== 'merged') {
      failures.push(
        `判定21 違反: 見送りが3回続いたのに合流経路へ落ちない（mode: ${merged.mode}）`
      )
    }
    if (merged.status !== 'applied') {
      failures.push(
        `判定21 違反: 合流経路でも前へ進まない（status: ${merged.status}）`
      )
    }
    if (merged.skips !== 0) {
      failures.push(
        `判定21 違反: 確定したのに見送りの回数が ${String(merged.skips)} のまま`
      )
    }
  } finally {
    db.close()
  }
  return failures
}
