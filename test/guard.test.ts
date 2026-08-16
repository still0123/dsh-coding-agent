import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { InMemoryActiveRunRegistry, installGuard } from '../src/guard.js'
import type {} from '../src/session.js'

function agent(id: string, parentSession?: string): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    cwd: '/workspace',
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  })
  return { id: sessionId, session } as Agent
}

function register(ctx: Context, name: string): void {
  ctx.tools.register(defineTool({
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => `ran:${name}`,
  }))
}

async function execute(ctx: Context, name: string, caller: Agent) {
  return ctx.tools.execute({
    callId: CallId(`${name}-call`),
    name,
    arguments: {},
    agent: caller,
    signal: new AbortController().signal,
  })
}

describe('ReproFix guard', () => {
  it('allows readonly and repair_failure while denying write, shell, and unknown tools when locked', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    for (const name of ['read', 'repair_failure', 'write', 'bash', 'mystery']) register(ctx, name)
    installGuard(ctx, new InMemoryActiveRunRegistry())
    const caller = agent('locked')

    expect((await execute(ctx, 'read', caller)).isError).toBe(false)
    expect((await execute(ctx, 'repair_failure', caller)).isError).toBe(false)
    for (const name of ['write', 'bash', 'mystery']) {
      const result = await execute(ctx, name, caller)
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('exact reproduction') })
    }
  })

  it('unlocks only a child of the current durable reproduced run and relocks on terminal state', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    for (const name of ['write', 'structured_output', 'bash', 'mystery']) register(ctx, name)
    const registry = new InMemoryActiveRunRegistry()
    installGuard(ctx, registry)
    const owner = agent('owner')
    const child = agent('child', 'owner')
    const stale = agent('stale', 'other')

    expect(registry.claim('owner', 'run-1', owner)).toBe(true)
    owner.session.append('reprofix/run-state', { runId: 'run-1', state: 'reproduced' })
    registry.setState('owner', 'run-1', 'reproduced')
    expect((await execute(ctx, 'write', child)).isError).toBe(false)
    expect((await execute(ctx, 'structured_output', child)).isError).toBe(false)
    for (const name of ['bash', 'mystery']) {
      const result = await execute(ctx, name, child)
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('wrapper-owned') })
    }
    expect((await execute(ctx, 'write', stale)).isError).toBe(true)

    owner.session.append('reprofix/run-state', { runId: 'run-1', state: 'fixed' })
    registry.setState('owner', 'run-1', 'fixed')
    expect((await execute(ctx, 'write', child)).isError).toBe(true)
  })

  it('does not unlock from durable state alone after restart', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    register(ctx, 'write')
    installGuard(ctx, new InMemoryActiveRunRegistry())
    const owner = agent('restarted')
    owner.session.append('reprofix/run-state', { runId: 'old-run', state: 'reproduced' })
    expect((await execute(ctx, 'write', owner)).isError).toBe(true)
  })
})
