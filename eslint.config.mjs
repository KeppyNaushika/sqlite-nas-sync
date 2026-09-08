// @ts-check
/**
 * ESLint の設定。
 *
 * 型情報を使う規則（`no-unsafe-*` など）は入れていない。このライブラリは
 * `SELECT *` の結果を `Record<string, unknown>` として扱うのが仕事なので、
 * その手の規則は**正しいコードに大量の警告を出す**だけになる。
 * 型の整合は `tsc --noEmit`（`npm run typecheck`）が見る。
 *
 * 整形は Prettier に任せ、ESLint は**間違いだけ**を見る（`eslint-config-prettier`
 * で整形系の規則を落としてある）。
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['dist/**', 'docs/api/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // 利用者のコンソールを勝手に汚さない。出すときは意図を明示して黙らせる
      // （既存の 2 箇所は「検出結果の通知」で、意図的に残してある）
      'no-console': 'error',
      // 使い切っていない引数は `_` 始まりで明示する（`.map((_, index) => …)` など）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // テストは「壊れ方」を作るために型を意図的に外すことがある
    files: ['__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  }
)
