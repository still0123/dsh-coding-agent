# DSH Coding Agent — Product and Technical Specification

## 0. Document Status

| Field | Value |
| --- | --- |
| Product | DSH Coding Agent |
| CLI | `dshagent` |
| Repository | `still0123/dsh-coding-agent` (single source of truth) |
| Predecessor | `still0123/dshagent` (to be archived, history preserved) |
| Specification version | 2.0 |
| Supersedes | v1.0 "DSHAgent general coding agent" positioning |
| Status | Implementation baseline |
| Baseline commit | `5b9166c` plus the uncommitted identity rename to `dsh-coding-agent` |
| Requirement count | 75 unique numbered requirements (5 ID, 15 CLI, 21 SEC, 10 RCP, 10 INS, 5 COD, 4 DEM, 5 REL) |
| DSH compatibility target | `0.1.0-rc.6` |
| Cordis | `4.0.1` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Package manager | pnpm `11.7.0` |
| License | MIT |

This document replaces specification v1.0. The earlier version framed the
product as a general coding agent whose value was novelty. That framing was
wrong for this project. This version fixes the positioning to what the code
actually is and what is defensible in interview review: a **DSH distribution
layer** with one **self-implemented strict repair mode**.

## 1. Product Definition

DSH Coding Agent is a distribution layer built on DeepSeek Harness. It does not
reimplement the DSH Agent Loop, model adapters, tool runtime, sandbox, session
model, or persistence. It composes DSH capabilities into two Agent Presets and
adds one self-implemented capability, ReproFix.

| Preset | Purpose | Ownership |
| --- | --- | --- |
| `coding` | General repository inspection, editing, command execution, Skills, Todo, questions, context compaction | Composition of DSH-provided plugins |
| `reprofix` | Strict reproduce-first repair: RED gate, single writer, wrapper-owned validation, durable receipts | Self-implemented plugin on DSH seams |

The honest one-line positioning is:

> A DSH/Cordis coding-agent distribution whose flagship capability, ReproFix,
> enforces an auditable repair contract: reproduce first, then allow one writer,
> then re-validate independently, then report.

The product does not claim to be a from-scratch agent runtime. Stating clearly
which parts DSH provides and which parts this project implements is a
deliberate design and review decision, not a limitation to hide.

## 2. Correctness Contract (the core claim)

The value of this project is not novelty. It is an **auditable execution
contract** that can be checked as a black box:

```text
exact reproduction matches the declared failure
  → writing is unlocked
  → after the final patch revision
  → all declared postconditions are re-run by the wrapper
  → only if all pass may the run report `fixed`
```

ReproFix provides an auditable execution contract: the declared failure was
observed before mutation, and every declared postcondition passed against the
final patch. It deliberately does **not** claim to prove that the failure
signature is correct, that the acceptance set is complete, that tests are not
flaky, that no uncovered regression exists, or that the code is semantically
fully fixed. The contract is defined over observable command outcomes and
repository invariants, not over model prose.

## 3. Ownership Boundary (DSH vs this project)

This table is both the design boundary and an interview artifact. Every
capability is assigned to exactly one owner.

| Capability | Owner | Seam / mechanism |
| --- | --- | --- |
| Agent Loop | DSH | agent runtime |
| Model adapters / providers | DSH | `dsh-llm` |
| Tool parameter and output validation | DSH | `defineTool` schema |
| Tool execution pipeline | DSH | `ctx.tools` |
| Permission ALLOW/ASK/DENY | DSH | permission preset + tool pipeline |
| Session event log (append-only) | DSH | `agent.session` / `dsh-session` |
| Resume / crash recovery | DSH | session persistence |
| Context compaction | DSH | compaction plugins |
| Shell execution + timeout + output limits | DSH | `dsh-shell` provider |
| Sandbox and approval | DSH | host sandbox + approval answerer |
| Cancellation | DSH | `exec.signal` (AbortSignal) |
| Two Agent Presets | This project | `preset/*/agent.cordis.yml` |
| Preset installer | This project | `scripts/install-presets.mjs` |
| ReproFix repair protocol | This project | `src/repair.ts` |
| Write gate (reproduce-before-edit) | This project | `src/guard.ts` via `ctx.tools.guard` |
| Repair workflow / lifecycle | This project | `src/workflow.ts` via `workflowEngine` |
| Durable receipts | This project | `agent.session.append('reprofix/receipt', …)` |
| Public CLI | This project | `bin: dshagent` (Phase 1) |

