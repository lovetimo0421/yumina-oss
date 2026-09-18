import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Feedback fence: only lib/feedback.tsx and the Toaster may import sonner.
// "error": the sweep is complete; any new sonner import outside the two allowed files fails lint.
// Spec: docs/superpowers/specs/2026-09-05-feedback-system-redesign-design.md
const SONNER_FENCE = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: 'sonner',
          message:
            'Use feedback.error/undo/progress/persistent from "@/lib/feedback", or inline state (see docs/superpowers/specs/2026-09-05-feedback-system-redesign-design.md §3).',
        },
      ],
    },
  ],
}

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
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: SONNER_FENCE,
  },
  {
    files: ['src/lib/feedback.tsx', 'src/components/ui/sonner.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
])
