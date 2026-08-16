import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
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
          truncated: output.truncated || result.stdout.truncated || result.stderr.truncated,
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
  if (evidence.truncated) throw new Error(`git command output exceeded ${GIT_OUTPUT_BYTES} bytes: ${command}`)
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

interface UntrackedSummary {
  binary: boolean
  contentDigest: Buffer
  executable: boolean
  lines: number
  type: 'file' | 'symlink'
}

function summarizeUntracked(content: Buffer, executable: boolean, type: UntrackedSummary['type']): UntrackedSummary {
  if (content.length === 0) {
    return { binary: false, contentDigest: createHash('sha256').update(content).digest(), executable, lines: 0, type }
  }
  let newlines = 0
  for (const byte of content) if (byte === 10) newlines += 1
  return {
    binary: content.subarray(0, 8_000).includes(0),
    contentDigest: createHash('sha256').update(content).digest(),
    executable,
    lines: newlines + (content.at(-1) === 10 ? 0 : 1),
    type,
  }
}

async function summarizeUntrackedFile(workspaceRoot: string, path: string): Promise<UntrackedSummary> {
  const absolute = join(workspaceRoot, path)
  const stats = await lstat(absolute)
  const executable = (stats.mode & 0o111) !== 0
  if (stats.isSymbolicLink()) return summarizeUntracked(Buffer.from(await readlink(absolute)), executable, 'symlink')
  if (!stats.isFile()) throw new Error(`unsupported untracked file type: ${path}`)

  const contentHash = createHash('sha256')
  let binary = false
  let sampled = 0
  let bytes = 0
  let newlines = 0
  let lastByte: number | undefined
  for await (const value of createReadStream(absolute)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    contentHash.update(chunk)
    bytes += chunk.length
    for (const byte of chunk) if (byte === 10) newlines += 1
    if (!binary && sampled < 8_000) {
      const sample = chunk.subarray(0, 8_000 - sampled)
      binary = sample.includes(0)
      sampled += sample.length
    }
    lastByte = chunk.at(-1)
  }
  return {
    binary,
    contentDigest: contentHash.digest(),
    executable,
    lines: binary || bytes === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1),
    type: 'file',
  }
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
      const trackedPatchDigest = createHash('sha256')
        .update(await gitText(runner, workspaceRoot, 'git diff --binary HEAD --'))
        .digest()
      const hash = createHash('sha256').update('reprofix.patch/v2\0').update(trackedPatchDigest)
      for (const path of untracked) {
        const summary = await summarizeUntrackedFile(workspaceRoot, path)
        const pathBytes = Buffer.from(path)
        const pathLength = Buffer.allocUnsafe(4)
        pathLength.writeUInt32BE(pathBytes.length)
        hash.update(pathLength)
        hash.update(pathBytes)
        hash.update(summary.type === 'file' ? '\x01' : '\x02')
        hash.update(summary.executable ? '\x01' : '\x00')
        hash.update(summary.contentDigest)
        if (summary.binary) binaryFiles.add(path)
        else added += summary.lines
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
