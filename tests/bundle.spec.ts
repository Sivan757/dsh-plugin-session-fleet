/** The installed package must declare one parseable Session Fleet bundle layer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'

describe('Session Fleet bundle declaration', () => {
  it('declares a parseable patch inserting the fleet row', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.name).toBe('dsh-plugin-session-fleet')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

    const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8')) as {
      insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
    }[]
    const inserted = (Array.isArray(parsed) ? parsed : []).flatMap(patch => patch.insert ?? [])
    expect(inserted.find(entry => entry.id === 'tool-session-fleet')).toMatchObject({
      name: 'dsh-plugin-session-fleet',
      config: { allowCrossWorkspace: false, maxListRows: 50, maxMessageChars: 20000, includeSubagents: false }
    })
  })

  it('declares a build that bundles before it emits declarations', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      main?: string
      types?: string
      scripts?: Record<string, string>
    }
    // The bundler cleans lib before it writes, so emitting declarations first loses them.
    const build = manifest.scripts?.build ?? ''
    expect(build.indexOf('tsdown')).toBeGreaterThanOrEqual(0)
    expect(build.indexOf('tsdown')).toBeLessThan(build.indexOf('build:types'))
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.types).toBe('lib/types/index.d.ts')
  })
})
