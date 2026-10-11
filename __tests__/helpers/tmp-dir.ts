/**
 * `os.tmpdir()` の行き先を、試験の中のディレクトリへ差し替える。
 *
 * `os.tmpdir()` は呼ぶたびに環境変数を見る。macOS と Linux は `TMPDIR`、Windows は `TEMP` と `TMP` を見るので、3つとも差し替える。
 * `TMPDIR` だけを差し替えると、Windows では並行して走る他の試験と同じ一時フォルダを使い、互いの一時コピーが見える。
 *
 * @returns 元に戻す関数
 */
const NAMES = ['TMPDIR', 'TEMP', 'TMP'] as const

export function isolateTmpDir(dir: string): () => void {
  const saved = NAMES.map((name) => [name, process.env[name]] as const)
  for (const name of NAMES) process.env[name] = dir
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
