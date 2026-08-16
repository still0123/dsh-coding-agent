# ADR-0004: Bind Validation to the Canonical Workspace and Final Patch

- Status: Accepted
- Date: 2026-08-17

## Context

Session-local concurrency control cannot stop two DSH processes from repairing
the same repository. Path aliases and symlinks can also make one Git repository
look like multiple workspaces.

A passing validation result is stale if HEAD or the patch changes after the
check. Tracked diffs alone are insufficient because untracked files can affect
builds and tests.

## Decision

ReproFix binds each transaction to one canonical repository state.

### Workspace identity and lock

- Resolve `git rev-parse --show-toplevel`.
- Canonicalize it with `realpath`.
- Hash the canonical root for the lock id.
- Acquire an atomic directory lock under:

  ```text
  $DSH_HOME/dsh-coding-agent/locks/<sha256(root)>.lock
  ```

- Persist PID, process-start identity, owner nonce, run id, Session id, root,
  and acquisition time.
- Release only when nonce, run id, and Session id still match.
- Recover a stale lock only when the owner process is confirmed absent.
- Fail closed when ownership is malformed or uncertain.

### Repository and patch invariants

- Record initial clean state and HEAD.
- Recheck clean state and HEAD after lock acquisition and reproduction.
- Verify HEAD after the writer and final validation.
- Fingerprint tracked binary diff plus sorted untracked paths, content digests,
  file type, and executable bit.
- Compute the fingerprint before and after validation; a mismatch prevents
  `fixed`.

## Alternatives Considered

### Session-id lock

Rejected. It does not coordinate different Sessions or processes.

### Raw cwd string as lock key

Rejected. Symlinks and nested paths can alias the same repository.

### PID-only stale recovery

Rejected. PIDs are reused; uncertain ownership must not be stolen.

### Tracked `git diff` only

Rejected. Untracked source, manifests, generated files, and symlinks would be
invisible.

### Automatically reset side effects

Rejected. Reset, checkout, or clean could destroy user data. V0.1 detects and
stops instead.

## Consequences

Positive:

- Processes sharing one `DSH_HOME` cannot write the same canonical repository
  concurrently.
- Validation is tied to the final observed patch and unchanged HEAD.
- Untracked files enter the patch identity.
- Failed repairs preserve the workspace for human inspection.

Negative:

- Different users or different `DSH_HOME` values do not share a lock.
- Network filesystem semantics are outside the V0.1 guarantee.
- Reproduction still runs in place; side effects can be detected but not
  undone.
- Fully isolated worktree/container execution remains future work.

## Evidence

- Lock implementation: [`src/workspace-lock.ts`](../../src/workspace-lock.ts)
- Git and fingerprint adapter: [`src/runner.ts`](../../src/runner.ts)
- Transaction checks: [`src/repair.ts`](../../src/repair.ts)
- Cross-process tests: [`test/workspace-lock.test.ts`](../../test/workspace-lock.test.ts)
- Real Git fixture tests:
  [`test/golden-fixture.integration.test.ts`](../../test/golden-fixture.integration.test.ts)
