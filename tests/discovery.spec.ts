import { afterEach, expect, it, vi } from 'vitest'
import { SearchContinuations } from '../src/discovery.ts'
const identity = { query: 'term', cwd: undefined, from: undefined, to: undefined, limit: 1, includeSubagents: false }
afterEach(() => vi.useRealTimers())

it('keeps emitted IDs behind an opaque handle bound to the owner and request', () => {
  const store = new SearchContinuations({ maxEntries: 10, ttlSeconds: 60, maxSessions: 3 })
  const first = store.begin('owner', identity)
  const cursor = store.next(first, ['sensitive-session-id'])
  expect(cursor).not.toContain('sensitive-session-id')
  expect(store.begin('owner', identity, cursor).seen).toEqual(['sensitive-session-id'])
  expect(() => store.begin('other', identity, cursor)).toThrow('mismatched')
  expect(() => store.begin('owner', { ...identity, limit: 2 }, cursor)).toThrow('mismatched')
  expect(() => store.begin('owner', identity, 'unrecognized')).toThrow('Invalid')
})

it('expires handles without retaining result bodies or authorization', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new SearchContinuations({ maxEntries: 10, ttlSeconds: 1, maxSessions: 3 })
  const cursor = store.next(store.begin('owner', identity), ['one'])
  vi.setSystemTime(Date.now() + 1001)
  expect(() => store.begin('owner', identity, cursor)).toThrow('expired')
})

it('caps both retained handles and remembered matches', () => {
  const store = new SearchContinuations({ maxEntries: 1, ttlSeconds: 60, maxSessions: 2 })
  const first = store.begin('owner', identity)
  const older = store.next(first, ['one'])
  const newer = store.next(first, ['two'])
  expect(() => store.begin('owner', identity, older)).toThrow('expired')
  const state = store.begin('owner', identity, newer)
  expect(store.remaining(state)).toBe(1)
  expect(() => store.next(state, ['three', 'four'])).toThrow('limit reached')
})

it('releases handles and rejects admission after unload', () => {
  const store = new SearchContinuations({ maxEntries: 10, ttlSeconds: 60, maxSessions: 3 })
  const state = store.begin('owner', identity)
  store.dispose()
  expect(() => store.begin('owner', identity)).toThrow('unloaded')
  expect(() => store.next(state, ['one'])).toThrow('unloaded')
})
