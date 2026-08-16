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

class RequestError extends Error {
  constructor(status, message, closeConnection = false) {
    super(message)
    this.status = status
    this.closeConnection = closeConnection
  }
}

function json(response, status, value, closeConnection = false) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(closeConnection ? { connection: 'close' } : {}),
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function readJson(request, timeoutMs) {
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) throw new RequestError(400, 'invalid content-length', true)
    if (length > MAX_BODY_BYTES) throw new RequestError(413, 'request body exceeds 64 KiB', true)
  }
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const timeout = setTimeout(() => fail(new RequestError(408, 'request body timed out', true)), timeoutMs)
    timeout.unref?.()
    const cleanup = () => {
      clearTimeout(timeout)
      request.off('aborted', onAborted)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAborted = () => fail(new RequestError(400, 'request body aborted', true))
    const onData = (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) return fail(new RequestError(413, 'request body exceeds 64 KiB', true))
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    }
    const onError = error => fail(error)
    request.on('aborted', onAborted)
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
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

async function createPatch(root = packageRoot) {
  const bridge = join(root, 'dist', 'client-scope.js')
  await stat(bridge)
  const patch = join(tmpdir(), `dsh-reprofix-client-${process.pid}-${randomBytes(6).toString('hex')}.yml`)
  try {
    await writeFile(patch, `- insert:\n    - id: reprofix-local-client\n      name: ${JSON.stringify(bridge)}\n`)
    return patch
  } catch (error) {
    await rm(patch, { force: true })
    throw error
  }
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
    return await Promise.race([
      Promise.resolve(promise).then(() => true),
      new Promise(resolvePromise => {
        timeout = setTimeout(() => resolvePromise(false), timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolvePromise()
    })
  })
}

export async function createLocalClient(options = {}) {
  const token = options.token ?? randomBytes(24).toString('base64url')
  const spawnProcess = options.spawnProcess ?? spawn
  const platform = options.platform ?? process.platform
  const requestBodyTimeoutMs = options.requestBodyTimeoutMs ?? 10_000
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000
  if (!Number.isInteger(requestBodyTimeoutMs) || requestBodyTimeoutMs < 1) {
    throw new Error('requestBodyTimeoutMs must be a positive integer')
  }
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0) {
    throw new Error('shutdownTimeoutMs must be a non-negative integer')
  }
  const ownsPatch = options.patch === undefined
  const patch = options.patch ?? await createPatch(options.packageRoot ?? packageRoot)
  let patchRemoved = false
  const removeOwnedPatch = async () => {
    if (!ownsPatch || patchRemoved) return
    await rm(patch, { force: true })
    patchRemoved = true
  }
  let launch
  try {
    launch = options.launch ?? await existingDshLaunch(options.packageRoot ?? packageRoot, platform)
  } catch (error) {
    await removeOwnedPatch()
    throw error
  }
  let active = false
  let activeChild
  let activeResponse
  let activeDone = Promise.resolve()
  let stopActiveChild = async () => true
  let settleActive
  const pendingRequests = new Set()
  let closing = false
  let closePromise
  const server = createServer(async (request, response) => {
    if (!validHost(request.headers.host)) return json(response, 421, { error: 'loopback Host required' })
    if (closing) return json(response, 503, { error: 'local client is shutting down' })
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

    let body
    pendingRequests.add(request)
    try {
      body = await readJson(request, requestBodyTimeoutMs)
    } catch (error) {
      if (!response.destroyed) {
        const status = error instanceof RequestError ? error.status : 400
        const closeConnection = error instanceof RequestError && error.closeConnection
        json(response, status, { error: error instanceof Error ? error.message : String(error) }, closeConnection)
      }
      return
    } finally {
      pendingRequests.delete(request)
    }

    if (closing || request.aborted || response.destroyed) {
      if (!response.destroyed) json(response, 503, { error: 'local client is shutting down' }, true)
      return
    }
    if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd)) return json(response, 400, { error: 'cwd must be an absolute path' })
    if (!validInput(body.input)) return json(response, 400, { error: 'input must contain task and repro objects' })
    if (active) return json(response, 409, { error: 'a ReproFix run is already active' })

    active = true
    activeResponse = response
    activeDone = new Promise(resolvePromise => { settleActive = resolvePromise })
    stopActiveChild = () => waitForSettlement(activeDone, shutdownTimeoutMs)
    try {
      const cwd = resolve(body.cwd)
      const info = await stat(cwd)
      if (!info.isDirectory()) throw new Error('cwd must be a directory')
      if (closing || request.aborted || response.destroyed) throw new Error('local client is shutting down')
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
      const runDone = activeDone
      let terminationPromise
      let terminateActiveChild
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
        if (activeResponse === response) activeResponse = undefined
        if (stopActiveChild === terminateActiveChild) stopActiveChild = async () => true
        settleActive?.()
        settleActive = undefined
        if (!response.destroyed) response.end(message)
      }
      terminateActiveChild = () => {
        if (terminationPromise) return terminationPromise
        terminationPromise = (async () => {
          if (settled) return true
          if (child.exitCode === null) child.kill('SIGTERM')
          if (await waitForSettlement(runDone, shutdownTimeoutMs)) return true
          if (child.exitCode === null) child.kill('SIGKILL')
          if (await waitForSettlement(runDone, shutdownTimeoutMs)) return true
          return false
        })()
        return terminationPromise
      }
      stopActiveChild = terminateActiveChild
      child.stdout?.on('data', chunk => response.write(chunk))
      child.stderr?.on('data', chunk => response.write(chunk))
      child.on('error', error => finish(`\n[launcher error] ${error.message}\n`))
      child.on('close', code => finish(`\n[ReproFix exited ${code ?? 'without a code'}]\n`))
      response.on('close', () => {
        if (!closing && !settled) void terminateActiveChild()
      })
    } catch (error) {
      active = false
      activeChild = undefined
      if (activeResponse === response) activeResponse = undefined
      settleActive?.()
      settleActive = undefined
      if (!response.destroyed) json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  let listening = false
  const listen = async (port = 0) => {
    if (closing) throw new Error('local client is shutting down')
    if (listening) throw new Error('local client is already listening')
    try {
      await new Promise((resolvePromise, reject) => {
        const cleanup = () => {
          server.off('error', onError)
          server.off('listening', onListening)
        }
        const onError = (error) => { cleanup(); reject(error) }
        const onListening = () => { cleanup(); resolvePromise() }
        server.once('error', onError)
        server.once('listening', onListening)
        try {
          server.listen(port, '127.0.0.1')
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
      listening = true
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('local client did not bind a TCP port')
      return `http://127.0.0.1:${address.port}/`
    } catch (error) {
      closing = true
      await removeOwnedPatch()
      throw error
    }
  }
  const close = () => {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      let failure
      let serverFailure
      const serverClosed = closeServer(server).catch(error => { serverFailure = error })
      for (const request of pendingRequests) request.destroy()
      pendingRequests.clear()
      if (!(await stopActiveChild())) failure ??= new Error('DSH child did not exit after SIGKILL')
      server.closeIdleConnections?.()
      if (!(await waitForSettlement(serverClosed, shutdownTimeoutMs))) {
        server.closeAllConnections?.()
        await serverClosed
      }
      failure ??= serverFailure
      try {
        await removeOwnedPatch()
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
    })()
    return closePromise
  }
  return { server, token, patch, listen, close }
}

function usage() {
  return 'Usage: dsh-reprofix-client [--port <number>] [--no-open]\n'
}

export function createShutdownHandler(client, runtime = process) {
  let shutdownPromise
  return () => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      try {
        await client.close()
        return true
      } catch (error) {
        runtime.exitCode = 1
        try {
          runtime.stderr.write(`Failed to close ReproFix Local: ${error instanceof Error ? error.message : String(error)}\n`)
        } catch {}
        return false
      }
    })()
    return shutdownPromise
  }
}

export async function openBrowser(url, platform = process.platform, spawnProcess = spawn) {
  const command = platform === 'win32' ? 'cmd.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url]
  try {
    const child = spawnProcess(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref?.()
    return await new Promise(resolvePromise => {
      const finish = (opened) => {
        child.off('error', onError)
        child.off('spawn', onSpawn)
        resolvePromise(opened)
      }
      const onError = () => finish(false)
      const onSpawn = () => finish(true)
      child.once('error', onError)
      child.once('spawn', onSpawn)
    })
  } catch {
    return false
  }
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
  if (!args.includes('--no-open') && !(await openBrowser(url))) {
    process.stderr.write(`Could not open a browser; open ${url} manually.\n`)
  }
  const shutdown = createShutdownHandler(client)
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
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
