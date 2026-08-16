import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
    const path = entry.slice(3)
    if (code.includes('R') || code.includes('C')) {
      const target = entries[index + 1]
      if (target !== undefined) {
        paths.push(target)
        index += 1
        continue
      }
    }
    paths.push(path)
  }
  return paths
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
      const numstat = await gitText(runner, workspaceRoot, 'git diff --numstat HEAD --')
      let added = 0
      let deleted = 0
      const binaryFiles = new Set<string>()
      for (const line of numstat.split('\n')) {
        if (!line) continue
        const [rawAdded, rawDeleted, path] = line.split('\t')
        if (!path) continue
        if (rawAdded === '-' || rawDeleted === '-') binaryFiles.add(path)
        else {
          added += Number(rawAdded)
          deleted += Number(rawDeleted)
        }
      }

      const untracked = (await gitText(runner, workspaceRoot, 'git ls-files --others --exclude-standard -z'))
        .split('\0').filter(Boolean).sort()
      const hash = createHash('sha256')
      hash.update(await gitText(runner, workspaceRoot, 'git diff --binary HEAD --'))
      for (const path of untracked) {
        const content = await readFile(`${workspaceRoot}/${path}`)
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
