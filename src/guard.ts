import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { foldRunState, type RunState } from './domain.js'
import type { ActiveRunRegistry } from './repair.js'
import type {} from './session.js'

interface ActiveRun {
  runId: string
  state: RunState
  owner: Agent
}

const WRITABLE_STATES = new Set<RunState>(['reproduced', 'repairing'])
export const DEFAULT_READONLY_TOOLS = ['read', 'glob', 'grep'] as const
export const DEFAULT_WRITER_TOOLS = [
  ...DEFAULT_READONLY_TOOLS,
  'write',
  'edit',
  'structured_output',
] as const

export class InMemoryActiveRunRegistry implements ActiveRunRegistry {
  private readonly active = new Map<string, ActiveRun>()

  claim(sessionId: string, runId: string, owner: Agent): boolean {
    if (this.active.has(sessionId)) return false
    this.active.set(sessionId, { runId, state: 'created', owner })
    return true
  }

  setState(sessionId: string, runId: string, state: RunState): void {
    const active = this.active.get(sessionId)
    if (active?.runId === runId) active.state = state
  }

  release(sessionId: string, runId: string): void {
    if (this.active.get(sessionId)?.runId === runId) this.active.delete(sessionId)
  }

  current(agent: Agent): Readonly<ActiveRun> | undefined {
    const own = this.active.get(String(agent.id))
    if (own) return own
    const parentSession = agent.session.header.parentSession
    return parentSession === undefined ? undefined : this.active.get(String(parentSession))
  }
}

function durableState(owner: Agent, runId: string): RunState | undefined {
  const events = owner.session.events
    .filter((event) => event.type === 'reprofix/run-state')
    .map((event) => event.data)
  return foldRunState(events, runId)
}

export function mayUseWriterTools(agent: Agent, registry: InMemoryActiveRunRegistry): boolean {
  const active = registry.current(agent)
  if (!active || !WRITABLE_STATES.has(active.state)) return false
  return durableState(active.owner, active.runId) === active.state
}

export function installGuard(
  ctx: Context,
  registry: InMemoryActiveRunRegistry,
  readonlyTools: readonly string[] = DEFAULT_READONLY_TOOLS,
  writerTools: readonly string[] = DEFAULT_WRITER_TOOLS,
): () => void {
  const allowed = new Set([...readonlyTools, 'repair_failure'])
  const writerAllowed = new Set(writerTools)
  return ctx.tools.guard((exec) => {
    if (allowed.has(exec.name)) return undefined
    if (exec.agent && mayUseWriterTools(exec.agent, registry)) {
      return writerAllowed.has(exec.name)
        ? undefined
        : `ReproFix writer denied tool "${exec.name}": commands are wrapper-owned`
    }
    return `ReproFix gate denied tool "${exec.name}": exact reproduction is required for the current active run`
  })
}
