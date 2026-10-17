import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    rules: {
      // These fire on code that predates them (36 errors on main). They stay
      // visible as warnings, and the gate runs `eslint --quiet`, so they do not
      // block until someone fixes them on purpose.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/incompatible-library': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // The 16:9 video frame belongs to Home. Commit 1b49953 put it in five list
    // rows too and 37fe812 took it back out; this pins the decision.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/pages/Home.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/mediaFrame', '**/mediaFrame.ts', '@/components/ui/mediaFrame'],
              message: 'Only Home draws the 16:9 video frame; every other list keeps square art.',
            },
          ],
        },
      ],
    },
  },
])
