import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { SessionSearchIndex } from '../src/search-index.ts'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
function fixture(): { root: string; indexPath: string } {
  const base = mkdtempSync(join(tmpdir(), 'fleet-index-'))
  roots.push(base)
  const root = join(base, 'sessions')
  mkdirSync(join(root, 'slug', 's1'), { recursive: true })
  mkdirSync(join(root, 'slug', 's2'), { recursive: true })
  return { root, indexPath: join(base, 'index.sqlite') }
}

function writeLog(root: string, id: string, events: string[]): void {
  const lines = [JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp' }), ...events].join('\n') + '\n'
  writeFileSync(join(root, 'slug', id, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
}

function message(seq: number, text: string): string {
  return JSON.stringify({ type: 'user/message', seq, time: 2, data: { content: [{ type: 'text', text }] } })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SessionSearchIndex', () => {
  it('indexes sessions, finds matches, and picks up appended events incrementally', () => {
    const { root, indexPath } = fixture()
    writeLog(root, 's1', [message(1, 'needle alpha')])
    writeLog(root, 's2', [message(1, 'unrelated beta')])
    const index = new SessionSearchIndex(indexPath, root)
    expect(index.sync({ maxSessions: 10, budgetMs: 1000 })).toMatchObject({ indexed: 2, removed: 0, pending: 0 })
    expect(index.search('needle').hits.map(hit => hit.sessionId)).toEqual(['s1'])
    const second = index.sync({ maxSessions: 10, budgetMs: 1000 })
    expect(second.indexed).toBe(0)
    writeLog(root, 's1', [message(1, 'needle alpha'), message(2, 'needle gamma')])
    expect(index.sync({ maxSessions: 10, budgetMs: 1000 }).indexed).toBe(1)
    expect(index.search('gamma').hits.map(hit => hit.sessionId)).toEqual(['s1'])
    expect(index.search('gamma').totalMatches).toBe(1)
  })

  it('drops documents for removed session logs', () => {
    const { root, indexPath } = fixture()
    writeLog(root, 's1', [message(1, 'removable word')])
    const index = new SessionSearchIndex(indexPath, root)
    expect(index.sync({ maxSessions: 10, budgetMs: 1000 }).indexed).toBe(1)
    rmSync(join(root, 'slug', 's1'), { recursive: true, force: true })
    expect(index.sync({ maxSessions: 10, budgetMs: 1000 })).toMatchObject({ indexed: 0, removed: 1 })
    expect(index.search('removable').hits).toEqual([])
  })
})
