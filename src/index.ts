import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workflow'
import type {} from '@deepseek-ai/dsh-shell'
import {
  validateRepairFailureInput,
  type RepairFailureResult,
} from './domain.js'
import { InMemoryActiveRunRegistry, installGuard } from './guard.js'
import { executeRepairFailure } from './repair.js'
import { renderRepairFailureResultMarkdown } from './receipt.js'
import { createCommandRunner, createGitAdapter } from './runner.js'
import { FileWorkspaceLock } from './workspace-lock.js'
import { runWriterWorkflow } from './workflow.js'
import type {} from './session.js'

export * from './domain.js'
export * from './guard.js'
export * from './receipt.js'
export * from './repair.js'
export * from './runner.js'
export * from './workflow.js'
export * from './workspace-lock.js'

export const name = 'reprofix'
export const inject = ['tools', 'workflowEngine', 'shell', 'llm']

const EXPECTATION_PROPERTIES = {
  exitCodes: { type: 'array', items: { type: 'integer' } },
  outputIncludes: { type: 'array', items: { type: 'string' } },
} as const

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['reproduction', 'post_fix_repro', 'acceptance'], required: true },
    name: { type: 'string', required: true },
    ok: { type: 'boolean', required: true },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    timedOut: { type: 'boolean', required: true },
    aborted: { type: 'boolean', required: true },
    durationMs: { type: 'number', required: true },
    outputDigest: { type: 'string', required: true },
    outputTail: { type: 'string', required: true },
  },
} as const

const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', required: true },
    evidence: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          line: { type: 'integer' },
          reason: { type: 'string', required: true },
        },
      },
    },
  },
} as const

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    fingerprint: { type: 'string', required: true },
    changedFiles: { type: 'array', items: { type: 'string' }, required: true },
    added: { type: 'integer', required: true },
    deleted: { type: 'integer', required: true },
    manifestFiles: { type: 'array', items: { type: 'string' }, required: true },
    binaryFiles: { type: 'array', items: { type: 'string' }, required: true },
    score: { type: 'integer', required: true },
  },
} as const

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    runId: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: [
        'fixed',
        'not_reproduced',
        'blocked_dirty_workspace',
        'blocked_repro_side_effect',
        'blocked_active_run',
        'repair_failed',
        'validation_failed',
        'cancelled',
        'infrastructure_error',
      ],
    },
    summary: { type: 'string', required: true },
    diagnosis: DIAGNOSIS_SCHEMA,
    patch: PATCH_SCHEMA,
    checks: { type: 'array', items: CHECK_SCHEMA, required: true },
    attempts: { type: 'integer', required: true },
    residualRisks: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

export function apply(ctx: Context): void {
  const activeRuns = new InMemoryActiveRunRegistry()
  installGuard(ctx, activeRuns)
  const commandRunner = createCommandRunner(ctx)
  const git = createGitAdapter(ctx)
  const workspaceLock = new FileWorkspaceLock()
  const runWriter: typeof runWriterWorkflow = (input) => runWriterWorkflow({ ...input, ctx })

  ctx.tools.register(defineTool({
    name: 'repair_failure',
    description:
      'Run a reproduce-first repair transaction in the current Git repository. '
      + 'This tool executes the supplied reproduction and acceptance commands, and may modify source files only after the declared failure matches exactly.',
    parameters: {
      task: { type: 'string', required: true, description: 'Repair task for the single writer Agent.' },
      failureLog: { type: 'string', description: 'Optional context only; never reproduction evidence.' },
      repro: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          command: { type: 'string', required: true },
          timeoutMs: { type: 'integer' },
          failure: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              exitCodes: EXPECTATION_PROPERTIES.exitCodes,
              outputIncludes: { ...EXPECTATION_PROPERTIES.outputIncludes, required: true },
            },
          },
          success: {
            type: 'object',
            additionalProperties: false,
            properties: EXPECTATION_PROPERTIES,
          },
        },
      },
      acceptance: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            command: { type: 'string', required: true },
            timeoutMs: { type: 'integer' },
            success: {
              type: 'object',
              additionalProperties: false,
              properties: EXPECTATION_PROPERTIES,
            },
          },
        },
      },
      maxRepairRounds: { type: 'integer' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: renderRepairFailureResultMarkdown(value as RepairFailureResult),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('repair_failure requires a calling agent (exec.agent was undefined)')
      const args = validateRepairFailureInput(rawArgs)
      return executeRepairFailure({
        args,
        agent,
        toolCallId: String(exec.callId),
        signal: exec.signal,
        dependencies: {
          commandRunner,
          git,
          activeRuns,
          workspaceLock,
          runWriter,
          prepareWriter: () => {
            const provider = agent.options.provider
            if (!provider || ctx.llm.listProviders().some((entry) => entry.id === provider)) return
            throw new Error(
              `No LLM adapter for provider "${provider}" in the active DSH profile`,
            )
          },
        },
      })
    },
  }))
}