Rule: if DSH already provides a capability, this project composes it and does
not reimplement it. Only project-specific invariants are implemented here.

## 4. Repository and Identity Unification

The project currently has three inconsistent identifiers. Phase 1 unifies them.

| Surface | Current | Target |
| --- | --- | --- |
| GitHub repository | `dsh-coding-agent` | `dsh-coding-agent` (keep) |
| npm package `name` | `dsh-reprofix` | see ID rule below |
| CLI binary | `dsh-reprofix-client` | `dshagent` |
| README links | `still0123/dshagent` (7 stale) | `still0123/dsh-coding-agent` |
| Preset dir (coding) | `.agent-presets/dshagent` | `.agent-presets/dshagent` (keep) |
| Preset dir (repair) | `.agent-presets/reprofix` | `.agent-presets/reprofix` (keep) |

ID rule (ID-000..ID-004):

| ID | Requirement |
| --- | --- |
| ID-000 | Product name is "DSH Coding Agent"; modes are `coding` and `reprofix`. |
| ID-001 | If `dsh-reprofix` is unpublished, rename npm package to `dsh-coding-agent`. |
| ID-002 | If `dsh-reprofix` is published and used, keep the package name and document that it is the ReproFix plugin inside the product; do not rename hastily. |
| ID-003 | Expose the primary CLI binary as `dshagent`; keep `dshagent-presets` for the installer. |
| ID-004 | Replace every `still0123/dshagent` link in README with `still0123/dsh-coding-agent`. |

Repository handling:

- `still0123/dsh-coding-agent` is the only development repository.
- `still0123/dshagent` gets a README migration notice at the top, then Archive.
- Preserve full Git history; do not recreate the repository or copy code.
- Do not maintain ReproFix and the coding agent as two separate projects.

Git lineage is linear: `2826fc9` (old head) is a direct ancestor of `4d455b9`
→ `5b9166c` (new head). This is one project's evolution, not a fork.

## 5. Users and Primary Workflows

### 5.1 General coding workflow

1. The user runs `dshagent run "<task>"` or the official DSH Web UI with the
   `coding` Preset.
2. The Agent inspects files and repository instructions.
3. Read operations run without mutation.
4. Write and Shell operations follow the active DSH permission preset
   (`workspace-write + ask` by default).
5. Tool results and messages are persisted by DSH Session storage.
6. Context compaction replaces only the model-visible projection and preserves
   the durable log.
7. The user can resume the Session after process restart.

### 5.2 Strict repair workflow

1. The user runs `dshagent repair --spec repair.json` (or selects the
   `reprofix` Preset).
2. The user supplies a task, a reproduction command, a failure signature, and
   optional acceptance commands.
3. ReproFix acquires the canonical workspace lock (see §8).
4. ReproFix checks a clean Git baseline and records HEAD.
5. The exact command set is shown for approval.
6. The reproduction command runs; it must match the declared failure signature.
7. Only on an exact match is the single writer unlocked.
8. After the final patch revision, the wrapper re-runs reproduction and
   acceptance commands.
9. A Receipt is written on every terminal path.

## 6. Goals and Non-Goals

### 6.1 Goals

- Provide a usable coding-agent distribution without forking DSH core.
- Keep ReproFix as a self-implemented, auditable repair contract.
- Unify product identity across repo, package, CLI, and docs.
- Promote the existing headless launcher into a stable public CLI.
- Make the ownership boundary explicit and defensible.
- Support macOS, Windows, and Linux.

### 6.2 V0.1 Non-Goals (deferred, not rejected)

- A custom TUI (Phase 2).
- Git checkpoint/rewind (Phase 2).
- Lazy MCP discovery (Phase 3).
- Multi-Agent teams, long-term vector memory, browser automation.
- Automatic PR/commit/push/deploy/release.
- Reimplementing any DSH-owned capability from §3.

### 6.3 Product-wide Non-Goals

- Claiming a from-scratch agent runtime.
- Claiming a hash proves semantic correctness.
- Claiming a passing patch is globally minimal.
- Treating model prose as verification evidence.
- Supporting arbitrary DSH pre-release versions without a compatibility check.

