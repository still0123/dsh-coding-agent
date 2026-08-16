# ADR-0005: Persist Bounded, Fail-closed Repair Receipts

- Status: Accepted
- Date: 2026-08-17

## Context

Model prose is not durable verification evidence. A reviewer needs to know
which command ran, whether it started, how it ended, which patch was validated,
and why the transaction stopped.

Raw command output can be large or contain sensitive material. Incomplete output
must not satisfy a failure literal merely because the retained tail happens to
contain it.

Infrastructure failure, cancellation, a non-reproduced report, and failed
validation are different operational outcomes and should not collapse into one
boolean.

## Decision

Every controlled terminal path attempts one typed Session event:

```text
reprofix/receipt
schema: reprofix.receipt/v1
```

The Receipt stores:

- run and tool-call identity;
- canonical input fingerprint;
- baseline root, HEAD, and clean state;
- reproduction and validation command evidence;
- diagnosis locations;
- patch metadata and fingerprint;
- Workflow outcomes and attempts;
- residual risks;
- one explicit terminal status.

Command evidence records process start, exit code, timeout, abort, sandbox
denial, duration, bounded digest, and bounded tail. Raw stdout/stderr are removed
from the durable Receipt.

Matching fails closed when a command did not start, timed out, was cancelled,
was sandbox-denied, or produced truncated evidence.

Terminal statuses are:

```text
fixed
not_reproduced
blocked_dirty_workspace
blocked_repro_side_effect
blocked_active_run
repair_failed
validation_failed
cancelled
infrastructure_error
```

Session append failure is reported to stderr; the system does not claim that a
Receipt exists. Crashes, power loss, and `SIGKILL` remain outside the durability
guarantee.

## Alternatives Considered

### Store only the final assistant message

Rejected. It is not structured, replayable, or authoritative.

### Persist complete stdout and stderr

Rejected. It creates unbounded storage and privacy risk.

### Treat retained output as complete

Rejected. The A/B benchmark demonstrates that a prompt-only Agent can treat
incomplete evidence as RED and mutate source.

### Use one `success` boolean

Rejected. Operators need to distinguish blocked, invalid, cancelled, failed,
and infrastructure paths.

### Call the fingerprint a signature

Rejected. It is an unkeyed integrity identifier, not authentication or a trusted
timestamp.

## Consequences

Positive:

- Terminal outcomes are machine-readable and auditable.
- Verification evidence survives ordinary process exit through DSH Session
  persistence.
- Output and privacy bounds are explicit.
- `ok` has one meaning: `status === fixed`.

Negative:

- Receipts retain command text, so callers must not place secrets in commands.
- Output tails may omit diagnostic context.
- Receipt existence cannot be guaranteed after uncontrolled termination.
- The V0.1 text CLI does not expose token usage or a stable JSONL projection.

## Evidence

- Event schema: [`src/session.ts`](../../src/session.ts)
- Evidence and status types: [`src/domain.ts`](../../src/domain.ts)
- Receipt construction: [`src/repair.ts`](../../src/repair.ts)
- Markdown projection: [`src/receipt.ts`](../../src/receipt.ts)
- Schema documentation: [`docs/receipt-schema.md`](../receipt-schema.md)
- Persistence tests:
  [`test/repair-failure.integration.test.ts`](../../test/repair-failure.integration.test.ts)
- A/B benchmark methodology: [`benchmark/README.md`](../../benchmark/README.md)
