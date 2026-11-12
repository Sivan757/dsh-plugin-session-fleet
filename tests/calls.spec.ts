/** Native identity pairing, stable captured prefixes, and bounded call metadata. */
import { expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { toolCallPage } from '../src/calls.ts'

function outer(seq: number, id: string, name = 'run_code'): SessionEvent {
  return { seq: SessionSeq(seq), time: seq * 10, type: 'tool/call', data: { turn: 1, step: 1, callId: ToolCallId(id), name, arguments: 'PRIVATE_INPUT'.repeat(1000) } }
}
function start(seq: number, id: string, name = 'read'): Extract<SessionEvent, { type: 'tool/ptc-dispatch-start' }> {
  return {
    seq: SessionSeq(seq),
    time: seq * 10,
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'), subCallId: ToolCallId(id), name, arguments: { private: 'PRIVATE_INPUT' } }
  }
}
function finish(seq: number, input: ReturnType<typeof start>, isError: boolean): SessionEvent {
  return { seq: SessionSeq(seq), time: seq * 10, type: 'tool/ptc-dispatch', data: { ...input.data, isError, content: [{ type: 'text', text: 'PRIVATE_RESULT'.repeat(1000) }] } }
}
const first = start(1, 'one')
const second = start(2, 'two', 'search_sessions')
const events: readonly SessionEvent[] = [
  outer(0, 'root'),
  first,
  second,
  finish(3, second, false),
  finish(4, first, true),
  { seq: SessionSeq(5), time: 50, type: 'tool/result', data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('root'), isError: false, content: [] }) } },
  outer(6, 'pending'),
  finish(7, start(7, 'legacy'), true)
]

it('pairs interleaved nested results by identity while preserving a successful outer wrapper', () => {
  const page = toolCallPage(events, { limit: 20 })
  expect(page.counts).toEqual({ outer: 2, nested: 3, failed: 2, pending: 1 })
  expect(page.calls).toEqual([
    { seq: 0, name: 'run_code', level: 'outer', status: 'succeeded', resultSeq: 5, durationMs: 50 },
    { seq: 1, name: 'read', level: 'nested', status: 'failed', resultSeq: 4, parentSeq: 0, durationMs: 30 },
    { seq: 2, name: 'search_sessions', level: 'nested', status: 'succeeded', resultSeq: 3, parentSeq: 0, durationMs: 10 },
    { seq: 6, name: 'run_code', level: 'outer', status: 'pending' },
    { seq: 7, name: 'read', level: 'nested', status: 'failed', resultSeq: 7, parentSeq: 0 }
  ])
  expect(JSON.stringify(page)).not.toContain('PRIVATE_')
})

it('pages failure metadata by sequence and keeps counts independent of the page position', () => {
  const page = toolCallPage(events, { limit: 1, errors_only: true })
  expect(page.total).toBe(2)
  expect(page.calls.map(call => call.seq)).toEqual([1])
  expect(page.nextSeq).toBe(7)
  const next = toolCallPage(events, { limit: 1, errors_only: true, from_seq: page.nextSeq!, until_seq: page.asOfSeq })
  expect(next.total).toBe(2)
  expect(next.calls.map(call => call.seq)).toEqual([7])
  expect(next.hasMore).toBe(false)
})

it('freezes result status at the requested event boundary across later appends', () => {
  const page = toolCallPage(events, { limit: 1, until_seq: 2 })
  expect(page.asOfSeq).toBe(2)
  expect(page.counts).toEqual({ outer: 1, nested: 2, failed: 0, pending: 3 })
  expect(page.calls[0]?.status).toBe('pending')
  const continued = toolCallPage([...events, outer(8, 'later')], { limit: 20, until_seq: page.asOfSeq, from_seq: page.nextSeq! })
  expect(continued.calls.map(call => [call.seq, call.status])).toEqual([
    [1, 'pending'],
    [2, 'pending']
  ])
})

it('excludes the active step when callers inspect their own call history', () => {
  const snapshot: SessionEvent[] = [...events, { seq: SessionSeq(8), time: 80, type: 'step/start', data: { turn: 1, step: 2 } }, outer(9, 'self')]
  const page = toolCallPage(snapshot, { limit: 20, excludeActiveStep: true })
  expect(page.asOfSeq).toBe(7)
  expect(page.calls.some(call => call.seq === 9)).toBe(false)
})

it('keeps empty sessions empty and bounds unusual tool names without losing a surrogate pair', () => {
  expect(toolCallPage([], { limit: 20 })).toMatchObject({ asOfSeq: -1, calls: [], total: 0, hasMore: false })
  const page = toolCallPage([outer(0, 'long', 'x'.repeat(159) + '😀'.repeat(100))], { limit: 20 })
  expect(page.calls[0]?.name).toBe('x'.repeat(159))
  expect(page.calls[0]?.nameTruncated).toBe(true)
})
