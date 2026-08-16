#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { stat, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BODY_BYTES = 64 * 1024

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

async function readJson(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body exceeds 64 KiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function validInput(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.task === 'string'
    && typeof value.repro === 'object' && value.repro !== null && !Array.isArray(value.repro)
}

export function validHost(value) {
  if (typeof value !== 'string') return false
  try {
    return new URL(`http://${value}`).hostname === '127.0.0.1'
  } catch {
    return false
  }
}

export function buildPrompt(input) {
  return [
    'Use the repair_failure tool exactly once with the following JSON input.',
    'Do not edit files or run shell commands outside that tool.',
    'After the tool returns, report its structured status, checks, patch summary, and residual risks.',
    '',
    JSON.stringify(input),
  ].join('\n')
}

export function dshLaunch(nodeEntry, platform = process.platform) {
  if (nodeEntry) return { command: process.execPath, prefixArgs: [nodeEntry] }
  if (platform === 'win32') {
    throw new Error('Windows requires @deepseek-ai/dsh beside dsh-reprofix or DSH_NODE_ENTRY pointing to its lib/bin.js')
  }
  return { command: process.env.DSH_BIN || 'dsh', prefixArgs: [] }
}

async function existingDshLaunch(root, platform = process.platform) {
  const configured = process.env.DSH_NODE_ENTRY
  if (configured) return dshLaunch(configured, platform)
  try {
    const require = createRequire(join(root, 'package.json'))
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
    const manifest = require(manifestPath)
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof bin !== 'string') throw new Error('@deepseek-ai/dsh publishes no dsh bin')
    return dshLaunch(join(dirname(manifestPath), bin))
  } catch (error) {
    if (platform === 'win32') throw error
    return dshLaunch(undefined, platform)
  }
}

async function createPatch() {
  const bridge = join(packageRoot, 'dist', 'client-scope.js')
  await stat(bridge)
  const patch = join(tmpdir(), `dsh-reprofix-client-${process.pid}-${randomBytes(6).toString('hex')}.yml`)
  await writeFile(patch, `- insert:\n    - id: reprofix-local-client\n      name: ${JSON.stringify(bridge)}\n`)
  return patch
}

