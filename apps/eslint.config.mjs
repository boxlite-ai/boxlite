import nx from '@nx/eslint-plugin'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // Workspace-wide ignores. Patterns are relative to this config (apps/).
    // Adapted from upstream daytonaio/daytona (root-level config) for the
    // BoxLite layout where lint scripts run with cwd=apps/ instead of root.
    ignores: [
      '**/dist',
      '**/node_modules/**',
      '**/.nx/**',
      '**/.sst/**',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
      'docs/**',
      'libs/*api-client*/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?js$'],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'],
    // Override or add rules here. Rules disabled below cover pre-existing
    // patterns in the BoxLite apps workspace (e.g. SST-generated config in
    // apps/infra/sst.config.ts uses triple-slash refs + $-escapes; empty
    // arrow/method stubs in test fixtures; `let`s never reassigned in
    // existing code) that the lint pipeline is not in scope to refactor.
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-useless-escape': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
    },
  },
  {
    // Match migration files in any subproject (e.g. apps/api/src/migrations/...).
    files: ['**/src/migrations/**/*.ts'],
    rules: {
      quotes: 'off',
    },
  },
  {
    // The SDK runtime-test fixtures intentionally import from the packed
    // published package instead of the workspace source -- that's the whole
    // point of the tests. Disable the enforce-module-boundaries auto-fix
    // that rewrites those imports to relative source paths.
    files: ['libs/sdk-typescript/runtime-tests/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
]
