import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Fleet suites bind ports, spawn agents, and use tmpdirs; keep files isolated.
    fileParallelism: false,
  },
})
