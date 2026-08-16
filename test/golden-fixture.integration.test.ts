import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { validateRepairFailureInput } from '../src/domain.js'
import { InMemoryActiveRunRegistry } from '../src/guard.js'
import { executeRepairFailure } from '../src/repair.js'
import { createCommandRunner, createGitAdapter } from '../src/runner.js'
import type {} from '../src/session.js'

const exec = promisify(execFile)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(projectRoot, 'fixtures', 'buggy-project')

function shellContext() {
  return {
    shell: {
      resolve: (value: unknown) => value,
      async run(spec: { command: string; workdir: string; timeoutMs: number; signal?: AbortSignal }) {
        try {
          const { stdout, stderr } = await exec('/bin/sh', ['-c', spec.command], {
            cwd: spec.workdir,
            encoding: 'utf8',
            timeout: spec.timeoutMs,
            signal: spec.signal,
            maxBuffer: 512 * 1024,
          })
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            timeoutMs: spec.timeoutMs,
            stdout: { text: stdout, truncated: false },
            stderr: { text: stderr, truncated: false },
          }
        } catch (error: unknown) {
          const failure = error as {
            code?: number | string
            signal?: NodeJS.Signals
            killed?: boolean
            stdout?: string
            stderr?: string
            name?: string
          }
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : null,
            signal: failure.signal ?? null,
            timedOut: failure.killed === true && failure.name !== 'AbortError',
            aborted: failure.name === 'AbortError',
            timeoutMs: spec.timeoutMs,
            stdout: { text: failure.stdout ?? '', truncated: false },
            stderr: { text: failure.stderr ?? String(error), truncated: false },
          }
        }
      },
    },
  }
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'reprofix-golden-'))
  await cp(fixtureRoot, root, { recursive: true })
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root })
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['commit', '-qm', 'buggy baseline'], { cwd: root })
  return root
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function agent(cwd: string, id: string): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    cwd,
  })
  return { id: sessionId, session, ctx: {} } as unknown as Agent
}

function repairArgs(outputIncludes = ['expected 4, received 3']) {
  const nodeTest = 'node --experimental-strip-types --test test/add.test.ts'
  return validateRepairFailureInput({
    task: 'Fix add() with the smallest patch.',
    repro: {
      command: nodeTest,
      failure: { outputIncludes },
      success: { exitCodes: [0] },
    },
    acceptance: [
      { name: 'unit', command: nodeTest },
      { name: 'types', command: `${JSON.stringify(join(projectRoot, 'node_modules', '.bin', 'tsc'))} --noEmit -p tsconfig.json` },
    ],
  })
}

describe('golden Git fixture', () => {
  it('leaves source unchanged for dirty and non-matching paths', async () => {
    const ctx = shellContext()
    const commandRunner = createCommandRunner(ctx as never)
    const git = createGitAdapter(ctx as never)

    const dirtyRoot = await makeRepo()
    const dirtySource = await readFile(join(dirtyRoot, 'src', 'add.ts'), 'utf8')
    await writeFile(join(dirtyRoot, 'untracked.txt'), 'dirty\n')
    const dirty = await executeRepairFailure({
      args: repairArgs(),
      agent: agent(dirtyRoot, 'dirty-golden'),
      toolCallId: 'dirty-call',
      signal: new AbortController().signal,
      dependencies: {
        commandRunner,
        git,
        activeRuns: new InMemoryActiveRunRegistry(),
        runWriter: async () => { throw new Error('writer must not start') },
      },
    })
    expect(dirty.status).toBe('blocked_dirty_workspace')
    expect(hash(await readFile(join(dirtyRoot, 'src', 'add.ts'), 'utf8'))).toBe(hash(dirtySource))

    const mismatchRoot = await makeRepo()
    const mismatchSource = await readFile(join(mismatchRoot, 'src', 'add.ts'), 'utf8')
    const mismatch = await executeRepairFailure({
      args: repairArgs(['different failure']),
      agent: agent(mismatchRoot, 'mismatch-golden'),
      toolCallId: 'mismatch-call',
      signal: new AbortController().signal,
      dependencies: {
        commandRunner,
        git,
        activeRuns: new InMemoryActiveRunRegistry(),
        runWriter: async () => { throw new Error('writer must not start') },
      },
    })
    expect(mismatch.status).toBe('not_reproduced')
    expect(hash(await readFile(join(mismatchRoot, 'src', 'add.ts'), 'utf8'))).toBe(hash(mismatchSource))
  })

  it('fixes one line and passes wrapper-owned repro, unit, and typecheck', async () => {
    const root = await makeRepo()
    const ctx = shellContext()
    const commandRunner = createCommandRunner(ctx as never)
    const git = createGitAdapter(ctx as never)
    let writerCalls = 0
    const result = await executeRepairFailure({
      args: repairArgs(),
      agent: agent(root, 'fixed-golden'),
      toolCallId: 'fixed-call',
      signal: new AbortController().signal,
      dependencies: {
        commandRunner,
        git,
        activeRuns: new InMemoryActiveRunRegistry(),
        async runWriter() {
          writerCalls += 1
          await writeFile(join(root, 'src', 'add.ts'), 'export function add(left: number, right: number): number {\n  return left + right\n}\n')
          return {
            stopReason: 'completed',
            agentsStarted: 1,
            writer: {
              outcome: 'patched',
              diagnosis: 'The implementation subtracts one from every result.',
              evidence: [{ path: 'src/add.ts', line: 2, reason: 'The return expression contains - 1.' }],
              residualRisks: [],
            },
          }
        },
      },
    })

    expect(result.status).toBe('fixed')
    expect(writerCalls).toBe(1)
    expect(result.patch).toMatchObject({
      changedFiles: ['src/add.ts'],
      added: 1,
      deleted: 1,
      score: 12,
    })
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ['declared reproduction', true],
      ['post-fix reproduction', true],
      ['unit', true],
      ['types', true],
    ])
    expect(await readFile(join(root, 'src', 'add.ts'), 'utf8')).toContain('return left + right\n')
  })
})
