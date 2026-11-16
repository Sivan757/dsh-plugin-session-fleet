import { defineConfig } from 'tsdown'

export default defineConfig({ entry: ['host.mjs'], outDir: '.build', format: 'esm', target: 'es2024', platform: 'node', clean: true })
