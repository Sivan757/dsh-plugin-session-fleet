/** Export byte budgets, immutable snapshots, and plugin-owned cleanup. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptStore, type TranscriptLimits } from '../src/transcript.ts'

const stores: TranscriptStore[] = []
const signal = new AbortController().signal
const newline = String.fromCharCode(10)
const tab = String.fromCharCode(9)
const slash = String.fromCharCode(92)
function store(overrides: Partial<TranscriptLimits> = {}) {
  const result = new TranscriptStore({ maxBytes: 16384, maxFiles: 2, ttlSeconds: 60, chunkChars: 64, ...overrides }, error => {
    throw error
  })
  stores.push(result)
  return result
}
function message(text: string): SessionEvent {
  return { seq: SessionSeq(0), time: Date.now(), type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }
}
afterEach(async () => {
  for (const item of stores.splice(0)) await item.dispose()
  vi.useRealTimers()
})

it('publishes unique private snapshots and escapes row delimiters without changing literals', async () => {
  const exports = store()
  const input = 'first' + newline + 'second' + tab + 'literal' + slash + 'n'
  const first = await exports.export([message(input)], signal)
  const second = await exports.export([message('new snapshot')], signal)
  expect(first.transcriptPath).not.toBe(second.transcriptPath)
  const content = await readFile(first.transcriptPath, 'utf8')
  expect(content.split(newline).filter(Boolean)).toHaveLength(1)
  expect(content.split(tab)).toHaveLength(6)
  expect(content).toContain('first' + slash + 'nsecond' + slash + 'tliteral' + slash + slash + 'n')
  expect(first.transcriptTruncated).toBe(false)
  if (process.platform !== 'win32') expect((await stat(first.transcriptPath)).mode & 0o777).toBe(0o600)
})

it.each([1, 140])('applies the %s-byte limit to complete emitted rows', async maxBytes => {
  const exported = await store({ maxBytes }).export([message('x'.repeat(5000))], signal)
  const bytes = await readFile(exported.transcriptPath)
  expect(bytes.byteLength).toBeLessThanOrEqual(maxBytes)
  expect(exported.transcriptBytes).toBe(bytes.byteLength)
  expect(exported.transcriptTruncated).toBe(true)
})

it('splits multibyte text into grep-sized rows without breaking surrogate pairs', async () => {
  const input = '中😀'.repeat(100)
  const exported = await store().export([message(input)], signal)
  const content = await readFile(exported.transcriptPath, 'utf8')
  const chunks = content
    .split(newline)
    .filter(Boolean)
    .map(line => line.split(tab).at(-1)!)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every(chunk => chunk.length <= 64)).toBe(true)
  expect(chunks.join('')).toBe(input)
})

it('expires old files and evicts by capacity without overwriting a snapshot', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const exports = store({ ttlSeconds: 1 })
  const first = await exports.export([message('expired')], signal)
  await vi.advanceTimersByTimeAsync(1001)
  await exports.export([message('fresh')], signal)
  await expect(readFile(first.transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const capped = store({ maxFiles: 1 })
  const older = await capped.export([message('older')], signal)
  const newer = await capped.export([message('newer')], signal)
  await expect(readFile(older.transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(newer.transcriptPath, 'utf8')).toContain('newer')
})

it('settles cancellation and removes owned files before unload completes', async () => {
  const exports = store()
  const first = await exports.export([message('kept until unload')], signal)
  const pending = exports.export([message('x'.repeat(100000))], signal)
  const closed = exports.dispose()
  await expect(pending).rejects.toThrow('unloaded')
  await closed
  await expect(readFile(first.transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(exports.export([], signal)).rejects.toThrow('unloaded')
})
