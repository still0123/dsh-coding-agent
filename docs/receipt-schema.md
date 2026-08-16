# ReproFix receipt schema

The durable source of truth is the lossless JSON payload appended as
`reprofix/receipt`. Markdown shown to the model is a projection of this object,
not a second record.

## `reprofix.receipt/v1`

```ts
interface ReprofixReceiptV1 {
  schemaVersion: 'reprofix.receipt/v1'
  runId: string
  toolCallId: string
  status:
    | 'fixed'
    | 'not_reproduced'
    | 'blocked_dirty_workspace'
    | 'blocked_repro_side_effect'
    | 'blocked_active_run'
    | 'repair_failed'
    | 'validation_failed'
    | 'cancelled'
  startedAt: string
  finishedAt: string
  inputFingerprint: `sha256:${string}`
  baseline: {
    workspaceRoot: string
    head: string
    clean: boolean
  }
  reproduction: CommandEvidence
  diagnosis?: {
    summary: string
    evidence: Array<{ path: string; line?: number; reason: string }>
  }
  patch?: PatchEvidence
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
```

`ok` is a tool-result projection and is true exactly when `status === 'fixed'`.
Every terminal status produces a receipt, including cancellation and blocked
runs. `failureLog` is never stored verbatim; only its digest contributes to the
input evidence.

## Command evidence

```ts
interface CommandEvidence {
  command: string
  processStarted: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  sandboxDenied: boolean
  durationMs: number
  outputDigest: `sha256:${string}`
  outputTail: string
  truncated?: boolean
  stdout?: string
  stderr?: string
  combinedOutput?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}
```

During execution, `combinedOutput` is the bounded `stdout + "\n" + stderr`;
ANSI is removed only for literal matching. Each stream is captured up to 256
KiB. The digest covers the complete bounded capture and the display tail is at
most 4,000 characters. `truncated` is true when either DSH's shell capture or the
plugin's own bound dropped bytes; truncated evidence is never eligible for RED
or GREEN matching. Receipt construction may omit the optional raw capture fields
after deriving the digest and tail. Spawn, sandbox, timeout, abort, and truncation
states are not represented as an invented exit code. Internal Git evidence is
also fail-closed on truncation, while untracked regular files are hashed and
line-counted as streams instead of being loaded whole into memory.

Initial reproduction is exact only when the process started, was not timed out,
aborted, or sandbox-denied, the declared failure exit-code rule matches, and
every case-sensitive literal is present. A command timeout is a domain failure;
an outer `exec.signal` cancellation produces `cancelled`.

## Patch evidence

```ts
interface PatchEvidence {
  revision: number
  fingerprint: `sha256:${string}`
  changedFiles: string[]
  added: number
  deleted: number
  manifestFiles: string[]
  binaryFiles: string[]
  score: number
}
```

The fingerprint canonically covers tracked and untracked patch state. It is
computed after a writer round, immediately before validation, and after all
validation commands. A mismatch makes validation fail. Any later writer round
increments `revision` and invalidates prior green checks.

The observable score is:

```text
added + deleted + 10 * changedFiles + 50 * manifestFiles + 100 * binaryFiles
```

It describes one final patch. It does not compare candidates or prove global
minimality.

## Canonicalization and privacy

Fingerprint inputs use recursively sorted object keys, original array order,
UTF-8 JSON, and SHA-256 with the `sha256:` prefix. Session payloads contain only
lossless JSON: no `Error`, `AbortSignal`, agent, service, or function values.
Commands are retained for auditability, so users must not put credentials in a
command string. Environment variables and secret files are not collected.

## State events

Each transition is also appended as `reprofix/run-state`, keyed by `runId`.
Durable events determine whether the current run reached exact RED; the in-memory
registry only prevents concurrent live runs. Terminal states relock the guard,
and a stale pre-restart state never unlocks mutation.
