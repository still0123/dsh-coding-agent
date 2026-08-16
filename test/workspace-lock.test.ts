import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FileWorkspaceLock } from '../src/workspace-lock.js'

function request(workspaceRoot: string, runId: string) {
  return { workspaceRoot, runId, sessionId: `session-${runId}` }
}

describe('workspace lock', () => {
  it('excludes another registry using the same DSH_HOME and releases by owner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshagent-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'dshagent-workspace-'))
    const first = new FileWorkspaceLock(home)
    const second = new FileWorkspaceLock(home)

    expect(await first.claim(request(workspace, 'one'))).toBe(true)
    expect(await second.claim(request(workspace, 'two'))).toBe(false)
    await second.release(request(workspace, 'two'))
    expect(await second.claim(request(workspace, 'two'))).toBe(false)
    await first.release(request(workspace, 'one'))
    expect(await second.claim(request(workspace, 'two'))).toBe(true)
    await second.release(request(workspace, 'two'))
  })

  it('recovers a well-formed lock only after its process is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshagent-stale-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'dshagent-stale-workspace-'))
    const id = createHash('sha256').update(workspace).digest('hex')
    const lockPath = join(home, 'dsh-coding-agent', 'locks', `${id}.lock`)
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify({
      nonce: 'stale-owner',
      pid: 2_147_483_647,
      processStartedAt: new Date(0).toISOString(),
      runId: 'stale',
      sessionId: 'session-stale',
      workspaceRoot: workspace,
      acquiredAt: new Date(0).toISOString(),
    })}\n`)

    const lock = new FileWorkspaceLock(home)
    expect(await lock.claim(request(workspace, 'replacement'))).toBe(true)
    await lock.release(request(workspace, 'replacement'))
  })

  it('excludes a live owner in another process and recovers after it exits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshagent-process-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'dshagent-process-workspace-'))
    const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'workspace-lock.ts')).href
    const script = `
      import { FileWorkspaceLock } from ${JSON.stringify(moduleUrl)}
      const lock = new FileWorkspaceLock(process.env.LOCK_HOME)
      const request = {
        workspaceRoot: process.env.LOCK_WORKSPACE,
        runId: 'child',
        sessionId: 'session-child',
      }
      if (!await lock.claim(request)) process.exit(2)
      process.stdout.write('claimed\\n')
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '--eval',
      script,
    ], {
      env: { ...process.env, LOCK_HOME: home, LOCK_WORKSPACE: workspace },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const [chunk] = await once(child.stdout, 'data') as [Buffer]
    expect(chunk.toString()).toContain('claimed')

    const contender = new FileWorkspaceLock(home)
    expect(await contender.claim(request(workspace, 'parent'))).toBe(false)
    child.kill('SIGKILL')
    const [code] = await once(child, 'close') as [number | null]
    expect(code).not.toBe(2)
    expect(Buffer.concat(stderr).toString()).toBe('')
    expect(await contender.claim(request(workspace, 'parent'))).toBe(true)
    await contender.release(request(workspace, 'parent'))
  })
})
