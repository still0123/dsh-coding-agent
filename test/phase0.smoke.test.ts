import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { describe, expect, it } from 'vitest'

class FakeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'phase0-fake'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.behavior(request)
  }
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((block) => block.type === 'text')?.text ?? ''
}

function registerEcho(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo one string.',
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => `echo:${args.value}`,
  }))
}

describe('Phase 0 real DSH API spike', () => {
  it('registers a defineTool output and enforces a monotonic guard', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    registerEcho(ctx)
    ctx.tools.guard((exec) => (exec.name === 'echo' ? 'phase0 denied' : undefined))

    const result = await ctx.tools.execute({
      callId: CallId('phase0-native'),
      name: 'echo',
      arguments: { value: 'x' },
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(textResult(result)).toContain('phase0 denied')
  })

  it('routes Code Mode sub-dispatch through the same guard', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'code' })
    await ctx.plugin(FakeCodeRuntime)
    registerEcho(ctx)
    ctx.tools.guard((exec) => (exec.name === 'echo' ? 'nested write denied' : undefined))
    const runtime = ctx.codeRuntime as FakeCodeRuntime
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.echo!({ value: 'x' })
        return { logs: [], value: 'unexpected success' }
      } catch (error: unknown) {
        return { logs: [], value: error instanceof Error ? error.message : String(error) }
      }
    }

    const result = await ctx.tools.execute({
      callId: CallId('phase0-code'),
      name: RUN_CODE_NAME,
      arguments: { code: 'await tools.echo({ value: "x" })', description: 'guard smoke' },
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(textResult(result)).toContain('nested write denied')
  })

  it('appends typed log-only Session events', () => {
    const session = Session.create(SessionId('phase0-session'))
    session.append('reprofix/run-state', {
      runId: 'phase0-run',
      state: 'created',
      at: new Date(0).toISOString(),
    })
    expect(session.events.at(-1)).toMatchObject({
      type: 'reprofix/run-state',
      data: { runId: 'phase0-run', state: 'created' },
    })
  })

  it('runs and disposes the real workflow worker on completed and cancelled paths', async () => {
    const ctx = new Context()
    const subagents = await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('phase0 script must not start a child')),
    })
    const engine = await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })
    const parent = { id: SessionId('phase0-parent'), options: {} } as unknown as Agent
    try {
      const completed = ctx.workflowEngine.start({
        script: 'return 6 * 7',
        meta: { name: 'phase0-completed', description: 'verify completed lifecycle' },
        parent,
        maxTotalAgents: 1,
      })
      try {
        await expect(completed.result).resolves.toMatchObject({ stopReason: 'completed', value: 42 })
      } finally {
        await completed.dispose()
      }

      const controller = new AbortController()
      controller.abort('phase0 cancellation')
      const cancelled = ctx.workflowEngine.start({
        script: 'return 1',
        meta: { name: 'phase0-cancelled', description: 'verify cancellation lifecycle' },
        parent,
        signal: controller.signal,
        maxTotalAgents: 1,
      })
      try {
        await expect(cancelled.result).resolves.toMatchObject({ stopReason: 'cancelled' })
      } finally {
        await cancelled.dispose()
      }
    } finally {
      await engine.dispose()
      await subagents.dispose()
    }
  })
})
