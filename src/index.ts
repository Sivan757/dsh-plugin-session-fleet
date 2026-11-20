/** Scoped model-facing tools for discovering, reading, creating, and messaging DSH sessions. */

import type { Context } from '@deepseek-ai/cordis'
import { literalQuery } from './discovery.ts'
import { TranscriptStore } from './transcript.ts'
import { INSPECT_OUTPUT_SCHEMA, inspectParameters, inspectSession } from './inspection.ts'
import z from '@deepseek-ai/schemastery'
/**
 * Apply a domain brand to a value the domain already admitted.
 *
 * The host brands its identifiers with a `unique symbol` declared in `@deepseek-ai/dsh-brand`.
 * Every host 0.2.1-rc.2 package depends on that package at exactly 0.2.0-rc.2, so a plugin that
 * installs its own copy gets a second symbol and a type error naming `Branded<string>` rather
 * than the duplicate install. A cast states the same admission without depending on which
 * physical copy of the brand declaration the compiler resolved.
 * @param value - a string the owning domain admitted as this identifier.
 * @returns the same string carrying the compile-time brand.
 */
const asBrand = <T>(value: string): T => value as unknown as T
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PEER_MESSAGE_SCHEMA, preparePeerMessage } from './coordination.ts'
import { POLICY } from './policy.ts'
import { INBOX_OUTPUT_SCHEMA, inboxParameters, manageInbox, pendingRevision, refreshPendingPreviews } from './inbox.ts'
export type { CoordinationRecord } from './coordination.ts'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'

/** Cordis plugin name. */
export const name = 'tool-session-fleet'
/** Services required by the Session Fleet tool plugin. */
export const inject = ['agents', 'sessions', 'sessionController', 'sessionQuery', 'workspaceRegistry', 'tools', 'systemPrompt']

/** Fleet tool routing configuration. */
export interface Config {
  /** Whether an agent may message a session recorded under a different cwd. */
  readonly allowCrossWorkspace?: boolean
  /** Upper bound of one list_sessions response. */
  readonly maxListRows?: number
  /** Upper bound of one send_to_session message body in UTF-16 code units. */
  readonly maxMessageChars?: number
  /** Expose subagent-owned sessions to list, search, and read. Delivery stays refused. */
  readonly includeSubagents?: boolean
  /** Maximum UTF-8 bytes in one exported transcript, including row metadata. */
  readonly transcriptMaxBytes?: number
  /** Maximum retained exports for one mounted plugin. */
  readonly transcriptMaxFiles?: number
  /** Export lifetime in seconds; capacity eviction or unload may remove it sooner. */
  readonly transcriptTtlSeconds?: number
  /** Maximum UTF-16 text units per transcript chunk before escaping. */
  readonly transcriptChunkChars?: number
}

/** Loader schema for the Session Fleet tool plugin. */
export const Config: z<Config> = z.object({
  allowCrossWorkspace: z.boolean().default(false),
  maxListRows: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(50),
  maxMessageChars: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(20_000),
  includeSubagents: z.boolean().default(false),
  transcriptMaxBytes: z
    .natural()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(8 * 1024 * 1024),
  transcriptMaxFiles: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(20),
  transcriptTtlSeconds: z.natural().min(1).max(2_147_483).default(3600),
  transcriptChunkChars: z.natural().min(64).max(65_536).default(1024)
})

/** Model-facing collaboration guidance for fleet tools. */

const SESSION_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    running: { type: 'boolean', required: true },
    agentAvailable: { type: 'boolean', required: true },
    blank: { type: 'boolean', required: true },
    cwd: { type: 'string' },
    title: { type: 'string' },
    parentSessionId: { type: 'string' },
    origin: { type: 'string', enum: ['subagent'] }
  }
} as const

const LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessions: { type: 'array', required: true, items: SESSION_ROW_SCHEMA },
    total: { type: 'integer', required: true },
    hasMore: { type: 'boolean', required: true },
    nextOffset: { type: 'integer' },
    hiddenSubagentSessions: { type: 'integer' }
  }
} as const

