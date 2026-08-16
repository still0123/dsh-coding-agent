#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scenarios = {
  'not-reproduced': { status: 'not_reproduced', exitCode: 1 },
  fixed: { status: 'fixed', exitCode: 0 },
  'validation-failed': { status: 'validation_failed', exitCode: 1 },
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { ...options, shell: false, windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolvePromise()
    })
  })
}

function runDemo(entry, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      process.stderr.write(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => resolvePromise({ code, output }))
  })
}

const scenario = process.argv[2]
const expected = scenarios[scenario]
if (!expected) {
  process.stderr.write(`Usage: node scripts/demo.mjs ${Object.keys(scenarios).join('|')}\n`)
  process.exitCode = 2
} else {
  const workspace = await mkdtemp(join(tmpdir(), `dshagent-${scenario}-`))
  await cp(join(root, 'fixtures', 'buggy-project'), workspace, { recursive: true })
  await run('git', ['init', '-q'], { cwd: workspace })
  await run('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspace })
  await run('git', ['config', 'user.name', 'DSHAgent Demo'], { cwd: workspace })
  await run('git', ['add', '.'], { cwd: workspace })
  await run('git', ['commit', '-qm', 'buggy baseline'], { cwd: workspace })

  process.stdout.write(`Demo workspace: ${workspace}\n`)
  const result = await runDemo(join(root, 'client', 'cli.mjs'), [
    'repair',
    '--spec',
    join(root, 'demos', `${scenario}.json`),
    '--cwd',
    workspace,
    '--yes',
  ], root)
  const marker = `## ReproFix: ${expected.status}`
  if (result.code !== expected.exitCode || !result.output.includes(marker)) {
    throw new Error(
      `demo expected ${marker} with exit ${expected.exitCode}, got exit ${result.code}`,
    )
  }
  process.stdout.write(`Demo assertion passed: ${expected.status}\n`)
}
