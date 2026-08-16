import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { validateRepairFailureInput, type CommandEvidence, type PatchSummary } from '../src/domain.js'
import { InMemoryActiveRunRegistry } from '../src/guard.js'
import { executeRepairFailure, type CommandRunner, type GitAdapter } from '../src/repair.js'
import type { WriterResult } from '../src/workflow.js'
import type {} from '../src/session.js'

const DIGEST = `sha256:${'1'.repeat(64)}`

function evidence(command: string, options: Partial<CommandEvidence> = {}): CommandEvidence {
  return {
    command,
    processStarted: true,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    sandboxDenied: false,
    durationMs: 1,
    outputDigest: DIGEST,
    outputTail: '',
    stdout: '',
    stderr: '',
    combinedOutput: '\n',
    ...options,
  }
}

function patch(revision: number, fingerprint = `sha256:patch-${revision}`): PatchSummary {
  return {
    revision,
    fingerprint,
    changedFiles: ['src/add.ts'],
    added: 1,
    deleted: 1,
    manifestFiles: [],
    binaryFiles: [],
    score: 12,
  }
}

function agent(id = 'integration-agent'): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    cwd: '/repo',
  })
  return {
    id: sessionId,
    session,
    ctx: { workflowEngine: {} },
  } as unknown as Agent
}

function args(maxRepairRounds = 1) {
  return validateRepairFailureInput({
    task: 'Fix add()',
    repro: {
      command: 'pnpm test repro',
      failure: { outputIncludes: ['expected 4, received 3'] },
      success: { exitCodes: [0] },
    },
    acceptance: [
      { name: 'unit', command: 'pnpm test' },
      { name: 'types', command: 'pnpm typecheck' },
    ],
    maxRepairRounds,
  })
}

function dependencies(options: {
  clean?: boolean
  commands?: CommandEvidence[]
  patches?: PatchSummary[]
  writers?: Array<WriterResult | null>
}) {
  const commands = [...(options.commands ?? [])]
  const patches = [...(options.patches ?? [])]
  const writers = [...(options.writers ?? [])]
  const commandRunner: CommandRunner = {
    run: vi.fn(async (input) => commands.shift() ?? evidence(input.command)),
  }
  const git: GitAdapter = {
    baseline: vi.fn(async () => ({ workspaceRoot: '/repo', head: 'abc', clean: options.clean ?? true })),
    isClean: vi.fn(async () => options.clean ?? true),
    patch: vi.fn(async (_root, revision) => patches.shift() ?? patch(revision)),
  }
  const runWriter = vi.fn(async () => {
    const writer = writers.shift()
    return writer
      ? { stopReason: 'completed', agentsStarted: 1, writer }
      : { stopReason: 'completed', agentsStarted: 1, error: 'invalid writer output' }
  })
  return {
    commandRunner,
    git,
    activeRuns: new InMemoryActiveRunRegistry(),
    runWriter,
    runId: () => 'run-1',
    now: () => new Date('2026-08-16T00:00:00.000Z'),
  }
}

const writer: WriterResult = {
  outcome: 'patched',
  diagnosis: 'add() returned a constant',
  evidence: [{ path: 'src/add.ts', line: 1, reason: 'returns 3' }],
  residualRisks: [],
}

