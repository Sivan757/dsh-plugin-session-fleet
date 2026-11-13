/** Bilateral proposals stay correlated, bounded, and separate from transport admission. */
import { expect, it } from 'vitest'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { preparePeerMessage, revisePeerMessage, reframePeerMessage, peerMessageSummary, type PeerMessageInput } from '../src/coordination.ts'

const a = SessionId('session-a')
const b = SessionId('session-b')
const c = SessionId('session-c')
const proposal = {
  kind: 'propose',
  task: ' Implement auth validation ',
  owner: a,
  scope: [' write:/repo/src/auth '],
  summary: 'I implement validation; please keep changes in tests.',
  next: 'Accept this division or state the conflicting scope before editing.'
} as const
const propose = () => preparePeerMessage(a, b, { ...proposal, scope: [...proposal.scope] }, 20000)

it('revises a cumulative summary without changing the author, contract or message identity', () => {
  const original = propose()
  const revised = revisePeerMessage(original, 'Cumulative current status; the original scope still applies.', 20000)
  expect(revised.id).toBe(original.id)
  expect(revised.source).toEqual({ ...original.source, coordination: { ...original.source.coordination, summary: 'Cumulative current status; the original scope still applies.' } })
  expect(revised.content[0]).toMatchObject({ text: expect.stringContaining('[Fleet propose ·') })
  expect(revised.content[1]).toEqual({ type: 'text', text: JSON.stringify(revised.source.coordination) })
  expect(original.source.coordination?.summary).toBe(proposal.summary)
  expect(() => revisePeerMessage(original, 'x'.repeat(2001), 20000)).toThrow('bound')
})

it.each(['legacy', 'current'] as const)('preserves a %s preface coalesced with its payload in one text block', format => {
  const original = propose()
  const combined = original.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
  const text = format === 'legacy' ? combined.slice(combined.indexOf('<system-reminder>')) : combined
  const coalesced = { ...original, content: [{ type: 'text' as const, text }] }
  const refreshed = reframePeerMessage(coalesced)
  expect(refreshed.id).toBe(original.id)
  expect(refreshed.source).toEqual(original.source)
  expect(refreshed.content.slice(1)).toEqual(original.content.slice(1))
  expect(peerMessageSummary(coalesced, 2000)).toEqual({ text: proposal.summary })
})

it('shows a manual payload edit instead of repeating stale structured metadata', () => {
  const original = propose()
  const manual = { ...original, content: [original.content[0]!, { type: 'text' as const, text: 'Edited in the receiving UI: keep this new finding.' }] }
  expect(peerMessageSummary(manual, 800)).toMatchObject({ text: 'Edited in the receiving UI: keep this new finding.', bodyEdited: true })
  expect(manual.source.coordination).toEqual(original.source.coordination)
})

it('refreshes older queue framing without changing payload or authority', () => {
  const original = propose()
  const first = original.content[0]!
  if (first.type !== 'text') throw new Error('Expected frame')
  const legacy = { ...original, content: [{ ...first, text: first.text.slice(first.text.indexOf('<system-reminder>')) }, ...original.content.slice(1)] }
  const refreshed = reframePeerMessage(legacy)
  expect(refreshed.id).toBe(legacy.id)
  expect(refreshed.source).toEqual(legacy.source)
  expect(refreshed.content.slice(1)).toEqual(legacy.content.slice(1))
  expect(refreshed.content[0]).toMatchObject({ text: expect.stringContaining(proposal.summary) })
})
const received = (message: ReturnType<typeof preparePeerMessage>): SessionEvent[] => [{ seq: SessionSeq(0), time: 0, type: 'user/message', data: message }]

it('keeps native identity visible in the frame while preserving plain peer input', () => {
  const message = preparePeerMessage(a, b, 'simple status question', 20000)
  expect(message.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(message.id) })
  expect(message.content[1]).toEqual({ type: 'text', text: 'simple status question' })
  expect(message.source).toEqual({ kind: 'session-fleet', senderSessionId: a })
  expect(Object.isFrozen(message)).toBe(true)
})

it('accepts an exact received proposal without asking the responder to retype its scope', () => {
  const offered = propose()
  const accepted = preparePeerMessage(b, a, { kind: 'accept', reply_to: offered.id, summary: 'Agreed. I will work only in tests.' }, 20000, received(offered))
  expect(accepted.source.coordination).toEqual({
    kind: 'accept',
    task: 'Implement auth validation',
    owner: a,
    scope: ['write:/repo/src/auth'],
    reply_to: offered.id,
    summary: 'Agreed. I will work only in tests.'
  })
  expect(accepted.content[0]).toMatchObject({ text: expect.stringContaining('No acknowledgement') })
})

