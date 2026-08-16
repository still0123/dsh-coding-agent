import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountPreset } from '@deepseek-ai/dsh-agent-presets'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import ShellExecutor, { type ShellExecRequest, type ShellExecSpec, type ShellProcess, type ShellRunResult } from '@deepseek-ai/dsh-shell'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as WorkflowWorker from '@deepseek-ai/dsh-workflow-worker-thread'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import * as ReproFix from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

class FakeShell extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? root,
      timeoutMs: request.timeoutMs ?? 1_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1_024,
      sandboxPolicy: request.sandboxPolicy,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    }
  }

  start(): ShellProcess {
    throw new Error('preset smoke never starts a background shell')
  }
}

function toolModule(names: readonly string[]) {
  return {
    name: `preset-smoke-${names.join('-')}`,
    inject: ['tools'],
    apply(ctx: Context) {
      for (const name of names) {
        ctx.tools.register(defineTool({
          name,
          description: `preset smoke ${name}`,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async () => `ran:${name}`,
        }))
      }
    },
  }
}

const noopModule = { name: 'preset-smoke-noop', apply() {} }

function agent(id: string) {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    cwd: root,
  })
  const key = { id: sessionId, session } as Agent
  const result = { key, session, scope: undefined as ReturnType<typeof createScope> | undefined }
  return result
}

describe('real DSH ReproFix preset mount', () => {
  it('mounts the actual YAML under a scope and enforces the locked tool surface', async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(FakeShell)

    const modules: Record<string, unknown> = {
      '@deepseek-ai/dsh-persona': noopModule,
      '@deepseek-ai/dsh-agent-instructions': noopModule,
      '@deepseek-ai/dsh-tool-bash': toolModule(['bash']),
      '@deepseek-ai/dsh-tool-pwsh': toolModule(['pwsh']),
      '@deepseek-ai/dsh-tool-fs': toolModule(['read', 'write', 'edit']),
      '@deepseek-ai/dsh-tool-fs-search': toolModule(['glob', 'grep']),
      '@deepseek-ai/dsh-workflow-worker-thread': WorkflowWorker,
      'dsh-reprofix': ReproFix,
    }
    ctx.loader.internal = {
      import: async (specifier: string) => {
        if (specifier in modules) return modules[specifier]
        throw new Error(`unexpected preset module: ${specifier}`)
      },
    } as never

    const mounted = agent('preset-agent')
    mounted.scope = createScope(ctx, mounted.key)
    ;(mounted.key as { ctx?: Context }).ctx = mounted.scope.ctx
    await mountPreset(mounted.scope.ctx, {
      id: 'reprofix',
      trust: 'system',
      path: join(root, 'preset', 'reprofix', 'agent.cordis.yml'),
    })

    const names = ctx.tools.schemas(mounted.key).map((schema) => schema.name).sort()
    expect(names).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'repair_failure', 'write'])
    expect(names.filter((name) => name === 'repair_failure')).toHaveLength(1)
    expect(ctx.tools.schemas().map((schema) => schema.name)).not.toContain('repair_failure')

    const write = await ctx.tools.execute({
      callId: CallId('preset-write'),
      name: 'write',
      arguments: {},
      agent: mounted.key,
      signal: new AbortController().signal,
    })
    expect(write.isError).toBe(true)
    expect(write.content[0]).toMatchObject({ text: expect.stringContaining('exact reproduction') })

    const read = await ctx.tools.execute({
      callId: CallId('preset-read'),
      name: 'read',
      arguments: {},
      agent: mounted.key,
      signal: new AbortController().signal,
    })
    expect(read.isError).toBe(false)
    await mounted.scope.dispose()
  })
})