## 7. Public CLI Specification (Phase 1 core)

The headless launcher already exists inside `client/server.mjs`: it spawns a
DSH child with `--profile headless --patch`, uses `shell: false`, forwards
stdout, and requests graceful-then-force termination. Phase 1 promotes this
into a documented text-mode CLI; it does not build new execution machinery.

The verified `0.1.0-rc.6` headless surface is limited: it accepts one task,
creates a fresh random Session per run, prints only the final assistant text to
stdout, has no `--resume`, and does not emit tool or Session events. Therefore
a stable event stream and Session resume are **not** achievable by "promoting
the launcher" alone; they require the bridge/SessionController work in V0.2.
V0.1 ships a text-mode CLI only.

Commands (V0.1b):

```text
dshagent run "<task>" [--cwd <path>] [--timeout <ms>]
dshagent repair --spec <repair.json> [--cwd <path>] [--timeout <ms>] [--yes]
dshagent presets install [--home <path>] [--force]
```

| ID | Requirement |
| --- | --- |
| CLI-001 | `dshagent run` starts a `coding` Preset headless Session for one task. |
| CLI-002 | `dshagent repair` starts a `reprofix` Session from a validated spec file. |
| CLI-003 | The CLI reuses the existing spawn, cancel, and output-forwarding logic. |
| CLI-004 | Child processes run with `shell: false` and argv arrays. |
| CLI-005 | `--cwd` sets the workspace root; default is the current directory. |
| CLI-006 | `--timeout` bounds the run; expiry requests graceful termination, then force termination. |
| CLI-007 | SIGINT/SIGTERM to the CLI shuts the child down; the DSH Session persists as usual. |
| CLI-008 | Missing DSH or an unavailable profile fails closed with a clear message. |
| CLI-009 | The CLI is covered by launch, cancel, and termination tests. |

Termination wording is intentional: on POSIX this is SIGTERM then SIGKILL; on
Windows it is a graceful stop request followed by a forced kill. The spec does
not promise literal POSIX signals on Windows.

The stable JSONL event stream, Session id echo, and `--resume` are deferred to
V0.2 (§16). The correctness requirement satisfied in V0.1 is lossless event
persistence, which DSH Session already provides; a machine-readable projection
of those events is a V0.2 transport concern.

### 7.1 repair.json command authorization

The current launcher places the repair JSON into the model prompt and asks the
model to call `repair_failure`. That lets the model rewrite the reproduction
command, acceptance commands, or failure signature, which contradicts SEC-011
through SEC-014. V0.1 replaces prompt-level trust with a CLI-boundary contract.

| ID | Requirement |
| --- | --- |
| CLI-010 | The CLI parses and validates `repair.json` before any model turn. |
| CLI-011 | Reproduction, acceptance, and failure signature are confirmed at the CLI boundary; `--yes` confirms non-interactively. |
| CLI-012 | The CLI computes a canonical input fingerprint over the confirmed command set and workspace root. |
| CLI-013 | The confirmed command set is passed to ReproFix through a trusted launch context, not through model-editable prompt text. |
| CLI-014 | The model may only author the patch; it cannot change the reproduction, acceptance, or failure signature. |
| CLI-015 | With no TTY and no `--yes`, the run fails closed. |

## 8. ReproFix Security Model (P1, first-class)

README and this spec assert cross-process locking and HEAD invariants.
Therefore these guarantees must be real. A false security promise is worse than
no promise. These items are Phase 1, not deferred.

### 8.1 Canonical workspace lock

The current Session-keyed registry must be replaced with a workspace-keyed
lease. The in-memory registry (`InMemoryActiveRunRegistry`) may cache state but
cannot be the authority.

| ID | Requirement |
| --- | --- |
| SEC-001 | Resolve the canonical Git root before acquiring the writer lease. |
| SEC-002 | Canonicalize the root with `realpath`. |
| SEC-003 | Hash the canonical root to derive a lock id. |
| SEC-004 | Reject a second live run targeting the same root, regardless of Session. |
| SEC-005 | Enforce the lock across processes that share the same `DSH_HOME`. |
| SEC-006 | Store pid, an owner nonce, run id, Session id, root, and acquisition time in the lock. |
| SEC-007 | Release the lock in `finally`. |
| SEC-008 | A stale lock is recoverable only when the owner is confirmed absent by pid plus owner nonce; when uncertain, fail closed. |
| SEC-009 | Acquisition and recovery are covered by concurrent-process tests. |

