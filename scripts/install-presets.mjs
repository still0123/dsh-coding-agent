#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const presets = [
  { source: 'coding', target: 'dshagent' },
  { source: 'reprofix', target: 'reprofix' },
]

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function samePreset(source, target) {
  try {
    const names = ['agent.cordis.yml', 'preset.yml']
    const pairs = await Promise.all(names.map(async name => [
      await readFile(join(source, name)),
      await readFile(join(target, name)),
    ]))
    return pairs.every(([left, right]) => left.equals(right))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function installPresets(options = {}) {
  const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const root = join(home, '.agent-presets')
  await mkdir(root, { recursive: true })
  const results = []

  for (const preset of presets) {
    const source = join(packageRoot, 'preset', preset.source)
    const target = join(root, preset.target)
    if (await exists(target)) {
      if (await samePreset(source, target)) {
        results.push({ id: preset.target, path: target, status: 'unchanged' })
        continue
      }
      if (!options.force) {
        throw new Error(`preset "${preset.target}" already exists with local changes; rerun with --force to replace it`)
      }
      await cp(join(source, 'agent.cordis.yml'), join(target, 'agent.cordis.yml'), { force: true })
      await cp(join(source, 'preset.yml'), join(target, 'preset.yml'), { force: true })
      results.push({ id: preset.target, path: target, status: 'installed' })
      continue
    }

    const temporary = join(root, `.${preset.target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
    try {
      await cp(source, temporary, { recursive: true, errorOnExist: true })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
    results.push({ id: preset.target, path: target, status: 'installed' })
  }
  return results
}

function usage() {
  return 'Usage: dshagent-presets install [--home <path>] [--force]\n'
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  if (args[0] !== 'install') throw new Error(usage().trim())
  let home
  let force = false
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--force') force = true
    else if (arg === '--home') {
      home = args[index + 1]
      if (!home) throw new Error('--home requires a path')
      index += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { force, home }
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
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write(usage())
    else {
      const results = await installPresets(options)
      for (const result of results) process.stdout.write(`${result.status}: ${result.id} -> ${result.path}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
