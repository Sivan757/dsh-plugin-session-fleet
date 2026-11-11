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
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { jsonlPersistencePlugin } from '../testkit/jsonl-persistence.ts'
import { MockAdapter } from '../testkit/mock-adapter.ts'
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
  await ctx.loader.resolve('fleet').fiber!.dispose()
  expect(ctx.tools.get('send_to_session', scopeOf(caller.ctx))).toBeUndefined()
})
