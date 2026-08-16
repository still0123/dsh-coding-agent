#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { cp, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installPresets } from '../scripts/install-presets.mjs'
import { existingDshLaunch, waitForSettlement } from './server.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_SPEC_BYTES = 1024 * 1024
const STOP_TIMEOUT_MS = 5_000
const AGENT_PLANE_ROWS = [
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
]

export function usage() {
  return `Usage:
  dshagent run "<task>" [--cwd <path>] [--timeout <ms>]
  dshagent repair --spec <repair.json> [--cwd <path>] [--timeout <ms>] [--yes]
  dshagent presets install [--home <path>] [--force]
`
}

function valueAfter(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function timeout(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('--timeout must be a positive integer in milliseconds')
  }
  return parsed
}

export function parseArgs(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { command: 'help' }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) return { command: 'version' }
  const command = args[0]

  if (command === 'presets') {
    if (args[1] !== 'install') throw new Error('presets requires the install subcommand')
    let home
    let force = false
    for (let index = 2; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--force') force = true
      else if (arg === '--home') {
        home = valueAfter(args, index, '--home')
        index += 1
      } else {
        throw new Error(`unknown argument: ${arg}`)
      }
    }
    return { command: 'presets', force, ...(home === undefined ? {} : { home }) }
  }

  if (command !== 'run' && command !== 'repair') throw new Error(`unknown command: ${command}`)
  let cwd = process.cwd()
  let timeoutMs
  let spec
  let yes = false
  const task = []
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--cwd') {
      cwd = valueAfter(args, index, '--cwd')
      index += 1
    } else if (arg === '--timeout') {
      timeoutMs = timeout(valueAfter(args, index, '--timeout'))
      index += 1
    } else if (arg === '--spec' && command === 'repair') {
      spec = valueAfter(args, index, '--spec')
      index += 1
    } else if (arg === '--yes' && command === 'repair') {
      yes = true
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown argument: ${arg}`)
    } else if (command === 'run') {
      task.push(arg)
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }
  if (command === 'run') {
    const text = task.join(' ').trim()
    if (!text) throw new Error('run requires a task')
    return { command, task: text, cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  }
  if (!spec) throw new Error('repair requires --spec <repair.json>')
  return { command, spec, cwd, yes, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

function execText(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error)
      else resolvePromise(stdout)
    })
  })
}

export async function canonicalDirectory(path) {
  const canonical = await realpath(resolve(path))
  if (!(await stat(canonical)).isDirectory()) throw new Error(`not a directory: ${path}`)
  return canonical
}

export async function canonicalGitRoot(path, runGit = execText) {
  const directory = await canonicalDirectory(path)
  let output
  try {
    output = await runGit('git', ['-C', directory, 'rev-parse', '--show-toplevel'])
  } catch (error) {
    throw new Error(`cannot resolve Git workspace: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = String(output).trim()
  if (!root) throw new Error('git rev-parse returned an empty workspace root')
  return realpath(root)
}

async function readRepairSpec(path) {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`repair spec is not a file: ${path}`)
  if (info.size > MAX_SPEC_BYTES) throw new Error('repair spec exceeds 1 MiB')
  return JSON.parse(await readFile(path, 'utf8'))
}

export function repairConfirmation(input, workspaceRoot) {
  const failureExit = input.repro.failure.exitCodes?.join(', ') ?? 'any non-zero code'
  const acceptance = input.acceptance.length === 0
    ? '  (none)'
    : input.acceptance.map((item, index) => `  ${index + 1}. ${item.command}`).join('\n')
  return `ReproFix command authorization
Workspace: ${workspaceRoot}
Reproduction: ${input.repro.command}
Failure exit codes: ${failureExit}
Failure output literals:
${input.repro.failure.outputIncludes.map((value) => `  - ${JSON.stringify(value)}`).join('\n')}
Acceptance commands:
${acceptance}
`
}

export async function confirmRepair(options) {
  if (options.yes) return
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  if (!(options.isTTY ?? (stdin.isTTY && stdout.isTTY))) {
    throw new Error('repair confirmation requires a TTY; pass --yes for non-interactive use')
  }
  stdout.write(`${repairConfirmation(options.input, options.workspaceRoot)}\n`)
  let answer
  if (options.ask) {
    answer = await options.ask('Execute these commands? [y/N] ')
  } else {
    const prompt = createInterface({ input: stdin, output: stdout })
    try {
      answer = await prompt.question('Execute these commands? [y/N] ')
    } finally {
      prompt.close()
    }
  }
  if (!/^(?:y|yes)$/i.test(answer.trim())) throw new Error('repair cancelled before execution')
}

function patchText(contextPath, presetRoot, runnerPath) {
  const disabled = [...AGENT_PLANE_ROWS, 'headless-startup', 'headless-runner']
    .map((id) => `- id: ${id}\n  disabled: true`)
    .join('\n\n')
  return `${disabled}

- insert:
    - id: dshagent-agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: dshagent
        roots:
          - path: ${JSON.stringify(presetRoot)}
            trust: system
        includeUserRoot: false

    - id: dshagent-cli-runner
      name: ${JSON.stringify(runnerPath)}
      config:
        contextPath: ${JSON.stringify(contextPath)}
`
}

