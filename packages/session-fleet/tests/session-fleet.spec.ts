/** Fleet tool behavior over real agents, scripted controller stubs, and the executor contract. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MockAdapter, textResponse } from '../../../testkit/mock-adapter.ts'
import * as fleet from '../src/index.ts'

const SIGNAL = new AbortController().signal

const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
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
    maxReadMessages: config.maxReadMessages ?? 50,
    maxMessageChars: config.maxMessageChars ?? 20_000,
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
  const notFound = (sessionId: SessionId) =>
    ({ error: new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId }) })
  const stub = {
    resolveAgent: vi.fn(async (sessionId: SessionId) => {
      const found = ctx.agents.get(sessionId)
      return found === undefined ? notFound(sessionId) : { agent: found }
    }),
    list: vi.fn(async () => ({
      items: [lead, other, foreign].map(target => ({
        sessionId: target.id,
        updatedAt: Date.now(),
        running: false,
        agentAvailable: true,
        blank: false,
        cwd: target.session.header.cwd,
      })),
    })),
    search: vi.fn(async () => ({ items: [{ sessionId: 'fleet-lead', snippet: 'needle match' }], hasMore: false })),
    inspect: vi.fn(async (sessionId: SessionId) => {
      const found = ctx.agents.get(sessionId)
      if (found === undefined) throw notFound(sessionId).error
      return { meta: found.session.header, inheritedEventCount: 0, events: [...found.session.snapshotEvents()] }
    }),
    create: vi.fn(async (request: { cwd?: string }) => {
      const created = await ctx.agentLoop.create(
        SessionId(`fleet-new-${ctx.agents.list().length}`),
        { provider: 'mock', model: 'mock' },
        { cwd: request.cwd ?? cwd },
      )
      return { sessionId: created.id }
    }),
  }
  ctx.provide('sessionController', stub as never)
  const fleetFiber = await ctx.plugin(fleet, full)
  return { ctx, lead, other, foreign, fleetFiber }
}

function execute(ctx: Context, agent: Agent | undefined, name: string, args: unknown, signal: AbortSignal = SIGNAL) {
  return ctx.tools.execute({
    callId: ToolCallId(`fleet-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Assert one executor failure result carries the expected tool diagnostic. */
function expectToolError(result: Awaited<ReturnType<typeof execute>>, fragment: string): void {
  expect(result.isError, text(result)).toBe(true)
  expect(text(result)).toContain(fragment)
}

