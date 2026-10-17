#!/usr/bin/env node
/** Point git at the tracked hooks directory, so the local gate runs without a manual config. */
import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
chmodSync('.githooks/pre-commit', 0o755)
console.log('git hooks installed: core.hooksPath=.githooks')
