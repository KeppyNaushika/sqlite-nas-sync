/**
 * ワーカーの入口を、Node がそのまま読める JS に組み上げる。
 *
 * `vitest` の変換は別スレッドには効かないので、ワーカーを起動する試験はその場で組み上げる。
 * 組み上げ先は `node_modules/.cache/` の下に置く。ワーカーが `better-sqlite3` を `require` するので、`node_modules` をたどれる場所でなければならない。
 *
 * `tsc` は `npx` を通さず、Node から直接起動する。Windows の `npx` は `npx.cmd` なので、`execFileSync('npx', …)` は `ENOENT` になる。
 *
 * @returns 組み上げた先のディレクトリ。`worker.js`（ワーカーの入口）と `worker-host.js` が入る。後片付けで消すのも呼んだ側
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export function buildWorker(name: string): string {
  const build = join(process.cwd(), 'node_modules', '.cache', name)
  execFileSync(
    process.execPath,
    [
      join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
      '--ignoreConfig',
      'src/worker.ts',
      'src/worker-host.ts',
      '--outDir',
      build,
      '--module',
      'node16',
      '--moduleResolution',
      'node16',
      '--target',
      'ES2020',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: process.cwd(), stdio: 'pipe' }
  )
  return build
}