function page(token) {
  const example = JSON.stringify({
    task: 'Fix the declared regression with the smallest patch.',
    repro: {
      command: 'pnpm test -- add.test.ts',
      failure: { exitCodes: [1], outputIncludes: ['expected 4, received 3'] },
      success: { exitCodes: [0] },
    },
    acceptance: [
      { name: 'typecheck', command: 'pnpm typecheck' },
      { name: 'unit', command: 'pnpm test' },
    ],
    maxRepairRounds: 2,
  }, null, 2)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReproFix Local</title><style>
:root{color-scheme:light dark;font:15px system-ui,sans-serif}body{max-width:980px;margin:0 auto;padding:24px}label{display:block;font-weight:650;margin:16px 0 6px}input,textarea,button,pre{box-sizing:border-box;width:100%;font:inherit}input,textarea{padding:10px;border:1px solid #777;border-radius:6px}textarea{min-height:360px;font-family:ui-monospace,monospace}button{margin-top:14px;padding:11px;border:0;border-radius:6px;background:#1769e0;color:white;font-weight:700;cursor:pointer}button:disabled{opacity:.5}pre{min-height:180px;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere;background:#111;color:#eee;border-radius:6px}.note{opacity:.75}</style></head>
<body><h1>ReproFix Local</h1><p class="note">Local-only launcher. The server binds to 127.0.0.1 and starts one native Tool-mode DSH headless run at a time.</p>
<form id="run"><label>Git workspace</label><input id="cwd" required placeholder="/path/to/repository"><label>repair_failure JSON</label><textarea id="input" spellcheck="false">${example}</textarea><button id="submit">Run ReproFix</button></form>
<h2>Output</h2><pre id="output">Ready.</pre>
<script>
const token=${JSON.stringify(token)};const form=document.querySelector('#run');const button=document.querySelector('#submit');const output=document.querySelector('#output');
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;output.textContent='Starting…\n';try{const input=JSON.parse(document.querySelector('#input').value);const response=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json','x-reprofix-token':token},body:JSON.stringify({cwd:document.querySelector('#cwd').value,input})});if(!response.ok){output.textContent=await response.text();return}const reader=response.body.getReader();const decoder=new TextDecoder();while(true){const part=await reader.read();if(part.done)break;output.textContent+=decoder.decode(part.value,{stream:true});output.scrollTop=output.scrollHeight}}catch(error){output.textContent='Error: '+error.message}finally{button.disabled=false}});
</script></body></html>`
}

export async function waitForSettlement(promise, timeoutMs = 5_000) {
  let timeout
  try {
    await Promise.race([
      promise,
      new Promise(resolvePromise => {
        timeout = setTimeout(resolvePromise, timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export async function createLocalClient(options = {}) {
  const token = options.token ?? randomBytes(24).toString('base64url')
  const spawnProcess = options.spawnProcess ?? spawn
  const patch = options.patch ?? await createPatch()
  const platform = options.platform ?? process.platform
  const launch = options.launch ?? await existingDshLaunch(options.packageRoot ?? packageRoot, platform)
  let active = false
  let activeChild
  let activeDone = Promise.resolve()
  let settleActive
  const server = createServer(async (request, response) => {
    if (!validHost(request.headers.host)) return json(response, 421, { error: 'loopback Host required' })
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      })
      response.end(page(token))
      return
    }
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, active })
    if (request.method !== 'POST' || url.pathname !== '/api/run') return json(response, 404, { error: 'not found' })
    if (request.headers['x-reprofix-token'] !== token) return json(response, 403, { error: 'invalid token' })
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: 'application/json required' })
    if (active) return json(response, 409, { error: 'a ReproFix run is already active' })
    active = true
    activeDone = new Promise(resolvePromise => { settleActive = resolvePromise })
    try {
      const body = await readJson(request)
      if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd)) throw new Error('cwd must be an absolute path')
      if (!validInput(body.input)) throw new Error('input must contain task and repro objects')
      const cwd = resolve(body.cwd)
      const info = await stat(cwd)
      if (!info.isDirectory()) throw new Error('cwd must be a directory')
      const child = spawnProcess(launch.command, [
        ...launch.prefixArgs,
        '--profile', 'headless', '--patch', patch, buildPrompt(body.input),
      ], {
        cwd,
        env: { ...process.env, DSH_TOOLS_MODE: 'native' },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      activeChild = child
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      let settled = false
      const finish = (message) => {
        if (settled) return
        settled = true
        active = false
        activeChild = undefined
        settleActive?.()
        settleActive = undefined
        if (!response.destroyed) response.end(message)
      }
      child.stdout?.on('data', chunk => response.write(chunk))
      child.stderr?.on('data', chunk => response.write(chunk))
      child.on('error', error => finish(`\n[launcher error] ${error.message}\n`))
      child.on('close', code => finish(`\n[ReproFix exited ${code ?? 'without a code'}]\n`))
      response.on('close', () => {
        if (!settled && child.exitCode === null) child.kill()
      })
    } catch (error) {
      active = false
      activeChild = undefined
      settleActive?.()
      settleActive = undefined
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  return {
    server,
    token,
    patch,
    async listen(port = 0) {
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolvePromise)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('local client did not bind a TCP port')
      return `http://127.0.0.1:${address.port}/`
    },
    async close() {
      if (activeChild?.exitCode === null) activeChild.kill()
      await waitForSettlement(activeDone)
      const closed = new Promise(resolvePromise => server.close(resolvePromise))
      server.closeAllConnections?.()
      await closed
      if (!options.patch) await rm(patch, { force: true })
    },
  }
}

function usage() {
  return 'Usage: dsh-reprofix-client [--port <number>] [--no-open]\n'
}

async function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage())
    return
  }
  const portIndex = args.indexOf('--port')
  const port = portIndex === -1 ? 0 : Number(args[portIndex + 1])
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be an integer from 0 to 65535')
  const client = await createLocalClient()
  const url = await client.listen(port)
  process.stdout.write(`ReproFix Local: ${url}\nPress Ctrl+C to stop.\n`)
  if (!args.includes('--no-open')) await openBrowser(url)
  const shutdown = async () => { await client.close(); process.exit(0) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (isMainModule()) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
