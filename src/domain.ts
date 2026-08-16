import { createHash } from 'node:crypto'

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_OUTPUT_BYTES = 256 * 1024
export const MAX_OUTPUT_TAIL_CHARS = 4_000

export interface ExitExpectation {
  exitCodes?: number[]
  outputIncludes?: string[]
}

export interface FailureExpectation extends ExitExpectation {
  outputIncludes: string[]
}

export interface RepairFailureInput {
  task: string
  failureLog?: string
  repro: {
    command: string
    timeoutMs?: number
    failure: FailureExpectation
    success?: ExitExpectation
  }
  acceptance?: Array<{
    name?: string
    command: string
    timeoutMs?: number
    success?: ExitExpectation
  }>
  maxRepairRounds?: number
}

export interface NormalizedRepairFailureInput {
  task: string
  failureLog?: string
  repro: {
    command: string
    timeoutMs: number
    failure: FailureExpectation
    success: Required<ExitExpectation>
  }
  acceptance: Array<{
    name?: string
    command: string
    timeoutMs: number
    success: Required<ExitExpectation>
  }>
  maxRepairRounds: number
}

export interface CommandEvidence {
  command: string
  processStarted: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  sandboxDenied: boolean
  durationMs: number
  outputDigest: string
  outputTail: string
  truncated?: boolean
  stdout?: string
  stderr?: string
  combinedOutput?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface DiagnosisEvidence {
  path: string
  line?: number
  reason: string
}

export interface Diagnosis {
  summary: string
  evidence: DiagnosisEvidence[]
}

export interface PatchSummary {
  revision: number
  fingerprint: string
  changedFiles: string[]
  added: number
  deleted: number
  manifestFiles: string[]
  binaryFiles: string[]
  score: number
}

export type RepairFailureStatus =
  | 'fixed'
  | 'not_reproduced'
  | 'blocked_dirty_workspace'
  | 'blocked_repro_side_effect'
  | 'blocked_active_run'
  | 'repair_failed'
  | 'validation_failed'
  | 'cancelled'
  | 'infrastructure_error'

export interface RepairCheck {
  kind: 'reproduction' | 'post_fix_repro' | 'acceptance'
  name: string
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  outputDigest: string
  outputTail: string
}

export interface RepairFailureResult {
  ok: boolean
  runId: string
  status: RepairFailureStatus
  summary: string
  diagnosis?: Diagnosis
  patch?: PatchSummary
  checks: RepairCheck[]
  attempts: number
  residualRisks: string[]
}

export interface ReprofixReceiptV1 {
  schemaVersion: 'reprofix.receipt/v1'
  runId: string
  toolCallId: string
  status: RepairFailureStatus
  startedAt: string
  finishedAt: string
  inputFingerprint: `sha256:${string}`
  baseline: {
    workspaceRoot: string
    head: string
    clean: boolean
  }
  reproduction: CommandEvidence
  diagnosis?: Diagnosis
  patch?: PatchSummary
  validation: CommandEvidence[]
  attempts: number
  workflow: Array<{
    round: number
    stopReason: string
    agentsStarted: number
    error?: string
  }>
  residualRisks: string[]
}

export type RunState =
  | 'created'
  | 'reproducing'
  | 'reproduced'
  | 'repairing'
  | 'validating'
  | 'superseded'
  | RepairFailureStatus

export interface RunStateEvent {
  runId: string
  state: RunState
  at?: string
  patchRevision?: number
}

const ANSI_ESCAPE = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'pyproject.toml',
  'poetry.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
])

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new RangeError(`${label} must be at most ${maxLength} characters`)
  }
  return value
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new TypeError(`${label} must be a string of at most ${maxLength} characters`)
  }
  return value
}

function command(value: unknown, label: string): string {
  const result = text(value, label)
  if (result.includes('\0')) throw new TypeError(`${label} must not contain NUL`)
  return result
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}

