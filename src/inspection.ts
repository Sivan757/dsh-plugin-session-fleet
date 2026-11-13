/** Native session inspection and the follow-up calls exposed to an Agent. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { TRANSCRIPT_EVENT_TYPES, type TranscriptStore } from './transcript.ts'
import { literalQuery } from './discovery.ts'
import { CALL_ROW_SCHEMA, toolCallPage } from './calls.ts'
import { SessionQueryError, buildSessionEventSearchDocuments, compileSessionTextFilter, filterSessionEventDocuments } from '@deepseek-ai/dsh-session-query'

const INSPECT_MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    messageId: { type: 'string', required: true },
    senderSessionId: { type: 'string' },
    role: { type: 'string', required: true, enum: ['user', 'assistant'] },
    source: { type: 'string', required: true },
    text: { type: 'string', required: true },
    truncated: { type: 'boolean' },
    fullLength: { type: 'integer' }
  }
} as const

const INSPECT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    running: { type: 'boolean', required: true },
    agentAvailable: { type: 'boolean', required: true },
    cwd: { type: 'string' },
    parentSessionId: { type: 'string' },
    origin: { type: 'string', enum: ['subagent'] },
    agentPreset: { type: 'string' },
    eventCount: { type: 'integer', required: true },
    counts: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        user: { type: 'integer', required: true },
        assistant: { type: 'integer', required: true },
        toolCalls: { type: 'integer', required: true }
      }
    },
    recentPrompts: { type: 'array', required: true, items: INSPECT_MESSAGE_SCHEMA },
    lastAssistant: INSPECT_MESSAGE_SCHEMA,
    asOfSeq: { type: 'integer', required: true },
    includedEventTypes: { type: 'array', required: true, items: { type: 'string' } },
    omittedEventTypes: { type: 'array', required: true, items: { type: 'string' } },
    transcriptPath: { type: 'string' },
    transcriptLines: { type: 'integer' },
    transcriptBytes: { type: 'integer' },
    transcriptTruncated: { type: 'boolean' },
    transcriptExpiresAt: { type: 'string' }
  }
} as const

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string', required: true, const: 'inspect_session' },
    arguments: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', required: true },
        mode: { type: 'string', required: true, enum: ['search', 'read', 'calls'] },
        from_seq: { type: 'integer' },
        until_seq: { type: 'integer' },
        errors_only: { type: 'boolean' },
        limit: { type: 'integer' },
        seq: { type: 'integer' },
        before: { type: 'integer' },
        after: { type: 'integer' }
      }
    },
    requiredArguments: { type: 'array', required: true, items: { type: 'string', enum: ['query'] } }
  }
} as const
const DETAIL_ACCESS_SCHEMA = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: { search: { ...ACTION_SCHEMA, required: true }, calls: { ...ACTION_SCHEMA, required: true }, read: ACTION_SCHEMA }
} as const
const OUTLINE_SCHEMA = {
  ...INSPECT_VALUE_SCHEMA,
  properties: {
    ...INSPECT_VALUE_SCHEMA.properties,
    mode: { type: 'string', required: true, const: 'outline' },
    source: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, enum: ['located', 'unavailable', 'error'] },
        location: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true }, path: { type: 'string', required: true } } },
        revision: { type: 'string' },
        reason: { type: 'string' }
      }
    },
    detailAccess: DETAIL_ACCESS_SCHEMA
  }
} as const
const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', required: true, const: 'search' },
    searchMode: { type: 'string', enum: ['literal'] },
    sessionId: { type: 'string', required: true },
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'integer', required: true },
          type: { type: 'string', required: true },
          time: { type: 'string', required: true },
          surface: { type: 'string', required: true },
          snippet: { type: 'string', required: true }
        }
      }
    },
    hasMore: { type: 'boolean', required: true },
    guidance: { type: 'string' },
    detailAccess: DETAIL_ACCESS_SCHEMA
  }
} as const
const CONTEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    type: { type: 'string', required: true },
    time: { type: 'string', required: true },
    messageId: { type: 'string' },
    senderSessionId: { type: 'string' },
    role: { type: 'string' },
    source: { type: 'string' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    fullLength: { type: 'integer' }
  }
} as const
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', required: true, const: 'read' },
    sessionId: { type: 'string', required: true },
    event: { type: 'json', required: true },
    text: {
      type: 'string',
      required: true,
      description: 'Readable text or tool arguments/results, up to 8000 UTF-16 units. Nontext events return an empty string; event retains the complete original.'
    },
    truncated: { type: 'boolean' },
    fullLength: { type: 'integer' },
    context: { type: 'array', required: true, items: CONTEXT_SCHEMA },
    startSeq: { type: 'integer', required: true },
    endSeq: { type: 'integer', required: true },
    detailAccess: DETAIL_ACCESS_SCHEMA
  }
} as const
const CALLS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', required: true, const: 'calls' },
    sessionId: { type: 'string', required: true },
    asOfSeq: { type: 'integer', required: true },
    counts: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        outer: { type: 'integer', required: true },
        nested: { type: 'integer', required: true },
        failed: { type: 'integer', required: true },
        pending: { type: 'integer', required: true }
      }
    },
    total: { type: 'integer', required: true },
    calls: { type: 'array', required: true, items: CALL_ROW_SCHEMA },
    hasMore: { type: 'boolean', required: true },
    next: ACTION_SCHEMA,
    detailAccess: DETAIL_ACCESS_SCHEMA
  }
} as const

/** Discriminated results retain the existing outline fields. */
export const INSPECT_OUTPUT_SCHEMA = { oneOf: [OUTLINE_SCHEMA, SEARCH_SCHEMA, READ_SCHEMA, CALLS_SCHEMA] } as const

