#!/usr/bin/env node
/**
 * Host support gate.
 *
 * The harness evaluates the @deepseek-ai/dsh and @deepseek-ai/dsh-* peers of a plugin against
 * the running dsh version with prereleases admitted, and marks the plugin abnormal when a range
 * does not match. A caret on one candidate, ^0.2.1-rc.2, rejects the 0.2.1-rc.1 build the host
 * shipped a day earlier, so a single pinned version turns a working plugin into an incompatible
 * one the moment the host cuts a candidate.
 *
 * This gate keeps every consumer-facing host pin on one support window and every build-time
 * mirror on one exact baseline:
 *
 * - peerDependencies and self-provisioned dependencies carry the window verbatim;
 * - devDependencies carry the exact baseline this repository builds and tests against;
 * - client bundle externals are host-supplied, so they are dev-only and never a peer;
 * - every host package the source imports is declared in one of those sections;
 * - the next dist-tag still names a version inside the window, so a host line that moves past
 *   the ceiling fails here instead of shipping a range that refuses it.
 *
 * Usage: node scripts/check-host-support.mjs [--offline] [--json]
 * Exit codes: 0 aligned, 1 drift, 2 the gate itself could not run.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MANIFEST = join(ROOT, 'package.json')
const SOURCE = join(ROOT, 'src')

/** The oldest host release this plugin runs on. */
const FLOOR = '0.2.0-rc.2'
/** Exclusive ceiling: the next host major line, prereleases included. */
const CEILING = '0.3.0-0'
/** One string every consumer-facing host pin carries. */
const WINDOW = '>=' + FLOOR + ' <' + CEILING

const HOST_PREFIX = '@deepseek-ai/dsh-'
/** The framework package tracks its own 4.x line and is not a dsh release member. */
const FRAMEWORK = '@deepseek-ai/cordis'
/** The package whose next dist-tag names the family release line. */
const ANCHOR = '@deepseek-ai/dsh'
/** Host-supplied browser bundle externals: provided by the host app, never installed here. */
const CLIENT_PREFIX = '@deepseek-ai/dsh-client-'
/** Host services this plugin installs into its own profile instead of receiving from the deployment. */
const SELF_PROVISIONED = new Set([])

const argv = new Set(process.argv.slice(2))
const wantJson = argv.has('--json')
const offline = argv.has('--offline')

const isHost = name => name === FRAMEWORK || name.startsWith(HOST_PREFIX)
const isClient = name => name.startsWith(CLIENT_PREFIX)

/** Split a semantic version into its numeric core and prerelease identifiers. */
function parseVersion(value) {
  const withoutBuild = value.split('+')[0]
  const dash = withoutBuild.indexOf('-')
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const pre = dash === -1 ? [] : withoutBuild.slice(dash + 1).split('.')
  return { numbers: core.split('.').map(Number), pre }
}

/** Compare two semantic versions, prerelease ordering included. */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = Number(x)
    const ny = Number(y)
    const xNumeric = Number.isInteger(nx)
    const yNumeric = Number.isInteger(ny)
    if (xNumeric && yNumeric) return nx > ny ? 1 : -1
    if (xNumeric) return -1
    if (yNumeric) return 1
    return x > y ? 1 : -1
  }
  return 0
}

/** Whether one concrete version enters the support window. */
const inWindow = version => compareVersions(version, FLOOR) >= 0 && compareVersions(version, CEILING) < 0

/** Every host package name the source mentions, statically or in a lazy import. */
function scanImports(directory) {
  const found = new Map()
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path)
        continue
      }
      if (!/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) continue
      const text = readFileSync(path, 'utf8')
      // Only a real import specifier counts: a package named in prose is not a dependency.
      for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/gu)) {
        if (isHost(match[0]) && !found.has(match[0])) found.set(match[0], relative(ROOT, path))
      }
    }
  }
  walk(directory)
  return found
}

