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
const runPnpm = (args, options) => /\.(?:c?js|mjs)$/i.test(pnpmCli)
  ? execFileSync(process.execPath, [pnpmCli, ...args], options)
  : execFileSync(pnpmCli, args, {
      ...options,
      ...(process.platform === 'win32' ? { shell: true } : {}),
    })
const temporary = mkdtempSync(join(tmpdir(), 'dsh-reprofix-pack-'))
const packed = join(temporary, 'packed')
const consumer = join(temporary, 'consumer')

try {
  mkdirSync(packed)
  mkdirSync(consumer)
  runPnpm(['build'], { cwd: root, stdio: 'inherit' })
  const output = runPnpm(['pack', '--pack-destination', packed], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const tarball = output.trim().split(/\r?\n/).findLast(line => line.trim().endsWith('.tgz'))?.trim()
  if (!tarball) throw new Error(`pnpm pack did not report a tarball: ${output}`)

  const requiredPeers = Object.fromEntries(
    Object.entries(manifest.peerDependencies).filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional),
  )
  const dependencies = {
    [manifest.name]: `file:${resolve(root, tarball)}`,
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

  runPnpm(['install', '--offline', '--ignore-scripts', '--frozen-lockfile=false'], {
    cwd: consumer,
    stdio: 'inherit',
  })
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
