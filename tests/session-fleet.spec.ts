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
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MockAdapter } from '../testkit/mock-adapter.ts'
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
async function setup(config: fleet.Config = {}, script: ConstructorParameters<typeof MockAdapter>[0] = []): Promise<Fixture> {
  const full = {
    allowCrossWorkspace: config.allowCrossWorkspace ?? false,
    maxListRows: config.maxListRows ?? 50,
    maxMessageChars: config.maxMessageChars ?? 20_000,
    includeSubagents: config.includeSubagents ?? false
  }
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-session-fleet-'))
  roots.push(storageRoot)
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-fleet-cwd-'))
  roots.push(cwd)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
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
    inspect: vi.fn(async (sessionId: SessionId) => {
      const found = ctx.agents.get(sessionId)
      if (found === undefined) throw notFound(sessionId).error
      return { meta: found.session.header, inheritedEventCount: 0, events: [...found.session.snapshotEvents()] }
    }),
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

  it('validates time windows and passes the scope and continuation to the query provider', async () => {
    const { ctx, lead } = await setup()
    const provider = vi.spyOn(ctx.sessionQuery, 'searchSessions')
    const args = { query: 'needle', cwd: lead.session.header.cwd, after: '2026-01-01T00:00:00Z', before: '2026-12-31T00:00:00Z', limit: 1, cursor: 'provider-cursor' }
    await execute(ctx, lead, 'search_sessions', args)
    expect(provider.mock.calls[0]?.[0]).toMatchObject({
      query: 'needle',
      limit: 1,
      cursor: 'provider-cursor',
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

describe('session-fleet tools', () => {
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
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: 'fleet-other' }))) as {
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
    const outline = JSON.parse(text(await execute(ctx, lead, 'inspect_session', { session_id: 'fleet-other' }))) as {
      recentPrompts: Array<{ text: string; truncated?: boolean; fullLength?: number }>
      transcriptPath: string
    }
    expect(outline.recentPrompts[0]).toMatchObject({ truncated: true, fullLength: 500 })
    expect(outline.recentPrompts[0]!.text).toHaveLength(200)
    expect(readFileSync(outline.transcriptPath, 'utf8')).toContain(long)
  })

  it('refuses subagent sessions in inspect by default', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { inspect: ReturnType<typeof vi.fn> }
    stub.inspect.mockResolvedValueOnce({
      meta: { version: 3, id: SessionId('fleet-child'), createdAt: 0, isSeeded: false, cwd: '/tmp', origin: 'subagent' },
      inheritedEventCount: 0,
      events: []
    })
    expectToolError(await execute(ctx, lead, 'inspect_session', { session_id: 'fleet-child' }), 'subagent session owned by its parent')
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
    ) as { sessionId: string; delivery: string; accepted: boolean }
    expect(sent).toEqual({ sessionId: 'fleet-other', delivery: 'queue', accepted: true })
    expect(other.status).toBe('idle')

    await other.whenIdle()
    const fleetMessage = other.session
      .snapshotEvents()
      .find(event => event.type === 'user/message' && event.data.source.kind === 'session-fleet' && event.data.source.senderSessionId === 'fleet-lead')
    expect(fleetMessage).toBeDefined()
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

  it('reports flush failures instead of claiming acceptance', async () => {
    const { ctx, lead, other } = await setup()
    const spy = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'hi' }), 'session persistence did not acknowledge the message')
    expect(spy).toHaveBeenCalled()
    expect(other.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'session-fleet')).toBe(true)
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
      inspect: vi.fn(async () => {
        throw new Error('unused')
      }),
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
