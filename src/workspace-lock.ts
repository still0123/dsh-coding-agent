import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

interface LockOwner {
  nonce: string
  pid: number
  processStartedAt: string
  runId: string
  sessionId: string
  workspaceRoot: string
  acquiredAt: string
}

export interface WorkspaceLockRequest {
  runId: string
  sessionId: string
  workspaceRoot: string
}

export interface WorkspaceLock {
  claim(request: WorkspaceLockRequest): Promise<boolean>
  release(request: WorkspaceLockRequest): Promise<void>
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

function parseOwner(value: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<LockOwner>
    return typeof owner.nonce === 'string'
      && Number.isInteger(owner.pid)
      && typeof owner.processStartedAt === 'string'
      && typeof owner.runId === 'string'
      && typeof owner.sessionId === 'string'
      && typeof owner.workspaceRoot === 'string'
      && typeof owner.acquiredAt === 'string'
      ? owner as LockOwner
      : undefined
  } catch {
    return undefined
  }
}

export class FileWorkspaceLock implements WorkspaceLock {
  private readonly held = new Map<string, string>()
  private readonly root: string

  constructor(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
    this.root = resolve(dshHome, 'dsh-coding-agent', 'locks')
  }

  private path(workspaceRoot: string): string {
    const id = createHash('sha256').update(workspaceRoot).digest('hex')
    return join(this.root, `${id}.lock`)
  }

  async claim(request: WorkspaceLockRequest): Promise<boolean> {
    const workspaceRoot = await realpath(request.workspaceRoot)
    if (this.held.has(workspaceRoot)) return false
    const lockPath = this.path(workspaceRoot)
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })

    for (;;) {
      try {
        await mkdir(lockPath, { mode: 0o700 })
        const nonce = randomUUID()
        const owner: LockOwner = {
          nonce,
          pid: process.pid,
          processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
          runId: request.runId,
          sessionId: request.sessionId,
          workspaceRoot,
          acquiredAt: new Date().toISOString(),
        }
        try {
          await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          })
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true })
          throw error
        }
        this.held.set(workspaceRoot, nonce)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      }

      let owner: LockOwner | undefined
      try {
        owner = parseOwner(await readFile(join(lockPath, 'owner.json'), 'utf8'))
      } catch (error) {
        if (isAbsent(error)) return false
        throw error
      }
      if (!owner || processExists(owner.pid)) return false

      const stalePath = `${lockPath}.stale-${randomUUID()}`
      try {
        await rename(lockPath, stalePath)
      } catch (error) {
        if (isAbsent(error)) continue
        throw error
      }
      await rm(stalePath, { recursive: true, force: true })
    }
  }

  async release(request: WorkspaceLockRequest): Promise<void> {
    const workspaceRoot = await realpath(request.workspaceRoot)
    const nonce = this.held.get(workspaceRoot)
    if (!nonce) return
    const lockPath = this.path(workspaceRoot)
    try {
      const owner = parseOwner(await readFile(join(lockPath, 'owner.json'), 'utf8'))
      if (owner?.nonce !== nonce || owner.runId !== request.runId || owner.sessionId !== request.sessionId) return
      const releasedPath = `${lockPath}.released-${nonce}`
      await rename(lockPath, releasedPath)
      await rm(releasedPath, { recursive: true, force: true })
    } catch (error) {
      if (!isAbsent(error)) throw error
    } finally {
      this.held.delete(workspaceRoot)
    }
  }
}
