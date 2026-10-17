import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Fleet suites spawn agents and use tmpdirs; keep files isolated.
    fileParallelism: false
  }
})
