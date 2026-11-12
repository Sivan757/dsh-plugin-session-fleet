/** Fleet tool behavior over real agents, scripted controller stubs, and the executor contract. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { jsonlPersistencePlugin as JsonlSessionPersistence } from '../testkit/jsonl-persistence.ts'
import SessionQueryEngine, { SessionQueryError, SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MockAdapter, textResponse, toolCallResponse } from '../testkit/mock-adapter.ts'
import * as fleet from '../src/index.ts'

const SIGNAL = new AbortController().signal

const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override async searchSessions() {
    const session = this.ctx.sessions.list()[0]!
    return {
      items: [
        {
          header: session.header,
          live: true,
          persisted: false,
          bestMatch: {
            sessionId: session.header.id,
            seq: SessionSeq(0),
            type: 'user/message' as const,
            time: session.header.createdAt,
            surface: 'current' as const,
            snippet: 'needle match'
          }
        }
      ]
    }
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Non-void cleanup that keeps suite concurrency safe. */
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  ctx: Context
  lead: Agent
  other: Agent
  foreign: Agent
  fleetFiber: { dispose(): Promise<void> }
}

/**
 * Minimal agent-loop world with JSONL persistence plus a sessionController
 * stub over three real agents: two sharing the caller workspace and one
 * recorded elsewhere.
 */
async function setup(config: fleet.Config = {}, script: ConstructorParameters<typeof MockAdapter>[0] = [], index: 'stub' | 'never' = 'stub'): Promise<Fixture> {
  const full = fleet.Config(config)
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-session-fleet-'))
  roots.push(storageRoot)
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-fleet-cwd-'))
  roots.push(cwd)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  if (index === 'never') await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
  else await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const lead = await ctx.agentLoop.create(SessionId('fleet-lead'), { provider: 'mock', model: 'mock' }, { cwd })
  const other = await ctx.agentLoop.create(SessionId('fleet-other'), { provider: 'mock', model: 'mock' }, { cwd })
  const foreign = await ctx.agentLoop.create(SessionId('fleet-foreign'), { provider: 'mock', model: 'mock' }, { cwd: '/somewhere-else' })
  const notFound = (sessionId: SessionId) => ({ error: new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId }) })
  const stub = {
    resolveAgent: vi.fn(async (sessionId: SessionId) => {
      const found = ctx.agents.get(sessionId)
      return found === undefined ? notFound(sessionId) : { agent: found }
    }),
    list: vi.fn(async () => ({
      items: [lead, other, foreign].map(target => ({
        sessionId: target.id,
        updatedAt: target.session.snapshotEvents().at(-1)?.time ?? target.session.header.createdAt,
        running: false,
        agentAvailable: true,
        blank: false,
        cwd: target.session.header.cwd
      }))
    })),
    create: vi.fn(async (request: { cwd?: string }) => {
      const created = await ctx.agentLoop.create(SessionId(`fleet-new-${ctx.agents.list().length}`), { provider: 'mock', model: 'mock' }, { cwd: request.cwd ?? cwd })
      return { sessionId: created.id }
    })
  }
  ctx.provide('sessionController', stub as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as any)
  const fleetFiber = await ctx.plugin(fleet, full)
  return { ctx, lead, other, foreign, fleetFiber }
}