function timeout(value: unknown, label: string): number {
  return value === undefined ? DEFAULT_TIMEOUT_MS : integer(value, label, 1_000, 1_800_000)
}

function exitCodes(value: unknown, label: string, fallback?: number[]): number[] | undefined {
  if (value === undefined) return fallback === undefined ? undefined : [...fallback]
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Number.isInteger(item))) {
    throw new TypeError(`${label} must be a non-empty integer array`)
  }
  return [...value] as number[]
}

function literals(value: unknown, label: string, required: boolean): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new TypeError(`${label} must be ${required ? 'a non-empty' : 'an'} array`)
  }
  return value.map((item, index) => text(item, `${label}[${index}]`, 2_000))
}

function expectation(value: unknown, label: string): Required<ExitExpectation> {
  const input = value === undefined ? {} : record(value, label)
  return {
    exitCodes: exitCodes(input.exitCodes, `${label}.exitCodes`, [0])!,
    outputIncludes: literals(input.outputIncludes, `${label}.outputIncludes`, false),
  }
}

export function validateRepairFailureInput(value: unknown): NormalizedRepairFailureInput {
  const input = record(value, 'input')
  const repro = record(input.repro, 'repro')
  const failure = record(repro.failure, 'repro.failure')
  const acceptanceInput = input.acceptance === undefined ? [] : input.acceptance
  if (!Array.isArray(acceptanceInput) || acceptanceInput.length > 10) {
    throw new RangeError('acceptance must be an array with at most 10 entries')
  }

  const failureLog = optionalText(input.failureLog, 'failureLog', 20_000)
  return {
    task: text(input.task, 'task', 10_000),
    ...(failureLog === undefined ? {} : { failureLog }),
    repro: {
      command: command(repro.command, 'repro.command'),
      timeoutMs: timeout(repro.timeoutMs, 'repro.timeoutMs'),
      failure: {
        ...(failure.exitCodes === undefined
          ? {}
          : { exitCodes: exitCodes(failure.exitCodes, 'repro.failure.exitCodes')! }),
        outputIncludes: literals(failure.outputIncludes, 'repro.failure.outputIncludes', true),
      },
      success: expectation(repro.success, 'repro.success'),
    },
    acceptance: acceptanceInput.map((item, index) => {
      const entry = record(item, `acceptance[${index}]`)
      if (entry.name !== undefined && typeof entry.name !== 'string') {
        throw new TypeError(`acceptance[${index}].name must be a string`)
      }
      const name = entry.name as string | undefined
      return {
        ...(name === undefined ? {} : { name }),
        command: command(entry.command, `acceptance[${index}].command`),
        timeoutMs: timeout(entry.timeoutMs, `acceptance[${index}].timeoutMs`),
        success: expectation(entry.success, `acceptance[${index}].success`),
      }
    }),
    maxRepairRounds:
      input.maxRepairRounds === undefined
        ? 1
        : integer(input.maxRepairRounds, 'maxRepairRounds', 1, 3),
  }
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, '')
}

export function commandCombinedOutput(evidence: CommandEvidence): string {
  return stripAnsi(evidence.combinedOutput ?? `${evidence.stdout ?? ''}\n${evidence.stderr ?? ''}`)
}

function completedCommand(evidence: CommandEvidence): evidence is CommandEvidence & { exitCode: number } {
  return (
    evidence.processStarted &&
    !evidence.timedOut &&
    !evidence.aborted &&
    !evidence.sandboxDenied &&
    !evidence.truncated &&
    typeof evidence.exitCode === 'number'
  )
}

export function matchesFailure(evidence: CommandEvidence, expected: FailureExpectation): boolean {
  if (!completedCommand(evidence)) return false
  const exitMatches = expected.exitCodes
    ? expected.exitCodes.includes(evidence.exitCode)
    : evidence.exitCode !== 0
  const output = commandCombinedOutput(evidence)
  return exitMatches && expected.outputIncludes.every((literal) => output.includes(literal))
}

