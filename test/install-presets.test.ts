import { execFile } from 'node:child_process'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { installPresets } from '../scripts/install-presets.mjs'

const exec = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('preset installer', () => {
  it('installs both presets, stays idempotent, and refuses local changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshagent-presets-'))

    expect(await installPresets({ home })).toMatchObject([
      { id: 'dshagent', status: 'installed' },
      { id: 'reprofix', status: 'installed' },
    ])
    expect(await installPresets({ home })).toMatchObject([
      { id: 'dshagent', status: 'unchanged' },
      { id: 'reprofix', status: 'unchanged' },
    ])

    const metadata = join(home, '.agent-presets', 'dshagent', 'preset.yml')
    const custom = join(home, '.agent-presets', 'dshagent', 'custom.txt')
    await writeFile(metadata, 'name: Local override\n')
    await writeFile(custom, 'keep me\n')
    await expect(installPresets({ home })).rejects.toThrow(/local changes/)

    expect(await installPresets({ home, force: true })).toMatchObject([
      { id: 'dshagent', status: 'installed' },
      { id: 'reprofix', status: 'unchanged' },
    ])
    expect(await readFile(metadata, 'utf8')).toContain('name: DSHAgent')
    expect(await readFile(custom, 'utf8')).toBe('keep me\n')
  })

  it('runs through a package-manager-style symlink', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshagent-presets-cli-'))
    const entry = join(home, 'dshagent-presets')
    await symlink(join(root, 'scripts', 'install-presets.mjs'), entry)

    const { stdout } = await exec(process.execPath, [entry, 'install', '--home', home])
    expect(stdout).toContain('installed: dshagent')
    expect(await readFile(join(home, '.agent-presets', 'reprofix', 'preset.yml'), 'utf8'))
      .toContain('name: ReproFix')
  })
})
