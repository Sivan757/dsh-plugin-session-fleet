/** Pending Fleet input management over the native inbox and read-only projection. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, InboxState } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { peerMessageSummary, isFleetFrame, revisePeerMessage, reframePeerMessage } from './coordination.ts'
import type { Config } from './index.ts'

export const inboxParameters = {
  session_id: { type: 'string', required: true, description: 'Session whose pending peer inbox is inspected or changed.' },
  action: {
    type: 'string',
    enum: ['list', 'replace', 'withdraw'],
    description:
      'Defaults to list without starting the Agent. Replace only your own pending delivery; withdraw your own delivery or peer input in your own inbox. History and human input cannot be changed.'
  },
  message_id: { type: 'string', description: 'Native pending message id. Required for mutations; optionally selects one full summary in list mode.' },
  expected_revision: { type: 'string', description: 'Exact revision returned by list or replace. Required for mutation; stale input is rejected.' },
  text: {
    type: 'string',
    description: 'For replace only: a cumulative summary for a structured message, or the body of a string message. Contract kind, task, owner, scope and native id stay fixed.'
  },
  limit: { type: 'integer', description: 'List page size, bounded by maxListRows.' },
  cursor: { type: 'string', description: 'Opaque list continuation. Restart if the pending inbox changes.' }
} as const

const ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    revision: { type: 'string', required: true },
    delivery: { type: 'string', required: true, enum: ['queue', 'steer'] },
    senderSessionId: { type: 'string', required: true },
    selfAddressed: { type: 'boolean', required: true },
    kind: { type: 'string', required: true },
    task: { type: 'string' },
    owner: { type: 'string' },
    scope: { type: 'array', items: { type: 'string' } },
    replyTo: { type: 'string' },
    next: { type: 'string', description: 'Outstanding decision or checkpoint from the original coordination record.' },
    summary: { type: 'string', required: true },
    truncated: { type: 'boolean' },
    fullLength: { type: 'integer' },
    bodyEdited: { type: 'boolean', description: 'Payload differs from the structured source record, for example after manual UI editing. Summary shows the actual payload.' },
    completionMessageId: { type: 'string', description: 'A pending complete from the same sender for the same reference. Check its coverage before withdrawing earlier findings.' },
    canReplace: { type: 'boolean', required: true },
    canWithdraw: { type: 'boolean', required: true }
  }
} as const
export const INBOX_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true, const: 'list' },
        sessionId: { type: 'string', required: true },
        asOfSeq: { type: 'integer', required: true },
        totalPending: { type: 'integer', required: true },
        peerPending: { type: 'integer', required: true },
        otherPending: { type: 'integer', required: true },
        items: { type: 'array', required: true, items: ITEM },
        hasMore: { type: 'boolean', required: true },
        nextCursor: { type: 'string' }
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true, enum: ['replace', 'withdraw'] },
        sessionId: { type: 'string', required: true },
        messageId: { type: 'string', required: true },
        changed: { type: 'boolean', required: true, const: true },
        revision: { type: 'string' },
        persistence: { type: 'string', required: true, enum: ['acknowledged', 'unknown'] },
        retrySafe: { type: 'boolean', required: true, const: false }
      }
    }
  ]
} as const

type Args = { session_id: string; action?: 'list' | 'replace' | 'withdraw'; message_id?: string; expected_revision?: string; text?: string; limit?: number; cursor?: string }
/** Revision over native wire JSON, including content and author/contract metadata. */
export const pendingRevision = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function nativeInbox(value: unknown): InboxState {
  if (value === null || typeof value !== 'object') throw new Error('Native inbox projection is unavailable')
  const candidate = value as Record<string, unknown>
  for (const target of ['next-turn', 'next-step']) {
    const messages = candidate[target]
    if (
      !Array.isArray(messages) ||
      messages.some(message => !message || message.role !== 'user' || typeof message.id !== 'string' || !message.source || !Array.isArray(message.content))
    )
      throw new Error('Native inbox projection has an unsupported shape')
  }
  return value as InboxState
}
function peers(inbox: InboxState) {
  return [...inbox['next-step'].map(message => ({ message, delivery: 'steer' as const })), ...inbox['next-turn'].map(message => ({ message, delivery: 'queue' as const }))].filter(
    (item): item is typeof item & { message: UserMessage & { source: Extract<UserMessage['source'], { kind: 'session-fleet' }> } } => item.message.source.kind === 'session-fleet'
  )
}

/** Upgrade only this plugin's old preview preface; preserve the native id, source and payload. */
export function refreshPendingPreviews(agent: Agent): number {
  if (agent.session.header.origin === 'subagent') return 0
  let changed = 0
  for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
    const first = message.content[0]
    if (message.source.kind !== 'session-fleet' || !isFleetFrame(first) || first?.type !== 'text' || !first.text.startsWith('<system-reminder>')) continue
    const current = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find(item => item.id === message.id)
    if (current !== message) continue
    if (agent.inbox.replace(message.id, reframePeerMessage(message))) changed++
  }
  return changed
}