const CREATE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    agentPreset: { type: 'string' }
  }
} as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    delivery: { type: 'string', required: true, enum: ['queue', 'steer'] },
    accepted: { type: 'boolean', required: true, const: true },
    messageId: { type: 'string', required: true },
    revision: { type: 'string', required: true, description: 'Expected revision for updating or withdrawing this delivery while it remains pending.' },
    persistence: { type: 'string', required: true, enum: ['acknowledged', 'unknown'] },
    retrySafe: { type: 'boolean', required: true, const: false },
    warning: { type: 'string' }
  }
} as const

/** Declare one canonical output schema with compact model-facing JSON. */
function jsonOutput<const S extends ValueSchemaSpec>(
  schema: S
): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }]
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Fleet tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  if (agent.id !== agent.session.header.id) throw new Error('Calling Agent identity does not match its session')
  return agent
}

/** One stable tool-result failure line for a controller rejection. */
function errorText(error: unknown): string {
  if (error instanceof RemoteError) return `${error.code}: ${error.message}`
  return String(error)
}

/** One model-facing fleet row derived from a session summary. */
function fleetRow(summary: SessionSummary): InferValue<typeof SESSION_ROW_SCHEMA> {
  return {
    sessionId: summary.sessionId,
    updatedAt: new Date(summary.updatedAt).toISOString(),
    running: summary.running,
    agentAvailable: summary.agentAvailable,
    blank: summary.blank,
    ...(typeof summary.projections?.values.title === 'string' ? { title: summary.projections.values.title } : {}),
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin })
  }
}

/** Compact relative age for one ISO timestamp. */
function compactAge(iso: string): string {
  const ageMs = Math.max(0, Date.now() - new Date(iso).getTime())
  if (ageMs < 60_000) return Math.round(ageMs / 1000) + 's'
  if (ageMs < 3_600_000) return Math.round(ageMs / 60_000) + 'm'
  if (ageMs < 86_400_000) return Math.round(ageMs / 3_600_000) + 'h'
  return Math.round(ageMs / 86_400_000) + 'd'
}

/** Parse a bounded recency window like 30s, 5m, 2h, 1d into milliseconds. */
function parseWithin(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value)
  const digits = match?.[1]
  const unit = match?.[2]
  if (digits === undefined || unit === undefined || digits.length > 9) throw new Error(`updated_within must look like 30s, 5m, 2h or 1d, got ${value}`)
  const ms = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return Number(digits) * ms
}

/** Render one compact fleet line: id | state | age | title | cwd-tail. */

/** Whether one value is a positive safe integer within `max`. */
function positiveInt(value: number | undefined, max: number): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= max)
}

