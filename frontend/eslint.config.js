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
      // Empty `catch {}` is an intentional best-effort pattern used throughout
      // (e.g. cleanup that mustn't throw). Allow it; every other empty block
      // still errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // React-Compiler-readiness rules shipped in eslint-plugin-react-hooks'
      // recommended set. They flag patterns that are correct at runtime but not
      // provably compiler-safe (setState in an effect, reading a ref during
      // render, calling Date.now() in render, using a value before its `const`
      // is initialised). MineDash does not use the React Compiler, so these are
      // advisory, not bugs — keep them visible as warnings instead of mechanically
      // rewriting working components. The load-bearing hooks rule (rules-of-hooks)
      // stays an error via the recommended config above.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
])
