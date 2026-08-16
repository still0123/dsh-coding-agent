# ADR-0003: Use a Reproduce-first, Shell-free Single Writer

- Status: Accepted
- Date: 2026-08-17

## Context

A repair Agent can claim success without reproducing the reported failure. A
prompt such as "test before editing" does not prevent the model from editing
first, changing the command, or treating incomplete output as evidence.

Giving the writer a Shell also makes command ownership unenforceable. Shell
aliases, wrapper scripts, and language runtimes can bypass command-text
denylists.

The repair process needs one clear mutation boundary and one final authority for
validation.

## Decision

ReproFix implements a monotonic state gate:

```text
clean baseline
  -> exact RED
  -> one writer
  -> wrapper-owned GREEN
  -> Receipt
```

- RED requires a completed command, the declared exit-code rule, every
  case-sensitive literal, and complete evidence.
- Before RED, only read/search tools and `repair_failure` are available.
- After RED, writer capability tools are limited to read/search/edit/write.
- Bash, PowerShell, and arbitrary command tools remain denied after RED.
- DSH's `structured_output` control channel is allowed only so the writer can
  return its schema result.
- `maxTotalAgents: 1` enforces one serial writer.
- The wrapper, not the writer, reruns reproduction and every acceptance
  command.

The prompt describes the restriction, but `ctx.tools.guard()` enforces it.

## Alternatives Considered

### Prompt-only sequencing

Rejected as the security boundary. It remains useful as the A/B baseline.

### Allow Shell after RED with a Git-command denylist

Rejected. Shell text is not a capability boundary and can be bypassed.

### Let the writer run supporting checks

Rejected. It would create two command authorities and make the final evidence
ambiguous.

### Multiple writer candidates

Rejected for V0.1. Parallel writers require isolated worktrees and a candidate
selection contract.

## Consequences

Positive:

- Mutation cannot begin before the observed RED state.
- The writer cannot rewrite or privately rerun validation commands.
- Final success depends on wrapper evidence, not model prose.
- One writer keeps patch ownership and state transitions simple.

Negative:

- The writer cannot use a compiler or test command while diagnosing.
- More repair rounds may be needed for complex failures.
- The allowed `structured_output` channel must remain classified as protocol
  control, not a general capability.

## Evidence

- Guard: [`src/guard.ts`](../../src/guard.ts)
- State machine: [`src/repair.ts`](../../src/repair.ts)
- Writer Workflow: [`src/workflow.ts`](../../src/workflow.ts)
- Guard tests: [`test/guard.test.ts`](../../test/guard.test.ts)
- A/B benchmark:
  [`benchmark/results/2026-08-17-traex-gpt-5.6-sol-max.md`](../../benchmark/results/2026-08-17-traex-gpt-5.6-sol-max.md)

In the initial controlled run, the prompt-only arm reported `fixed` and mutated
source from incomplete output, while ReproFix returned `not_reproduced` without
starting the writer. The result is exploratory (`n=1` per scenario), not a
general statistical claim.