/** Flat arguments keep native lookup selectors explicit to the model. */
export interface InspectArgs {
  session_id: string
  mode?: 'outline' | 'search' | 'read' | 'calls'
  transcript?: boolean
  query?: string
  limit?: number
  seq?: number
  before?: number
  after?: number
  from_seq?: number
  until_seq?: number
  errors_only?: boolean
}
interface InspectionConfig {
  includeSubagents: boolean
  maxListRows: number
}
const CONTEXT_MAX = 10

/** Model-facing selectors and per-mode parameter rules. */
export function inspectParameters(maxRows: number) {
  return {
    session_id: { type: 'string', required: true, description: 'Session id from list_sessions or search_sessions.' },
    mode: {
      type: 'string',
      enum: ['outline', 'search', 'read', 'calls'],
      description: 'Defaults to outline. Use calls for tool inputs, results and failures, search to find events, or read for readable text and the complete original event.'
    },
    transcript: { type: 'boolean', description: 'Only for outline: generate a bounded private text projection for grep. Defaults to false.' },
    query: { type: 'string', description: 'Required for search: word or phrase, 1–500 UTF-16 code units. Uses native literal matching when the full-text index is disabled.' },
    limit: {
      type: 'integer',
      description:
        'Only for search or calls: maximum rows, 1 through ' +
        maxRows +
        '. Defaults to the smaller of 20 and that maximum. Follow next for calls; narrow search queries when hasMore is true.'
    },
    from_seq: { type: 'integer', description: 'Only for calls: inclusive starting call-event sequence. Defaults to 0; follow next for continuation.' },
    until_seq: { type: 'integer', description: 'Only for calls: inclusive capture boundary. Defaults to the observed end; next preserves it across pages.' },
    errors_only: { type: 'boolean', description: 'Only for calls: return failed outer and nested calls. Defaults to false. Counts always cover the captured prefix.' },
    seq: { type: 'integer', description: 'Required for read: nonnegative event sequence from a search hit, call row, or outline.' },
    before: { type: 'integer', description: 'Only for read: preceding event summaries, 0–10. Defaults to 2.' },
    after: { type: 'integer', description: 'Only for read: following event summaries, 0–10. Defaults to 2.' }
  } as const
}

// shortcut: fixed display bounds; promote to Config when deployments tune them.
const PROMPT_CLIP = 200
const REPLY_CLIP = 300
const RECENT_PROMPTS = 3
const READ_TEXT_CLIP = 8000

/** Preview joined text blocks without copying message bodies beyond the display bound. */
function textPreview(content: readonly ContentBlock[], max: number, separator: ' ' | '\n' = ' '): { text: string; truncated?: true; fullLength?: number } {
  let text = ''
  let fullLength = 0
  let blocks = 0
  for (const block of content) {
    if (block.type !== 'text') continue
    if (blocks++ > 0) {
      fullLength++
      if (text.length < max) text += separator
    }
    fullLength += block.text.length
    if (text.length < max) text += block.text.slice(0, max - text.length)
  }
  if (fullLength <= max) return { text }
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return { text, truncated: true, fullLength }
}

