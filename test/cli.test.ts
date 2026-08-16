import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  confirmRepair,
  createLaunchFiles,
  main,
  parseArgs,
  repairConfirmation,
  runDshChild,
} from '../client/cli.mjs'
import { repairInputFingerprint, validateRepairFailureInput } from '../src/domain.js'

const exec = promisify(execFile)
const root = join(import.meta.dirname, '..')

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  exitCode: number | null = null
  closeOn: string | undefined

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === this.closeOn) {
      queueMicrotask(() => this.emit('close', null, signal))
    }
    return true
  }
}

function launchOptions(overrides: Record<string, unknown> = {}) {
  return {
    launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
    patchPath: '/tmp/dshagent.patch.yml',
    cwd: '/repo',
    env: {},
    runtime: new EventEmitter(),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    ...overrides,
  }
}

describe('dshagent CLI', () => {
  it('parses the three public commands and rejects incomplete repair input', () => {
    expect(parseArgs(['run', 'fix', 'the', 'bug', '--cwd', '/repo', '--timeout', '1000']))
      .toEqual({ command: 'run', task: 'fix the bug', cwd: '/repo', timeoutMs: 1000 })
    expect(parseArgs(['repair', '--spec', 'repair.json', '--yes']))
      .toMatchObject({ command: 'repair', spec: 'repair.json', yes: true })
    expect(parseArgs(['presets', 'install', '--home', '/tmp/dsh', '--force']))
      .toEqual({ command: 'presets', home: '/tmp/dsh', force: true })
    expect(() => parseArgs(['repair'])).toThrow(/requires --spec/)
    expect(() => parseArgs(['run', 'task', '--timeout', '0'])).toThrow(/positive integer/)
  })

  it('shows the exact authorization set and fails closed without a TTY', async () => {
    const input = validateRepairFailureInput({
      task: 'fix',
      repro: {
        command: 'pnpm test',
        failure: { exitCodes: [1], outputIncludes: ['expected 4'] },
      },
      acceptance: [{ name: 'types', command: 'pnpm typecheck' }],
    })
    const text = repairConfirmation(input, '/repo')
    expect(text).toContain('Reproduction: pnpm test')
    expect(text).toContain('"expected 4"')
    expect(text).toContain('pnpm typecheck')
    await expect(confirmRepair({ yes: false, input, workspaceRoot: '/repo', isTTY: false }))
      .rejects.toThrow(/requires a TTY/)
    await expect(confirmRepair({
      yes: false,
      input,
      workspaceRoot: '/repo',
      isTTY: true,
      stdout: { write: vi.fn() },
      ask: async () => 'yes',
    })).resolves.toBeUndefined()
  })

  it('writes an owner-only trusted context and keeps commands out of the patch', async () => {
    const input = validateRepairFailureInput({
      task: 'fix',
      repro: { command: 'pnpm test', failure: { outputIncludes: ['failure'] } },
    })
    const launch = {
      version: 1,
      mode: 'repair',
      workspaceRoot: '/repo',
      input,
      fingerprint: repairInputFingerprint(input, '/repo'),
    }
    const files = await createLaunchFiles(launch, root)
    try {
      expect(JSON.parse(await readFile(files.contextPath, 'utf8'))).toEqual(launch)
      const patch = await readFile(files.patchPath, 'utf8')
      expect(patch).toContain('dshagent-cli-runner')
      expect(patch).toContain('dshagent-agent-presets')
      expect(patch).not.toContain('pnpm test')
      expect(await readFile(join(files.presetRoot, 'dshagent', 'preset.yml'), 'utf8')).toContain('DSHAgent')
      expect(await readFile(join(files.presetRoot, 'reprofix', 'agent.cordis.yml'), 'utf8'))
        .toContain(join(root, 'dist', 'index.js'))
      if (process.platform !== 'win32') {
        expect((await stat(files.contextPath)).mode & 0o777).toBe(0o600)
        expect((await stat(files.patchPath)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await files.cleanup()
    }
  })

  it('launches DSH with argv arrays and forwards output', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const output = { write: vi.fn() }
    const running = runDshChild(launchOptions({ spawnProcess, stdout: output }))
    child.stdout.write('answer\n')
    child.emit('close', 0, null)
    await expect(running).resolves.toBe(0)
    expect(output.write).toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['/opt/dsh/lib/bin.js', '--profile', 'headless', '--patch', '/tmp/dshagent.patch.yml'],
      expect.objectContaining({ cwd: '/repo', shell: false }),
    )
  })

  it('uses graceful then forced termination on timeout', async () => {
    const child = new FakeChild()
    child.closeOn = 'SIGKILL'
    const running = runDshChild(launchOptions({
      spawnProcess: () => child as never,
      timeoutMs: 5,
      shutdownTimeoutMs: 5,
    }))
    await expect(running).resolves.toBe(124)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('maps SIGINT cancellation to exit code 130', async () => {
    const child = new FakeChild()
    child.closeOn = 'SIGTERM'
    const runtime = new EventEmitter()
    const running = runDshChild(launchOptions({
      spawnProcess: () => child as never,
      runtime,
    }))
    runtime.emit('SIGINT')
    await expect(running).resolves.toBe(130)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('validates and fingerprints repair input before spawning DSH', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshagent-cli-workspace-'))
    const spec = join(workspace, 'repair.json')
    await exec('git', ['init', '-q'], { cwd: workspace })
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace })
    await exec('git', ['config', 'user.name', 'Test'], { cwd: workspace })
    await writeFile(join(workspace, 'file.txt'), 'base\n')
    await writeFile(spec, JSON.stringify({
      task: 'fix',
      repro: { command: 'pnpm test', failure: { outputIncludes: ['failure'] } },
    }))
    await exec('git', ['add', '.'], { cwd: workspace })
    await exec('git', ['commit', '-qm', 'base'], { cwd: workspace })
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0, null))
      return child as never
    })
    try {
      await expect(main(
        ['repair', '--spec', spec, '--cwd', workspace, '--yes'],
        {
          packageRoot: root,
          domain: { validateRepairFailureInput, repairInputFingerprint },
          launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
          spawnProcess,
          runtime: new EventEmitter(),
          stdout: { write: vi.fn() },
          stderr: { write: vi.fn() },
        },
      )).resolves.toBe(0)
      const args = spawnProcess.mock.calls[0]?.[1] as string[]
      expect(args.join(' ')).not.toContain('pnpm test')
      expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({
        shell: false,
        env: expect.objectContaining({ DSH_TOOLS_MODE: 'native' }),
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