const FLEET_TOOLS = [
  'list_sessions',
  'search_sessions',
  'read_session',
  'create_session',
  'send_to_session',
].sort()

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
    expect(mine.sessions.map(row => row.sessionId)).toEqual(['fleet-lead', 'fleet-other'])

    const limited = JSON.parse(text(await execute(ctx, lead, 'list_sessions', { limit: 1 }))) as { sessions: unknown[] }
    expect(limited.sessions).toHaveLength(1)
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 0 }), 'limit must be an integer from 1 through 50')
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 51 }), 'limit must be an integer from 1 through 50')
    expect(other.status).toBe('idle')
  })

  it('reads another session transcript with truncation and controller failures', async () => {
    const { ctx, lead, other } = await setup()
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'first fixture line' }], source: { kind: 'user' } }))
    await other.whenIdle()
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'second fixture line' }], source: { kind: 'user' } }))
    await other.whenIdle()

    const read = JSON.parse(text(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other' }))) as {
      messages: Array<{ role: string; source: string; text: string }>
      truncated: boolean
    }
    expect(read.messages.filter(row => row.role === 'user').map(row => row.text))
      .toEqual(['first fixture line', 'second fixture line'])
    expect(read.messages.every(row => row.role === 'user' ? row.source === 'user' : true)).toBe(true)
    expect(read.truncated).toBe(false)

    const clipped = JSON.parse(text(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other', max_messages: 1 }))) as {
      messages: Array<{ text: string }>
      truncated: boolean
    }
    expect(clipped.messages).toHaveLength(1)
    expect(clipped.messages[0]!.text).toBe('second fixture line')
    expect(clipped.truncated).toBe(true)

    expectToolError(await execute(ctx, lead, 'read_session', { session_id: 'fleet-missing' }), 'session/not-found')
    expectToolError(
      await execute(ctx, lead, 'read_session', { session_id: 'fleet-other', max_messages: 0 }),
      'max_messages must be an integer from 1 through 50',
    )
  })

  it('searches sessions through the controller and surfaces hasMore', async () => {
    const { ctx, lead } = await setup()
    const found = JSON.parse(text(await execute(ctx, lead, 'search_sessions', { query: 'needle' }))) as {
      results: Array<{ sessionId: string; snippet: string }>
      hasMore: boolean
    }
    expect(found.results).toEqual([{ sessionId: 'fleet-lead', snippet: 'needle match' }])
    expect(found.hasMore).toBe(false)
  })

  it('creates sessions with the caller cwd or an explicit cwd, rejecting conflicts', async () => {
    const { ctx, lead } = await setup()
    const created = JSON.parse(text(await execute(ctx, lead, 'create_session', {}))) as { sessionId: string }
    expect(ctx.agents.get(SessionId(created.sessionId))!.session.header.cwd).toBe(lead.session.header.cwd)

    const explicit = JSON.parse(text(await execute(ctx, lead, 'create_session', { cwd: '/tmp' }))) as { sessionId: string }
    expect(ctx.agents.get(SessionId(explicit.sessionId))!.session.header.cwd).toBe('/tmp')

    expectToolError(
      await execute(ctx, lead, 'create_session', { cwd: '/tmp', workspace_id: 'ws' }),
      'accepts cwd or workspace_id, not both',
    )
  })

  it('queues and steers a fleet message and proves source identity in the target log', async () => {
    const { ctx, lead, other } = await setup()
    const sent = JSON.parse(text(await execute(ctx, lead, 'send_to_session', {
      session_id: 'fleet-other', message: 'please review the diff',
    }))) as { sessionId: string; delivery: string; accepted: boolean }
    expect(sent).toEqual({ sessionId: 'fleet-other', delivery: 'queue', accepted: true })
    expect(other.status).toBe('idle')

    await other.whenIdle()
    const fleetMessage = other.session.snapshotEvents().find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'session-fleet'
      && event.data.source.senderSessionId === 'fleet-lead')
    expect(fleetMessage).toBeDefined()
    expect(JSON.stringify(fleetMessage!.data.content)).toContain('please review the diff')
    expect(JSON.stringify(fleetMessage!.data.content)).toContain('peer-agent input')

    const steered = await execute(ctx, lead, 'send_to_session', {
      session_id: 'fleet-other', message: 'mid-turn note', delivery: 'steer',
    })
    expect(steered.isError, text(steered)).toBe(false)
    await other.whenIdle()
  })

  it('rejects unknown targets, self-delivery, oversized messages, and cross-workspace by default', async () => {
    const { ctx, lead } = await setup()
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-missing', message: 'hi' }), 'session/not-found')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-lead', message: 'note' }), 'targets another session')
    expectToolError(
      await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'x'.repeat(20_001) }),
      'exceeds 20000 characters',
    )
    expectToolError(
      await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-foreign', message: 'hello' }),
      'cross-workspace delivery is disabled',
    )
  })

  it('delivers across workspaces when the deployment opts in', async () => {
    const { ctx, lead, foreign } = await setup({ allowCrossWorkspace: true })
    const sent = await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-foreign', message: 'hi' })
    expect(sent.isError, text(sent)).toBe(false)
    await foreign.whenIdle()
    expect(foreign.session.snapshotEvents().some(event =>
      event.type === 'user/message' && event.data.source.kind === 'session-fleet')).toBe(true)
  })

  it('installs the complete scoped schema and policy, and disposes with the plugin fiber', async () => {
    const { ctx, lead, fleetFiber } = await setup()
    const scope = scopeOf(lead.ctx)
    const assembly = await ctx.systemPrompt.assemble({ scope })
    expect(assembly.tools.map(schema => schema.name).filter(name => FLEET_TOOLS.includes(name)).sort())
      .toEqual(FLEET_TOOLS)
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
    expect(ctx.tools.get('list_sessions', leadScope))
      .not.toBe(ctx.tools.get('list_sessions', secondScope))
  })
})


