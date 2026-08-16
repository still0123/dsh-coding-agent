import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { runWriterWorkflow } from '../src/workflow.js'

function input(ctx: object, signal = new AbortController().signal) {
  return {
    ctx: ctx as never,
    parent: {} as Agent,
    signal,
    task: 'fix the failure',
    reproduction: {
      command: 'test',
      processStarted: true,
      exitCode: 1,
      timedOut: false,
      aborted: false,
      sandboxDenied: false,
      durationMs: 1,
      outputDigest: `sha256:${'0'.repeat(64)}`,
      outputTail: 'expected 4, received 3',
    },
  }
}

describe('writer workflow lifecycle', () => {
  it('passes args instead of interpolating user text and disposes exactly once', async () => {
    const dispose = vi.fn(async () => undefined)
    const start = vi.fn(() => ({
      result: Promise.resolve({
        stopReason: 'completed',
        agentsStarted: 1,
        value: { outcome: 'patched', diagnosis: 'off by one', evidence: [], residualRisks: [] },
      }),
      cancel: vi.fn(),
      dispose,
    }))
    const result = await runWriterWorkflow(input({ workflowEngine: { start } }))

    expect(result.writer?.outcome).toBe('patched')
    expect(dispose).toHaveBeenCalledTimes(1)
    const request = start.mock.calls[0]![0]
    expect(request.script).not.toContain('fix the failure')
    expect(request.args.task).toBe('fix the failure')
    expect(request.maxTotalAgents).toBe(1)
  })

  it('treats non-completed and invalid output as failures while still disposing', async () => {
    for (const value of [
      { stopReason: 'error', error: 'boom', agentsStarted: 1, value: null },
      { stopReason: 'completed', agentsStarted: 1, value: null },
    ]) {
      const dispose = vi.fn(async () => undefined)
      const result = await runWriterWorkflow(input({
        workflowEngine: {
          start: () => ({ result: Promise.resolve(value), cancel: vi.fn(), dispose }),
        },
      }))
      expect(result.writer).toBeUndefined()
      expect(result.error).toBeDefined()
      expect(dispose).toHaveBeenCalledTimes(1)
    }
  })

  it('does not start a workflow for an already-aborted caller', async () => {
    const controller = new AbortController()
    controller.abort('stop')
    const start = vi.fn()

    await expect(runWriterWorkflow(input({ workflowEngine: { start } }, controller.signal))).resolves.toEqual({
      stopReason: 'cancelled',
      agentsStarted: 0,
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('forwards an abort that races with workflow start exactly once', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const dispose = vi.fn(async () => undefined)
    const start = vi.fn(() => {
      controller.abort('stop')
      return {
        result: Promise.resolve({ stopReason: 'cancelled', agentsStarted: 0, value: null }),
        cancel,
        dispose,
      }
    })

    const result = await runWriterWorkflow(input({ workflowEngine: { start } }, controller.signal))
    expect(result.stopReason).toBe('cancelled')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('bridges caller cancellation and disposes', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const dispose = vi.fn(async () => undefined)
    let settle!: (value: { stopReason: 'cancelled'; agentsStarted: number; value: null }) => void
    const resultPromise = new Promise<{ stopReason: 'cancelled'; agentsStarted: number; value: null }>((resolve) => {
      settle = resolve
    })
    const promise = runWriterWorkflow(input({
      workflowEngine: { start: () => ({ result: resultPromise, cancel, dispose }) },
    }, controller.signal))
    controller.abort('stop')
    settle({ stopReason: 'cancelled', agentsStarted: 0, value: null })
    const result = await promise
    expect(result.stopReason).toBe('cancelled')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