/** List without resuming; mutate only a still-pending, authorized native occurrence. */
export async function manageInbox(ctx: Context, caller: Agent, config: Required<Config>, args: Args, signal: AbortSignal) {
  const action = args.action ?? 'list'
  const id = args.session_id as SessionId
  const visible = (await ctx.sessionController.list({}, signal)).items.find(item => item.sessionId === id && (config.includeSubagents || item.origin !== 'subagent'))
  if (!visible) throw new Error('Session is not visible to Fleet')
  signal.throwIfAborted()
  const view = await ctx.sessionController.projections({ sessionId: id }, signal)
  signal.throwIfAborted()
  if (!view || view.kind !== 'sequenced') throw new Error('Native inbox requires an available sequenced projection')
  const inbox = nativeInbox(view.values.inbox)
  const pending = peers(inbox)
  const sameWorkspace = config.allowCrossWorkspace || caller.session.header.cwd === visible.cwd
  if (action === 'list') {
    if (args.expected_revision !== undefined || args.text !== undefined) throw new Error('List does not accept mutation fields')
    const limit = args.limit ?? Math.min(20, config.maxListRows)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.maxListRows) throw new Error('Invalid inbox page size')
    const fingerprint = pendingRevision({ id, inbox, selected: args.message_id })
    let offset = 0
    if (args.cursor !== undefined) {
      if (args.cursor.length > 2048) throw new Error('Invalid inbox cursor')
      let cursor
      try {
        cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'))
      } catch {
        throw new Error('Invalid inbox cursor')
      }
      if (cursor?.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
        throw new Error('Pending inbox changed or cursor is invalid; restart listing')
      offset = cursor.offset
    }
    const selected = args.message_id === undefined ? pending : pending.filter(item => item.message.id === args.message_id)
    const items = selected.slice(offset, offset + limit).map(({ message, delivery }) => {
      const coordination = message.source.coordination
      const summary = peerMessageSummary(message, args.message_id === undefined ? 800 : config.maxMessageChars)
      const completion =
        coordination?.reply_to === undefined || coordination.kind === 'complete'
          ? undefined
          : pending.find(
              item =>
                item.message.source.senderSessionId === message.source.senderSessionId &&
                item.message.source.coordination?.kind === 'complete' &&
                item.message.source.coordination.reply_to === coordination.reply_to
            )
      return {
        messageId: message.id,
        revision: pendingRevision(message),
        delivery,
        senderSessionId: message.source.senderSessionId,
        selfAddressed: message.source.senderSessionId === id,
        kind: coordination?.kind ?? 'text',
        ...(coordination === undefined
          ? {}
          : {
              task: coordination.task,
              owner: coordination.owner,
              scope: coordination.scope,
              ...(coordination.next === undefined ? {} : { next: coordination.next }),
              ...(coordination.reply_to === undefined ? {} : { replyTo: coordination.reply_to })
            }),
        summary: summary.text,
        ...(summary.truncated ? { truncated: true, fullLength: summary.fullLength! } : {}),
        ...(summary.bodyEdited ? { bodyEdited: true } : {}),
        ...(completion === undefined ? {} : { completionMessageId: completion.message.id }),
        canReplace: sameWorkspace && visible.origin !== 'subagent' && message.source.senderSessionId === caller.id,
        canWithdraw: sameWorkspace && visible.origin !== 'subagent' && (message.source.senderSessionId === caller.id || id === caller.id)
      }
    })
    const hasMore = offset + items.length < selected.length
    return {
      action: 'list' as const,
      sessionId: id,
      asOfSeq: view.asOfSeq,
      totalPending: inbox['next-turn'].length + inbox['next-step'].length,
      peerPending: pending.length,
      otherPending: inbox['next-turn'].length + inbox['next-step'].length - pending.length,
      items,
      hasMore,
      ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, offset: offset + items.length })).toString('base64url') } : {})
    }
  }
  if (!sameWorkspace || visible.origin === 'subagent') throw new Error('Fleet inbox mutation is restricted to permitted ordinary workspaces')
  if (!args.message_id || !args.expected_revision || !/^[a-f0-9]{64}$/.test(args.expected_revision)) throw new Error('Mutation requires message_id and its exact expected_revision')
  if (args.cursor !== undefined || args.limit !== undefined || (action === 'withdraw' && args.text !== undefined) || (action === 'replace' && args.text === undefined))
    throw new Error('Invalid inbox mutation fields')
  const initial = pending.find(item => item.message.id === args.message_id)?.message
  if (!initial) throw new Error('Message is no longer pending Fleet input; delivered history and human input cannot be changed')
  if (initial.source.senderSessionId !== caller.id && (action === 'replace' || id !== caller.id))
    throw new Error('Only the sender can replace its delivery; the sender or recipient can withdraw pending peer input')
  if (pendingRevision(initial) !== args.expected_revision) throw new Error('Pending message changed; inspect its current revision before retrying')
  const resolved = await ctx.sessionController.resolveAgent(id)
  signal.throwIfAborted()
  if ('error' in resolved) throw new Error('Cannot resolve inbox owner: ' + String(resolved.error))
  const agent = resolved.agent
  if (agent.id !== id || agent.session.header.id !== id || agent.session.header.origin === 'subagent') throw new Error('Resolved inbox owner identity is invalid')
  const current = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find(message => message.id === args.message_id)
  if (!current) throw new Error('Message is no longer pending; inspect before retrying')
  if (pendingRevision(current) !== args.expected_revision) throw new Error('Pending message changed; inspect its current revision before retrying')
  if (current.source.kind !== 'session-fleet' || (current.source.senderSessionId !== caller.id && (action === 'replace' || id !== caller.id)))
    throw new Error('Pending message ownership changed')
  const revised = action === 'replace' ? revisePeerMessage(current, args.text!, config.maxMessageChars) : undefined
  const changed = revised === undefined ? agent.inbox.remove(current.id) : agent.inbox.replace(current.id, revised)
  if (!changed) throw new Error('Message is no longer pending; inspect before retrying')
  let persistence: 'acknowledged' | 'unknown' = 'unknown'
  try {
    if (await ctx.sessions.flush(agent.session)) persistence = 'acknowledged'
  } catch {
    /* The durable mutation may already have happened; inspect before retrying. */
  }
  return {
    action,
    sessionId: id,
    messageId: current.id,
    changed: true as const,
    ...(revised === undefined ? {} : { revision: pendingRevision(revised) }),
    persistence,
    retrySafe: false as const
  }
}