describe('session-fleet failure paths and optionality', () => {
  it('maps controller rejections from list and search into tool errors', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.sessionController, 'list').mockRejectedValue(new RemoteError('gateway/internal', 'list broke', {}))
    vi.spyOn(ctx.sessionController, 'search').mockRejectedValue(new RemoteError('gateway/internal', 'search broke', {}))
    expectToolError(await execute(ctx, lead, 'list_sessions', {}), 'gateway/internal: list broke')
    expectToolError(await execute(ctx, lead, 'search_sessions', { query: 'x' }), 'gateway/internal: search broke')
  })

  it('maps plain controller failures without RemoteError identity', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.sessionController, 'list').mockRejectedValue(new Error('plain failure'))
    expectToolError(await execute(ctx, lead, 'list_sessions', {}), 'plain failure')
  })

  it('projects assistant rows and non-text blocks with placeholders', async () => {
    const { ctx, lead, other } = await setup()
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }))
    await other.whenIdle()
    // The scripted mock adapter answered with a tool call-free text response? The default script is empty,
    // so drive one assistant answer through an explicit followup and empty adapter entry.
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const read = JSON.parse(text(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other' }))) as {
      messages: Array<{ role: string; source: string; text: string }>
    }
    expect(read.messages.every(row => typeof row.text === 'string')).toBe(true)
    expect(read.messages.some(row => row.source === 'user')).toBe(true)
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
    expectToolError(
      await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'hi' }),
      'session persistence did not acknowledge the message',
    )
    expect(spy).toHaveBeenCalled()
    expect(other.session.snapshotEvents().some(event =>
      event.type === 'user/message' && event.data.source.kind === 'session-fleet')).toBe(true)
  })

  it('defaults omitted config to the documented bounds', async () => {
    const { ctx, lead } = await setup({})
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 51 }), 'limit must be an integer from 1 through 50')
    expectToolError(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other', max_messages: 51 }), 'max_messages must be an integer from 1 through 50')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'x'.repeat(20_001) }), 'exceeds 20000 characters')
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
      inspect: vi.fn(async () => { throw new Error('unused') }),
      create: vi.fn(async () => ({ sessionId: agent.id })),
    }
    ctx.provide('sessionController', stub as never)
    const breaking = vi.spyOn(ctx.tools, 'register').mockImplementationOnce(() => { throw new Error('registration exploded') })
    await expect(ctx.plugin(fleet)).rejects.toThrow('registration exploded')
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
  it('projects assistant messages with model source in transcripts', async () => {
    const { ctx, lead, other } = await setup({}, [textResponse('assistant answer')])
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const read = JSON.parse(text(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other' }))) as {
      messages: Array<{ role: string; source: string; text: string }>
    }
    const assistant = read.messages.find(row => row.role === 'assistant')
    expect(assistant).toMatchObject({ role: 'assistant', source: 'model', text: 'assistant answer' })
  })

  it('reads a cwd-less session and omits the cwd field', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { inspect: ReturnType<typeof vi.fn> }
    stub.inspect.mockResolvedValueOnce({
      meta: { version: 3, id: SessionId('fleet-cwdless'), createdAt: 0, isSeeded: false },
      inheritedEventCount: 0,
      events: [],
    })
    const read = JSON.parse(text(await execute(ctx, lead, 'read_session', { session_id: 'fleet-cwdless' }))) as {
      cwd?: string
      messages: unknown[]
    }
    expect(read.cwd).toBeUndefined()
    expect(read.messages).toEqual([])
  })

  it('omits absent parent and origin fields in list rows', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { list: ReturnType<typeof vi.fn> }
    stub.list.mockResolvedValueOnce({
      items: [{
        sessionId: 'fleet-plain', updatedAt: 0, running: false, agentAvailable: false, blank: true,
      }],
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {}))) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listed.sessions[0]).toEqual({
      sessionId: 'fleet-plain', updatedAt: new Date(0).toISOString(), running: false, agentAvailable: false, blank: true,
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
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const scope = scopeOf(handle.agent.ctx)
    expect(ctx.tools.get('list_sessions', scope)).toBeDefined()
    await handle.dispose()
    expect(ctx.tools.get('list_sessions', scope)).toBeUndefined()
  })

  it('applies explicit config bounds over the defaults', async () => {
    const { ctx, lead } = await setup({ maxListRows: 2, maxReadMessages: 3, maxMessageChars: 10 })
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 3 }), 'limit must be an integer from 1 through 2')
    expectToolError(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other', max_messages: 4 }), 'max_messages must be an integer from 1 through 3')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'x'.repeat(11) }), 'exceeds 10 characters')
  })
})


