import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell'
import {
  calculatePatchScore,
  isManifestFile,
  summarizeCommandOutput,
  type CommandEvidence,
  type PatchSummary,
} from './domain.js'
import type { BaselineEvidence, CommandRunner, GitAdapter } from './repair.js'

const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_BYTES = 8 * 1024 * 1024

function now(): number {
  return Date.now()
}

export function createCommandRunner(ctx: Context): CommandRunner {
  return {
    async run(input) {
      const started = now()
      const startedAt = new Date(started).toISOString()
      try {
        const result = await ctx.shell.run(ctx.shell.resolve({
          command: input.command,
          workdir: input.cwd,
          timeoutMs: input.timeoutMs,
          stdoutMaxBytes: input.maxOutputBytes,
          signal: input.signal,
        }))
        const finished = now()
        const output = summarizeCommandOutput(result.stdout.text, result.stderr.text, input.maxOutputBytes)
        return {
          command: input.command,
          processStarted: !(result.sandbox?.runnerFailed ?? false),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          sandboxDenied: result.sandbox?.denied ?? false,
          durationMs: finished - started,
          ...output,
          startedAt,
          finishedAt: new Date(finished).toISOString(),
          ...(result.sandbox?.runnerFailed ? { error: 'sandbox runner failed before command execution' } : {}),
        }
      } catch (error: unknown) {
        const finished = now()
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
        const output = summarizeCommandOutput('', message, input.maxOutputBytes)
        return {
          command: input.command,
          processStarted: false,
          exitCode: null,
          timedOut: false,
          aborted: input.signal.aborted,
          sandboxDenied: false,
          durationMs: finished - started,
          ...output,
          startedAt,
          finishedAt: new Date(finished).toISOString(),
          error: message,
        }
      }
    },
  }
}

async function gitText(
  runner: CommandRunner,
  cwd: string,
  command: string,
): Promise<string> {
  const evidence = await runner.run({
    command,
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    signal: new AbortController().signal,
    maxOutputBytes: GIT_OUTPUT_BYTES,
  })
  if (!evidence.processStarted || evidence.exitCode !== 0 || evidence.timedOut || evidence.aborted || evidence.sandboxDenied) {
    throw new Error(`git command failed: ${command}\n${evidence.outputTail}`)
  }
  return evidence.stdout ?? ''
}

function porcelainPaths(status: string): string[] {
  const entries = status.split('\0').filter(Boolean)
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const code = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (code.includes('R') || code.includes('C')) index += 1
  }
  return paths
}

interface NumstatSummary {
  added: number
  deleted: number
  binaryFiles: string[]
}

function parseNumstat(value: string): NumstatSummary {
  const entries = value.split('\0')
  const binaryFiles: string[] = []
  let added = 0
  let deleted = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    const firstTab = entry.indexOf('\t')
    const secondTab = firstTab === -1 ? -1 : entry.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) throw new Error('git numstat returned an invalid record')
    const rawAdded = entry.slice(0, firstTab)
    const rawDeleted = entry.slice(firstTab + 1, secondTab)
    let path = entry.slice(secondTab + 1)
    if (path === '') {
      const oldPath = entries[index + 1]
      const newPath = entries[index + 2]
      if (!oldPath || !newPath) throw new Error('git numstat returned an incomplete rename record')
      path = newPath
      index += 2
    }
    if (rawAdded === '-' || rawDeleted === '-') binaryFiles.push(path)
    else {
      added += Number(rawAdded)
      deleted += Number(rawDeleted)
    }
  }
  return { added, deleted, binaryFiles }
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8_000).includes(0)
}

function lineCount(content: Buffer): number {
  if (content.length === 0) return 0
  let lines = 0
  for (const byte of content) if (byte === 10) lines += 1
  return lines + (content.at(-1) === 10 ? 0 : 1)
}

async function readUntracked(workspaceRoot: string, path: string): Promise<Buffer> {
  const absolute = join(workspaceRoot, path)
  const stats = await lstat(absolute)
  if (stats.isSymbolicLink()) return Buffer.from(await readlink(absolute))
  if (stats.isFile()) return readFile(absolute)
  throw new Error(`unsupported untracked file type: ${path}`)
}

export function createGitAdapter(ctx: Context): GitAdapter {
  const runner = createCommandRunner(ctx)
  return {
    async baseline(cwd): Promise<BaselineEvidence> {
      const workspaceRoot = (await gitText(runner, cwd, 'git rev-parse --show-toplevel')).trim()
      const head = (await gitText(runner, workspaceRoot, 'git rev-parse HEAD')).trim()
      const status = await gitText(runner, workspaceRoot, 'git status --porcelain=v1 -z --untracked-files=all')
      return { workspaceRoot, head, clean: status.length === 0 }
    },

    async isClean(workspaceRoot): Promise<boolean> {
      return (await gitText(runner, workspaceRoot, 'git status --porcelain=v1 -z --untracked-files=all')).length === 0
    },

    async patch(workspaceRoot, revision): Promise<PatchSummary> {
      const status = await gitText(runner, workspaceRoot, 'git status --porcelain=v1 -z --untracked-files=all')
      const changedFiles = [...new Set(porcelainPaths(status))].sort()
      const numstat = parseNumstat(await gitText(runner, workspaceRoot, 'git diff --numstat -z HEAD --'))
      let { added, deleted } = numstat
      const binaryFiles = new Set(numstat.binaryFiles)

      const untracked = (await gitText(runner, workspaceRoot, 'git ls-files --others --exclude-standard -z'))
        .split('\0').filter(Boolean).sort()
      const hash = createHash('sha256')
      hash.update(await gitText(runner, workspaceRoot, 'git diff --binary HEAD --'))
      for (const path of untracked) {
        const content = await readUntracked(workspaceRoot, path)
        hash.update(path)
        hash.update('\0')
        hash.update(content)
        if (isBinary(content)) binaryFiles.add(path)
        else added += lineCount(content)
      }

      const manifestFiles = changedFiles.filter(isManifestFile)
      const binary = [...binaryFiles].sort()
      return {
        revision,
        fingerprint: `sha256:${hash.digest('hex')}`,
        changedFiles,
        added,
        deleted,
        manifestFiles,
        binaryFiles: binary,
        score: calculatePatchScore({
          added,
          deleted,
          changedFiles,
          manifestFiles,
          binaryFiles: binary,
        }),
      }
    },
  }
}
