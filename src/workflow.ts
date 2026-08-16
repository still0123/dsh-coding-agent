import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import type { CommandEvidence, Diagnosis, PatchSummary } from './domain.js'

const WRITER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['patched', 'blocked'] },
    diagnosis: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
      },
    },
    residualRisks: { type: 'array', items: { type: 'string' } },
  },
  required: ['outcome', 'diagnosis', 'evidence', 'residualRisks'],
} as const

export const REPAIR_WORKFLOW_SCRIPT = String.raw`const prompt = [
  'You are the single ReproFix writer. The wrapper has reproduced the declared failure for this run.',
  'Inspect the evidence, form a root-cause hypothesis, then make only the smallest patch needed.',
  'Avoid unrelated refactors, formatting, dependency upgrades, and public API changes.',
  'You may run supporting checks, but the wrapper independently owns final verification.',
  'Do not commit, push, reset, checkout, clean, or delete user data.',
  'Task: ' + args.task,
  'Reproduction evidence: ' + JSON.stringify(args.reproduction),
  args.previousValidation ? 'Previous validation failure: ' + JSON.stringify(args.previousValidation) : '',
  args.patch ? 'Current patch: ' + JSON.stringify(args.patch) : '',
  'Return strict JSON matching the requested schema.',
].filter(Boolean).join('\n\n')
return await agent(prompt, {
  label: 'reprofix-writer',
  phase: 'repair',
  schema: args.writerSchema,
})
`

const WORKFLOW_META = {
  name: 'reprofix-repair',
  description: 'Run one serial writer after exact reproduction.',
  phases: [{ title: 'repair', detail: 'Root cause and minimal patch' }],
} satisfies WorkflowMeta

export interface WriterResult {
  outcome: 'patched' | 'blocked'
  diagnosis: string
  evidence: Array<{ path: string; line?: number; reason: string }>
  residualRisks: string[]
}

export interface WorkflowAttempt {
  stopReason: string
  agentsStarted: number
  error?: string
  writer?: WriterResult
}

function isWriterResult(value: unknown): value is WriterResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.outcome !== 'patched' && record.outcome !== 'blocked') return false
  if (typeof record.diagnosis !== 'string' || !Array.isArray(record.evidence) || !Array.isArray(record.residualRisks)) return false
  return record.evidence.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const evidence = item as Record<string, unknown>
    return typeof evidence.path === 'string'
      && typeof evidence.reason === 'string'
      && (evidence.line === undefined || Number.isInteger(evidence.line))
  }) && record.residualRisks.every((risk) => typeof risk === 'string')
}

export async function runWriterWorkflow(input: {
  ctx: Context
  parent: Agent
  signal: AbortSignal
  task: string
  reproduction: CommandEvidence
  previousValidation?: CommandEvidence[]
  patch?: PatchSummary
}): Promise<WorkflowAttempt> {
  const run = input.ctx.workflowEngine.start({
    script: REPAIR_WORKFLOW_SCRIPT,
    meta: WORKFLOW_META,
    args: {
      task: input.task,
      reproduction: input.reproduction,
      writerSchema: WRITER_SCHEMA,
      ...(input.previousValidation === undefined ? {} : { previousValidation: input.previousValidation }),
      ...(input.patch === undefined ? {} : { patch: input.patch }),
    },
    parent: input.parent,
    signal: input.signal,
    maxTotalAgents: 1,
  })

  const onAbort = (): void => { run.cancel('repair_failure aborted') }
  input.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await run.result
    const base: WorkflowAttempt = {
      stopReason: result.stopReason,
      agentsStarted: result.agentsStarted,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
    if (result.stopReason !== 'completed') return base
    if (!isWriterResult(result.value)) return { ...base, error: 'workflow returned invalid writer output' }
    return { ...base, writer: result.value }
  } finally {
    input.signal.removeEventListener('abort', onAbort)
    await run.dispose()
  }
}

export function diagnosisFromWriter(writer: WriterResult): Diagnosis {
  return {
    summary: writer.diagnosis,
    evidence: writer.evidence,
  }
}