describe('session-fleet projection edge values', () => {
  it('renders non-text content blocks as placeholders in transcripts', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { inspect: ReturnType<typeof vi.fn> }
    stub.inspect.mockResolvedValueOnce({
      meta: { version: 3, id: SessionId('fleet-blocks'), createdAt: 0, isSeeded: false, cwd: '/tmp' },
      inheritedEventCount: 0,
      events: [{
        type: 'user/message', seq: 1, time: 1,
        data: { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'x' }], source: { kind: 'user' } },
      }],
    })
    const read = JSON.parse(text(await execute(ctx, lead, 'read_session', { session_id: 'fleet-blocks' }))) as {
      messages: Array<{ text: string }>
    }
    expect(read.messages[0]!.text).toBe('[image]')
  })

  it('carries parent and origin fields in list rows when present', async () => {
    const { ctx, lead } = await setup()
    const stub = ctx.sessionController as unknown as { list: ReturnType<typeof vi.fn> }
    stub.list.mockResolvedValueOnce({
      items: [{
        sessionId: 'fleet-child', updatedAt: 8, running: true, agentAvailable: true, blank: false,
        parentSessionId: 'fleet-lead', origin: 'subagent', cwd: '/tmp',
      }],
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_sessions', {}))) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listed.sessions[0]).toEqual({
      sessionId: 'fleet-child', updatedAt: new Date(8).toISOString(), running: true, agentAvailable: true,
      blank: false, parentSessionId: 'fleet-lead', origin: 'subagent', cwd: '/tmp',
    })
  })

  it('fails loud on a duplicate plugin application to the same scope', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(fleet)).rejects.toThrow('already registered in this scope')
  })
})


describe('session-fleet apply defaults and re-entry', () => {
  it('resolves documented default bounds when loaded without config', async () => {
    const { ctx, lead } = await setup()
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 51 }), 'from 1 through 50')
    expectToolError(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other', max_messages: 51 }), 'from 1 through 50')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-other', message: 'x'.repeat(20_001) }), 'exceeds 20000 characters')
  })

  it('skips a second install when an agent re-enters the created path', async () => {
    const { ctx, lead } = await setup()
    const scope = scopeOf(lead.ctx)
    const before = ctx.tools.get('list_sessions', scope)
    // Re-emitting agent/created for an installed agent must not re-register.
    ctx.emit('agent/created', { agent: lead })
    expect(ctx.tools.get('list_sessions', scope)).toBe(before)
  })
})


describe('session-fleet bare apply defaults', () => {
  it('resolves all defaults when apply receives no config', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const stub = {
      resolveAgent: vi.fn(async (sessionId: SessionId) => sessionId === SessionId('foreign')
        ? { agent: { id: sessionId, session: { header: { id: sessionId, cwd: '/elsewhere' } } } }
        : { error: new RemoteError('session/not-found', 'no', { sessionId: SessionId('x') }) }),
      list: vi.fn(async () => ({ items: [] })),
      search: vi.fn(async () => ({ items: [], hasMore: false })),
      inspect: vi.fn(async () => { throw new Error('unused') }),
      create: vi.fn(async () => ({ sessionId: 'x' })),
    }
    ctx.provide('sessionController', stub as never)
    await ctx.plugin(fleet)
    const agent = await ctx.agentLoop.create(SessionId('fleet-default'), { provider: 'mock', model: 'mock' })
    expectToolError(await execute(ctx, agent, 'list_sessions', { limit: 51 }), 'from 1 through 50')
    expectToolError(await execute(ctx, agent, 'read_session', { session_id: 'fleet-default', max_messages: 51 }), 'from 1 through 50')
    expectToolError(await execute(ctx, agent, 'send_to_session', { session_id: 'foreign', message: 'x'.repeat(20_001) }), 'exceeds 20000 characters')
    expectToolError(await execute(ctx, agent, 'send_to_session', { session_id: 'foreign', message: 'hi' }), 'cross-workspace delivery is disabled')
  })
})


describe('session-fleet partial config defaults', () => {
  it('falls back per key when config sets only some keys', async () => {
    const { ctx, lead } = await setup({ maxListRows: 3 })
    expectToolError(await execute(ctx, lead, 'list_sessions', { limit: 4 }), 'from 1 through 3')
    expectToolError(await execute(ctx, lead, 'read_session', { session_id: 'fleet-other', max_messages: 51 }), 'from 1 through 50')
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-foreign', message: 'hi' }), 'cross-workspace delivery is disabled')
  })

  it('falls back message bound per key with a partial config', async () => {
    const { ctx, lead } = await setup({ allowCrossWorkspace: true, maxMessageChars: 5 })
    expectToolError(await execute(ctx, lead, 'send_to_session', { session_id: 'fleet-foreign', message: 'x'.repeat(6) }), 'exceeds 5 characters')
  })
})