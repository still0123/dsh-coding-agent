# ADR-0001: Compose DSH Instead of Reimplementing the Runtime

- Status: Accepted
- Date: 2026-08-17

## Context

DeepSeek Harness already owns the Agent Loop, model adapters, tool runtime,
permission pipeline, Sandbox, Session event log, persistence, Shell execution,
Workflow engine, and context compaction.

Reimplementing these layers would increase code volume while weakening
compatibility with DSH. It would also make the project difficult to explain:
runtime behavior and product-specific behavior would have no clear owner.

The project needs two product modes:

- a general coding composition;
- a strict repair transaction with additional invariants.

## Decision

DSH Coding Agent is a distribution and contract layer over DSH/Cordis.

- The `coding` Preset composes DSH-provided plugins.
- The `reprofix` Preset composes DSH plugins plus this package's ReproFix
  plugin.
- Public CLI processes boot the official DSH `headless` Profile and mount one
  Preset through `agentPresets.mount()`.
- ReproFix extends official seams: `defineTool`, `ctx.tools.guard`,
  `workflowEngine`, and `agent.session.append`.
- DSH compatibility is pinned to `0.1.0-rc.6` until a compatibility suite
  admits a newer version.

## Alternatives Considered

### Fork DSH

Rejected. A fork would make upstream upgrades expensive and blur ownership of
runtime behavior.

### Build a standalone Agent runtime

Rejected. Agent loops, model routing, persistence, and sandboxing are not the
project's differentiator.

### Install ReproFix globally in every DSH Session

Rejected. A process-global Guard would incorrectly restrict ordinary Coding
Preset sessions.

## Consequences

Positive:

- The project remains small relative to the runtime it uses.
- Every capability has an explicit owner.
- ReproFix can be tested as a scoped plugin and Preset.
- DSH Web and headless surfaces can use the same Presets.

Negative:

- The package depends on a developer-preview RC release.
- DSH API changes require compatibility work.
- Reviewers must understand which behavior comes from DSH and which comes from
  this repository.

## Evidence

- Presets: [`preset/coding`](../../preset/coding) and
  [`preset/reprofix`](../../preset/reprofix)
- CLI Preset mount: [`src/cli-runner.ts`](../../src/cli-runner.ts)
- Plugin entry: [`src/index.ts`](../../src/index.ts)
- Real Preset smoke: [`test/dsh-preset.smoke.test.ts`](../../test/dsh-preset.smoke.test.ts)
- Ownership diagram: [`docs/architecture.md`](../architecture.md)
