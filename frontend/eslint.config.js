import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The build uses the automatic JSX runtime (@vitejs/plugin-react), so
      // components that still `import React` never "use" it by ESLint's reckoning
      // — ~140 false positives that bury the genuine findings. Ignore the React
      // import specifically, plus the conventional `_` placeholder for an
      // intentionally-unused binding/arg. Every other unused variable still errors.
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^(React|_)$',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
])
