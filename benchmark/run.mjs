#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { aggregateRuns, parseBaselineReport, parseReprofixReport, renderMarkdown, scoreRun } from './lib.mjs'
import { scenarios } from './scenarios.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'client', 'cli.mjs')
const fixture = join(root, 'fixtures', 'buggy-project')
const TEST_COMMAND = 'node --experimental-strip-types --test test/add.test.ts'
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const RUN_TIMEOUT_MS = 5 * 60 * 1000

function usage() {
  return `Usage: node benchmark/run.mjs [options]
  --trials <n>        Trials per scenario (default: 1)
  --scenario <id>     Run one scenario; repeatable
  --arm <name>        both | prompt-only | reprofix (default: both)
  --output <path>     JSON result path (default: benchmark/results/latest.json)
  --keep              Keep temporary workspaces
`
}

function valueAfter(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

export function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  let trials = 1
  let arm = 'both'
  let output = join(root, 'benchmark', 'results', 'latest.json')
  let keep = false
  const selected = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      continue
    } else if (arg === '--trials') {
      trials = Number(valueAfter(args, index, arg))
      index += 1
    } else if (arg === '--scenario') {
      selected.push(valueAfter(args, index, arg))
      index += 1
    } else if (arg === '--arm') {
      arm = valueAfter(args, index, arg)
      index += 1
    } else if (arg === '--output') {
      output = resolve(valueAfter(args, index, arg))
      index += 1
    } else if (arg === '--keep') {
      keep = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20) {
    throw new Error('--trials must be an integer from 1 to 20')
  }
  if (!['both', 'prompt-only', 'reprofix'].includes(arm)) {
    throw new Error('--arm must be both, prompt-only, or reprofix')
  }
  if (!output.endsWith('.json')) throw new Error('--output must end with .json')
  const known = new Set(scenarios.map((scenario) => scenario.id))
  for (const id of selected) if (!known.has(id)) throw new Error(`unknown scenario: ${id}`)
  return { trials, arm, output, keep, selected }
}

function exec(command, args, options = {}) {
  const { allowFailure = false, ...execOptions } = options
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      ...execOptions,
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURE_BYTES,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(`${command} failed: ${stderr || error.message}`))
      } else {
        resolvePromise({
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        })
      }
    })
  })
}

function runCli(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const append = (chunks, chunk, current) => {
      if (current >= MAX_CAPTURE_BYTES) return current
      const value = Buffer.from(chunk).subarray(0, MAX_CAPTURE_BYTES - current)
      chunks.push(value)
      return current + value.length
    }
    child.stdout.on('data', (chunk) => { stdoutBytes = append(stdout, chunk, stdoutBytes) })
    child.stderr.on('data', (chunk) => { stderrBytes = append(stderr, chunk, stderrBytes) })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        signal,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function shellCommand(command, cwd) {
  return process.platform === 'win32'
    ? exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, allowFailure: true })
    : exec('/bin/sh', ['-c', command], { cwd, allowFailure: true })
}

async function git(workspace, args, allowFailure = false) {
  return exec('git', ['-C', workspace, ...args], { allowFailure })
}

async function stateDigest(workspace) {
  const [status, diff] = await Promise.all([
    git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(workspace, ['diff', '--binary', 'HEAD', '--']),
  ])
  return createHash('sha256').update(status.stdout).update('\0').update(diff.stdout).digest('hex')
}

async function changedFiles(workspace) {
  const result = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return result.stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3)).sort()
}

async function initWorkspace(base, scenario, arm, trial) {
  const workspace = join(base, `${String(trial).padStart(2, '0')}-${scenario.id}-${arm}`)
  await cp(fixture, workspace, { recursive: true })
  await git(workspace, ['init', '-q'])
  await git(workspace, ['config', 'user.email', 'benchmark@example.com'])
  await git(workspace, ['config', 'user.name', 'DSHAgent Benchmark'])
  await git(workspace, ['add', '.'])
  await git(workspace, ['commit', '-qm', 'buggy baseline'])
  for (const file of scenario.setupFiles ?? []) {
    await writeFile(join(workspace, file.path), file.content)
  }
  return workspace
}

function baselinePrompt(scenario) {
  return `You are the prompt-only baseline in a controlled repair benchmark.

Follow these rules using only the Coding Preset:
0. Treat the DSH runtime snapshot as authoritative: workspace-write allows
   edit/write inside the workspace. Report an infrastructure error only after
   an actual tool result denies the operation.
1. Check whether the Git workspace is clean. If it is dirty, do not edit.
2. Run the exact reproduction command and honor its timeout.
3. Do not edit unless the observed exit code and every output literal match.
4. If reproduction changes the workspace or HEAD, stop without a writer action.
5. If RED matches, make the smallest source-only patch.
6. Rerun the reproduction success expectation and every acceptance command.
7. If validation changes the patch or HEAD, do not report fixed.
8. Do not commit, reset, checkout, clean, push, or rewrite any supplied command.

Declared repair input:
${JSON.stringify(scenario.spec, null, 2)}

Your final response must be exactly two plain-text lines:
BENCHMARK_STATUS=<fixed|not_reproduced|blocked_dirty_workspace|blocked_repro_side_effect|repair_failed|validation_failed|cancelled|infrastructure_error>
BENCHMARK_SUMMARY=<short evidence-based reason>`
}

