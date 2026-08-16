import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { buildPrompt, createLocalClient, dshLaunch, validHost } from '../client/server.mjs'
import { apply as applyClientScope, mountReproFix } from '../src/client-scope.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)
  exitCode: number | null = null
}

async function post(url: string, token: string, body: unknown) {
  return fetch(new URL('/api/run', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-reprofix-token': token },
    body: JSON.stringify(body),
  })
}

describe('local client', () => {
  it('mounts ReproFix synchronously on top-level agent scope without touching the host layer', () => {
    const scoped = {
      tools: { guard: vi.fn(), register: vi.fn() },
      shell: {},
      workflowEngine: {},
    }
    const childScoped = {
      tools: { guard: vi.fn(), register: vi.fn() },
      shell: {},
      workflowEngine: {},
    }
    const agent = { session: { header: {} }, ctx: scoped }
    const child = { session: { header: { origin: 'subagent' } }, ctx: childScoped }
    let created!: (payload: { agent: typeof agent }) => void
    const host = {
      on: vi.fn((_name: string, listener: typeof created) => { created = listener }),
    }

    applyClientScope(host as never)
    created({ agent: agent as never })
    created({ agent: child as never })

    expect(host.on).toHaveBeenCalledWith('agent/created', expect.any(Function))
    expect(scoped.tools.guard).toHaveBeenCalledTimes(1)
    expect(scoped.tools.register).toHaveBeenCalledTimes(1)
    expect(scoped.tools.register.mock.calls[0]?.[0]).toMatchObject({ name: 'repair_failure' })
    expect(childScoped.tools.guard).not.toHaveBeenCalled()
    expect(childScoped.tools.register).not.toHaveBeenCalled()
  })

  it('mounts the plugin directly when asked by the bridge', () => {
    const scoped = {
      tools: { guard: vi.fn(), register: vi.fn() },
      shell: {},
      workflowEngine: {},
    }
    mountReproFix({ ctx: scoped } as never)
    expect(scoped.tools.guard).toHaveBeenCalledTimes(1)
    expect(scoped.tools.register).toHaveBeenCalledTimes(1)
    expect(scoped.tools.register.mock.calls[0]?.[0]).toMatchObject({ name: 'repair_failure' })
  })

  it('builds a constrained prompt without shell interpolation', () => {
    const input = { task: 'fix "quoted"', repro: { command: 'echo $TOKEN', failure: { outputIncludes: ['x'] } } }
    const prompt = buildPrompt(input)
    expect(prompt).toContain('Use the repair_failure tool exactly once')
    expect(prompt).toContain(JSON.stringify(input))
    expect(prompt).toContain('Do not edit files or run shell commands outside that tool')
  })

  it('accepts only the numeric loopback Host', () => {
    expect(validHost('127.0.0.1:4317')).toBe(true)
    expect(validHost('localhost:4317')).toBe(false)
    expect(validHost('evil.example:4317')).toBe(false)
    expect(validHost(undefined)).toBe(false)
  })

  it('uses the DSH Node entry on both macOS and Windows without a command shell', () => {
    expect(dshLaunch('/app/dsh/lib/bin.js', 'darwin')).toEqual({
      command: process.execPath,
      prefixArgs: ['/app/dsh/lib/bin.js'],
    })
    expect(dshLaunch('C:\\app\\dsh\\lib\\bin.js', 'win32')).toEqual({
      command: process.execPath,
      prefixArgs: ['C:\\app\\dsh\\lib\\bin.js'],
    })
    expect(() => dshLaunch(undefined, 'win32')).toThrow(/Windows requires @deepseek-ai\/dsh/)
  })

  it('binds locally, requires its token, and spawns DSH without a shell', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const client = await createLocalClient({
      token: 'test-token',
      patch: '/tmp/reprofix-test.yml',
      launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
      spawnProcess,
    })
    const url = await client.listen()
    try {
      expect(new URL(url).hostname).toBe('127.0.0.1')
      const page = await fetch(url)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(await page.text()).toContain('ReproFix Local')

      const denied = await post(url, 'wrong-token', { cwd: process.cwd(), input: {} })
      expect(denied.status).toBe(403)

      const input = {
        task: 'Fix the bug.',
        repro: { command: 'pnpm test', failure: { outputIncludes: ['failure'] } },
      }
      const run = post(url, 'test-token', { cwd: process.cwd(), input })
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
      const [command, args, options] = spawnProcess.mock.calls[0]!
      expect(command).toBe(process.execPath)
      expect(args.slice(0, 5)).toEqual(['/opt/dsh/lib/bin.js', '--profile', 'headless', '--patch', '/tmp/reprofix-test.yml'])
      expect(args.at(-1)).toContain(JSON.stringify(input))
      expect(options).toMatchObject({ cwd: process.cwd(), shell: false, windowsHide: true })
      expect(options.env.DSH_TOOLS_MODE).toBe('native')

      child.stdout.write('agent output\n')
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0)
      const response = await run
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('agent output')
    } finally {
      await client.close()
    }
  })

  it('rejects a second run and kills the active child on shutdown', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const client = await createLocalClient({
      token: 'test-token',
      patch: '/tmp/reprofix-test.yml',
      launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
      spawnProcess,
    })
    const url = await client.listen()
    const input = { task: 'Fix the bug.', repro: { command: 'pnpm test', failure: { outputIncludes: ['failure'] } } }
    const first = post(url, 'test-token', { cwd: process.cwd(), input })
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
    const second = await post(url, 'test-token', { cwd: process.cwd(), input })
    expect(second.status).toBe(409)
    const closing = client.close()
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.exitCode = 143
    child.emit('close', null)
    await closing
    await first
  })

  it('returns a bounded launcher error and clears the active slot', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const client = await createLocalClient({
      token: 'test-token',
      patch: '/tmp/reprofix-test.yml',
      launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
      spawnProcess,
    })
    const url = await client.listen()
    try {
      const input = { task: 'Fix the bug.', repro: { command: 'pnpm test', failure: { outputIncludes: ['failure'] } } }
      const run = post(url, 'test-token', { cwd: process.cwd(), input })
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
      child.emit('error', new Error('spawn failed'))
      const response = await run
      expect(await response.text()).toContain('[launcher error] spawn failed')
      expect(await fetch(new URL('/health', url)).then((item) => item.json())).toEqual({ ok: true, active: false })
    } finally {
      await client.close()
    }
  })

  it('returns 400 and clears the active slot when spawning throws synchronously', async () => {
    const spawnProcess = vi.fn(() => { throw new Error('spawn exploded') })
    const client = await createLocalClient({
      token: 'test-token',
      patch: '/tmp/reprofix-test.yml',
      launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
      spawnProcess,
    })
    const url = await client.listen()
    try {
      const input = { task: 'Fix the bug.', repro: { command: 'pnpm test', failure: { outputIncludes: ['failure'] } } }
      const response = await post(url, 'test-token', { cwd: process.cwd(), input })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('spawn exploded')
      expect(await fetch(new URL('/health', url)).then((item) => item.json())).toEqual({ ok: true, active: false })
    } finally {
      await client.close()
    }
  })

  it('rejects relative workspaces and oversized requests before spawning', async () => {
    const spawnProcess = vi.fn()
    const client = await createLocalClient({
      token: 'test-token',
      patch: '/tmp/reprofix-test.yml',
      launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
      spawnProcess,
    })
    const url = await client.listen()
    try {
      const invalid = await post(url, 'test-token', {
        cwd: 'relative/path',
        input: { task: 'x', repro: {} },
      })
      expect(invalid.status).toBe(400)
      expect(spawnProcess).not.toHaveBeenCalled()

      const oversized = await fetch(new URL('/api/run', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-reprofix-token': 'test-token' },
        body: JSON.stringify({ cwd: process.cwd(), input: { task: 'x'.repeat(70_000), repro: {} } }),
      })
      expect(oversized.status).toBe(400)
      expect(spawnProcess).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })
})