/** Register the complete Session Fleet tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Config>, transcripts: TranscriptStore): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => {
    disposers.push(disposer)
  }
  try {
    register(
      scoped.systemPrompt.section({
        name: 'session-fleet:policy',
        order: scoped.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'),
        text: POLICY + '\nYour fleet session id: ' + JSON.stringify(agent.id) + '. Recorded workspace cwd: ' + JSON.stringify(agent.session.header.cwd ?? null) + '.'
      })
    )

    register(
      scoped.tools.register(
        defineTool({
          name: 'list_sessions',
          description:
            'List Host-visible DSH sessions with title, status, activity time, and working directory, without starting them. Narrow with query, cwd, status, updated_within or order; view:"compact" renders one line per session. Skip the scan for reads and for files only you write.',
          parameters: {
            query: {
              type: 'string',
              description: 'Optional literal title substring, case-insensitive, 1–500 UTF-16 code units. Works without a full-text index. Omit to list all sessions.'
            },
            limit: { type: 'integer', description: `Maximum rows to return, 1 through ${config.maxListRows}. Defaults to ${Math.min(20, config.maxListRows)}.` },
            cwd: { type: 'string', description: 'Only sessions whose recorded working directory starts with this absolute path.' },
            status: { type: 'string', description: 'Filter by state: running (executing now) or idle.', enum: ['running', 'idle'] },
            updated_within: { type: 'string', description: 'Only sessions updated within this window, e.g. 30m, 2h, 1d. Units: s, m, h, d.' },
            order: { type: 'string', description: 'Sort by most recent update (default) or sessionId.', enum: ['updated', 'id'] },
            view: { type: 'string', description: 'compact renders one pipe-delimited line per session instead of JSON objects.', enum: ['compact'] },
            offset: { type: 'integer', description: 'Zero-based row offset for continuation. Defaults to 0; pass nextOffset from a previous page.' }
          },
          output: {
            schema: LIST_VALUE_SCHEMA,
            render: (args: { view?: string }, value: InferValue<typeof LIST_VALUE_SCHEMA>) => [
              {
                type: 'text',
                text:
                  args.view === 'compact'
                    ? 'sessions:\n' +
                      value.sessions
                        .map(row =>
                          [
                            row.sessionId,
                            row.running ? 'running' : 'idle',
                            compactAge(row.updatedAt),
                            (row.title ?? '').slice(0, 40) + (row.cwd === undefined ? '' : ' …/' + row.cwd.split('/').filter(Boolean).slice(-2).join('/'))
                          ]
                            .filter(part => part.length > 0)
                            .join(' | ')
                        )
                        .join('\n') +
                      (value.hasMore && value.nextOffset !== undefined ? '\nnextOffset: ' + value.nextOffset : '')
                    : JSON.stringify(value)
              }
            ]
          },
          async execute(args, exec) {
            callingAgent(exec.agent, 'list_sessions')
            if (!positiveInt(args.limit, config.maxListRows)) {
              throw new Error(`limit must be an integer from 1 through ${config.maxListRows}`)
            }
            if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
              throw new Error('offset must be a non-negative integer')
            }
            const offset: number = args.offset ?? 0
            try {
              const query = args.query === undefined ? undefined : literalQuery(args.query).toLowerCase()
              const withinMs = args.updated_within === undefined ? undefined : parseWithin(args.updated_within)
              if (args.order !== undefined && args.order !== 'updated' && args.order !== 'id') throw new Error('order must be updated or id')
              const { items } = await ctx.sessionController.list({}, exec.signal)
              const visible = config.includeSubagents ? items : items.filter(row => row.origin !== 'subagent')
              const prefix = args.cwd
              const now = Date.now()
              const filtered = visible
                .filter(row => prefix === undefined || row.cwd?.startsWith(prefix))
                .filter(row => query === undefined || (typeof row.projections?.values.title === 'string' && row.projections.values.title.toLowerCase().includes(query)))
                .filter(row => (args.status === undefined || row.running === (args.status === 'running')) && (withinMs === undefined || now - row.updatedAt <= withinMs))
                .sort((a, b) => (args.order === 'id' ? a.sessionId.localeCompare(b.sessionId) : b.updatedAt - a.updatedAt) || a.sessionId.localeCompare(b.sessionId))
              const limit = args.limit ?? Math.min(20, config.maxListRows)
              const page = filtered.slice(offset, offset + limit)
              const hasMore = offset + page.length < filtered.length
              return {
                sessions: page.map(fleetRow),
                total: filtered.length,
                hasMore,
                ...(hasMore ? { nextOffset: offset + page.length } : {}),
                ...(items.length === visible.length ? {} : { hiddenSubagentSessions: items.length - visible.length })
              }
            } catch (error: unknown) {
              throw new Error(errorText(error))
            }
          }
        })
      )
    )

    register(
      scoped.tools.register(
        defineTool({
          name: 'inspect_session',
          description:
            'Inspect one session without starting it: outline, event search, tool calls and failures, or one exact event. Pass mode to choose; search and calls return follow-up arguments.',
          parameters: inspectParameters(config.maxListRows),
          output: jsonOutput(INSPECT_OUTPUT_SCHEMA),
          execute(args, exec) {
            return inspectSession(ctx, callingAgent(exec.agent, 'inspect_session'), config, transcripts, args, exec.signal)
          }
        })
      )
    )

    register(
      scoped.tools.register(
        defineTool({
          name: 'manage_session_inbox',
          description:
            'List still-pending Fleet peer input; list does not start the Agent. Replace a pending message you sent, or withdraw one you sent or one in your own inbox. Human input and consumed history stay untouched.',
          parameters: inboxParameters,
          output: jsonOutput(INBOX_OUTPUT_SCHEMA),
          async execute(args, exec) {
            return manageInbox(ctx, callingAgent(exec.agent, 'manage_session_inbox'), config, args, exec.signal)
          }
        })
      )
    )
    register(
      scoped.tools.register(
        defineTool({
          name: 'create_session',
          description: 'Create an independent ordinary conversation, attached to a workspace so it appears in the session list. Prefer native delegation for owned subtasks.',
          parameters: {
            cwd: { type: 'string', description: 'Absolute working directory for the new session.' },
            workspace_id: { type: 'string', description: 'Existing workspace to attach the new session to.' }
          },
          output: jsonOutput(CREATE_VALUE_SCHEMA),
          async execute(args, exec) {
            const caller = callingAgent(exec.agent, 'create_session')
            if (args.cwd !== undefined && args.workspace_id !== undefined) {
              throw new Error('create_session accepts cwd or workspace_id, not both')
            }
            let workspaceId = args.workspace_id
            if (workspaceId === undefined) {
              // Attach the new session to a workspace so it appears in the session list.
              // An explicit cwd attaches only to its own workspace; otherwise use the caller's.
              const resolved = args.cwd === undefined ? undefined : await ctx.workspaceRegistry.resolveByPath(args.cwd)
              const callerWs = ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(caller.id))
              workspaceId = (resolved ?? (args.cwd === undefined ? callerWs : undefined))?.id
            }
            // The controller rejects a request carrying both fields; a workspace attachment carries the location itself.
            const cwd = workspaceId === undefined ? (args.cwd ?? caller.session.header.cwd) : undefined
            if (workspaceId === undefined && cwd === undefined) {
              throw new Error('create_session could not resolve a working directory; pass cwd')
            }
            let created
            try {
              created = await ctx.sessionController.create({
                ...(cwd === undefined ? {} : { cwd }),
                ...(workspaceId === undefined ? {} : { workspaceId: asBrand<WorkspaceId>(workspaceId) })
              })
            } catch (error: unknown) {
              throw new Error(errorText(error))
            }
            return {
              sessionId: created.sessionId,
              ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset })
            }
          }
        })
      )
    )

    register(
      scoped.tools.register(
        defineTool({
          name: 'send_to_session',
          description:
            'Send peer input, not a user instruction, to another ordinary session; the receipt admits delivery, not agreement. Use message objects, never JSON text. Inspect only a peer whose unfinished work overlaps a path or exclusive resource you are about to touch, then send one proposal naming paths and order. The recipient replies accept or block with reply_to; silence never releases ownership. Delivery to a session whose recorded cwd differs is refused unless the host enables cross-workspace delivery.',
          parameters: {
            session_id: { type: 'string', required: true, description: 'Target session id returned by list_sessions or create_session.' },
            message: { ...PEER_MESSAGE_SCHEMA, required: true },
            delivery: {
              type: 'string',
              enum: ['queue', 'steer'],
              description:
                'steer delivers at the next step without stopping running tools; queue waits for the current turn to end. Defaults to steer for structured coordination and queue for strings. Choose queue only when the information can wait.'
            }
          },
          output: jsonOutput(SEND_VALUE_SCHEMA),
          async execute(args, exec) {
            const caller = callingAgent(exec.agent, 'send_to_session')
            const delivery = args.delivery ?? (typeof args.message === 'string' ? 'queue' : 'steer')
            if (asBrand<SessionId>(args.session_id) === caller.id) {
              throw new Error('send_to_session targets another session; speak in your own conversation instead')
            }
            let history: readonly SessionEvent[] = []
            if (typeof args.message !== 'string' && args.message.reply_to !== undefined) {
              const snapshot = await ctx.sessionQuery.readSession(caller.id)
              exec.signal.throwIfAborted()
              if (snapshot.session.id !== caller.id) throw new Error('Coordination history returned a different session')
              history = snapshot.events
            }
            const message = preparePeerMessage(caller.id, asBrand<SessionId>(args.session_id), args.message, config.maxMessageChars, history)
            const resolved = await ctx.sessionController.resolveAgent(asBrand<SessionId>(args.session_id))
            if ('error' in resolved) throw new Error(errorText(resolved.error))
            const target = resolved.agent
            if (target.id !== args.session_id || target.session.header.id !== target.id || target.id === caller.id)
              throw new Error('Resolved delivery target identity is invalid; self-delivery is refused')
            if (target.session.header.origin === 'subagent') {
              throw new Error(`session "${target.id}" is a subagent session; fleet delivery is limited to ordinary sessions`)
            }
            if (!config.allowCrossWorkspace && caller.session.header.cwd !== target.session.header.cwd) {
              throw new Error(
                `session "${target.id}" belongs to workspace "${String(target.session.header.cwd)}", not "${String(caller.session.header.cwd)}"; cross-workspace delivery is disabled by config`
              )
            }

            try {
              if (delivery === 'steer') target.steer(message)
              else target.followup(message)
            } catch (error) {
              throw new Error(`Delivery outcome is unknown for message ${message.id} to ${target.id}. Inspect before retrying; repeated sends are not deduplicated.`, {
                cause: error
              })
            }
            let warning: string | undefined
            try {
              if (!(await ctx.sessions.flush(target.session))) warning = 'Session persistence did not acknowledge the message.'
            } catch (error) {
              warning = 'Session persistence acknowledgement failed: ' + errorText(error)
            }
            return {
              sessionId: target.id,
              delivery,
              accepted: true,
              messageId: message.id,
              revision: pendingRevision(message),
              persistence: warning === undefined ? ('acknowledged' as const) : ('unknown' as const),
              retrySafe: false as const,
              ...(warning === undefined
                ? {}
                : { warning: warning + ' The target may already have received this message. Inspect before retrying; repeated sends are not deduplicated.' })
            }
          }
        })
      )
    )
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Session Fleet tools in every live or subsequently published Agent scope. */
export async function apply(ctx: Context, options: Config): Promise<void> {
  const config = Config(options) as Required<Config>
  const transcripts = new TranscriptStore(
    { maxBytes: config.transcriptMaxBytes, maxFiles: config.transcriptMaxFiles, ttlSeconds: config.transcriptTtlSeconds, chunkChars: config.transcriptChunkChars },
    error => ctx.logger.warn('Session Fleet transcript cleanup failed: %s', String(error))
  )
  ctx.effect(() => () => transcripts.dispose(), 'tool-session-fleet.transcripts()')
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, install(agent, ctx, config, transcripts))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(
    () => () => {
      for (const dispose of installed.values()) dispose()
      installed.clear()
    },
    'tool-session-fleet.scopedTools()'
  )
  for (const agent of ctx.agents.list()) {
    if (refreshPendingPreviews(agent) === 0) continue
    try {
      if (!(await ctx.sessions.flush(agent.session))) ctx.logger.warn('Fleet pending preview refresh persistence was not acknowledged: %s', agent.id)
    } catch (error) {
      ctx.logger.warn('Fleet pending preview refresh persistence failed: %s', String(error))
    }
  }
}
