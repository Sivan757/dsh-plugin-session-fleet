import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Fleet suites spawn agents and use tmpdirs; keep files isolated.
    // evals/*.test.mjs are node:test files run by pnpm run test:evals.
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**', 'evals/**']
  }
})
