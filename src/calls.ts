/** Compact, index-independent navigation over native tool lifecycles. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

export const CALL_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    resultSeq: { type: 'integer' },
    parentSeq: { type: 'integer' },
    name: { type: 'string', required: true },
    nameTruncated: { type: 'boolean' },
    level: { type: 'string', required: true, enum: ['outer', 'nested'] },
    status: { type: 'string', required: true, enum: ['pending', 'succeeded', 'failed'] },
    durationMs: { type: 'number' }
  }
} as const

type CallRow = InferValue<typeof CALL_ROW_SCHEMA>
export interface CallOptions {
  limit: number
  from_seq?: number
  until_seq?: number
  errors_only?: boolean
  excludeActiveStep?: boolean
}

type StartEvent = Extract<SessionEvent, { type: 'tool/call' | 'tool/ptc-dispatch-start' | 'tool/ptc-dispatch' }>
interface CallState {
  row: CallRow
  startedAt: number | undefined
  parentId: ToolCallId | undefined
}

/** Pair calls by native identity, then page one captured prefix without message bodies. */
export function toolCallPage(events: readonly SessionEvent[], options: CallOptions) {
  let asOfSeq = Math.min(events.at(-1)?.seq ?? -1, options.until_seq ?? Number.MAX_SAFE_INTEGER)
  if (options.excludeActiveStep) {
    const boundary = events.findLast(event => event.type === 'step/start' || event.type === 'step/end')
    if (boundary?.type === 'step/start') asOfSeq = Math.min(asOfSeq, boundary.seq - 1)
  }
  const states = new Map<ToolCallId, CallState>()
  const begin = (event: StartEvent): CallState => {
    const id = event.type === 'tool/call' ? event.data.callId : event.data.subCallId
    const existing = states.get(id)
    if (existing !== undefined) return existing
    const name = event.data.name.slice(0, 160).replace(/[\uD800-\uDBFF]$/u, '')
    const state: CallState = {
      row: {
        seq: event.seq,
        name,
        ...(name.length < event.data.name.length ? { nameTruncated: true } : {}),
        level: event.type === 'tool/call' ? 'outer' : 'nested',
        status: 'pending'
      },
      startedAt: event.type === 'tool/ptc-dispatch' ? undefined : event.time,
      parentId: event.type === 'tool/call' ? undefined : event.data.parentCallId
    }
    states.set(id, state)
    return state
  }
  const settle = (state: CallState, event: SessionEvent, failed: boolean) => {
    state.row.status = failed ? 'failed' : 'succeeded'
    state.row.resultSeq = event.seq
    if (state.startedAt !== undefined && event.time >= state.startedAt) state.row.durationMs = event.time - state.startedAt
  }
  for (const event of events) {
    if (event.seq > asOfSeq) break
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') begin(event)
    else if (event.type === 'tool/ptc-dispatch') settle(begin(event), event, event.data.isError)
    else if (event.type === 'tool/result') {
      const state = states.get(event.data.message.toolCallId)
      if (state !== undefined) settle(state, event, event.data.message.isError === true)
    }
  }
  const counts = { outer: 0, nested: 0, failed: 0, pending: 0 }
  const matching: CallRow[] = []
  for (const { row, parentId } of states.values()) {
    const parent = parentId === undefined ? undefined : states.get(parentId)
    if (parent !== undefined) row.parentSeq = parent.row.seq
    counts[row.level]++
    if (row.status === 'failed') counts.failed++
    if (row.status === 'pending') counts.pending++
    if (!options.errors_only || row.status === 'failed') matching.push(row)
  }
  const remaining = matching.filter(row => row.seq >= (options.from_seq ?? 0))
  const calls = remaining.slice(0, options.limit)
  const nextSeq = remaining[options.limit]?.seq
  return { asOfSeq, counts, total: matching.length, calls, hasMore: nextSeq !== undefined, ...(nextSeq === undefined ? {} : { nextSeq }) }
}