it('rejects references received from another peer or a message that was never received', () => {
  const offered = propose()
  const reply = { kind: 'accept', reply_to: offered.id, summary: 'Agreed' } as const
  expect(() => preparePeerMessage(b, c, reply, 20000, received(offered))).toThrow('received from the target')
  expect(() => preparePeerMessage(b, a, reply, 20000)).toThrow('reply_to')
})

it('rejects acknowledgements of acknowledgements and contradictory reply requests on acceptance', () => {
  const offered = propose()
  const accepted = preparePeerMessage(b, a, { kind: 'accept', reply_to: offered.id, summary: 'Agreed' }, 20000, received(offered))
  expect(() => preparePeerMessage(a, b, { kind: 'accept', reply_to: accepted.id, summary: 'Thanks' }, 20000, received(accepted))).toThrow('proposal or handoff')
  expect(() => preparePeerMessage(b, a, { kind: 'accept', reply_to: offered.id, summary: 'Agreed', next: 'Please acknowledge' }, 20000, received(offered))).toThrow('next')
})

it('allows only the stated owner to report completion or release', () => {
  const offered = propose()
  const accepted = preparePeerMessage(b, a, { kind: 'accept', reply_to: offered.id, summary: 'Agreed' }, 20000, received(offered))
  const done = preparePeerMessage(a, b, { kind: 'complete', reply_to: accepted.id, summary: 'Validation implemented; auth tests pass.' }, 20000, received(accepted))
  expect(done.source.coordination).toMatchObject({ task: 'Implement auth validation', owner: a, scope: ['write:/repo/src/auth'], kind: 'complete' })
  expect(() => preparePeerMessage(b, a, { kind: 'release', reply_to: offered.id, summary: 'I release your work' }, 20000, received(offered))).toThrow('owner')
})

it('requires handoff from the known owner to the actual recipient, preserving scope', () => {
  const offered = propose()
  const accepted = preparePeerMessage(b, a, { kind: 'accept', reply_to: offered.id, summary: 'Agreed' }, 20000, received(offered))
  const handoff: PeerMessageInput = {
    ...proposal,
    kind: 'handoff',
    owner: b,
    scope: ['write:/repo/src/auth'],
    reply_to: accepted.id,
    summary: 'My changes are saved and I have stopped; please take over.'
  }
  expect(preparePeerMessage(a, b, handoff, 20000, received(accepted)).source.coordination).toMatchObject({ owner: b, kind: 'handoff' })
  expect(() => preparePeerMessage(a, b, { ...handoff, scope: ['write:/repo/elsewhere'] }, 20000, received(accepted))).toThrow('scope')
  expect(() => preparePeerMessage(a, b, { ...handoff, owner: c }, 20000, received(accepted))).toThrow('recipient')
})

it.each([
  [{ ...proposal, scope: [] }, 'scope'],
  [{ ...proposal, scope: [' '] }, 'scope'],
  [{ ...proposal, scope: Array.from({ length: 17 }, (_, i) => 'write:' + i) }, 'scope'],
  [{ ...proposal, task: ' ', scope: ['write:x'] }, 'task'],
  [{ ...proposal, next: ' ', scope: ['write:x'] }, 'next']
])('rejects an incomplete contract %j', (input, field) => {
  expect(() => preparePeerMessage(a, b, input, 20000)).toThrow(field)
})