Recommended lock location:

```text
$DSH_HOME/dsh-coding-agent/locks/<sha256(real-git-root)>.lock
```

Acquisition must be owned by an atomic `mkdir` or exclusive file creation.

Scope limit: this lock only guarantees mutual exclusion across processes that
share the same `DSH_HOME`. Runs under different `DSH_HOME` values, different
users, or network filesystems are out of scope for V0.1 and must be documented
as such. A pid alone is not a safe liveness signal because pids are reused;
recovery therefore requires the owner nonce and process start identity, and
fails closed when liveness cannot be established.

### 8.2 Reproduction side-effect containment

Today the reproduction command runs in place, and only afterward is the
workspace checked (`blocked_repro_side_effect`). Detection-after-damage is not
containment.

| ID | Requirement |
| --- | --- |
| SEC-010 | Record baseline HEAD and clean status before reproduction. |
| SEC-011 | Reproduction and acceptance command text is confirmed at the CLI boundary before execution (see §7.1). |
| SEC-012 | Commands originate from the validated `repair.json`, not from model output; a missing confirmation path fails closed. |
| SEC-013 | The canonical input fingerprint binds the confirmed command list and workspace root. |
| SEC-014 | Any change to the command set invalidates the fingerprint and requires re-confirmation. |
| SEC-015 | Verify HEAD is unchanged after reproduction, writer, and validation. |
| SEC-016 | Detect reproduction worktree changes before the writer starts. |

V0.1 may run trusted commands in place after confirmation, and must state that
ignored files, repository-external files, network actions, and remote side
effects are not recoverable. Fully isolated reproduction (detached worktree or
container) is Phase 2.

### 8.3 Writer confinement (replaces prompt-only Git restrictions)