/** Resolve the anchor next version from the registry. */
async function resolveNext() {
  const url = 'https://registry.npmjs.org/' + ANCHOR.replace('/', '%2F')
  const response = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (!response.ok) throw new Error('registry answered ' + response.status + ' for ' + ANCHOR)
  const tags = (await response.json())['dist-tags']
  const version = tags?.next
  if (typeof version !== 'string') throw new Error(ANCHOR + ' has no next dist-tag')
  return version
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const peer = manifest.peerDependencies ?? {}
  const dev = manifest.devDependencies ?? {}
  const deps = manifest.dependencies ?? {}
  const imports = scanImports(SOURCE)
  const violations = []
  const names = new Set([...Object.keys(peer), ...Object.keys(dev), ...Object.keys(deps), ...imports.keys()].filter(isHost))
  // The build baseline is one exact version: the anchor dev mirror when this plugin declares
  // it, otherwise the first non-client host mirror.
  const baseline =
    dev[ANCHOR] ??
    Object.entries(dev)
      .filter(([name]) => isHost(name) && !isClient(name) && name !== FRAMEWORK)
      .map(([, version]) => version)[0] ??
    null

  for (const name of [...names].sort()) {
    if (isClient(name)) {
      if (peer[name] !== undefined || deps[name] !== undefined) {
        violations.push(name + ' is a host-supplied client external; declare it in devDependencies only')
        continue
      }
      if (dev[name] === undefined) violations.push(name + ' is imported but has no devDependency mirror')
      else if (baseline !== undefined && dev[name] !== baseline) violations.push('devDependencies[' + name + '] is ' + dev[name] + ', expected the baseline ' + baseline)
      continue
    }
    if (name === FRAMEWORK) {
      if (peer[name] === undefined) violations.push('peerDependencies[' + name + '] is missing')
      else if (!/^~4\.\d+\.\d+$/u.test(peer[name])) violations.push('peerDependencies[' + name + '] is ' + peer[name] + ', expected one ~4.x line')
      continue
    }
    const selfProvisioned = SELF_PROVISIONED.has(name)
    const windowed = selfProvisioned ? deps[name] : peer[name]
    const section = selfProvisioned ? 'dependencies' : 'peerDependencies'
    // A host package reached only from the test tree builds this repository own suites; it
    // never reaches production source, so the exact dev mirror is its whole contract.
    if (windowed === undefined && !imports.has(name) && dev[name] !== undefined) continue
    if (windowed === undefined) {
      violations.push(name + ', imported by ' + (imports.get(name) ?? 'the manifest') + ', has no ' + section + ' contract')
      continue
    }
    if (windowed !== WINDOW) violations.push(section + '[' + name + '] is ' + windowed + ', expected ' + WINDOW)
    if (selfProvisioned) continue
    if (dev[name] === undefined) violations.push('devDependencies[' + name + '] is missing its exact build mirror')
    else if (baseline !== undefined && dev[name] !== baseline) violations.push('devDependencies[' + name + '] is ' + dev[name] + ', expected the baseline ' + baseline)
  }

  let next = null
  if (!offline) {
    next = await resolveNext()
    if (!inWindow(next)) violations.push(ANCHOR + ' next is ' + next + ', outside the support window ' + WINDOW + '; move FLOOR and CEILING deliberately before releasing')
  }

  const report = { window: WINDOW, baseline, next, packages: [...names].sort(), violations }
  if (wantJson) console.log(JSON.stringify(report, null, 2))
  else {
    console.log('support window: ' + WINDOW)
    console.log('build baseline: ' + (baseline ?? '(none)') + (offline ? ' (offline: next not checked)' : ' | next: ' + next))
    console.log('host packages checked: ' + names.size)
    for (const violation of violations) console.log('  x ' + violation)
    if (violations.length === 0) console.log('  ok every host pin carries the window and one exact build baseline')
  }
  return violations.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (error) {
  if (wantJson) console.log(JSON.stringify({ error: String(error?.message ?? error) }, null, 2))
  else console.error('host support gate could not run: ' + (error?.message ?? error))
  process.exitCode = 2
}
