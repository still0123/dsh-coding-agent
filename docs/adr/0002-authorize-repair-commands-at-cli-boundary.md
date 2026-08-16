# ADR-0002: Authorize Repair Commands at the CLI Boundary

- Status: Accepted
- Date: 2026-08-17

## Context

Reproduction commands, acceptance commands, and failure literals define what a
ReproFix run is authorized to execute and what counts as RED or GREEN.

Putting `repair.json` in a model prompt and asking the model to call
`repair_failure` would allow the model to rewrite those commands or literals.
Prompt text is not an authorization boundary.

The command set must remain identical between user confirmation, reproduction,
and final validation.

## Decision

The CLI owns repair authorization before any model turn:

1. Parse and validate `repair.json`.
2. Resolve the canonical Git root.
3. Display the normalized reproduction command, failure literals, and
   acceptance commands.
4. Require interactive confirmation, or explicit `--yes` in non-interactive
   use.
5. Compute a canonical SHA-256 fingerprint over the normalized input and
   canonical workspace root.
6. Write the input and fingerprint to an owner-only temporary context.
7. Start DSH with a generated Cordis patch containing only the context path.
8. Recompute and compare the fingerprint inside the trusted runner.
9. Invoke `repair_failure` directly; the model receives only the patch task.

The loopback browser client delegates to `dshagent repair --yes`, so it uses the
same path instead of maintaining a second trust boundary.

## Alternatives Considered

### Put JSON in the model prompt

Rejected. The model could alter executable commands or the matching rule.

### Pass commands directly in process argv

Rejected. Process listings would expose the complete command set, and quoting
would become platform-sensitive.

### Store only a hash

Rejected. The runner still needs the exact normalized input. A hash without the
bound data cannot execute or audit the transaction.

### Trust `--yes` without validation

Rejected. Non-interactive confirmation changes who confirms, not whether the
input is structurally valid.

## Consequences

Positive:

- Model output cannot change command authorization.
- A changed command set invalidates the fingerprint.
- CLI and browser entry points share one implementation.
- Command invocation uses argv arrays and `shell: false`.

Negative:

- V0.1 CLI creates temporary context and patch files.
- The CLI must resolve the Git root before DSH starts.
- The fingerprint is an integrity identifier, not a signature or proof of
  semantic correctness.

## Evidence

- CLI boundary: [`client/cli.mjs`](../../client/cli.mjs)
- Trusted runner: [`src/cli-runner.ts`](../../src/cli-runner.ts)
- Canonical fingerprint:
  [`repairInputFingerprint`](../../src/domain.ts)
- Browser delegation: [`client/server.mjs`](../../client/server.mjs)
- CLI tests: [`test/cli.test.ts`](../../test/cli.test.ts)