/** Select readable event content without replay streams, reasoning, or attachment payloads. */
function readText(event: SessionEvent) {
  switch (event.type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      return textPreview(event.data.content, READ_TEXT_CLIP, '\n')
    case 'assistant/message':
    case 'tool/result':
      return textPreview(event.data.message.content, READ_TEXT_CLIP, '\n')
    case 'tool/call':
      return textPreview([{ type: 'text', text: event.data.arguments }], READ_TEXT_CLIP)
    case 'tool/ptc-dispatch-start':
      return textPreview([{ type: 'text', text: JSON.stringify(event.data.arguments) }], READ_TEXT_CLIP)
    default:
      return { text: '' }
  }
}

/** Keep the literal match visible even in long commands and tool results. */
function literalSnippet(text: string, pattern: RegExp): string {
  let start = Math.max(0, (pattern.exec(text)?.index ?? 0) - 80)
  const first = text.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff) start++
  return textPreview([{ type: 'text', text: (start === 0 ? '' : '…') + text.slice(start, start + 241) }], 240).text
}

/** One message row for the inspect view, or undefined for events that are not messages. */
function messageRow(event: SessionEvent, max: number): InferValue<typeof INSPECT_MESSAGE_SCHEMA> | undefined {
  if (event.type === 'user/message') {
    const first = event.data.content[0]
    const ownFraming =
      event.data.source.kind === 'session-fleet' &&
      event.data.content.length > 1 &&
      first?.type === 'text' &&
      first.text.startsWith('<system-reminder>') &&
      first.text.includes('through the session-fleet tools.')
    const content = ownFraming ? event.data.content.slice(1) : event.data.content
    return {
      seq: event.seq,
      messageId: event.data.id,
      ...(event.data.source.kind === 'session-fleet' ? { senderSessionId: event.data.source.senderSessionId } : {}),
      role: 'user',
      source: event.data.source.kind,
      ...textPreview(content, max)
    }
  }
  if (event.type === 'assistant/message') {
    return { seq: event.seq, messageId: event.data.message.id, role: 'assistant', source: 'model', ...textPreview(event.data.message.content, max) }
  }
  return undefined
}

function detailAccess(sessionId: string, seq?: number): InferValue<typeof DETAIL_ACCESS_SCHEMA> {
  return {
    search: { tool: 'inspect_session', arguments: { session_id: sessionId, mode: 'search' }, requiredArguments: ['query'] },
    calls: { tool: 'inspect_session', arguments: { session_id: sessionId, mode: 'calls' }, requiredArguments: [] },
    ...(seq === undefined
      ? {}
      : { read: { tool: 'inspect_session' as const, arguments: { session_id: sessionId, mode: 'read' as const, seq, before: 2, after: 2 }, requiredArguments: [] } })
  }
}

function assertHeader(id: string, origin: string | undefined, requested: string, includeSubagents: boolean): void {
  if (id !== requested) throw new Error('Native session reader returned a different session')
  if (!includeSubagents && origin === 'subagent') throw new Error('Subagent sessions are hidden by default')
}

function contextSummary(event: SessionEvent): InferValue<typeof CONTEXT_SCHEMA> {
  const base = { seq: event.seq, type: event.type, time: new Date(event.time).toISOString() }
  const message = messageRow(event, REPLY_CLIP)
  if (message !== undefined) return { ...base, ...message }
  if (event.type === 'tool/call') return { ...base, role: 'tool', source: event.data.name, ...textPreview([{ type: 'text', text: event.data.arguments }], REPLY_CLIP) }
  return base
}

async function sourceInfo(
  ctx: Context,
  sessionId: Parameters<Context['sessionQuery']['readSession']>[0],
  signal: AbortSignal
): Promise<InferValue<typeof OUTLINE_SCHEMA.properties.source>> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return { status: 'unavailable', reason: 'No session persistence service is mounted. Use the session-id detail calls.' }
  try {
    // Physical location is optional across the supported Host versions.
    const snapshot: (SessionPersistenceSnapshot & { location?: { kind: string; path: string } }) | undefined = await persistence.stat(sessionId, { signal })
    if (snapshot === undefined) return { status: 'unavailable', reason: 'No stored snapshot is available. Use the session-id detail calls.' }
    return {
      status: snapshot.location === undefined ? 'unavailable' : 'located',
      revision: snapshot.revision,
      ...(snapshot.location === undefined
        ? { reason: 'The backend does not expose a physical location. Use the session-id detail calls.' }
        : { location: { kind: snapshot.location.kind, path: snapshot.location.path } })
    }
  } catch (error) {
    signal.throwIfAborted()
    return { status: 'error', reason: String(error) }
  }
}

