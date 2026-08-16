import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pnpmCli = process.env.npm_execpath
if (!pnpmCli) throw new Error('pack:check must run through pnpm')
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const runPnpm = (args, options) => /\.(?:c?js|mjs)$/i.test(pnpmCli)
  ? execFileSync(process.execPath, [pnpmCli, ...args], options)
  : execFileSync(pnpmCli, args, options)
const runNpm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options)
const temporary = mkdtempSync(join(tmpdir(), 'dsh-reprofix-pack-'))
const packed = join(temporary, 'packed')
const consumer = join(temporary, 'consumer')

function packedFilename(output) {
  const trimmed = output.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed)
    const record = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof record?.filename === 'string') return record.filename
  }
  return trimmed.split(/\r?\n/).findLast(line => line.trim().endsWith('.tgz'))?.trim()
}

try {
  mkdirSync(packed)
  mkdirSync(consumer)
  const output = process.platform === 'win32'
    ? (runNpm(['run', 'build'], { cwd: root, stdio: 'inherit' }), runNpm(['pack', '--pack-destination', packed, '--json'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }))
    : (runPnpm(['build'], { cwd: root, stdio: 'inherit' }), runPnpm(['pack', '--pack-destination', packed], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }))
  const tarball = packedFilename(output)
  if (!tarball) throw new Error(`package manager did not report a tarball: ${output}`)
  const tarballPath = resolve(packed, tarball)

  const requiredPeers = Object.fromEntries(
    Object.entries(manifest.peerDependencies).filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional),
  )
  const dependencies = {
    [manifest.name]: `file:${tarballPath}`,
    ...manifest.dependencies,
    ...requiredPeers,
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'dsh-reprofix-pack-consumer',
    private: true,
    type: 'module',
    packageManager: manifest.packageManager,
    dependencies,
  }, null, 2))

  if (process.platform === 'win32') {
    runNpm(['install', '--ignore-scripts', '--no-package-lock'], { cwd: consumer, stdio: 'inherit' })
  } else {
    runPnpm(['install', '--offline', '--ignore-scripts', '--frozen-lockfile=false'], { cwd: consumer, stdio: 'inherit' })
  }
  const imported = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `const plugin = await import(${JSON.stringify(manifest.name)}); if (Object.keys(plugin).length === 0) throw new Error('public export is empty')`,
  ], {
    cwd: consumer,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  process.stdout.write(imported)
  const installed = join(consumer, 'node_modules', manifest.name)
  for (const path of [
    'preset/coding/agent.cordis.yml',
    'preset/coding/preset.yml',
    'preset/reprofix/agent.cordis.yml',
    'preset/reprofix/preset.yml',
  ]) {
    readFileSync(join(installed, path))
  }
  const presetHome = join(temporary, 'preset-home')
  const presetEntry = join(installed, manifest.bin['dshagent-presets'])
  execFileSync(process.execPath, [presetEntry, 'install', '--home', presetHome], {
    cwd: consumer,
    stdio: 'inherit',
  })
  readFileSync(join(presetHome, '.agent-presets', 'dshagent', 'agent.cordis.yml'))
  readFileSync(join(presetHome, '.agent-presets', 'reprofix', 'agent.cordis.yml'))
  const clientEntry = join(installed, manifest.bin['dsh-reprofix-client'])
  const clientHelp = execFileSync(process.execPath, [clientEntry, '--help'], {
    cwd: consumer,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (!clientHelp.includes('dsh-reprofix-client')) throw new Error('packed client bin did not render help')
  console.log(`pack:check imported ${manifest.name} and executed its client bin from ${tarball}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