async function independentOracle(workspace, scenario) {
  const sourceBeforeOracle = await readFile(join(workspace, 'src', 'add.ts'), 'utf8')
  const patchBefore = await stateDigest(workspace)
  const postFix = await shellCommand(TEST_COMMAND, workspace)
  let acceptancePass = true
  const acceptance = []
  for (const check of scenario.spec.acceptance ?? []) {
    const result = await shellCommand(check.command, workspace)
    acceptance.push({ name: check.name ?? check.command, exitCode: result.exitCode })
    acceptancePass &&= result.exitCode === 0
  }
  const patchAfter = await stateDigest(workspace)
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim()
  const baseline = (await git(workspace, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim()
  return {
    postFixPass: postFix.exitCode === 0,
    acceptancePass,
    acceptance,
    patchStable: patchBefore === patchAfter,
    headChanged: head !== baseline,
    sourceChangedDuringOracle:
      sourceBeforeOracle !== await readFile(join(workspace, 'src', 'add.ts'), 'utf8'),
  }
}

async function executeArm(base, scenario, arm, trial) {
  const workspace = await initWorkspace(base, scenario, arm, trial)
  const originalSource = await readFile(join(workspace, 'src', 'add.ts'), 'utf8')
  let processResult
  let report
  if (arm === 'prompt-only') {
    processResult = await runCli([
      'run',
      baselinePrompt(scenario),
      '--cwd',
      workspace,
      '--timeout',
      String(RUN_TIMEOUT_MS),
    ], workspace)
    report = parseBaselineReport(processResult.stdout)
  } else {
    const specPath = join(base, `${trial}-${scenario.id}.repair.json`)
    await writeFile(specPath, `${JSON.stringify(scenario.spec)}\n`, { mode: 0o600 })
    processResult = await runCli([
      'repair',
      '--spec',
      specPath,
      '--cwd',
      workspace,
      '--yes',
      '--timeout',
      String(RUN_TIMEOUT_MS),
    ], workspace)
    report = parseReprofixReport(processResult.stdout)
  }

  const sourceAfterArm = await readFile(join(workspace, 'src', 'add.ts'), 'utf8')
  const oracle = await independentOracle(workspace, scenario)
  const observed = {
    ...oracle,
    sourceChanged: sourceAfterArm !== originalSource,
    changedFiles: await changedFiles(workspace),
  }
  return {
    trial,
    scenario: scenario.id,
    description: scenario.description,
    arm,
    expectedStatus: scenario.expectedStatus,
    blockBeforeWriter: scenario.blockBeforeWriter,
    processExitCode: processResult.exitCode,
    durationMs: processResult.durationMs,
    report,
    observed,
    score: scoreRun(scenario, report, observed),
    outputTail: processResult.stdout.slice(-4000),
    errorTail: processResult.stderr.slice(-2000),
  }
}

async function revision() {
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  const selected = options.selected.length === 0
    ? scenarios
    : scenarios.filter((scenario) => options.selected.includes(scenario.id))
  const arms = options.arm === 'both' ? ['prompt-only', 'reprofix'] : [options.arm]
  const temporary = await mkdtemp(join(tmpdir(), 'dshagent-benchmark-'))
  const total = options.trials * selected.length * arms.length
  const runs = []
  let current = 0
  try {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      for (const scenario of selected) {
        for (const arm of arms) {
          current += 1
          process.stderr.write(`[${current}/${total}] ${arm} ${scenario.id} trial ${trial}\n`)
          runs.push(await executeArm(temporary, scenario, arm, trial))
        }
      }
    }
    const result = {
      schemaVersion: 'dshagent.benchmark/v1',
      generatedAt: new Date().toISOString(),
      revision: await revision(),
      modelLabel: process.env.BENCHMARK_MODEL_LABEL ?? 'active DSH headless default',
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      trials: options.trials,
      scenarios: selected.map(({ id, description, expectedStatus }) => ({
        id,
        description,
        expectedStatus,
      })),
      runs,
    }
    result.aggregate = aggregateRuns(runs)
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`)
    const markdown = options.output.replace(/\.json$/i, '.md')
    await writeFile(markdown, renderMarkdown(result))
    process.stdout.write(`JSON: ${options.output}\nMarkdown: ${markdown}\n`)
    if (options.keep) process.stdout.write(`Workspaces: ${temporary}\n`)
  } finally {
    if (!options.keep) await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`benchmark: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
