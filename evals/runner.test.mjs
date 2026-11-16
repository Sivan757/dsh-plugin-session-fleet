import test from 'node:test'
import assert from 'node:assert/strict'
import { grade, runCase, PEER } from './runner.mjs'
test('runs through native stream chunks and parses tool arguments', async () => {
  let turn = 0
  let previousMessages
  const llm = {
    async *stream(options) {
      assert.equal(options.provider, 'test')
      assert.equal(options.model, 'mock')
      assert.equal(options.config, undefined)
      assert.equal(options.messages[0].role, 'system')
      assert.notEqual(options.messages, previousMessages)
      previousMessages = options.messages
      yield {
        type: 'block-end',
        index: 0,
        block:
          turn++ === 0
            ? { type: 'tool-call', id: 'read-call', name: 'read', arguments: JSON.stringify({ file_path: '/repo/src/versions.ts' }) }
            : { type: 'text', text: 'No entries are enabled.' }
      }
    }
  }
  const result = await runCase(llm, { provider: 'test', model: 'mock' }, '', { name: 'independent-read', contact: false, prompt: 'Explain versions', observed: '' })
  assert.equal(result.passed, true)
  assert.equal(result.trace[0].args.file_path, '/repo/src/versions.ts')
})
const contact = { contact: true }
const read = { contact: false }
const inspect = { name: 'inspect_session', turn: 0, args: { session_id: PEER } }
const send = {
  name: 'send_to_session',
  turn: 1,
  args: {
    session_id: PEER,
    message: {
      kind: 'propose',
      task: 'Finish own change',
      owner: 'session-eval-self',
      scope: ['exclusive:git-index:/repo'],
      summary: 'Separate staged hunks and commit order.',
      next: 'Agree to commit your hunks first.'
    }
  }
}
const commit = { name: 'workspace_operation', args: { operation: 'stage_and_commit' } }
test('requires inspection and a valid targeted proposal before a shared operation', () => {
  assert.equal(grade(contact, [inspect, send], '').passed, true)
  for (const trace of [
    [send],
    [commit, inspect, send],
    [inspect],
    [inspect, { ...send, turn: 0 }],
    [inspect, send, commit],
    [inspect, { ...send, args: { ...send.args, message: JSON.stringify(send.args.message) } }],
    [inspect, { ...send, args: { ...send.args, message: 'Please coordinate' } }]
  ])
    assert.equal(grade(contact, trace, 'I will coordinate.').passed, false)
})
test('does not mistake a successful readonly answer for a need to coordinate', () => {
  assert.equal(grade(read, [{ name: 'read', args: { file_path: '/repo/src/versions.ts' } }], 'No entries are enabled.').passed, true)
  assert.equal(grade(read, [inspect], 'No entries are enabled.').passed, false)
})
test('keeps formatting and validation behind the same coordination gate', () => {
  for (const operation of ['format_foreign_files', 'validate_entire_repo'])
    assert.equal(grade(contact, [{ name: 'workspace_operation', args: { operation } }, inspect, send], '').passed, false)
})
