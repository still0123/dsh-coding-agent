import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ReproFix from './index.js'

export const name = 'reprofix-local-client-scope'
export const inject = ['tools', 'workflowEngine', 'shell']

export function mountReproFix(agent: Agent): void {
  ReproFix.apply(agent.ctx)
}

export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return
    mountReproFix(agent)
  })
}