export function matchesSuccess(evidence: CommandEvidence, expected: ExitExpectation = {}): boolean {
  if (!completedCommand(evidence)) return false
  const exitCodes = expected.exitCodes ?? [0]
  const outputIncludes = expected.outputIncludes ?? []
  const output = commandCombinedOutput(evidence)
  return exitCodes.includes(evidence.exitCode) && outputIncludes.every((literal) => output.includes(literal))
}

function canonicalize(value: unknown, inArray = false): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null'
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item, true) ?? 'null').join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([key, item]) => {
        const encoded = canonicalize(item)
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`]
      })
    return `{${entries.join(',')}}`
  }
  if (inArray) return 'null'
  return undefined
}

export function stableCanonicalJson(value: unknown): string {
  const result = canonicalize(value)
  if (result === undefined) throw new TypeError('value is not JSON serializable')
  return result
}

export function sha256Digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function fingerprint(value: unknown): `sha256:${string}` {
  return sha256Digest(stableCanonicalJson(value))
}

export function repairInputFingerprint(
  input: NormalizedRepairFailureInput,
  workspaceRoot: string,
): `sha256:${string}` {
  return fingerprint({
    workspaceRoot,
    input: {
      ...input,
      failureLog: input.failureLog === undefined ? undefined : fingerprint(input.failureLog),
    },
  })
}

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  return bytes.length <= maxBytes
    ? { value, truncated: false }
    : { value: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

export interface OutputSummary {
  stdout: string
  stderr: string
  combinedOutput: string
  outputDigest: `sha256:${string}`
  outputTail: string
  truncated: boolean
}

export function summarizeCommandOutput(
  stdout: string,
  stderr: string,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  maxTailChars = MAX_OUTPUT_TAIL_CHARS,
): OutputSummary {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new RangeError('maxOutputBytes must be a non-negative integer')
  }
  if (!Number.isInteger(maxTailChars) || maxTailChars < 0) {
    throw new RangeError('maxTailChars must be a non-negative integer')
  }
  const boundedStdout = boundedUtf8(stdout, maxOutputBytes)
  const boundedStderr = boundedUtf8(stderr, maxOutputBytes)
  const combinedOutput = `${boundedStdout.value}\n${boundedStderr.value}`
  return {
    stdout: boundedStdout.value,
    stderr: boundedStderr.value,
    combinedOutput,
    outputDigest: sha256Digest(combinedOutput),
    outputTail: combinedOutput.slice(-maxTailChars),
    truncated: boundedStdout.truncated || boundedStderr.truncated,
  }
}

export function isManifestFile(path: string): boolean {
  const basename = path.replaceAll('\\', '/').split('/').at(-1) ?? path
  return MANIFEST_BASENAMES.has(basename) || /^requirements.*\.txt$/.test(basename)
}

export function calculatePatchScore(input: {
  added: number
  deleted: number
  changedFiles: string[] | number
  manifestFiles: string[] | number
  binaryFiles: string[] | number
}): number {
  const count = (value: string[] | number) => (typeof value === 'number' ? value : value.length)
  return (
    input.added +
    input.deleted +
    10 * count(input.changedFiles) +
    50 * count(input.manifestFiles) +
    100 * count(input.binaryFiles)
  )
}

export function foldRunState(events: readonly RunStateEvent[], runId: string): RunState | undefined {
  let state: RunState | undefined
  for (const event of events) {
    if (event.runId === runId) state = event.state
  }
  return state
}

export function foldRunStates(events: readonly RunStateEvent[]): ReadonlyMap<string, RunState> {
  const states = new Map<string, RunState>()
  for (const event of events) states.set(event.runId, event.state)
  return states
}

export function isTerminalRunState(state: RunState): state is RepairFailureStatus | 'superseded' {
  return !['created', 'reproducing', 'reproduced', 'repairing', 'validating'].includes(state)
}
