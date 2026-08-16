import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { buildPrompt, createLocalClient, dshLaunch, openBrowser, validHost, waitForSettlement } from '../client/server.mjs'
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

  it('clears settlement timers after early completion and timeout', async () => {
    vi.useFakeTimers()
    try {
      await waitForSettlement(Promise.resolve(), 5_000)
      expect(vi.getTimerCount()).toBe(0)

      const waiting = waitForSettlement(new Promise(() => {}), 10)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(10)
      await waiting
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
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

  it.each([
    ['darwin', 'open', ['http://127.0.0.1:4317/']],
    ['linux', 'xdg-open', ['http://127.0.0.1:4317/']],
    ['win32', 'cmd.exe', ['/d', '/s', '/c', 'start', '', 'http://127.0.0.1:4317/']],
  ])('opens the browser on %s without a command shell', async (platform, command, args) => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child as never
    })

    await expect(openBrowser('http://127.0.0.1:4317/', platform, spawnProcess)).resolves.toBe(true)
    expect(spawnProcess).toHaveBeenCalledWith(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('contains synchronous and asynchronous browser launcher failures', async () => {
    await expect(openBrowser('http://127.0.0.1:4317/', 'linux', () => {
      throw new Error('spawn exploded')
    })).resolves.toBe(false)

    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('xdg-open missing')))
      return child as never
    })
    await expect(openBrowser('http://127.0.0.1:4317/', 'linux', spawnProcess)).resolves.toBe(false)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('spawn')).toBe(0)
  })

  it('removes its generated patch when Windows launch discovery fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reprofix-client-init-'))
    const prefix = `dsh-reprofix-client-${process.pid}-`
    const before = (await readdir(tmpdir())).filter(name => name.startsWith(prefix)).sort()
    const configuredEntry = process.env.DSH_NODE_ENTRY
    try {
      await mkdir(join(root, 'dist'), { recursive: true })
      await writeFile(join(root, 'dist', 'client-scope.js'), 'export {}\n')
      await writeFile(join(root, 'package.json'), '{"name":"isolated-client-test"}\n')
      delete process.env.DSH_NODE_ENTRY
      await expect(createLocalClient({ packageRoot: root, platform: 'win32' })).rejects.toThrow()
      const after = (await readdir(tmpdir())).filter(name => name.startsWith(prefix)).sort()
      expect(after).toEqual(before)
    } finally {
      if (configuredEntry === undefined) delete process.env.DSH_NODE_ENTRY
      else process.env.DSH_NODE_ENTRY = configuredEntry
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes its generated patch when the requested port is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reprofix-client-listen-'))
    const occupied = createHttpServer()
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'client-scope.js'), 'export {}\n')
    await new Promise<void>((resolvePromise, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const client = await createLocalClient({
      packageRoot: root,
      launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
    })
    try {
      await stat(client.patch)
      await expect(client.listen(address.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
      await expect(stat(client.patch)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(client.close()).resolves.toBeUndefined()
    } finally {
      await new Promise<void>((resolvePromise, reject) => occupied.close(error => error ? reject(error) : resolvePromise()))
      await rm(root, { recursive: true, force: true })
    }
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

  it('escalates a timed-out shutdown to SIGKILL and shares concurrent close work', async () => {
    const child = new FakeChild()
    child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') {
        child.exitCode = 137
        queueMicrotask(() => child.emit('close', null))
      }
      return true
    })
    const spawnProcess = vi.fn(() => child as never)
    const client = await createLocalClient({
      token: 'test-token',
      patch: '/tmp/reprofix-test.yml',
      launch: { command: process.execPath, prefixArgs: ['/opt/dsh/lib/bin.js'] },
      shutdownTimeoutMs: 5,
      spawnProcess,
    })
    const url = await client.listen()
    const input = { task: 'Fix the bug.', repro: { command: 'pnpm test', failure: { outputIncludes: ['failure'] } } }
    const run = post(url, 'test-token', { cwd: process.cwd(), input })
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

    const firstClose = client.close()
    const secondClose = client.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    await run
    expect(child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
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