function validate(args: InspectArgs, maxRows: number): void {
  const mode = args.mode ?? 'outline'
  const allowed: readonly string[] = {
    outline: ['transcript'],
    search: ['query', 'limit'],
    read: ['seq', 'before', 'after'],
    calls: ['limit', 'from_seq', 'until_seq', 'errors_only']
  }[mode]
  for (const key of ['transcript', 'query', 'limit', 'seq', 'before', 'after', 'from_seq', 'until_seq', 'errors_only'] as const) {
    if (args[key] !== undefined && !allowed.includes(key)) throw new Error(key + ' is not valid in ' + mode + ' mode')
  }
  if (mode === 'search') literalQuery(args.query ?? '')
  if (mode === 'calls') {
    for (const key of ['from_seq', 'until_seq'] as const)
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 0)) throw new Error(key + ' must be a nonnegative safe integer')
    if (args.from_seq !== undefined && args.until_seq !== undefined && args.from_seq > args.until_seq) throw new Error('from_seq must not exceed until_seq')
  }
  if (mode === 'search' || mode === 'calls') {
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > maxRows))
      throw new Error('limit must be an integer from 1 through ' + maxRows)
  }
  if (mode === 'read') {
    if (args.seq === undefined || !Number.isSafeInteger(args.seq) || args.seq < 0) throw new Error('seq must be a nonnegative safe integer')
    for (const key of ['before', 'after'] as const)
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 0 || args[key] > CONTEXT_MAX))
        throw new Error(key + ' must be an integer from 0 through ' + CONTEXT_MAX)
  }
}

