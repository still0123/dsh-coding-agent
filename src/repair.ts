import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  fingerprint,
  foldRunStates,
  isTerminalRunState,
  matchesFailure,
  matchesSuccess,
  type CommandEvidence,
  type Diagnosis,
  type NormalizedRepairFailureInput,
  type PatchSummary,
  type RepairCheck,
  type RepairFailureResult,
  type RepairFailureStatus,
  type ReprofixReceiptV1,
  type RunState,
} from './domain.js'
import { diagnosisFromWriter, runWriterWorkflow, type WorkflowAttempt } from './workflow.js'

export interface BaselineEvidence {
  workspaceRoot: string
  head: string
  clean: boolean
}

export interface CommandRunner {
  run(input: {
    command: string
    cwd: string
    timeoutMs: number
    signal: AbortSignal
    maxOutputBytes: number
  }): Promise<CommandEvidence>
}

export interface GitAdapter {
  baseline(cwd: string): Promise<BaselineEvidence>
  isClean(workspaceRoot: string): Promise<boolean>
  patch(workspaceRoot: string, revision: number): Promise<PatchSummary>
}

export interface ActiveRunRegistry {
  claim(sessionId: string, runId: string, agent: Agent): boolean
  setState(sessionId: string, runId: string, state: RunState): void
  release(sessionId: string, runId: string): void
}

export interface RepairDependencies {
  commandRunner: CommandRunner
  git: GitAdapter
  activeRuns: ActiveRunRegistry
  maxOutputBytes?: number
  runWriter?: typeof runWriterWorkflow
  now?: () => Date
  runId?: () => string
}

