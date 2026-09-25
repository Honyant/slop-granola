import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Playwright requires a destructuring pattern for the fixtures argument, even when unused.
    files: ['test/**/*.ts'],
    rules: { 'no-empty-pattern': 'off' },
  },
  {
    files: ['test/e2e/fake-helper.mjs'],
    languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setTimeout: 'readonly' } },
  },
)