it.each([
  ['direct', 'propose'],
  ['nested', 'propose'],
  ['direct', 'handoff'],
  ['nested', 'handoff']
] as const)('lets the accepting owner complete, release and hand back after a successful %s %s acceptance', (level, kind) => {
  const initial = propose()
  const initialAccept = preparePeerMessage(b, a, { kind: 'accept', reply_to: initial.id, summary: 'Agreed' }, 20000, received(initial))
  const offered =
    kind === 'propose'
      ? preparePeerMessage(a, b, { ...proposal, owner: b, scope: [...proposal.scope] }, 20000)
      : preparePeerMessage(a, b, { ...proposal, kind: 'handoff', owner: b, scope: [...proposal.scope], reply_to: initialAccept.id }, 20000, received(initialAccept))
  const accepted = preparePeerMessage(b, a, { kind: 'accept', reply_to: offered.id, summary: 'I accept ownership.' }, 20000, received(offered))
  const args = { session_id: a, message: { kind: 'accept', reply_to: offered.id, summary: 'I accept ownership.' } }
  const receipt = [{ type: 'text' as const, text: JSON.stringify({ sessionId: a, messageId: accepted.id, accepted: true }) }]
  const log: SessionEvent[] =
    level === 'direct'
      ? [
          { seq: SessionSeq(1), time: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: ToolCallId('accept'), name: 'send_to_session', arguments: JSON.stringify(args) } },
          {
            seq: SessionSeq(2),
            time: 2,
            type: 'tool/result',
            data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('accept'), isError: false, content: receipt }) }
          }
        ]
      : [
          {
            seq: SessionSeq(1),
            time: 1,
            type: 'tool/ptc-dispatch',
            data: {
              rootCallId: ToolCallId('root'),
              parentCallId: ToolCallId('root'),
              subCallId: ToolCallId('accept'),
              name: 'send_to_session',
              arguments: args,
              isError: false,
              content: receipt
            }
          }
        ]
  const history = [...received(offered), ...log]
  expect(() => preparePeerMessage(b, a, { kind: 'complete', reply_to: offered.id, summary: 'Work done.' }, 20000, received(offered))).toThrow('acceptance')
  expect(preparePeerMessage(b, a, { kind: 'complete', reply_to: offered.id, summary: 'Work done.' }, 20000, history).source.coordination?.owner).toBe(b)
  expect(preparePeerMessage(b, a, { kind: 'release', reply_to: offered.id, summary: 'Stopped.' }, 20000, history).source.coordination?.kind).toBe('release')
  expect(
    preparePeerMessage(
      b,
      a,
      { ...proposal, kind: 'handoff', owner: a, scope: ['write:/repo/src/auth'], reply_to: offered.id, summary: 'Stopped; please take over.' },
      20000,
      history
    ).source.coordination?.kind
  ).toBe('handoff')
})

it('does not accept wrong, failed, pending or unrelated send records as ownership evidence', () => {
  const offered = preparePeerMessage(a, b, { ...proposal, owner: b, scope: [...proposal.scope] }, 20000)
  const args = { session_id: a, message: { kind: 'accept', reply_to: offered.id, summary: 'Agreed' } }
  const content = [{ type: 'text' as const, text: JSON.stringify({ sessionId: a, messageId: 'sent', accepted: true }) }]
  const data = {
    rootCallId: ToolCallId('root'),
    parentCallId: ToolCallId('root'),
    subCallId: ToolCallId('sent'),
    name: 'send_to_session',
    arguments: args,
    isError: false,
    content
  }
  const invalid: SessionEvent[][] = [
    [{ seq: SessionSeq(1), time: 1, type: 'tool/ptc-dispatch', data: { ...data, arguments: { ...args, session_id: c } } }],
    [{ seq: SessionSeq(1), time: 1, type: 'tool/ptc-dispatch', data: { ...data, arguments: { ...args, message: { ...args.message, reply_to: 'other-proposal' } } } }],
    [{ seq: SessionSeq(1), time: 1, type: 'tool/ptc-dispatch', data: { ...data, name: 'run_code' } }],
    [{ seq: SessionSeq(1), time: 1, type: 'tool/ptc-dispatch', data: { ...data, isError: true } }],
    [
      {
        seq: SessionSeq(1),
        time: 1,
        type: 'tool/ptc-dispatch',
        data: { ...data, content: [{ type: 'text', text: JSON.stringify({ sessionId: a, messageId: 'sent', accepted: false }) }] }
      }
    ],
    [{ seq: SessionSeq(1), time: 1, type: 'tool/ptc-dispatch-start', data }],
    [
      { seq: SessionSeq(1), time: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: ToolCallId('input'), name: 'send_to_session', arguments: JSON.stringify(args) } },
      {
        seq: SessionSeq(2),
        time: 2,
        type: 'tool/result',
        data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('other-call'), isError: false, content }) }
      }
    ]
  ]
  for (const evidence of invalid)
    expect(() => preparePeerMessage(b, a, { kind: 'complete', reply_to: offered.id, summary: 'Done' }, 20000, [...received(offered), ...evidence])).toThrow('acceptance')
})

it('applies the configured size limit to structured and plain message bodies', () => {
  expect(() => preparePeerMessage(a, b, 'long message', 3)).toThrow('exceeds 3')
  expect(() => preparePeerMessage(a, b, { ...proposal, scope: [...proposal.scope] }, 30)).toThrow('exceeds 30')
})
