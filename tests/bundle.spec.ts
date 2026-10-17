/** The installed package must declare one parseable Session Fleet bundle layer. */

import { existsSync, readFileSync } from 'node:fs'
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

  it('ships every file its manifest promises', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      main?: string
      types?: string
      files?: string[]
    }
    // The bundler cleans lib before writing, so a build that emits declarations first loses them.
    expect(existsSync(resolve(root, manifest.main!)), manifest.main).toBe(true)
    expect(existsSync(resolve(root, manifest.types!)), manifest.types).toBe(true)
  })
})
