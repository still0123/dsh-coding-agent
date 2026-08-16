import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temporary = mkdtempSync(join(tmpdir(), 'dsh-reprofix-pack-'))
const packed = join(temporary, 'packed')
const consumer = join(temporary, 'consumer')

try {
  mkdirSync(packed)
  mkdirSync(consumer)
  execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' })
  const output = execFileSync('pnpm', ['pack', '--pack-destination', packed], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const tarball = output.trim().split(/\r?\n/).findLast(line => line.trim().endsWith('.tgz'))?.trim()
  if (!tarball) throw new Error(`pnpm pack did not report a tarball: ${output}`)

  const dependencies = {
    [manifest.name]: `file:${resolve(root, tarball)}`,
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'dsh-reprofix-pack-consumer',
    private: true,
    type: 'module',
    packageManager: manifest.packageManager,
    dependencies,
  }, null, 2))

  execFileSync('pnpm', ['install', '--offline', '--ignore-scripts', '--frozen-lockfile=false'], {
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
  console.log(`pack:check imported ${manifest.name} from ${tarball}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