interface ReceiptContext {
  runId: string
  toolCallId: string
  startedAt: string
  baseline: BaselineEvidence
  reproduction: CommandEvidence
  diagnosis?: Diagnosis
  patch?: PatchSummary
  validation: CommandEvidence[]
  attempts: number
  workflow: ReprofixReceiptV1['workflow']
  residualRisks: string[]
}

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`

function notRun(command: string): CommandEvidence {
  return {
    command,
    processStarted: false,
    exitCode: null,
    timedOut: false,
    aborted: false,
    sandboxDenied: false,
    durationMs: 0,
    outputDigest: ZERO_DIGEST,
    outputTail: '',
  }
}

function toCheck(
  evidence: CommandEvidence,
  kind: RepairCheck['kind'],
  name: string,
  ok: boolean,
): RepairCheck {
  return {
    kind,
    name,
    ok,
    exitCode: evidence.exitCode,
    timedOut: evidence.timedOut,
    aborted: evidence.aborted,
    durationMs: evidence.durationMs,
    outputDigest: evidence.outputDigest,
    outputTail: evidence.outputTail,
  }
}

function statusSummary(status: RepairFailureStatus): string {
  switch (status) {
    case 'fixed': return 'The declared failure was reproduced and the final patch passed wrapper-owned validation.'
    case 'not_reproduced': return 'The reproduction command did not match the declared failure signature.'
    case 'blocked_dirty_workspace': return 'The workspace was dirty before reproduction, so no command or writer ran.'
    case 'blocked_repro_side_effect': return 'The reproduction command changed the workspace, so the writer was not started.'
    case 'blocked_active_run': return 'Another ReproFix run is already active for this Session.'
    case 'repair_failed': return 'The writer workflow did not produce a valid patch.'
    case 'validation_failed': return 'The final patch did not pass wrapper-owned validation.'
    case 'cancelled': return 'The ReproFix run was cancelled.'
  }
}

function receiptEvidence(evidence: CommandEvidence): CommandEvidence {
  const { stdout: _stdout, stderr: _stderr, combinedOutput: _combinedOutput, ...persisted } = evidence
  return persisted
}

function terminalResult(
  context: ReceiptContext,
  input: NormalizedRepairFailureInput,
  status: RepairFailureStatus,
  checks: RepairCheck[],
  finishedAt: string,
): { result: RepairFailureResult; receipt: ReprofixReceiptV1 } {
  const result: RepairFailureResult = {
    ok: status === 'fixed',
    runId: context.runId,
    status,
    summary: statusSummary(status),
    ...(context.diagnosis === undefined ? {} : { diagnosis: context.diagnosis }),
    ...(context.patch === undefined ? {} : { patch: context.patch }),
    checks,
    attempts: context.attempts,
    residualRisks: context.residualRisks,
  }
  const receipt: ReprofixReceiptV1 = {
    schemaVersion: 'reprofix.receipt/v1',
    runId: context.runId,
    toolCallId: context.toolCallId,
    status,
    startedAt: context.startedAt,
    finishedAt,
    inputFingerprint: fingerprint({
      ...input,
      failureLog: input.failureLog === undefined ? undefined : fingerprint(input.failureLog),
    }),
    baseline: context.baseline,
    reproduction: receiptEvidence(context.reproduction),
    ...(context.diagnosis === undefined ? {} : { diagnosis: context.diagnosis }),
    ...(context.patch === undefined ? {} : { patch: context.patch }),
    validation: context.validation.map(receiptEvidence),
    attempts: context.attempts,
    workflow: context.workflow,
    residualRisks: context.residualRisks,
  }
  return { result, receipt }
}

export async function executeRepairFailure(input: {
  args: NormalizedRepairFailureInput
  agent: Agent
  toolCallId: string
  signal: AbortSignal
  dependencies: RepairDependencies
}): Promise<RepairFailureResult> {
  const { args, agent, toolCallId, signal, dependencies } = input
  const now = dependencies.now ?? (() => new Date())
  const runId = (dependencies.runId ?? randomUUID)()
  const sessionId = String(agent.id)
  const cwd = agent.session.header.cwd
  if (!cwd) throw new Error('repair_failure requires an agent Session with a workspace cwd')

  const appendState = (state: RunState, patchRevision?: number): void => {
    agent.session.append('reprofix/run-state', {
      runId,
      state,
      at: now().toISOString(),
      ...(patchRevision === undefined ? {} : { patchRevision }),
    })
    dependencies.activeRuns.setState(sessionId, runId, state)
  }

  const startedAt = now().toISOString()
  const emptyBaseline: BaselineEvidence = { workspaceRoot: cwd, head: '', clean: false }
  const context: ReceiptContext = {
    runId,
    toolCallId,
    startedAt,
    baseline: emptyBaseline,
    reproduction: notRun(args.repro.command),
    validation: [],
    attempts: 0,
    workflow: [],
    residualRisks: [],
  }
  const checks: RepairCheck[] = []

  const finish = (status: RepairFailureStatus): RepairFailureResult => {
    appendState(status)
    const { result, receipt } = terminalResult(context, args, status, checks, now().toISOString())
    agent.session.append('reprofix/receipt', receipt)
    return result
  }

  if (!dependencies.activeRuns.claim(sessionId, runId, agent)) {
    return finish('blocked_active_run')
  }

  try {
    appendState('created')
    if (signal.aborted) return finish('cancelled')

    const baseline = await dependencies.git.baseline(cwd)
    context.baseline = baseline
    if (signal.aborted) return finish('cancelled')
    if (!baseline.clean) return finish('blocked_dirty_workspace')

    const priorStates = foldRunStates(
      agent.session.events
        .filter((event) => event.type === 'reprofix/run-state')
        .map((event) => event.data),
    )
    for (const [priorRunId, priorState] of priorStates) {
      if (priorRunId === runId || isTerminalRunState(priorState)) continue
      agent.session.append('reprofix/run-state', {
        runId: priorRunId,
        state: 'superseded',
        at: now().toISOString(),
      })
    }

    appendState('reproducing')
    const reproduction = await dependencies.commandRunner.run({
      command: args.repro.command,
      cwd: baseline.workspaceRoot,
      timeoutMs: args.repro.timeoutMs,
      signal,
      maxOutputBytes: dependencies.maxOutputBytes ?? 256 * 1024,
    })
    context.reproduction = reproduction
    const reproduced = matchesFailure(reproduction, args.repro.failure)
    checks.push(toCheck(reproduction, 'reproduction', 'declared reproduction', reproduced))
    if (signal.aborted || reproduction.aborted) return finish('cancelled')
    if (!reproduced) return finish('not_reproduced')
    const cleanAfterReproduction = await dependencies.git.isClean(baseline.workspaceRoot)
    if (signal.aborted) return finish('cancelled')
    if (!cleanAfterReproduction) return finish('blocked_repro_side_effect')

    appendState('reproduced')
    const writer = dependencies.runWriter ?? runWriterWorkflow
    let previousValidation: CommandEvidence[] | undefined

    for (let round = 1; round <= args.maxRepairRounds; round += 1) {
      context.attempts = round
      appendState('repairing', round)
      let attempt: WorkflowAttempt
      try {
        attempt = await writer({
          ctx: agent.ctx,
          parent: agent,
          signal,
          task: args.task,
          reproduction,
          ...(previousValidation === undefined ? {} : { previousValidation }),
          ...(context.patch === undefined ? {} : { patch: context.patch }),
        })
      } catch (error: unknown) {
        context.workflow.push({
          round,
          stopReason: 'error',
          agentsStarted: 0,
          error: error instanceof Error ? error.message : String(error),
        })
        return finish(signal.aborted ? 'cancelled' : 'repair_failed')
      }
      context.workflow.push({
        round,
        stopReason: attempt.stopReason,
        agentsStarted: attempt.agentsStarted,
        ...(attempt.error === undefined ? {} : { error: attempt.error }),
      })
      if (signal.aborted || attempt.stopReason === 'cancelled') return finish('cancelled')
      if (attempt.stopReason !== 'completed' || !attempt.writer || attempt.writer.outcome !== 'patched') {
        context.residualRisks = attempt.writer?.residualRisks ?? []
        return finish('repair_failed')
      }

      context.diagnosis = diagnosisFromWriter(attempt.writer)
      context.residualRisks = attempt.writer.residualRisks
      const patch = await dependencies.git.patch(baseline.workspaceRoot, round)
      context.patch = patch
      if (signal.aborted) return finish('cancelled')
      if (patch.changedFiles.length === 0) return finish('repair_failed')

      appendState('validating', round)
      const beforeFingerprint = patch.fingerprint
      const validation: CommandEvidence[] = []
      const postFix = await dependencies.commandRunner.run({
        command: args.repro.command,
        cwd: baseline.workspaceRoot,
        timeoutMs: args.repro.timeoutMs,
        signal,
        maxOutputBytes: dependencies.maxOutputBytes ?? 256 * 1024,
      })
      validation.push(postFix)
      let passed = matchesSuccess(postFix, args.repro.success)
      checks.push(toCheck(postFix, 'post_fix_repro', 'post-fix reproduction', passed))

      for (const [index, acceptance] of args.acceptance.entries()) {
        if (signal.aborted) break
        const evidence = await dependencies.commandRunner.run({
          command: acceptance.command,
          cwd: baseline.workspaceRoot,
          timeoutMs: acceptance.timeoutMs,
          signal,
          maxOutputBytes: dependencies.maxOutputBytes ?? 256 * 1024,
        })
        validation.push(evidence)
        const ok = matchesSuccess(evidence, acceptance.success)
        checks.push(toCheck(evidence, 'acceptance', acceptance.name ?? `acceptance ${index + 1}`, ok))
        passed &&= ok
      }
      context.validation.push(...validation)
      if (signal.aborted || validation.some((item) => item.aborted)) return finish('cancelled')

      const afterPatch = await dependencies.git.patch(baseline.workspaceRoot, round)
      context.patch = afterPatch
      if (signal.aborted) return finish('cancelled')
      if (afterPatch.fingerprint !== beforeFingerprint) passed = false
      if (passed) return finish('fixed')
      previousValidation = validation
    }

    return finish('validation_failed')
  } finally {
    dependencies.activeRuns.release(sessionId, runId)
  }
}
