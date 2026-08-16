import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { createCommandRunner, createGitAdapter } from '../src/runner.js'

const exec = promisify(execFile)

function shellResult(overrides: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1_000,
    stdout: { text: 'out', truncated: false },
    stderr: { text: 'err', truncated: false },
    ...overrides,
  }
}

describe('command runner', () => {
  it('preserves command evidence classifications', async () => {
    const run = vi.fn(async () => shellResult({
      exitCode: null,
      timedOut: true,
      sandbox: { mode: 'workspace-write', denied: true },
    }))
    const runner = createCommandRunner({ shell: { resolve: (value: unknown) => value, run } } as never)
    const result = await runner.run({
      command: 'failing command', cwd: '/repo', timeoutMs: 1_000,
      signal: new AbortController().signal, maxOutputBytes: 1_024,
    })
    expect(result).toMatchObject({
      processStarted: true,
      exitCode: null,
      timedOut: true,
      sandboxDenied: true,
      stdout: 'out',
      stderr: 'err',
    })
  })

  it('normalizes spawn infrastructure errors without inventing exit code 1', async () => {
    const runner = createCommandRunner({
      shell: { resolve: (value: unknown) => value, run: async () => { throw new Error('spawn ENOENT') } },
    } as never)
    const result = await runner.run({
      command: 'missing', cwd: '/repo', timeoutMs: 1_000,
      signal: new AbortController().signal, maxOutputBytes: 1_024,
    })
    expect(result).toMatchObject({ processStarted: false, exitCode: null, error: 'spawn ENOENT' })
  })
})

describe('git adapter', () => {
  it('detects dirty untracked files and computes deterministic patch stats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reprofix-git-'))
    await exec('git', ['init', '-q'], { cwd: root })
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    await exec('git', ['config', 'user.name', 'Test'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'one\n')
    await exec('git', ['add', '.'], { cwd: root })
    await exec('git', ['commit', '-qm', 'base'], { cwd: root })

    const shell = {
      resolve: (value: unknown) => value,
      async run(spec: { command: string; workdir: string }) {
        try {
          const { stdout, stderr } = await exec('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8' })
          return shellResult({ stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } })
        } catch (error: unknown) {
          const failure = error as { code?: number; stdout?: string; stderr?: string }
          return shellResult({
            exitCode: failure.code ?? 1,
            stdout: { text: failure.stdout ?? '', truncated: false },
            stderr: { text: failure.stderr ?? String(error), truncated: false },
          })
        }
      },
    }
    const adapter = createGitAdapter({ shell } as never)
    expect((await adapter.baseline(root)).clean).toBe(true)

    await writeFile(join(root, 'tracked.txt'), 'two\n')
    await writeFile(join(root, 'package.json'), '{}\n')
    expect(await adapter.isClean(root)).toBe(false)
    const first = await adapter.patch(root, 1)
    const second = await adapter.patch(root, 1)
    expect(first).toEqual(second)
    expect(first.changedFiles).toEqual(['package.json', 'tracked.txt'])
    expect(first.manifestFiles).toEqual(['package.json'])
    expect(first.added).toBeGreaterThanOrEqual(2)
    expect(first.deleted).toBe(1)
    expect(first.score).toBe(first.added + first.deleted + 20 + 50)
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('two\n')
  })
})
