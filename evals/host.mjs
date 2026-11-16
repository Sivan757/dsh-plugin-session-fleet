import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { POLICY } from '../src/policy.ts'
import { runCase } from './runner.mjs'

export const name = 'fleet-coordination-eval'
export const inject = ['agents', 'llm', 'agentDefaultModel']
export function apply(ctx, config) {
  const cases = JSON.parse(readFileSync(new URL('../cases.json', import.meta.url), 'utf8'))
  const policies = { candidate: POLICY, baseline: readFileSync(new URL('../baseline-policy.txt', import.meta.url), 'utf8').trimEnd(), none: '' }
  const fixtureHash = createHash('sha256')
    .update(readFileSync(new URL('../runner.mjs', import.meta.url)))
    .update(readFileSync(new URL('../tools.json', import.meta.url)))
    .update(JSON.stringify(cases))
    .digest('hex')
  const registerFor = agent => {
    if (agent.id !== config.caller && config.allowAnyCaller !== true) return undefined
    const dispose = agent.ctx.tools.register(
      defineTool({
        name: 'eval_fleet_coordination',
        description: 'Run one isolated model-choice replay with simulated tools. No file operation or peer delivery is executed.',
        parameters: {
          case: { type: 'string', required: true, enum: cases.map(test => test.name) },
          arm: { type: 'string', required: true, enum: ['candidate', 'baseline', 'none'] },
          repeat: { type: 'integer', required: true, enum: [1, 2, 3] },
          provider: { type: 'string', description: 'Optional LLM provider override.' },
          model: { type: 'string', description: 'Optional model override for the replayed selection.' }
        },
        output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
        timeoutMs: 90000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (exec.agent.id !== config.caller && config.allowAnyCaller !== true) throw new Error('Evaluation is scoped to its owning caller')
          const selection = {
            ...ctx.agentDefaultModel.currentSelection(),
            ...(args.provider === undefined ? {} : { provider: args.provider }),
            ...(args.model === undefined ? {} : { model: args.model })
          }
          const policy = policies[args.arm]
          const start = Date.now()
          let outcome
          try {
            outcome = await runCase(
              ctx.llm,
              selection,
              policy,
              cases.find(test => test.name === args.case),
              AbortSignal.any([exec.signal, AbortSignal.timeout(60000)])
            )
          } catch (error) {
            outcome = { passed: false, error: String(error) }
          }
          const result = {
            case: args.case,
            arm: args.arm,
            repeat: args.repeat,
            fixtureHash,
            selection,
            elapsedMs: Date.now() - start,
            policyHash: createHash('sha256').update(policy).digest('hex'),
            ...outcome
          }
          const directory = new URL('../results/', import.meta.url)
          await mkdir(directory, { recursive: true })
          const file = new URL(args.case + '-' + args.arm + '-' + args.repeat + '-' + randomUUID() + '.json', directory)
          await writeFile(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
          return { ...result, file: file.pathname }
        }
      })
    )
    return () => dispose()
  }
  const installed = new Map()
  const maybeInstall = agent => {
    if (installed.has(agent)) return
    const dispose = registerFor(agent)
    if (dispose) installed.set(agent, dispose)
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => maybeInstall(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  })
}
