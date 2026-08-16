import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { repairInputFingerprint, validateRepairFailureInput } from './domain.js'
import type {} from './session.js'

export const name = 'dshagent-repair-runner'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'llm', 'sessions']
export const Config = z.object({ contextPath: z.string().required() })
export interface Config {
  contextPath: string
}

export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
}

interface RunLaunchContext {
  version: 1
  mode: 'run'
  workspaceRoot: string
  task: string
}

interface RepairLaunchContext {
  version: 1
  mode: 'repair'
  workspaceRoot: string
  input: unknown
  fingerprint: string
}

type LaunchContext = RunLaunchContext | RepairLaunchContext

function launchContext(value: unknown): LaunchContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('launch context must be an object')
  }
  const input = value as Record<string, unknown>
  if (input.version !== 1 || typeof input.workspaceRoot !== 'string') {
    throw new TypeError('launch context requires version 1 and workspaceRoot')
  }
  if (input.mode === 'run' && typeof input.task === 'string' && input.task.trim() !== '') {
    return {
      version: 1,
      mode: 'run',
      workspaceRoot: input.workspaceRoot,
      task: input.task,
    }
  }
  if (input.mode === 'repair' && typeof input.fingerprint === 'string') {
    return {
      version: 1,
      mode: 'repair',
      workspaceRoot: input.workspaceRoot,
      input: input.input,
      fingerprint: input.fingerprint,
    }
  }
  throw new TypeError('launch context must describe run or repair mode')
}

function summarize(agent: Agent, firstSeq: number): { text: string; failed: boolean } {
  let started = false
  let text = ''
  let failed = true
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const output = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (output !== '') text = output
    }
    if (event.type === 'turn/end') failed = event.data.reason.kind !== 'completed'
  }
  return { text, failed }
}

async function run(ctx: Context, config: Config): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const llm = ctx.get('llm')
  const presets = ctx.get('agentPresets')
  const sessions = ctx.get('sessions')
  const exit = ctx.get('appExit')
  if (!agents || !defaultModel || !presets || !llm || !sessions || !exit) {
    throw new Error('CLI runner requires agentPresets, agents, agentDefaultModel, llm, sessions, and appExit')
  }

  const launch = launchContext(JSON.parse(await readFile(config.contextPath, 'utf8')))
  const presetId = launch.mode === 'run' ? 'dshagent' : 'reprofix'
  await presets.resolve(presetId)
  const selection = defaultModel.currentSelection()
  if (
    launch.mode === 'run'
    && !llm.listProviders().some((provider) => provider.id === selection.provider)
  ) {
    throw new Error(
      `No LLM adapter for provider "${selection.provider}" in the active DSH profile`,
    )
  }
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: launch.workspaceRoot, agentPreset: presetId },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, presetId)
    },
  })
  await agent.whenIdle()

  if (launch.mode === 'run') {
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: launch.task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await sessions.flush(agent.session)
    const outcome = summarize(agent, firstSeq)
    if (outcome.text) internals.stdout.write(`${outcome.text}\n`)
    exit(outcome.failed ? 1 : 0)
    return
  }

  const args = validateRepairFailureInput(launch.input)
  const expected = repairInputFingerprint(args, launch.workspaceRoot)
  if (launch.fingerprint !== expected) throw new Error('repair launch context fingerprint mismatch')
  const toolCallId = CallId(`repair-cli-${randomUUID()}`)
  const controller = new AbortController()
  const removeAbort = ctx.effect(() => () => {
    controller.abort('DSH CLI runner disposed')
  })
  const result = await agent.ctx.tools.execute({
    callId: toolCallId,
    name: 'repair_failure',
    arguments: args,
    agent,
    signal: controller.signal,
  }).finally(removeAbort)
  await sessions.flush(agent.session)
  const receipt = agent.session.events.findLast(
    (event) => event.type === 'reprofix/receipt' && event.data.toolCallId === String(toolCallId),
  )
  const fixed = receipt?.type === 'reprofix/receipt' && receipt.data.status === 'fixed'
  const output = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (output) internals.stdout.write(`${output}\n`)
  if (result.isError) internals.stderr.write('dshagent: repair tool execution failed\n')
  exit(!result.isError && fixed ? 0 : 1)
}

export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (!exit) throw new Error('repair runner requires launcher-provided appExit')
  run(ctx, config).catch((error) => {
    internals.stderr.write(`dshagent: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