Parsing shell text to forbid `commit`/`push`/`reset` cannot be a security
guarantee: a writer with a shell can bypass it with aliases, wrapper scripts,
or `node -e`. The current build exposes bash/pwsh to the writer once the run is
in a writable state ([guard.ts:64](file:///Users/bytedance/vqa_thesis_continue/dshagent/src/guard.ts))
and even invites "supporting checks"
([workflow.ts:34](file:///Users/bytedance/vqa_thesis_continue/dshagent/src/workflow.ts)).
V0.1 makes confinement mechanical.

| ID | Requirement |
| --- | --- |
| SEC-017 | The writer is granted only read, search, edit, and write tools. |
| SEC-018 | The writer is not granted bash, pwsh, or any arbitrary command tool. |
| SEC-019 | All reproduction and acceptance commands are executed only by the wrapper, never by the writer. |
| SEC-020 | The writer prompt must not invite the writer to run commands or supporting checks. |
| SEC-021 | Confinement is enforced by the guard allowlist, not by prompt wording. |

Because the writer cannot execute commands, `commit`, `push`, `reset`,
`checkout`, `clean`, and branch or worktree creation are unreachable writer
actions by construction, rather than by shell-text parsing.

## 9. ReproFix Result and Receipt

Terminal statuses. The first eight already exist in `src/domain.ts`;
`infrastructure_error` is added in V0.1c for controlled failures that occur
before or around the repair transaction (missing Git, lock directory not
writable, Session persistence failure):

```text
fixed | not_reproduced | blocked_dirty_workspace | blocked_repro_side_effect
blocked_active_run | repair_failed | validation_failed | cancelled
infrastructure_error
```

Durable event type: `reprofix/receipt`, schema `reprofix.receipt/v1`.

| ID | Requirement |
| --- | --- |
| RCP-001 | Store baseline root, HEAD, and clean status. |
| RCP-002 | Store command text, exit classification, timing, bounded digest, and tail. |
| RCP-003 | Exclude raw complete stdout/stderr from persisted receipts. |
| RCP-004 | Store diagnosis evidence paths and optional lines. |
| RCP-005 | Store patch file list, line counts, binary/manifest lists, score, and fingerprint. |
| RCP-006 | Store validation checks and workflow outcomes. |
| RCP-007 | Store residual risks. |
| RCP-008 | Every controlled terminal result attempts to write one Receipt, including blocked, cancelled, and `infrastructure_error`. |
| RCP-009 | If Session persistence itself fails, emit a clear error to stderr; do not claim a Receipt exists. |
| RCP-010 | Never call an unkeyed hash a signature or trusted timestamp. |

Receipt durability is bounded. The spec does not promise a Receipt after an
uncontrolled termination such as `SIGKILL`, a crash, or power loss, because no
in-process code runs in those cases.

## 10. Preset Installer (already implemented)

Command: `dshagent presets install [--home <path>] [--force]`.

| ID | Requirement |
| --- | --- |
| INS-001 | Default home is `DSH_HOME`, falling back to `~/.dsh`. |
| INS-002 | Install `coding` as `.agent-presets/dshagent`. |
| INS-003 | Install `reprofix` as `.agent-presets/reprofix`. |
| INS-004 | Repeating installation with identical files reports `unchanged`. |
| INS-005 | Different managed files fail without `--force`. |
| INS-006 | `--force` replaces only `agent.cordis.yml` and `preset.yml`. |
| INS-007 | `--force` preserves additional Skills and assets in the directory. |
| INS-008 | Initial directory installation uses a temporary sibling and rename. |
| INS-009 | The CLI works through package-manager symlinks. |
| INS-010 | The packed artifact executes the installer in a clean consumer. |

## 11. Coding Preset Composition

The `coding` Preset composes DSH plugins only; it introduces no ReproFix Guard.

| ID | Requirement |
| --- | --- |
| COD-001 | Compose persona, agent-instructions, fs, fs-search, shell (bash/pwsh), skill, ask-user, and todo. |
| COD-002 | Compose the context compaction group (basic compaction, command-compact, tool-result pruner) in an isolated realm. |
| COD-003 | Default to DSH `workspace-write + ask`. |
| COD-004 | Do not expose `repair_failure` or the ReproFix write gate. |
| COD-005 | A Preset loader smoke test asserts both Presets load. |

### 11.1 Surface capability differences

The three surfaces do not expose the same interaction capabilities. This must
be documented rather than assumed uniform.

| Capability | Web UI | Headless CLI (V0.1) | TUI (V0.2) |
| --- | --- | --- | --- |
| ask-user prompts | yes | not interactive; fails closed if a turn requires it | yes |
| Approval answerer | yes | CLI-boundary confirmation only (§7.1) | yes |
| Session resume | yes | no (V0.2) | yes |
| Event stream projection | rendered | final text only (V0.1) | rendered (V0.2) |

A run that requires an interactive capability the current surface lacks must
fail closed with a clear message, not silently proceed.

## 12. Demonstrations (interview artifacts)

| ID | Requirement |
| --- | --- |
| DEM-001 | Demo A: reproduction does not match → writing refused, Receipt shows `not_reproduced`. |
| DEM-002 | Demo B: reproduction matches → patch applied → validation passes → `fixed`. |
| DEM-003 | Demo C: patch applied → acceptance fails → `validation_failed` with report. |
| DEM-004 | Each demo runs against `fixtures/buggy-project` with one command. |

## 13. Architecture Note (interview artifact)

A short document must explain, in order:

1. How a user task enters DSH.
2. How the selected Preset determines available tools.
3. How tool calls are constrained (schema, permission, guard).
4. How the Session is cancelled and persisted (resume and streaming are V0.2).
5. How ReproFix forms the reproduce → edit → validate state machine.

This note references §3 (ownership boundary) as its backbone.

## 14. Test Matrix

Current baseline: 73 unit, 14 integration, 2 preset smoke (89 total), plus
typecheck, build, and pack check.

| Layer | Scope |
| --- | --- |
| Unit | domain, guard, runner, workflow, receipt, install-presets, client scope |
| Integration | repair-failure end to end, golden fixture |
| Preset smoke | both Presets load under a real temporary profile |
| Security | concurrent-process lock acquisition and recovery (new, §8.1); writer confinement denies shell tools (new, §8.3) |
| CLI | run/repair launch, cancel, termination, repair.json validation and confirmation (new, §7) |
| Pack | packed artifact installs both Presets in a clean consumer |
| Platforms | Linux, macOS, Windows required CI jobs |

## 15. Release

| ID | Requirement |
| --- | --- |
| REL-001 | Pin DSH `0.1.0-rc.6` until a compatibility suite admits a new version. |
| REL-002 | README contains no command that depends on an unpublished artifact. |
| REL-003 | Publish an npm package or a GitHub Release with a SHA-256 checksum. |
| REL-004 | Verify installation of the exact released artifact on a clean machine. |
| REL-005 | Keep ReproFix attribution and NOTICE. |

## 16. Implementation Phases

V0.1 is split into three independently verifiable stages so each can be
reviewed and demonstrated on its own.

### V0.1a — Identity and story

1. Unify identity (ID-000..ID-004): package renamed to `dsh-coding-agent`,
   `dshagent-*` binaries, fix all stale README links. (Done.)
2. Add three demos against `fixtures/buggy-project` (DEM-001..004).
3. Write the ownership boundary and architecture note (§3, §13).
4. Archive `still0123/dshagent` with a migration notice.

### V0.1b — Text-mode CLI

1. Promote the headless launcher into `dshagent run` / `dshagent repair`
   (CLI-001..009), text mode only.
2. Implement the repair.json authorization chain (CLI-010..015, §7.1).
3. No JSONL, no resume, no event protocol in this stage.

### V0.1c — Security invariants

1. Canonical workspace lock (SEC-001..009).
2. Reproduction side-effect containment and HEAD invariants (SEC-010..016).
3. Writer confinement: remove writer shell access (SEC-017..021).
4. Add `infrastructure_error` and Receipt-attempt semantics (RCP-008..009).
5. Release with checksum; verify clean-machine install (REL-001..005).

### Phase 2 — V0.2

1. Borrow, do not fork, from `catyans/cathead-coding`: child-process isolation,
   versioned NDJSON bridge, SessionController, event reducer, and
   queue/steer/cancel/approval state design.
2. Add the stable JSONL event stream, Session id echo, and `--resume`.
3. Implement a minimal TUI on the existing main.
4. Implement isolated reproduction (detached worktree or container).
5. Implement Git checkpoint/rewind.

Do not copy the theme system, complex panels, model menus, or the full TUI.

### Phase 3 — V0.3

1. Lazy MCP discovery via a `search/describe/call` proxy.
2. Stable headless JSONL automation contract hardening.

## 17. V0.1 Definition of Done

V0.1 is complete only when all conditions hold.

V0.1a:

- Product identity is unified per ID-000..ID-004; no stale `dshagent` links.
- The three demos pass against `fixtures/buggy-project`.
- The ownership boundary and architecture note exist.
- `still0123/dshagent` is archived with a migration notice.

V0.1b:

- `dshagent run` and `dshagent repair` work headless with `--cwd/--timeout`
  in text mode; no `--jsonl` and no resume are claimed.
- `repair.json` is validated and confirmed at the CLI boundary; the model
  cannot alter reproduction, acceptance, or the failure signature.
- With no TTY and no `--yes`, a repair run fails closed.

V0.1c:

- ReproFix locks by canonical workspace across processes that share `DSH_HOME`.
- ReproFix records clean state and verifies unchanged HEAD.
- The writer has no shell; reproduction and acceptance run only in the wrapper.
- ReproFix cannot return `fixed` from truncated or incomplete evidence.
- Every controlled terminal result attempts one Receipt, including
  `infrastructure_error`; Session-write failure surfaces on stderr.
- The package pins DSH `0.1.0-rc.6`.
- Both Presets install from the packed artifact and appear in official DSH Web.
- Coding can read, edit, search, run commands, use Skills, use Todo, ask
  questions, and compact; it does not expose the ReproFix Guard.
- Linux, macOS, and Windows required CI jobs pass.
- A clean machine can install the documented exact release.

## 18. V0.2 / V0.3 Definition of Done

V0.2:

- A minimal TUI starts and resumes DSH Sessions and renders tools, approvals,
  questions, Todo, and context pressure.
- Isolated reproduction runs in a detached worktree or container.
- Rewind restores files and forks compatible context.
- macOS, Windows, and Linux TUI tests pass.

V0.3:

- MCP servers are discovered lazily and do not bloat every request.
- Headless JSONL remains stable and fails closed on missing approval.