/** Read through the Host's authorized inventory and native logical-session reader. */
export async function inspectSession(
  ctx: Context,
  caller: Agent,
  config: InspectionConfig,
  transcripts: TranscriptStore,
  args: InspectArgs,
  signal: AbortSignal
): Promise<InferValue<typeof INSPECT_OUTPUT_SCHEMA>> {
  validate(args, config.maxListRows)
  signal.throwIfAborted()
  const row = (await ctx.sessionController.list({}, signal)).items.find(item => item.sessionId === args.session_id)
  if (row === undefined) throw new Error('Session is not accessible through the Host')
  assertHeader(row.sessionId, row.origin, args.session_id, config.includeSubagents)
  const sessionId = row.sessionId
  const mode = args.mode ?? 'outline'
  if (mode === 'search') {
    const filters: import('@deepseek-ai/dsh-session-query').SessionEventMetadataFilter[] = []
    if (sessionId === caller.id) {
      const boundary = caller.session.snapshotEvents().findLast(event => event.type === 'step/start' || event.type === 'step/end')
      if (boundary?.type === 'step/start') {
        if (boundary.seq === 0) return { mode, sessionId, results: [], hasMore: false, detailAccess: detailAccess(sessionId) }
        filters.push({ kind: 'seq', to: boundary.seq - 1 })
      }
    }
    const query = literalQuery(args.query!)
    const limit = args.limit ?? Math.min(20, config.maxListRows)
    let page: Awaited<ReturnType<Context['sessionQuery']['searchEvents']>>
    let searchMode: 'literal' | undefined
    let hasMore: boolean
    try {
      page = await ctx.sessionQuery.searchEvents({ sessionId, query, limit, ...(filters.length === 0 ? {} : { filters }) }, { signal })
      hasMore = page.nextCursor !== undefined
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      signal.throwIfAborted()
      assertHeader(snapshot.session.id, snapshot.session.origin, args.session_id, config.includeSubagents)
      const documents = filterSessionEventDocuments(buildSessionEventSearchDocuments(sessionId, snapshot.events), [...filters, { kind: 'text', text: query }])
      const pattern = compileSessionTextFilter(query)
      page = { session: snapshot.session, items: documents.slice(0, limit).map(hit => ({ ...hit, snippet: literalSnippet(hit.text, pattern) })) }
      hasMore = documents.length > limit
      searchMode = 'literal'
    }
    signal.throwIfAborted()
    assertHeader(page.session.id, page.session.origin, args.session_id, config.includeSubagents)
    return {
      mode,
      sessionId,
      ...(searchMode === undefined ? {} : { searchMode }),
      results: page.items.map(hit => {
        if (hit.sessionId !== sessionId) throw new Error('Native event search returned a different session')
        return { seq: hit.seq, type: hit.type, time: new Date(hit.time).toISOString(), surface: hit.surface, snippet: textPreview([{ type: 'text', text: hit.snippet }], 240).text }
      }),
      hasMore,
      ...(hasMore ? { guidance: 'More matches exist; narrow the query rather than paging a changing log.' } : {}),
      detailAccess: detailAccess(sessionId, page.items[0]?.seq)
    }
  }
  if (mode === 'read') {
    const window = await ctx.sessionQuery.readEvent({ sessionId, seq: SessionSeq(args.seq!), before: args.before ?? 2, after: args.after ?? 2 }, signal)
    assertHeader(window.session.id, window.session.origin, args.session_id, config.includeSubagents)
    // The native append/read boundary guarantees lossless JSON; its event interfaces lack a JSON index signature.
    const event = window.target as unknown as InferValue<typeof READ_SCHEMA.properties.event>
    return {
      mode,
      sessionId,
      event,
      ...readText(window.target),
      context: window.events.filter(item => item.seq !== window.target.seq).map(contextSummary),
      startSeq: window.startSeq,
      endSeq: window.endSeq,
      detailAccess: detailAccess(sessionId, window.target.seq)
    }
  }
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  signal.throwIfAborted()
  const { session: meta, events } = snapshot
  assertHeader(meta.id, meta.origin, args.session_id, config.includeSubagents)
  if (mode === 'calls') {
    const limit = args.limit ?? Math.min(20, config.maxListRows)
    const page = toolCallPage(events, { ...args, limit, excludeActiveStep: sessionId === caller.id })
    return {
      mode,
      sessionId,
      asOfSeq: page.asOfSeq,
      counts: page.counts,
      total: page.total,
      calls: page.calls,
      hasMore: page.hasMore,
      ...(page.nextSeq === undefined
        ? {}
        : {
            next: {
              tool: 'inspect_session' as const,
              arguments: {
                session_id: sessionId,
                mode: 'calls' as const,
                from_seq: page.nextSeq,
                until_seq: page.asOfSeq,
                limit,
                ...(args.errors_only === undefined ? {} : { errors_only: args.errors_only })
              },
              requiredArguments: []
            }
          }),
      detailAccess: detailAccess(sessionId, page.calls[0]?.resultSeq ?? page.calls[0]?.seq)
    }
  }
  const counts = { user: 0, assistant: 0, toolCalls: 0 }
  const promptEvents: SessionEvent[] = []
  let assistantEvent: SessionEvent | undefined
  const omitted = new Set<string>()
  for (const event of events) {
    if (event.type === 'user/message') {
      counts.user++
      if (event.data.source.kind === 'user' || event.data.source.kind === 'session-fleet') {
        promptEvents.push(event)
        if (promptEvents.length > RECENT_PROMPTS) promptEvents.shift()
      }
    } else if (event.type === 'assistant/message') {
      counts.assistant++
      if (event.data.message.content.some(block => block.type === 'text' && /\S/.test(block.text))) assistantEvent = event
    } else if (event.type === 'tool/call') counts.toolCalls++
    if (!TRANSCRIPT_EVENT_TYPES.some(type => type === event.type)) omitted.add(event.type)
  }
  const prompts = promptEvents.flatMap(event => {
    const value = messageRow(event, PROMPT_CLIP)
    return value === undefined ? [] : [value]
  })
  const lastAssistant = assistantEvent === undefined ? undefined : messageRow(assistantEvent, REPLY_CLIP)
  const source = await sourceInfo(ctx, sessionId, signal)
  const transcript = args.transcript === true ? await transcripts.export(events, signal) : undefined
  return {
    mode,
    sessionId: meta.id,
    createdAt: new Date(meta.createdAt).toISOString(),
    updatedAt: new Date(events.at(-1)?.time ?? meta.createdAt).toISOString(),
    running: row.running,
    agentAvailable: row.agentAvailable,
    eventCount: events.length,
    counts,
    recentPrompts: prompts,
    ...(lastAssistant === undefined ? {} : { lastAssistant }),
    asOfSeq: events.at(-1)?.seq ?? -1,
    includedEventTypes: [...TRANSCRIPT_EVENT_TYPES],
    omittedEventTypes: [...omitted],
    ...transcript,
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    ...(meta.parentSession === undefined ? {} : { parentSessionId: meta.parentSession }),
    ...(meta.origin === undefined ? {} : { origin: meta.origin }),
    source,
    detailAccess: detailAccess(sessionId, lastAssistant?.seq ?? prompts.at(-1)?.seq ?? events.at(-1)?.seq)
  }
}
