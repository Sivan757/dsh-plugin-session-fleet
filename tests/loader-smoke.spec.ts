/** Fleet tools loaded from YAML over the real controller, workspace registry, and durable storage. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import Typert from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { jsonlPersistencePlugin } from '../testkit/jsonl-persistence.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../testkit/mock-adapter.ts'
import * as fleet from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('loads the configured fleet with real workspace creation, delivery, inspection, and teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-loader-smoke-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  const explicitCwd = join(root, 'explicit')
  await mkdir(cwd)
  await mkdir(explicitCwd)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const runtime = {
    name: 'fleet-smoke-runtime',
    async apply(test: Context) {
      await mountAgentLoopTestDependencies(test)
      await test.plugin(jsonlPersistencePlugin, { root: join(root, 'sessions') })
      await test.plugin(SessionQuery, { path: ':memory:', openAt: 'first-search' })
      await test.plugin(AgentLoop, { agents: [] })
      test.get('llm')!.registerAdapter(['mock'], new MockAdapter([]))
      // Image uploads and GUI receipt transport are outside this text-only test.
      test.provide('attachments', {
        imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] }
      } as never)
      test.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
    }
  }
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    runtime,
    storage: Storage,
    json: StorageJson,
    domain: StorageDomain,
    workspace: WorkspaceRegistry,
    typert: Typert,
    access: RemoteAccess,
    filesystem: FsLocal,
    'default-model': AgentDefaultModel,
    controller: SessionController,
    fleet
  })
  const entries = yaml.load(await readFile(new URL('../testkit/fleet-smoke.yml', import.meta.url), 'utf8')) as Array<{ id: string; name: string; config?: unknown }>
  const patch = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as Array<{ insert: Array<{ config: fleet.Config }> }>
  for (const entry of entries) {
    if (entry.id === 'json') entry.config = { root: join(root, 'storage') }
    if (entry.id === 'fleet') entry.config = patch[0]!.insert[0]!.config
    await ctx.loader.create(entry)
    await ctx.loader.resolve(entry.id).fiber!.await()
  }
  await ctx.loader.await()
  expect(ctx.get('sessionController')).toBeDefined()
  expect(ctx.get('workspaceRegistry')).toBeDefined()
  const workspace = await ctx.workspaceRegistry.create(cwd)
  const created = await ctx.sessionController.create({ workspaceId: workspace.id })
  const caller = ctx.agents.get(created.sessionId)!
  expect(workspace.sessionIds).toContain(caller.id)
  let call = 0
  const execute = async (name: string, args: unknown) => {
    const result = await ctx.tools.execute({ callId: ToolCallId('smoke-' + ++call), name, arguments: args, signal: new AbortController().signal, agent: caller })
    const text = result.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
    expect(result.isError, text).not.toBe(true)
    return JSON.parse(text)
  }
  const explicit = await execute('create_session', { cwd: explicitCwd })
  expect(ctx.agents.get(SessionId(explicit.sessionId))!.session.header.cwd).toBe(explicitCwd)
  const inherited = await execute('create_session', {})
  expect(workspace.sessionIds).toContain(inherited.sessionId)
  await execute('send_to_session', { session_id: inherited.sessionId, message: 'loader smoke message' })
  await ctx.agents.get(SessionId(inherited.sessionId))!.whenIdle()
  const inspected = await execute('inspect_session', { session_id: inherited.sessionId, transcript: true })
  cleanups.push(() => rm(inspected.transcriptPath, { force: true }))
  expect(inspected.counts.user).toBe(1)
  expect(inspected.recentPrompts[0].source).toBe('session-fleet')
  expect(inspected.recentPrompts[0].senderSessionId).toBe(caller.id)
  expect(inspected.recentPrompts[0].text).toContain('loader smoke message')
  expect(await readFile(inspected.transcriptPath, 'utf8')).toContain('loader smoke message')
  const second = await execute('create_session', {})
  await execute('send_to_session', { session_id: second.sessionId, message: 'loader smoke message' })
  await ctx.agents.get(SessionId(second.sessionId))!.whenIdle()
  const child = await ctx.agentLoop.create(SessionId('smoke-child'), { provider: 'mock', model: 'mock', cwd, origin: 'subagent', parentSessionId: caller.id })
  child.followup(createUserMessage({ content: [{ type: 'text', text: 'loader smoke message' }], source: { kind: 'user' } }))
  await child.whenIdle()
  const found = await execute('search_sessions', { query: 'smoke message', cwd: workspace.path, limit: 1 })
  expect(found.results).toHaveLength(1)
  expect(found.nextCursor).toBeTypeOf('string')
  const next = await execute('search_sessions', { query: 'smoke message', cwd: workspace.path, limit: 1, cursor: found.nextCursor })
  expect(next.results).toHaveLength(1)
  expect(next.hasMore).toBe(false)
  expect(new Set([...found.results, ...next.results].map(row => row.sessionId))).toEqual(new Set([inherited.sessionId, second.sessionId]))
  expect(found.results[0].seq).toBeTypeOf('number')
  const listed = await execute('list_sessions', { cwd: workspace.path, limit: 1 })
  const listedAgain = await execute('list_sessions', { cwd: workspace.path, limit: 1, cursor: listed.nextCursor })
  expect(listedAgain.sessions[0].sessionId).not.toBe(listed.sessions[0].sessionId)
  const actualPages: string[] = []
  const request = { query: 'smoke message', cwd: workspace.path, limit: 1 }
  const toolText = (options: import('@deepseek-ai/dsh-llm').GenerateOptions) =>
    options.messages
      .findLast(message => message.role === 'tool')!
      .content.flatMap(block => (block.type === 'text' ? [block.text] : []))
      .join('')
  const continueSearch = (options: import('@deepseek-ai/dsh-llm').GenerateOptions) => {
    const text = toolText(options)
    actualPages.push(text)
    const page = JSON.parse(text)
    return page.hasMore ? toolCallResponse('page-' + actualPages.length, 'search_sessions', { ...request, cursor: page.nextCursor }) : textResponse('finished')
  }
  ctx.get('llm')!.registerAdapter(['fleet-paging'], new MockAdapter([toolCallResponse('page-one', 'search_sessions', request), ...Array.from({ length: 6 }, () => continueSearch)]))
  const pager = await ctx.agentLoop.create(SessionId('fleet-real-tool-pager'), { provider: 'fleet-paging', model: 'mock' }, { cwd: workspace.path })
  pager.followup(createUserMessage({ content: [{ type: 'text', text: 'exercise discovery continuation' }], source: { kind: 'user' } }))
  await pager.whenIdle()
  expect(actualPages.length).toBeGreaterThanOrEqual(2)
  const paged = actualPages.map(text => JSON.parse(text))
  const ids = paged.flatMap(page => page.results.map((row: { sessionId: string }) => row.sessionId))
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toEqual(expect.arrayContaining([inherited.sessionId, second.sessionId]))
  expect(paged.at(-1).hasMore).toBe(false)
  const coldId = SessionId('fleet-native-cold-fixture')
  const original = ctx.agents.get(SessionId(inherited.sessionId))!.session
  const persisted = await ctx.get('sessionPersistence')!.create({ ...original.header, id: coldId })
  try {
    await persisted.append(original.snapshotEvents())
    await persisted.flush()
  } finally {
    await persisted.close()
  }
  expect(ctx.agents.get(coldId)).toBeUndefined()
  const resume = vi.spyOn(ctx.sessionController, 'resolveAgent')
  const nativeSteps: string[] = []
  const capture = (options: import('@deepseek-ai/dsh-llm').GenerateOptions) => {
    const text = toolText(options)
    expect(text).not.toMatch(/^Error:/)
    const value = JSON.parse(text)
    nativeSteps.push(text)
    return value
  }
  ctx.get('llm')!.registerAdapter(
    ['fleet-native-details'],
    new MockAdapter([
      toolCallResponse('native-outline', 'inspect_session', { session_id: coldId }),
      options => {
        const outline = capture(options)
        return toolCallResponse('native-search', outline.detailAccess.search.tool, { ...outline.detailAccess.search.arguments, query: 'loader smoke message' })
      },
      options => {
        const hits = capture(options)
        const hit = hits.results.find((event: { type: string }) => event.type === 'user/message')
        expect(hit).toBeDefined()
        return toolCallResponse('native-read', hits.detailAccess.read.tool, { ...hits.detailAccess.read.arguments, seq: hit.seq })
      },
      options => {
        capture(options)
        return toolCallResponse('native-calls', 'inspect_session', { session_id: 'fleet-native-reader', mode: 'calls', limit: 1 })
      },
      options => {
        const page = capture(options)
        expect(page.counts).toEqual({ outer: 3, nested: 0, failed: 0, pending: 0 })
        expect(page.calls).toHaveLength(1)
        expect(page.calls[0].status).toBe('succeeded')
        expect(page.next.arguments.until_seq).toBe(page.asOfSeq)
        return toolCallResponse('native-calls-next', page.next.tool, page.next.arguments)
      },
      options => {
        const page = capture(options)
        expect(page.counts.outer).toBe(3)
        expect(page.total).toBe(3)
        expect(page.detailAccess.read.arguments.seq).toBe(page.calls[0].resultSeq)
        return toolCallResponse('native-call-result', page.detailAccess.read.tool, page.detailAccess.read.arguments)
      },
      options => {
        expect(capture(options).event.type).toBe('tool/result')
        return textResponse('native detail verified')
      }
    ])
  )
  const reader = await ctx.agentLoop.create(SessionId('fleet-native-reader'), { provider: 'fleet-native-details', model: 'mock' }, { cwd: workspace.path })
  reader.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the selected archived session and read its matching original event.' }], source: { kind: 'user' } }))
  await reader.whenIdle()
  expect(nativeSteps.map(text => JSON.parse(text).mode)).toEqual(['outline', 'search', 'read', 'calls', 'calls', 'read'])
  const readEvent = JSON.parse(nativeSteps[2]!).event
  expect(readEvent).toEqual(original.snapshotEvents().find(event => event.seq === readEvent.seq))
  expect(readEvent.data.content.some((block: { text?: string }) => block.text === 'loader smoke message')).toBe(true)
  expect(ctx.agents.get(coldId)).toBeUndefined()
  expect(resume).not.toHaveBeenCalled()
  const selfResults: string[] = []
  ctx.get('llm')!.registerAdapter(
    ['fleet-native-self'],
    new MockAdapter([
      toolCallResponse('native-self-search', 'inspect_session', { session_id: 'fleet-native-self-reader', mode: 'search', query: 'only-in-current-tool-needle-72' }),
      options => {
        selfResults.push(toolText(options))
        return textResponse('self search verified')
      }
    ])
  )
  const selfReader = await ctx.agentLoop.create(SessionId('fleet-native-self-reader'), { provider: 'fleet-native-self', model: 'mock' }, { cwd: workspace.path })
  selfReader.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise native search isolation in the current step.' }], source: { kind: 'user' } }))
  await selfReader.whenIdle()
  expect(selfResults).toHaveLength(1)
  expect(JSON.parse(selfResults[0]!)).toMatchObject({ mode: 'search', results: [], hasMore: false })
  const ownerId = SessionId('coord-owner')
  const reviewerId = SessionId('coord-reviewer')
  const sharedFile = join(workspace.path, 'coordination-proof.txt')
  const observed = Promise.withResolvers<void>()
  const receivedCoordination = (options: import('@deepseek-ai/dsh-llm').GenerateOptions) => {
    const message = options.messages.findLast(item => item.role === 'user' && item.source.kind === 'session-fleet')
    if (message?.role !== 'user' || message.source.kind !== 'session-fleet' || message.source.coordination === undefined) throw new Error('missing native coordination message')
    expect(message.content[0]).toMatchObject({ text: expect.stringContaining(message.id) })
    return { id: message.id, contract: message.source.coordination }
  }
  let writes = 0
  let acceptanceId = ''
  ctx.llm.registerAdapter(
    ['coord-owner'],
    new MockAdapter([
      toolCallResponse('coord-discover', 'list_sessions', { cwd: workspace.path }),
      () => toolCallResponse('coord-inspect', 'inspect_session', { session_id: reviewerId }),
      () =>
        toolCallResponse('coord-propose', 'send_to_session', {
          session_id: reviewerId,
          message: {
            kind: 'propose',
            task: 'Implement shared validation',
            owner: ownerId,
            scope: ['write:' + sharedFile],
            summary: 'I implement validation. Please review without modifying this file.',
            next: 'Accept the division or identify the overlap before work starts.'
          }
        }),
      options => {
        expect(JSON.parse(toolText(options))).toMatchObject({ accepted: true, retrySafe: false })
        expect(writes).toBe(0)
        return textResponse('Proposal delivered. Awaiting explicit agreement.')
      },
      options => {
        const accepted = receivedCoordination(options)
        expect(accepted.contract).toMatchObject({ kind: 'accept', owner: ownerId, scope: ['write:' + sharedFile] })
        acceptanceId = accepted.id
        writeFileSync(sharedFile, 'validation complete')
        writes++
        return toolCallResponse('coord-complete', 'send_to_session', {
          session_id: reviewerId,
          message: { kind: 'complete', reply_to: acceptanceId, summary: 'Validation complete; artifact is saved at the agreed path.' }
        })
      },
      () => textResponse('Completed the agreed scope.')
    ])
  )
  ctx.llm.registerAdapter(
    ['coord-reviewer'],
    new MockAdapter([
      options => {
        const proposed = receivedCoordination(options)
        expect(proposed.contract.kind).toBe('propose')
        return toolCallResponse('coord-accept', 'send_to_session', {
          session_id: ownerId,
          message: { kind: 'accept', reply_to: proposed.id, summary: 'Agreed. I review only and leave the shared file to you.' }
        })
      },
      () => textResponse('Accepted the scope; no further acknowledgement is needed.'),
      options => {
        expect(receivedCoordination(options).contract.kind).toBe('complete')
        observed.resolve()
        return textResponse('Completion observed. No acknowledgement sent.')
      }
    ])
  )
  const owner = await ctx.agentLoop.create(ownerId, { provider: 'coord-owner', model: 'mock' }, { cwd: workspace.path })
  const reviewer = await ctx.agentLoop.create(reviewerId, { provider: 'coord-reviewer', model: 'mock' }, { cwd: workspace.path })
  owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Coordinate the authorized shared validation work before editing.' }], source: { kind: 'user' } }))
  await observed.promise
  await owner.whenIdle()
  await reviewer.whenIdle()
  expect(writes).toBe(1)
  expect(await readFile(sharedFile, 'utf8')).toBe('validation complete')
  const contracts = (await Promise.all([ctx.sessionQuery.readSession(ownerId), ctx.sessionQuery.readSession(reviewerId)])).flatMap(snapshot =>
    snapshot.events.flatMap(event => (event.type === 'user/message' && event.data.source.kind === 'session-fleet' ? [event.data.source.coordination?.kind] : []))
  )
  expect(contracts.sort()).toEqual(['accept', 'complete', 'propose'])
  const assigneeId = SessionId('coord-assignee')
  const assigneeDone = Promise.withResolvers<void>()
  let receivedProposalId = ''
  ctx.llm.registerAdapter(
    ['coord-assignee'],
    new MockAdapter([
      options => {
        receivedProposalId = receivedCoordination(options).id
        return toolCallResponse('assignee-accept', 'send_to_session', {
          session_id: caller.id,
          message: { kind: 'accept', reply_to: receivedProposalId, summary: 'I accept the assigned scope.' }
        })
      },
      () =>
        toolCallResponse('assignee-complete', 'send_to_session', {
          session_id: caller.id,
          message: { kind: 'complete', reply_to: receivedProposalId, summary: 'Assigned work completed and checked.' }
        }),
      () =>
        toolCallResponse('assignee-handoff', 'send_to_session', {
          session_id: caller.id,
          message: {
            kind: 'handoff',
            reply_to: receivedProposalId,
            task: 'Assigned review',
            owner: caller.id,
            scope: ['write:/fixture/review'],
            summary: 'My work is saved and I have stopped.',
            next: 'Accept the handoff before resuming the scope.'
          }
        }),
      () =>
        toolCallResponse('assignee-release', 'send_to_session', {
          session_id: caller.id,
          message: { kind: 'release', reply_to: receivedProposalId, summary: 'Stopped; the scope is released.' }
        }),
      () => {
        assigneeDone.resolve()
        return textResponse('Assignee lifecycle verified.')
      }
    ])
  )
  const assignee = await ctx.agentLoop.create(assigneeId, { provider: 'coord-assignee', model: 'mock' }, { cwd: workspace.path })
  const assignment = await execute('send_to_session', {
    session_id: assignee.id,
    message: {
      kind: 'propose',
      task: 'Assigned review',
      owner: assignee.id,
      scope: ['write:/fixture/review'],
      summary: 'Please own the review scope; I will leave it unchanged.',
      next: 'Accept or identify a conflict.'
    }
  })
  await assigneeDone.promise
  await assignee.whenIdle()
  await caller.whenIdle()
  const receivedReplies = (await ctx.sessionQuery.readSession(caller.id)).events.flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'session-fleet' && event.data.source.senderSessionId === assignee.id ? [event.data.source.coordination] : []
  )
  expect(receivedReplies.map(reply => reply?.kind)).toEqual(['accept', 'complete', 'handoff', 'release'])
  expect(receivedReplies[0]?.reply_to).toBe(assignment.messageId)
  await ctx.loader.resolve('fleet').fiber!.dispose()
  expect(ctx.tools.get('send_to_session', scopeOf(caller.ctx))).toBeUndefined()
})