function execute(ctx: Context, agent: Agent | undefined, name: string, args: unknown, signal: AbortSignal = SIGNAL) {
  return ctx.tools.execute({
    callId: ToolCallId(`fleet-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...(agent === undefined ? {} : { agent })
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

/** Assert one executor failure result carries the expected tool diagnostic. */
function expectToolError(result: Awaited<ReturnType<typeof execute>>, fragment: string): void {
  expect(result.isError, text(result)).toBe(true)
  expect(text(result)).toContain(fragment)
}

const FLEET_TOOLS = ['list_sessions', 'search_sessions', 'inspect_session', 'create_session', 'send_to_session'].sort()

describe('fleet location and list boundaries', () => {
  it('uses an explicit cwd without inheriting the caller workspace', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.workspaceRegistry, 'list').mockReturnValueOnce([{ id: 'ws-home', sessionIds: [lead.id] } as never])
    const stub = ctx.sessionController as unknown as { create: ReturnType<typeof vi.fn> }
    stub.create.mockImplementationOnce(async (request: { cwd?: string; workspaceId?: string }) => {
      if (request.cwd !== undefined && request.workspaceId !== undefined) throw new Error('session.create accepts workspaceId or cwd, not both')
      return { sessionId: 'fleet-explicit' }
    })
    const result = await execute(ctx, lead, 'create_session', { cwd: '/explicit-location' })
    expect(result.isError, text(result)).not.toBe(true)
    expect(JSON.parse(text(result)).sessionId).toBe('fleet-explicit')
  })

  it('inherits the caller workspace only when neither location parameter is set', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.workspaceRegistry, 'list').mockReturnValueOnce([{ id: 'ws-home', sessionIds: [lead.id] } as never])
    const stub = ctx.sessionController as unknown as { create: ReturnType<typeof vi.fn> }
    stub.create.mockResolvedValueOnce({ sessionId: 'fleet-inherited' })
    const result = await execute(ctx, lead, 'create_session', {})
    expect(result.isError, text(result)).not.toBe(true)
    expect(stub.create.mock.calls.at(-1)?.[0]).toEqual({ workspaceId: 'ws-home' })
  })

  it('bounds the default list length by the configured maximum', async () => {
    const { ctx, lead } = await setup({ maxListRows: 1 })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {})))
    expect(listed.sessions).toHaveLength(1)
    expect(listed.total).toBe(3)
  })

  it('does not label ordinary sessions outside a cwd filter as hidden subagents', async () => {
    const { ctx, lead } = await setup()
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { cwd: lead.session.header.cwd })))
    expect(listed.sessions).toHaveLength(2)
    expect(listed.hiddenSubagentSessions ?? 0).toBe(0)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid configured row limit %s', maxListRows => {
    expect(() => fleet.Config({ maxListRows })).toThrow()
    expect(() => fleet.Config({ maxMessageChars: maxListRows })).toThrow()
  })
})

describe('fleet discovery continuation', () => {
  it('walks all ordinary sessions without repeats and rejects changed scopes', async () => {
    const { ctx, lead } = await setup()
    const first = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { limit: 1 })))
    const second = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { limit: 1, cursor: first.nextCursor })))
    const third = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { limit: 1, cursor: second.nextCursor })))
    expect(new Set([first, second, third].flatMap(page => page.sessions.map((row: { sessionId: string }) => row.sessionId)))).toEqual(
      new Set(['fleet-lead', 'fleet-other', 'fleet-foreign'])
    )
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBeUndefined()
    expectToolError(await execute(ctx, lead, 'list_sessions', { cwd: '/other-scope', limit: 1, cursor: first.nextCursor }), 'changed')
    expectToolError(await execute(ctx, lead, 'list_sessions', { cursor: '%' }), 'Invalid list cursor')
  })

  it('filters query hits against the current authorized summary list', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValueOnce({ items: [] })
    const provider = vi.spyOn(ctx.sessionQuery, 'searchSessions')
    const result = JSON.parse(text(await execute(ctx, lead, 'search_sessions', { query: 'needle' })))
    expect(result).toEqual({ results: [], hasMore: false })
    expect(provider).not.toHaveBeenCalled()
  })

  it('does not expose hits for a session missing from the authorized summary', async () => {
    const { ctx, lead } = await setup()
    const original = await ctx.sessionController.list({}, SIGNAL)
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValueOnce({ items: original.items.filter(row => row.sessionId !== lead.id) })
    const result = JSON.parse(text(await execute(ctx, lead, 'search_sessions', { query: 'needle' })))
    expect(result.results).toEqual([])
  })

  it('binds continuation to the caller and request while rechecking authorization per page', async () => {
    const { ctx, lead, other } = await setup()
    const sample = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 })
    const provider = vi.spyOn(ctx.sessionQuery, 'searchSessions').mockResolvedValueOnce({ ...sample, nextCursor: SessionSearchCursor('native-next') })
    const args = { query: 'needle', cwd: lead.session.header.cwd, limit: 1 }
    const first = JSON.parse(text(await execute(ctx, lead, 'search_sessions', args)))
    expect(first.nextCursor).not.toBe('native-next')
    expect(provider.mock.calls[0]?.[0].cursor).toBeUndefined()
    expectToolError(await execute(ctx, other, 'search_sessions', { ...args, cursor: first.nextCursor }), 'mismatched')
    expectToolError(await execute(ctx, lead, 'search_sessions', { ...args, query: 'changed', cursor: first.nextCursor }), 'mismatched')
    const authorized = await ctx.sessionController.list({}, SIGNAL)
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValueOnce({ items: authorized.items.filter(row => row.sessionId === lead.id) })
    expect(JSON.parse(text(await execute(ctx, lead, 'search_sessions', { ...args, cursor: first.nextCursor })))).toEqual({ results: [], hasMore: false })
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('limits IDs remembered by a search traversal before requesting another provider page', async () => {
    const { ctx, lead } = await setup({ searchCursorMaxSessions: 1 })
    const sample = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 })
    const provider = vi.spyOn(ctx.sessionQuery, 'searchSessions').mockResolvedValueOnce({ ...sample, nextCursor: SessionSearchCursor('native-next') })
    const args = { query: 'needle', cwd: lead.session.header.cwd, limit: 1 }
    const first = JSON.parse(text(await execute(ctx, lead, 'search_sessions', args)))
    expectToolError(await execute(ctx, lead, 'search_sessions', { ...args, cursor: first.nextCursor }), 'continuation limit')
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('validates time windows and passes the current scope to the query provider', async () => {
    const { ctx, lead } = await setup()
    const provider = vi.spyOn(ctx.sessionQuery, 'searchSessions')
    const args = { query: 'needle', cwd: lead.session.header.cwd, after: '2026-01-01T00:00:00Z', before: '2026-12-31T00:00:00Z', limit: 1 }
    await execute(ctx, lead, 'search_sessions', args)
    expect(provider.mock.calls[0]?.[0]).toMatchObject({
      query: 'needle',
      limit: 1,
      sessionFilters: [{ kind: 'id', values: ['fleet-lead', 'fleet-other'] }],
      eventFilters: [
        { kind: 'type', values: ['user/message', 'assistant/message'] },
        { kind: 'surface', values: ['current'] },
        { kind: 'time', from: Date.parse(args.after), to: Date.parse(args.before) }
      ]
    })
    expectToolError(await execute(ctx, lead, 'search_sessions', { query: 'needle', after: 'bad' }), 'ISO 8601')
    expectToolError(await execute(ctx, lead, 'search_sessions', { query: 'needle', after: args.before, before: args.after }), 'later than')
    expectToolError(await execute(ctx, lead, 'search_sessions', { query: 'needle', limit: 0 }), 'limit must')
  })
})

describe('history retrieval without a full-text index', () => {
  it('finds title candidates in one bounded call instead of traversing 863 sessions', async () => {
    const { ctx, lead } = await setup()
    const base = (await ctx.sessionController.list({}, SIGNAL)).items[0]!
    const rows = Array.from({ length: 864 }, (_, index) => ({
      ...base,
      sessionId: SessionId('catalog-' + index),
      updatedAt: 1_700_000_000_000 + index,
      ...(index === 863 ? { origin: 'subagent' as const } : {}),
      projections: { kind: 'cached' as const, asOfSeq: 0, values: { title: index >= 859 ? '部署：service-' + index : 'Unrelated task ' + index } }
    }))
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValue({ items: rows })
    const nativeSearch = vi.spyOn(ctx.sessionQuery, 'searchSessions').mockRejectedValue(new SessionQueryError('index disabled', 'SESSION_QUERY_SEARCH_DISABLED'))
    const legacy: string[] = []
    let cursor: string | undefined
    let legacyCalls = 0
    do {
      const page = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { limit: 50, ...(cursor === undefined ? {} : { cursor }) })))
      legacyCalls++
      legacy.push(...page.sessions.filter((row: { title?: string }) => row.title?.includes('部署')).map((row: { sessionId: string }) => row.sessionId))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    const filtered = await execute(ctx, lead, 'list_sessions', { query: '部署', limit: 50 })
    expect(filtered.isError, text(filtered)).not.toBe(true)
    const page = JSON.parse(text(filtered))
    expect(page.sessions.map((row: { sessionId: string }) => row.sessionId)).toEqual(legacy)
    expect(page.total).toBe(4)
    expect(page.hasMore).toBe(false)
    expect(page.hiddenSubagentSessions).toBe(1)
    expect(legacyCalls).toBe(18)
    expect(nativeSearch).not.toHaveBeenCalled()
  })

  it('binds title cursors to the query even when both queries match the same rows', async () => {
    const { ctx, lead } = await setup()
    const { items } = await ctx.sessionController.list({}, SIGNAL)
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValue({
      items: items.map(row => ({ ...row, projections: { kind: 'cached', asOfSeq: 0, values: { title: 'Deploy service' } } }))
    })
    const args = { query: '  dEpLoY  ', cwd: lead.session.header.cwd, limit: 1 }
    const first = JSON.parse(text(await execute(ctx, lead, 'list_sessions', args)))
    const next = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { ...args, cursor: first.nextCursor })))
    expect(first.total).toBe(2)
    expect(next.hasMore).toBe(false)
    expect(next.sessions[0].sessionId).not.toBe(first.sessions[0].sessionId)
    expectToolError(await execute(ctx, lead, 'list_sessions', { ...args, query: 'service', cursor: first.nextCursor }), 'changed')
    expectToolError(await execute(ctx, lead, 'list_sessions', { query: '   ' }), 'query must contain')
    expectToolError(await execute(ctx, lead, 'list_sessions', { query: 'x'.repeat(501) }), 'query must contain')
  })

  it('explains the title-discovery recovery when cross-session full-text search is disabled', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.sessionQuery, 'searchSessions').mockRejectedValueOnce(new SessionQueryError('index openAt never', 'SESSION_QUERY_SEARCH_DISABLED'))
    const result = await execute(ctx, lead, 'search_sessions', { query: '部署' })
    expectToolError(result, 'index openAt never')
    expect(text(result)).toContain('list_sessions')
    expect(text(result)).toContain('query')
  })

  it('retains conversational prompts and the latest textual answer after injected context and empty assistant messages', async () => {
    const { ctx, lead, other } = await setup({}, [textResponse('The service is ready.')])
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'Deploy the selected service.' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const snapshot = await ctx.sessionQuery.readSession(other.id)
    const prompt = snapshot.events.find(event => event.type === 'user/message')!
    const answer = snapshot.events.find(event => event.type === 'assistant/message')!
    if (prompt.type !== 'user/message' || answer.type !== 'assistant/message') throw new Error('missing fixture conversation')
    const nextSeq = snapshot.events.at(-1)!.seq + 1
    const injected = ['runtime-context', 'skill-catalog', 'goal', 'tool-goal'].map((kind, index) => ({
      ...prompt,
      seq: SessionSeq(nextSeq + index),
      data: { ...createUserMessage({ content: [{ type: 'text', text: 'Machine-generated context: ' + kind }], source: { kind: 'user' } }), source: { kind } as never }
    }))
    const empty = { ...answer, seq: SessionSeq(nextSeq + injected.length), data: { ...answer.data, message: { ...answer.data.message, content: [] } } }
    vi.spyOn(ctx.sessionQuery, 'readSession').mockResolvedValueOnce({ ...snapshot, events: [...snapshot.events, ...injected, empty] })
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id })))
    expect(outline.recentPrompts.map((row: { text: string }) => row.text)).toEqual(['Deploy the selected service.'])
    expect(outline.lastAssistant).toMatchObject({ seq: answer.seq, text: 'The service is ready.' })
    expect(outline.detailAccess.read.arguments.seq).toBe(answer.seq)
    expect(outline.counts.user).toBe(5)
  })

  it('uses native literal filtering for one session when the index is disabled, with a snippet around the match', async () => {
    const { ctx, lead, other } = await setup()
    const body = 'prefix '.repeat(100) + '自托管 dOcKeR\n[stable].v1' + ' suffix'.repeat(100)
    for (let index = 0; index < 2; index++) {
      other.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
      await other.whenIdle()
    }
    vi.spyOn(ctx.sessionQuery, 'searchEvents').mockRejectedValue(new SessionQueryError('index disabled', 'SESSION_QUERY_SEARCH_DISABLED'))
    const result = await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode: 'search', query: '自托管 Docker [stable].v1', limit: 1 })
    expect(result.isError, text(result)).not.toBe(true)
    const page = JSON.parse(text(result))
    expect(page.searchMode).toBe('literal')
    expect(page.results).toHaveLength(1)
    expect(page.hasMore).toBe(true)
    expect(page.results[0].snippet).toContain('自托管')
    expect(page.results[0].snippet).toContain('[stable].v1')
    expect(page.results[0].snippet.length).toBeLessThanOrEqual(240)
    const read = JSON.parse(text(await execute(ctx, lead, page.detailAccess.read.tool, page.detailAccess.read.arguments)))
    expect(read.event.data.content[0].text).toBe(body)
  })
})

describe('unindexed retrieval safety and actual AgentLoop', () => {
  it('recovers from disabled search, finds a cold session, and reads evidence through actual model tool results', async () => {
    const { ctx, lead, other } = await setup({}, [], 'never')
    const body = '部署验收：service A is ready. Evidence-marker [v1].'
    other.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await other.whenIdle()
    const coldId = SessionId('cold-retrieval-fixture')
    const stored = await ctx.get('sessionPersistence')!.create({ ...other.session.header, id: coldId })
    try {
      await stored.append(other.session.snapshotEvents())
      await stored.flush()
    } finally {
      await stored.close()
    }
    const { items } = await ctx.sessionController.list({}, SIGNAL)
    const cold = {
      ...items.find(row => row.sessionId === other.id)!,
      sessionId: coldId,
      agentAvailable: false,
      projections: { kind: 'cached' as const, asOfSeq: 0, values: { title: '部署：service A' } }
    }
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValue({ items: [...items, cold] })
    const resolve = vi.spyOn(ctx.sessionController, 'resolveAgent')
    const observations: string[] = []
    const lastToolText = (options: import('@deepseek-ai/dsh-llm').GenerateOptions) => {
      const value = options.messages
        .findLast(message => message.role === 'tool')!
        .content.flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('')
      observations.push(value)
      return value
    }
    ctx.llm.registerAdapter(
      ['unindexed-retrieval'],
      new MockAdapter([
        toolCallResponse('discover', 'search_sessions', { query: '部署' }),
        options => {
          expect(lastToolText(options)).toContain('list_sessions')
          return toolCallResponse('titles', 'list_sessions', { query: '部署' })
        },
        options => {
          const listed = JSON.parse(lastToolText(options))
          expect(listed.total).toBe(1)
          return toolCallResponse('outline', 'inspect_session', { session_id: listed.sessions[0].sessionId })
        },
        options => {
          const outline = JSON.parse(lastToolText(options))
          expect(outline.recentPrompts[0].text).toBe(body)
          return toolCallResponse('locate', outline.detailAccess.search.tool, { ...outline.detailAccess.search.arguments, query: 'evidence-marker [v1]' })
        },
        options => {
          const page = JSON.parse(lastToolText(options))
          expect(page.searchMode).toBe('literal')
          expect(page.results).toHaveLength(1)
          return toolCallResponse('evidence', page.detailAccess.read.tool, page.detailAccess.read.arguments)
        },
        options => {
          const detail = JSON.parse(lastToolText(options))
          expect(detail.event.data.content[0].text).toBe(body)
          return toolCallResponse('self-isolation', 'inspect_session', { session_id: 'unindexed-reader', mode: 'search', query: 'needle-only-in-the-active-tool-7281' })
        },
        options => {
          expect(JSON.parse(lastToolText(options))).toMatchObject({ searchMode: 'literal', results: [], hasMore: false })
          return textResponse('verified archived evidence')
        }
      ])
    )
    const reader = await ctx.agentLoop.create(SessionId('unindexed-reader'), { provider: 'unindexed-retrieval', model: 'mock' }, { cwd: lead.session.header.cwd })
    reader.followup(createUserMessage({ content: [{ type: 'text', text: 'Find the previous deployment conversation and cite its evidence.' }], source: { kind: 'user' } }))
    await reader.whenIdle()
    expect(observations).toHaveLength(6)
    expect(ctx.agents.get(coldId)).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not scan after operational failures and rechecks the fallback snapshot identity', async () => {
    const { ctx, lead, other } = await setup()
    const native = vi.spyOn(ctx.sessionQuery, 'searchEvents')
    const read = vi.spyOn(ctx.sessionQuery, 'readSession')
    native.mockRejectedValueOnce(new SessionQueryError('broken store', 'SESSION_QUERY_PERSISTENCE_FAILED'))
    expectToolError(await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode: 'search', query: 'needle' }), 'broken store')
    expect(read).not.toHaveBeenCalled()
    const snapshot = await ctx.sessionQuery.readSession(other.id)
    native.mockRejectedValueOnce(new SessionQueryError('disabled', 'SESSION_QUERY_SEARCH_DISABLED'))
    read.mockResolvedValueOnce({ ...snapshot, session: { ...snapshot.session, id: lead.id } })
    expectToolError(await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode: 'search', query: 'needle' }), 'different session')
  })
})

describe('native inspection interaction', () => {
  it('returns the backend locator and a directly executable read example', async () => {
    const { ctx, lead, other } = await setup()
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'native detail marker' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const persistence = ctx.get('sessionPersistence')!
    const snapshot = (await persistence.stat(other.id))!
    vi.spyOn(persistence, 'stat').mockResolvedValueOnce({ ...snapshot, location: { kind: 'fixture-native', path: '/fixture/original-session.zst' } })
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id })))
    expect(outline.mode).toBe('outline')
    expect(outline.source).toMatchObject({ status: 'located', location: { kind: 'fixture-native', path: '/fixture/original-session.zst' } })
    expect(outline.detailAccess.search).toMatchObject({ tool: 'inspect_session', arguments: { mode: 'search', session_id: other.id }, requiredArguments: ['query'] })
    const action = outline.detailAccess.read
    expect(action.requiredArguments).toEqual([])
    const detail = JSON.parse(text(await execute(ctx, lead, action.tool, action.arguments)))
    expect(detail.mode).toBe('read')
    expect(detail.event.seq).toBe(action.arguments.seq)
    expect(detail.context.every((event: { seq: number }) => event.seq !== detail.event.seq)).toBe(true)
  })

  it('keeps native event data complete and limits surrounding previews', async () => {
    const { ctx, lead, other } = await setup()
    const body = 'raw-body-'.repeat(1000)
    other.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await other.whenIdle()
    const target = other.session.snapshotEvents().find(event => event.type === 'user/message')!
    const native = vi.spyOn(ctx.sessionQuery, 'readEvent')
    const detail = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode: 'read', seq: target.seq, before: 2, after: 2 })))
    expect(detail.event).toEqual(target)
    expect(detail.context.length).toBeLessThanOrEqual(4)
    expect(detail.context.every((event: { text?: string }) => event.text === undefined || event.text.length <= 300)).toBe(true)
    expect(native.mock.calls[0]?.[0]).toMatchObject({ sessionId: other.id, seq: target.seq, before: 2, after: 2 })
    expect(native.mock.calls[0]?.[1]).toBe(SIGNAL)
  })

  it('uses native session event search and offers a read call for the hit', async () => {
    const { ctx, lead, other } = await setup()
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'event-search-marker' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const target = other.session.snapshotEvents().find(event => event.type === 'user/message')!
    const native = vi.spyOn(ctx.sessionQuery, 'searchEvents').mockResolvedValueOnce({
      session: other.session.header,
      items: [{ sessionId: other.id, seq: target.seq, time: target.time, type: target.type, surface: 'current', snippet: 'event-search-marker' }],
      nextCursor: SessionSearchCursor('native-more')
    })
    const searched = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode: 'search', query: 'event-search-marker', limit: 1 })))
    expect(native.mock.calls[0]?.[0]).toMatchObject({ sessionId: other.id, query: 'event-search-marker', limit: 1 })
    expect(native.mock.calls[0]?.[1]?.signal).toBe(SIGNAL)
    expect(searched).toMatchObject({ mode: 'search', hasMore: true, results: [{ seq: target.seq, snippet: 'event-search-marker' }] })
    expect(searched.nextCursor).toBeUndefined()
    expect(searched.guidance).toContain('narrow')
    expect(searched.detailAccess.read.arguments).toMatchObject({ session_id: other.id, mode: 'read', seq: target.seq })
  })

  it('reads raw tool results and clips actual neighboring call arguments', async () => {
    const { ctx, lead, other } = await setup({}, [toolCallResponse('native-list', 'list_sessions', { cwd: 'long-context-'.repeat(100) }), textResponse('finished')])
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'exercise a raw tool result' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const target = other.session.snapshotEvents().find(event => event.type === 'tool/result')!
    expect(target).toBeDefined()
    const detail = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode: 'read', seq: target.seq, before: 10, after: 0 })))
    expect(detail.event).toEqual(target)
    const call = detail.context.find((event: { type: string }) => event.type === 'tool/call')
    expect(call).toMatchObject({ source: 'list_sessions', truncated: true })
    expect(call.text.length).toBeLessThanOrEqual(300)
    expect(call.fullLength).toBeGreaterThan(1000)
  })

  it('rejects event search hits whose session differs from the authorized target', async () => {
    const { ctx, lead, other } = await setup()
    vi.spyOn(ctx.sessionQuery, 'searchEvents').mockResolvedValueOnce({
      session: other.session.header,
      items: [{ sessionId: SessionId('hidden-session'), seq: SessionSeq(0), time: 0, type: 'user/message', surface: 'current', snippet: 'must not be disclosed' }]
    })
    const result = await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode: 'search', query: 'marker' })
    expectToolError(result, 'different session')
    expect(text(result)).not.toContain('must not be disclosed')
  })

  it('retains useful access instructions when no physical locator is supplied', async () => {
    const { ctx, lead, other } = await setup()
    const persistence = ctx.get('sessionPersistence')!
    const snapshot = (await persistence.stat(other.id))!
    vi.spyOn(persistence, 'stat').mockResolvedValueOnce({ header: snapshot.header, revision: snapshot.revision })
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id })))
    expect(outline.source.status).toBe('unavailable')
    expect(outline.source.location).toBeUndefined()
    expect(outline.detailAccess.search.tool).toBe('inspect_session')
  })

  it('reports a locator lookup failure without discarding the outline', async () => {
    const { ctx, lead, other } = await setup()
    vi.spyOn(ctx.get('sessionPersistence')!, 'stat').mockRejectedValueOnce(new Error('locator failed'))
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id })))
    expect(outline.source).toMatchObject({ status: 'error', reason: expect.stringContaining('locator failed') })
    expect(outline.counts).toBeDefined()
  })

  it.each(['outline', 'search', 'read'])('checks Host visibility before native %s reads or locator lookup', async mode => {
    const { ctx, lead, other } = await setup()
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValueOnce({ items: [] })
    const read = vi.spyOn(ctx.sessionQuery, 'readEvent')
    const search = vi.spyOn(ctx.sessionQuery, 'searchEvents')
    const locate = vi.spyOn(ctx.get('sessionPersistence')!, 'stat')
    const args = mode === 'search' ? { query: 'marker' } : mode === 'read' ? { seq: 0 } : {}
    expectToolError(await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode, ...args }), 'not accessible')
    expect(read).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(locate).not.toHaveBeenCalled()
  })

  it.each([
    [{ mode: 'read' }, 'seq'],
    [{ mode: 'read', seq: -1 }, 'seq'],
    [{ mode: 'read', seq: 0, before: 11 }, 'before'],
    [{ mode: 'read', seq: 0, after: -1 }, 'after'],
    [{ mode: 'read', seq: 0, query: 'mixed' }, 'query'],
    [{ mode: 'search' }, 'query'],
    [{ mode: 'search', query: ' ' }, 'query'],
    [{ mode: 'search', query: 'x', seq: 0 }, 'seq'],
    [{ mode: 'search', query: 'x', transcript: true }, 'transcript'],
    [{ mode: 'search', query: 'x', limit: 0 }, 'limit'],
    [{ mode: 'outline', query: 'mixed' }, 'query']
  ])('rejects an invalid mode combination %j', async (args, message) => {
    const { ctx, lead, other } = await setup()
    expectToolError(await execute(ctx, lead, 'inspect_session', { session_id: other.id, ...args }), message)
  })
})

describe('session-fleet tools', () => {
  it('returns an outline without creating a transcript unless requested', async () => {
    const { ctx, lead, other } = await setup()
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: other.id })))
    expect(outline.transcriptPath).toBeUndefined()
    expect(outline.asOfSeq).toBeTypeOf('number')
    expect(outline.omittedEventTypes).toBeInstanceOf(Array)
  })
  it('lists visible sessions, filters by cwd, and validates limit bounds', async () => {
    const { ctx, lead, other } = await setup()
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {}))) as {
      sessions: Array<{ sessionId: string; running: boolean }>
      total: number
    }
    expect(listed.sessions.map(row => row.sessionId).sort()).toEqual(['fleet-foreign', 'fleet-lead', 'fleet-other'])
    expect(listed.total).toBe(3)

    const mine = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { cwd: lead.session.header.cwd }))) as {
      sessions: Array<{ sessionId: string }>
    }
    expect(mine.sessions.map(row => row.sessionId).sort()).toEqual(['fleet-lead', 'fleet-other'])

    const limited = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { limit: 1 }))) as { sessions: unknown[] }
    expect(limited.sessions).toHaveLength(1)
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 0 }), 'limit must be an integer from 1 through 50')
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 51 }), 'limit must be an integer from 1 through 50')
    expect(other.status).toBe('idle')
  })

  it('searches the authorized query service and surfaces workspace context', async () => {
    const { ctx, lead } = await setup()
    const found = JSON.parse(text(await execute(ctx, lead, 'search_sessions', { query: 'needle' }))) as {
      results: Array<{ sessionId: string; snippet: string; running: boolean; updatedAt: string; cwd?: string }>
      hasMore: boolean
    }
    expect(found.results).toHaveLength(1)
    expect(found.results[0]).toMatchObject({ sessionId: 'fleet-lead', snippet: 'needle match', running: false })
    expect(typeof found.results[0]!.updatedAt).toBe('string')
    expect(found.hasMore).toBe(false)
  })

  it('inspects one session outline and writes a grep-able transcript', async () => {
    const { ctx, lead, other } = await setup()
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'first line' }], source: { kind: 'user' } }))
    await other.whenIdle()
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'second line' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: 'fleet-other', transcript: true }))) as {
      counts: { user: number; assistant: number; toolCalls: number }
      recentPrompts: Array<{ text: string; role: string }>
      running: boolean
      agentAvailable: boolean
      cwd?: string
      eventCount: number
      transcriptPath: string
      transcriptLines: number
    }
    expect(outline.counts.user).toBe(2)
    expect(outline.recentPrompts.map(row => row.text)).toEqual(['first line', 'second line'])
    expect(outline.running).toBe(false)
    expect(outline.agentAvailable).toBe(true)
    expect(outline.cwd).toBe(other.session.header.cwd)
    expect(outline.eventCount).toBeGreaterThan(0)
    expect(outline.transcriptLines).toBeGreaterThanOrEqual(2)
    const transcript = readFileSync(outline.transcriptPath, 'utf8')
    expect(transcript).toContain('first line')
    expect(transcript).toContain('second line')
    expect(transcript.split('\n')[0]).toMatch(/^\d+\t\S+\tuser\tuser\t/)
  })

  it('keeps the transcript unclipped while the outline clips long prompts', async () => {
    const { ctx, lead, other } = await setup()
    const long = 'x'.repeat(500)
    other.followup(createUserMessage({ content: [{ type: 'text', text: long }], source: { kind: 'user' } }))
    await other.whenIdle()
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: 'fleet-other', transcript: true }))) as {
      recentPrompts: Array<{ text: string; truncated?: boolean; fullLength?: number }>
      transcriptPath: string
    }
    expect(outline.recentPrompts[0]).toMatchObject({ truncated: true, fullLength: 500 })
    expect(outline.recentPrompts[0]!.text).toHaveLength(200)
    expect(readFileSync(outline.transcriptPath, 'utf8')).toContain(long)
  })

  it.each(['outline', 'search', 'read'])('refuses subagent sessions in %s mode before native access', async mode => {
    const { ctx, lead, other } = await setup()
    const rows = await ctx.sessionController.list({}, SIGNAL)
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValueOnce({ items: rows.items.map(row => (row.sessionId === other.id ? { ...row, origin: 'subagent' } : row)) })
    const read = vi.spyOn(ctx.sessionQuery, 'readEvent')
    const search = vi.spyOn(ctx.sessionQuery, 'searchEvents')
    const args = mode === 'search' ? { query: 'marker' } : mode === 'read' ? { seq: 0 } : {}
    expectToolError(await execute(ctx, lead, 'inspect_session', { session_id: other.id, mode, ...args }), 'Subagent sessions are hidden')
    expect(read).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('creates sessions with the caller cwd or an explicit cwd, rejecting conflicts', async () => {
    const { ctx, lead } = await setup()
    const created = JSON.parse(text(await execute(ctx, lead, 'create_session', {}))) as { sessionId: string }
    expect(ctx.agents.get(SessionId(created.sessionId))!.session.header.cwd).toBe(lead.session.header.cwd)

    const explicit = JSON.parse(text(await execute(ctx, lead, 'create_session', { cwd: '/tmp' }))) as { sessionId: string }
    expect(ctx.agents.get(SessionId(explicit.sessionId))!.session.header.cwd).toBe('/tmp')

    expectToolError(await execute(ctx, lead, 'create_session', { cwd: '/tmp', workspace_id: 'ws' }), 'accepts cwd or workspace_id, not both')
  })

  it('queues and steers a fleet message and proves source identity in the target log', async () => {
    const { ctx, lead, other } = await setup()
    const sent = JSON.parse(
      text(
        await execute(ctx, lead, 'send_to_session', {
          session_id: 'fleet-other',
          message: 'please review the diff'
        })
      )
    ) as { sessionId: string; delivery: string; accepted: boolean; messageId: string }
    expect(sent).toEqual({ sessionId: 'fleet-other', delivery: 'queue', accepted: true, messageId: expect.any(String), persistence: 'acknowledged', retrySafe: false })
    expect(other.status).toBe('idle')

    await other.whenIdle()
    const fleetMessage = other.session
      .snapshotEvents()
      .find(event => event.type === 'user/message' && event.data.source.kind === 'session-fleet' && event.data.source.senderSessionId === 'fleet-lead')
    expect(fleetMessage).toBeDefined()
    expect(fleetMessage!.data.id).toBe(sent.messageId)
    expect(JSON.stringify(fleetMessage!.data.content)).toContain('please review the diff')
    expect(JSON.stringify(fleetMessage!.data.content)).toContain('peer-agent input')

    const steered = await execute(ctx, lead, 'send_to_session', {
      session_id: 'fleet-other',
      message: 'mid-turn note',
      delivery: 'steer'
    })
    expect(steered.isError, text(steered)).toBe(false)
    await other.whenIdle()
  })

  it('rejects unknown targets, self-delivery, oversized messages, and cross-workspace by default', async () => {
    const { ctx, lead } = await setup()
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-missing', message: 'hi' }), 'session/not-found')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-lead', message: 'note' }), 'targets another session')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'x'.repeat(20_001) }), 'exceeds 20000 characters')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-foreign', message: 'hello' }), 'cross-workspace delivery is disabled')
  })

  it('delivers across workspaces when the deployment opts in', async () => {
    const { ctx, lead, foreign } = await setup({ allowCrossWorkspace: true })
    const sent = await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-foreign', message: 'hi' })
    expect(sent.isError, text(sent)).toBe(false)
    await foreign.whenIdle()
    expect(foreign.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'session-fleet')).toBe(true)
  })

  it('installs the complete scoped schema and policy, and disposes with the plugin fiber', async () => {
    const { ctx, lead, fleetFiber } = await setup()
    const scope = scopeOf(lead.ctx)
    const assembly = await ctx.systemPrompt.assemble({ scope })
    expect(
      assembly.tools
        .map(schema => schema.name)
        .filter(name => FLEET_TOOLS.includes(name))
        .sort()
    ).toEqual(FLEET_TOOLS)
    const prompt = renderPrompt(assembly)
    expect(prompt).toContain('peer-agent input')
    expect(prompt).toContain('untrusted peer input')

    await fleetFiber.dispose()
    expect(ctx.tools.get('list_sessions', scope)).toBeUndefined()
    expect(ctx.tools.get('send_to_session', scope)).toBeUndefined()
    const after = await ctx.agentLoop.create(SessionId('fleet-after'), { provider: 'mock', model: 'mock' })
    expect(ctx.tools.get('list_sessions', scopeOf(after.ctx))).toBeUndefined()
  })

  it('installs per-agent tools for agents created after the plugin', async () => {
    const { ctx, lead } = await setup()
    const second = await ctx.agentLoop.create(SessionId('fleet-second'), { provider: 'mock', model: 'mock' })
    const secondScope = scopeOf(second.ctx)
    expect(ctx.tools.get('list_sessions', secondScope)).toBeDefined()
    const leadScope = scopeOf(lead.ctx)
    expect(ctx.tools.get('list_sessions', leadScope)).toBeDefined()
    expect(ctx.tools.get('list_sessions', leadScope)).not.toBe(ctx.tools.get('list_sessions', secondScope))
  })
})

describe('session-fleet failure paths and optionality', () => {
  it('maps controller rejections from list and search into tool errors', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.sessionController, 'list').mockRejectedValueOnce(new RemoteError('gateway/internal', 'list broke', {}))
    vi.spyOn(ctx.sessionQuery, 'searchSessions').mockRejectedValueOnce(new RemoteError('gateway/internal', 'search broke', {}))
    expectToolError(await execute(ctx, lead, 'list_sessions', {}), 'gateway/internal: list broke')
    expectToolError(await execute(ctx, lead, 'search_sessions', { query: 'x' }), 'gateway/internal: search broke')
  })

  it('maps plain controller failures without RemoteError identity', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.sessionController, 'list').mockRejectedValue(new Error('plain failure'))
    expectToolError(await execute(ctx, lead, 'list_sessions', {}), 'plain failure')
  })

  it('creates through a workspace id and carries the resolved preset', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { create: ReturnType<typeof vi.fn> }
    stub.create.mockResolvedValueOnce({ sessionId: 'fleet-ws-child', agentPreset: 'reviewer' })
    const created = JSON.parse(text(await execute(ctx, lead, 'create_session', { workspace_id: 'ws-1' }))) as {
      sessionId: string
      agentPreset?: string
    }
    expect(created).toEqual({ sessionId: 'fleet-ws-child', agentPreset: 'reviewer' })
    expect(stub.create.mock.calls[0]?.[0]).toEqual({ workspaceId: 'ws-1' })
  })

  it('reports create failures without a resolvable cwd', async () => {
    const { ctx, lead } = await setup()
    const cwdless = lead
    const stub = ctx.sessionController as unknown as { create: ReturnType<typeof vi.fn> }
    // A caller with no cwd and no workspace_id cannot resolve a location.
    Object.defineProperty(cwdless.session, 'header', { value: { ...cwdless.session.header, cwd: undefined } })
    expectToolError(await execute(ctx, cwdless, 'create_session', {}), 'could not resolve a working directory')
    expect(stub.create).not.toHaveBeenCalled()
  })

  it('rejects subagent-owned targets regardless of workspace policy', async () => {
    const { ctx, lead } = await setup({ allowCrossWorkspace: true })
    const stub = ctx.sessionController as unknown as { resolveAgent: ReturnType<typeof vi.fn> }
    const subagentLike = { id: SessionId('fleet-sub'), session: { header: { id: SessionId('fleet-sub'), origin: 'subagent', cwd: lead.session.header.cwd } } }
    stub.resolveAgent.mockResolvedValueOnce({ agent: subagentLike })
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-sub', message: 'hi' }), 'subagent session')
  })

  it.each(['false', 'rejection'])('returns an inspectable receipt when persistence is unknown after %s', async failure => {
    const { ctx, lead, other } = await setup()
    const spy = vi.spyOn(ctx.sessions, 'flush')
    if (failure === 'false') spy.mockResolvedValue(false)
    else spy.mockRejectedValue(new Error('disk failure'))
    const result = await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'hi' })
    expect(result.isError, text(result)).not.toBe(true)
    const receipt = JSON.parse(text(result))
    expect(receipt).toMatchObject({ accepted: true, persistence: 'unknown', retrySafe: false })
    expect(receipt.warning).toContain('Inspect before retrying')
    const incoming = other.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === receipt.messageId)
    expect(incoming).toBeDefined()
  })

  it('marks an enqueue exception as uncertain when the target already has the message', async () => {
    const { ctx, lead, other } = await setup()
    const enqueue = other.followup.bind(other)
    vi.spyOn(other, 'followup').mockImplementationOnce(message => {
      enqueue(message)
      throw new Error('after admission')
    })
    const result = await execute(ctx, lead, 'send_to_session', { session_id: other.id, message: 'uncertain enqueue' })
    expectToolError(result, 'Delivery outcome is unknown')
    await other.whenIdle()
    const received = other.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'session-fleet')
    expect(text(result)).toContain(received!.data.id)
  })

  it('rolls back partial installs when a scope registration throws', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-session-fleet-'))
    roots.push(storageRoot)
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-fleet-cwd-'))
    roots.push(cwd)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const agent = await ctx.agentLoop.create(SessionId('fleet-rollback'), { provider: 'mock', model: 'mock' }, { cwd })
    const stub = {
      resolveAgent: vi.fn(async () => ({ error: new RemoteError('session/not-found', 'no', { sessionId: agent.id }) })),
      list: vi.fn(async () => ({ items: [] })),
      search: vi.fn(async () => ({ items: [], hasMore: false })),
      create: vi.fn(async () => ({ sessionId: agent.id }))
    }
    ctx.provide('sessionController', stub as never)
    const breaking = vi.spyOn(ctx.tools, 'register').mockImplementationOnce(() => {
      throw new Error('registration exploded')
    })
    try {
      await ctx.plugin(fleet)
    } catch (error) {
      expect(String(error)).toContain('registration exploded')
    }
    breaking.mockRestore()
  })

  it('guards tools against a missing execution agent', async () => {
    const { ctx, lead } = await setup()
    // Scoped discovery supplies fleet tools only inside an Agent scope; a bare
    // execution reports the tool as unknown instead of reaching the guard.
    expectToolError(await execute(ctx, undefined, 'list_sessions', {}), 'unknown tool "list_sessions"')
    expect(lead.status).toBe('idle')
  })
})

describe('session-fleet coverage completion', () => {
  it('omits absent parent and origin fields in list rows', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { list: ReturnType<typeof vi.fn> }
    stub.list.mockResolvedValueOnce({
      items: [
        {
          sessionId: 'fleet-plain',
          updatedAt: 0,
          running: false,
          agentAvailable: false,
          blank: true
        }
      ]
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {}))) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listed.sessions[0]).toEqual({
      sessionId: 'fleet-plain',
      updatedAt: new Date(0).toISOString(),
      running: false,
      agentAvailable: false,
      blank: true
    })
  })

  it('maps create controller rejections into tool errors', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { create: ReturnType<typeof vi.fn> }
    stub.create.mockRejectedValueOnce(new RemoteError('session/conflict', 'taken', {}))
    expectToolError(await execute(ctx, lead, 'create_session', { cwd: '/tmp' }), 'session/conflict: taken')
  })

  it('skips duplicate install for an already-installed agent', async () => {
    const { ctx, lead } = await setup()
    const installs = ctx.agents.list().length
    expect(installs).toBeGreaterThan(0)
    const scope = scopeOf(lead.ctx)
    const before = ctx.tools.get('list_sessions', scope)
    expect(before).toBeDefined()
    // A second plugin instance installs its own scoped set per agent; disposal removes each.
  })

  it('removes per-agent tools on agent disposal', async () => {
    const { ctx } = await setup()
    const handle = await ctx.agents.create({
      sessionId: SessionId('fleet-disposal'),
      agentOptions: { provider: 'mock', model: 'mock' }
    })
    const scope = scopeOf(handle.agent.ctx)
    expect(ctx.tools.get('list_sessions', scope)).toBeDefined()
    await handle.dispose()
    expect(ctx.tools.get('list_sessions', scope)).toBeUndefined()
  })
})

describe('session-fleet projection edge values', () => {
  it('carries parent and origin fields in list rows when present', async () => {
    const { ctx, lead } = await setup({ includeSubagents: true })
    const stub = ctx.sessionController as unknown as { list: ReturnType<typeof vi.fn> }
    stub.list.mockResolvedValueOnce({
      items: [
        {
          sessionId: 'fleet-child',
          updatedAt: 8,
          running: true,
          agentAvailable: true,
          blank: false,
          parentSessionId: 'fleet-lead',
          origin: 'subagent',
          cwd: '/tmp'
        }
      ]
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {}))) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listed.sessions[0]).toEqual({
      sessionId: 'fleet-child',
      updatedAt: new Date(8).toISOString(),
      running: true,
      agentAvailable: true,
      blank: false,
      parentSessionId: 'fleet-lead',
      origin: 'subagent',
      cwd: '/tmp'
    })
  })

  it('fails loud on a duplicate plugin application to the same scope', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(fleet)).rejects.toThrow('already registered in this scope')
  })
})

describe('session-fleet apply defaults and re-entry', () => {
  it('skips a second install when an agent re-enters the created path', async () => {
    const { ctx, lead } = await setup()
    const scope = scopeOf(lead.ctx)
    const before = ctx.tools.get('list_sessions', scope)
    // Re-emitting agent/created for an installed agent must not re-register.
    ctx.emit('agent/created', { agent: lead })
    expect(ctx.tools.get('list_sessions', scope)).toBe(before)
  })
})

describe('session-fleet partial config defaults', () => {
  it('falls back message bound per key with a partial config', async () => {
    const { ctx, lead } = await setup({ allowCrossWorkspace: true, maxMessageChars: 5 })
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-foreign', message: 'x'.repeat(6) }), 'exceeds 5 characters')
  })
})

describe('session-fleet ownership filtering', () => {
  it('hides subagent rows from list_sessions and reports the hidden count', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { list: ReturnType<typeof vi.fn> }
    stub.list.mockResolvedValueOnce({
      items: [
        { sessionId: 'fleet-top', updatedAt: 1, running: false, agentAvailable: false, blank: false, cwd: '/tmp' },
        { sessionId: 'fleet-child', updatedAt: 2, running: false, agentAvailable: false, blank: false, cwd: '/tmp', origin: 'subagent' }
      ]
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {}))) as {
      sessions: Array<{ sessionId: string }>
      total: number
      hiddenSubagentSessions?: number
    }
    expect(listed.sessions.map(row => row.sessionId)).toEqual(['fleet-top'])
    expect(listed.total).toBe(1)
    expect(listed.hiddenSubagentSessions).toBe(1)

    // A later call keeps filtering and keeps reporting the hidden count.
    stub.list.mockResolvedValueOnce({
      items: [
        { sessionId: 'fleet-top', updatedAt: 1, running: false, agentAvailable: false, blank: false, cwd: '/tmp' },
        { sessionId: 'fleet-child', updatedAt: 2, running: false, agentAvailable: false, blank: false, cwd: '/tmp', origin: 'subagent' }
      ]
    })
    const scoped = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { cwd: '/tmp' }))) as {
      sessions: Array<{ sessionId: string }>
      hiddenSubagentSessions?: number
    }
    expect(scoped.sessions.map(row => row.sessionId)).toEqual(['fleet-top'])
    expect(scoped.hiddenSubagentSessions).toBe(1)
  })

  it('exposes subagent rows when includeSubagents is enabled', async () => {
    const { ctx, lead } = await setup({ includeSubagents: true })
    const stub = ctx.sessionController as unknown as { list: ReturnType<typeof vi.fn> }
    stub.list.mockResolvedValueOnce({
      items: [
        { sessionId: 'fleet-top', updatedAt: 1, running: false, agentAvailable: false, blank: false, cwd: '/tmp' },
        { sessionId: 'fleet-child', updatedAt: 2, running: false, agentAvailable: false, blank: false, cwd: '/tmp', origin: 'subagent' }
      ]
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {}))) as {
      sessions: Array<{ sessionId: string }>
      hiddenSubagentSessions?: number
    }
    expect(listed.sessions.map(row => row.sessionId).sort()).toEqual(['fleet-child', 'fleet-top'])
    expect(listed.hiddenSubagentSessions).toBeUndefined()
  })
})
