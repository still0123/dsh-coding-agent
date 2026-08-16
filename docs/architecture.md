# Architecture

DSH Coding Agent is a distribution over DeepSeek Harness, not a replacement
runtime. DSH owns the Agent Loop, model route, tool runtime, permissions,
Sandbox, Session log, persistence, Shell provider, and workflow engine. This
repository owns two Presets, the public launcher, and the ReproFix transaction.

## Request path

```text
dshagent run/repair
  -> validate cwd and CLI arguments
  -> repair only: validate + confirm repair.json, bind fingerprint to Git root
  -> write owner-only launch context and Cordis overlay
  -> spawn dsh --profile headless --patch ... with shell: false
  -> DSH mounts dshagent or reprofix through agentPresets.mount()
  -> cli-runner creates one DSH Agent and Session
  -> run: deliver one user turn
     repair: call repair_failure directly with confirmed input
  -> DSH flushes the Session and exits
```

The repair command set is never reconstructed from model output. The model can
author only the patch through the writer tools.

## Preset boundary

The `dshagent` Preset composes DSH filesystem, search, platform shell, Skills,
Todo, ask-user, and compaction plugins. It does not mount ReproFix.

The `reprofix` Preset composes filesystem/search tools, one isolated workflow
engine, and the project plugin. The plugin adds `repair_failure` and a scoped
Guard. Before RED, only read/search and `repair_failure` are allowed. During the
writer phase, capability tools are limited to read/search/edit/write; DSH's
`structured_output` control channel is also allowed so the writer can return its
schema result. Bash, PowerShell, and unknown command tools remain denied.

DSH performs tool schema validation and its ordinary permission/Sandbox checks.
The ReproFix Guard is an additional monotonic restriction, not a replacement for
DSH permissions.

## ReproFix state machine

```text
created
  -> acquire canonical-root process lock
  -> verify clean baseline and HEAD
  -> reproducing
     -> mismatch: not_reproduced
     -> worktree/HEAD change: blocked_repro_side_effect
  -> reproduced
  -> repairing (one writer)
     -> no patch: repair_failed
     -> HEAD change: validation_failed
  -> validating
     -> rerun reproduction and every acceptance command
     -> compare final patch fingerprint and HEAD
     -> fixed | validation_failed
```

Every controlled terminal path attempts a `reprofix/receipt` Session event.
Missing Git, lock failures, and similar controlled local failures become
`infrastructure_error`. Session write failures are reported to stderr. Crashes,
power loss, and forced process termination cannot guarantee a final Receipt.

## Lock and evidence

Git root discovery uses `git rev-parse --show-toplevel` followed by `realpath`.
The SHA-256 of that canonical path names an atomic directory lock under:

```text
$DSH_HOME/dsh-coding-agent/locks/<root-hash>.lock
```

Owner metadata includes PID, process start identity, nonce, run ID, Session ID,
root, and acquisition time. A live or uncertain owner fails closed. The
guarantee covers only processes sharing one `DSH_HOME`.

Receipts retain bounded command evidence, baseline HEAD, patch metadata,
validation outcomes, workflow outcomes, and residual risks. A fingerprint is
an integrity identifier, not a signature or proof of semantic correctness.

## Lifecycle limits

V0.1 is one-shot text mode. SIGINT, SIGTERM, or `--timeout` requests graceful
DSH shutdown and then forced termination after a bounded wait. DSH owns Session
persistence. Stable event streaming, printed Session IDs, resume, interactive
approval handling, and isolated worktrees are V0.2 work.