describe('repair_failure transaction', () => {
  it('blocks a dirty workspace before running reproduction or workflow', async () => {
    const deps = dependencies({ clean: false })
    const caller = agent()
    const result = await executeRepairFailure({
      args: args(), agent: caller, toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })

    expect(result.status).toBe('blocked_dirty_workspace')
    expect(deps.commandRunner.run).not.toHaveBeenCalled()
    expect(deps.runWriter).not.toHaveBeenCalled()
    expect(caller.session.events.at(-1)?.type).toBe('reprofix/receipt')
  })

  it('blocks a concurrent active run without Git or command side effects', async () => {
    const deps = dependencies({})
    const caller = agent()
    expect(deps.activeRuns.claim(String(caller.id), 'existing', caller)).toBe(true)
    const result = await executeRepairFailure({
      args: args(), agent: caller, toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })

    expect(result.status).toBe('blocked_active_run')
    expect(deps.git.baseline).not.toHaveBeenCalled()
    expect(deps.commandRunner.run).not.toHaveBeenCalled()
    expect(deps.runWriter).not.toHaveBeenCalled()
    deps.activeRuns.release(String(caller.id), 'existing')
  })

  it('supersedes stale non-terminal runs only after confirming a clean baseline', async () => {
    const deps = dependencies({
      commands: [evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'different failure\n' })],
    })
    const caller = agent()
    caller.session.append('reprofix/run-state', { runId: 'stale-run', state: 'reproduced' })
    const result = await executeRepairFailure({
      args: args(), agent: caller, toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })

    expect(result.status).toBe('not_reproduced')
    expect(caller.session.events).toContainEqual(expect.objectContaining({
      type: 'reprofix/run-state',
      data: expect.objectContaining({ runId: 'stale-run', state: 'superseded' }),
    }))
  })

  it('does not unlock a non-matching failure and never starts workflow', async () => {
    const deps = dependencies({
      commands: [evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'different failure\n' })],
    })
    const caller = agent()
    const result = await executeRepairFailure({
      args: args(), agent: caller, toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })

    expect(result.status).toBe('not_reproduced')
    expect(deps.runWriter).not.toHaveBeenCalled()
    expect(caller.session.events.some((event) => event.type === 'reprofix/run-state' && event.data.state === 'reproduced')).toBe(false)
  })

  it('blocks when reproduction changes the workspace before starting workflow', async () => {
    const deps = dependencies({
      commands: [evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' })],
    })
    vi.mocked(deps.git.isClean).mockResolvedValueOnce(false)
    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })

    expect(result.status).toBe('blocked_repro_side_effect')
    expect(deps.runWriter).not.toHaveBeenCalled()
  })

  it('records a workflow start exception as repair_failed with a terminal receipt', async () => {
    const deps = dependencies({
      commands: [evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' })],
    })
    deps.runWriter.mockRejectedValueOnce(new Error('workflow start failed'))
    const caller = agent()
    const result = await executeRepairFailure({
      args: args(), agent: caller, toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })

    expect(result.status).toBe('repair_failed')
    expect(caller.session.events.at(-1)).toMatchObject({
      type: 'reprofix/receipt',
      data: { status: 'repair_failed', workflow: [{ stopReason: 'error', error: 'workflow start failed' }] },
    })
  })

  it('returns repair_failed when the writer produces no patch', async () => {
    const deps = dependencies({
      commands: [evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' })],
      writers: [writer],
    })
    vi.mocked(deps.git.patch).mockResolvedValueOnce({ ...patch(1), changedFiles: [] })
    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })
    expect(result.status).toBe('repair_failed')
  })

  it('returns fixed only after wrapper-owned repro and all acceptance checks pass', async () => {
    const deps = dependencies({
      commands: [
        evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' }),
        evidence('pnpm test repro'),
        evidence('pnpm test'),
        evidence('pnpm typecheck'),
      ],
      patches: [patch(1), patch(1)],
      writers: [writer],
    })
    const caller = agent()
    const result = await executeRepairFailure({
      args: args(), agent: caller, toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })

    expect(result.status).toBe('fixed')
    expect(result.checks.map((check) => [check.kind, check.ok])).toEqual([
      ['reproduction', true],
      ['post_fix_repro', true],
      ['acceptance', true],
      ['acceptance', true],
    ])
    expect(deps.commandRunner.run).toHaveBeenCalledTimes(4)
    const receipt = caller.session.events.find((event) => event.type === 'reprofix/receipt')
    expect(receipt?.data.status).toBe('fixed')
    expect(receipt?.data.validation).toHaveLength(3)
    expect(receipt?.data.reproduction).not.toHaveProperty('stdout')
    expect(receipt?.data.reproduction).not.toHaveProperty('stderr')
    expect(receipt?.data.reproduction).not.toHaveProperty('combinedOutput')
    for (const item of receipt?.data.validation ?? []) {
      expect(item).not.toHaveProperty('stdout')
      expect(item).not.toHaveProperty('stderr')
      expect(item).not.toHaveProperty('combinedOutput')
    }
  })

  it('runs every acceptance command even when post-fix repro fails', async () => {
    const deps = dependencies({
      commands: [
        evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' }),
        evidence('pnpm test repro', { exitCode: 1 }),
        evidence('pnpm test'),
        evidence('pnpm typecheck'),
      ],
      patches: [patch(1), patch(1)],
      writers: [writer],
    })
    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })
    expect(result.status).toBe('validation_failed')
    expect(deps.commandRunner.run).toHaveBeenCalledTimes(4)
  })

  it('invalidates validation when the patch fingerprint changes', async () => {
    const deps = dependencies({
      commands: [
        evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' }),
        evidence('pnpm test repro'), evidence('pnpm test'), evidence('pnpm typecheck'),
      ],
      patches: [patch(1, 'sha256:before'), patch(1, 'sha256:after')],
      writers: [writer],
    })
    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })
    expect(result.status).toBe('validation_failed')
  })

  it('uses only the latest round validation and keeps writers serial', async () => {
    const deps = dependencies({
      commands: [
        evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' }),
        evidence('pnpm test repro', { exitCode: 1 }), evidence('pnpm test'), evidence('pnpm typecheck'),
        evidence('pnpm test repro'), evidence('pnpm test'), evidence('pnpm typecheck'),
      ],
      patches: [patch(1), patch(1), patch(2), patch(2)],
      writers: [writer, writer],
    })
    const result = await executeRepairFailure({
      args: args(2), agent: agent(), toolCallId: 'call-1', signal: new AbortController().signal, dependencies: deps,
    })
    expect(result.status).toBe('fixed')
    expect(result.attempts).toBe(2)
    expect(deps.runWriter).toHaveBeenCalledTimes(2)
    expect(deps.runWriter.mock.invocationCallOrder[0]).toBeLessThan(deps.runWriter.mock.invocationCallOrder[1]!)
  })

  it('returns cancelled when the host signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort('user')
    const deps = dependencies({})
    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: controller.signal, dependencies: deps,
    })
    expect(result.status).toBe('cancelled')
    expect(deps.commandRunner.run).not.toHaveBeenCalled()
  })

  it('returns cancelled when the host aborts during Git baseline discovery', async () => {
    const controller = new AbortController()
    const deps = dependencies({ clean: false })
    vi.mocked(deps.git.baseline).mockImplementationOnce(async () => {
      controller.abort('user')
      return { workspaceRoot: '/repo', head: 'abc', clean: false }
    })

    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: controller.signal, dependencies: deps,
    })
    expect(result.status).toBe('cancelled')
    expect(deps.commandRunner.run).not.toHaveBeenCalled()
  })

  it('returns cancelled when the host aborts during the post-reproduction clean check', async () => {
    const controller = new AbortController()
    const deps = dependencies({
      commands: [evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' })],
    })
    vi.mocked(deps.git.isClean).mockImplementationOnce(async () => {
      controller.abort('user')
      return false
    })

    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: controller.signal, dependencies: deps,
    })
    expect(result.status).toBe('cancelled')
    expect(deps.runWriter).not.toHaveBeenCalled()
  })

  it('returns cancelled when the host aborts while reading the writer patch', async () => {
    const controller = new AbortController()
    const deps = dependencies({
      commands: [evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' })],
      writers: [writer],
    })
    vi.mocked(deps.git.patch).mockImplementationOnce(async () => {
      controller.abort('user')
      return { ...patch(1), changedFiles: [] }
    })

    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: controller.signal, dependencies: deps,
    })
    expect(result.status).toBe('cancelled')
  })

  it('returns cancelled when the host aborts during the final patch fingerprint read', async () => {
    const controller = new AbortController()
    const deps = dependencies({
      commands: [
        evidence('pnpm test repro', { exitCode: 1, combinedOutput: 'expected 4, received 3\n' }),
        evidence('pnpm test repro'), evidence('pnpm test'), evidence('pnpm typecheck'),
      ],
      patches: [patch(1)],
      writers: [writer],
    })
    vi.mocked(deps.git.patch).mockImplementationOnce(async (_root, revision) => patch(revision))
      .mockImplementationOnce(async (_root, revision) => {
        controller.abort('user')
        return patch(revision)
      })

    const result = await executeRepairFailure({
      args: args(), agent: agent(), toolCallId: 'call-1', signal: controller.signal, dependencies: deps,
    })
    expect(result.status).toBe('cancelled')
  })
})