export async function createLaunchFiles(launch, root = packageRoot) {
  const directory = await mkdtemp(join(tmpdir(), 'dshagent-'))
  await chmod(directory, 0o700)
  try {
    const presetRoot = join(directory, 'presets')
    await mkdir(presetRoot, { mode: 0o700 })
    await cp(join(root, 'preset', 'coding'), join(presetRoot, 'dshagent'), { recursive: true })
    await cp(join(root, 'preset', 'reprofix'), join(presetRoot, 'reprofix'), { recursive: true })
    const reprofixPreset = join(presetRoot, 'reprofix', 'agent.cordis.yml')
    const presetText = await readFile(reprofixPreset, 'utf8')
    const packageName = '      name: dsh-coding-agent'
    if (presetText.split(packageName).length !== 2) {
      throw new Error('ReproFix preset must contain exactly one dsh-coding-agent plugin row')
    }
    await writeFile(
      reprofixPreset,
      presetText.replace(packageName, `      name: ${JSON.stringify(join(root, 'dist', 'index.js'))}`),
      { mode: 0o600 },
    )
    const contextPath = join(directory, 'launch.json')
    const patchPath = join(directory, 'cordis.patch.yml')
    await writeFile(contextPath, `${JSON.stringify(launch)}\n`, { mode: 0o600, flag: 'wx' })
    await writeFile(
      patchPath,
      patchText(contextPath, presetRoot, join(root, 'dist', 'cli-runner.js')),
      { mode: 0o600, flag: 'wx' },
    )
    return {
      contextPath,
      patchPath,
      presetRoot,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function runDshChild(options) {
  const spawnProcess = options.spawnProcess ?? spawn
  const runtime = options.runtime ?? process
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? STOP_TIMEOUT_MS
  const child = spawnProcess(options.launch.command, [
    ...options.launch.prefixArgs,
    '--profile',
    'headless',
    '--patch',
    options.patchPath,
  ], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => (options.stdout ?? process.stdout).write(chunk))
  child.stderr?.on('data', (chunk) => (options.stderr ?? process.stderr).write(chunk))

  let settled = false
  const done = new Promise((resolvePromise) => {
    child.once('error', (error) => {
      if (settled) return
      settled = true
      resolvePromise({ error })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      resolvePromise({ code, signal })
    })
  })
  let stopPromise
  let stopReason
  let rejectStop
  const stopFailure = new Promise((_, reject) => {
    rejectStop = reject
  })
  const requestStop = (reason) => {
    if (stopPromise) return stopPromise
    stopReason = reason
    stopPromise = (async () => {
      if (!settled) child.kill('SIGTERM')
      if (await waitForSettlement(done, shutdownTimeoutMs)) return
      if (!settled) child.kill('SIGKILL')
      if (!(await waitForSettlement(done, shutdownTimeoutMs))) {
        throw new Error('DSH child did not exit after forced termination')
      }
    })()
    stopPromise.catch(rejectStop)
    return stopPromise
  }
  const onSigint = () => { void requestStop('SIGINT') }
  const onSigterm = () => { void requestStop('SIGTERM') }
  runtime.once('SIGINT', onSigint)
  runtime.once('SIGTERM', onSigterm)
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => { void requestStop('timeout') }, options.timeoutMs)
  timer?.unref?.()

  try {
    const result = await Promise.race([done, stopFailure])
    if (stopPromise) await stopPromise
    if (result.error) throw result.error
    if (stopReason === 'timeout') return 124
    if (stopReason === 'SIGINT') return 130
    if (stopReason === 'SIGTERM') return 143
    return result.code ?? 1
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    runtime.off('SIGINT', onSigint)
    runtime.off('SIGTERM', onSigterm)
  }
}

async function loadDomain(root) {
  return import(pathToFileURL(join(root, 'dist', 'domain.js')).href)
}

async function packageVersion(root) {
  const require = createRequire(join(root, 'package.json'))
  return require(join(root, 'package.json')).version
}

export async function main(args = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(args)
  const stdout = options.stdout ?? process.stdout
  if (parsed.command === 'help') {
    stdout.write(usage())
    return 0
  }
  if (parsed.command === 'version') {
    stdout.write(`${await packageVersion(options.packageRoot ?? packageRoot)}\n`)
    return 0
  }
  if (parsed.command === 'presets') {
    const results = await installPresets(parsed)
    for (const result of results) stdout.write(`${result.status}: ${result.id} -> ${result.path}\n`)
    return 0
  }

  const root = options.packageRoot ?? packageRoot
  const workspaceRoot = parsed.command === 'repair'
    ? await canonicalGitRoot(parsed.cwd, options.runGit)
    : await canonicalDirectory(parsed.cwd)
  let launchContext
  if (parsed.command === 'repair') {
    const domain = options.domain ?? await loadDomain(root)
    const input = domain.validateRepairFailureInput(
      await readRepairSpec(resolve(parsed.spec)),
    )
    await confirmRepair({
      yes: parsed.yes,
      input,
      workspaceRoot,
      stdin: options.stdin,
      stdout,
      ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
      ...(options.ask === undefined ? {} : { ask: options.ask }),
    })
    launchContext = {
      version: 1,
      mode: 'repair',
      workspaceRoot,
      input,
      fingerprint: domain.repairInputFingerprint(input, workspaceRoot),
    }
  } else {
    launchContext = { version: 1, mode: 'run', workspaceRoot, task: parsed.task }
  }

  const launch = options.launch ?? await existingDshLaunch(root, options.platform ?? process.platform)
  const files = await createLaunchFiles(launchContext, root)
  try {
    return await runDshChild({
      launch,
      patchPath: files.patchPath,
      cwd: workspaceRoot,
      timeoutMs: parsed.timeoutMs,
      env: {
        ...process.env,
        DSH_TOOLS_MODE: 'native',
      },
      stdout,
      stderr: options.stderr ?? process.stderr,
      runtime: options.runtime ?? process,
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    })
  } finally {
    await files.cleanup()
  }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  }
}

if (isMainModule()) {
  main().then(
    (code) => { process.exitCode = code },
    (error) => {
      process.stderr.write(`dshagent: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
