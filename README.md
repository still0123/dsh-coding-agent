# dsh-reprofix

Reproduce-first repair transactions for DeepSeek Harness (DSH).

`dsh-reprofix` adds one model-callable tool, `repair_failure`. The wrapper checks
a clean Git baseline, runs the declared reproduction command itself, requires an
exact exit-code and literal-output match, unlocks one serial writer only after
that RED evidence, and independently reruns the post-fix reproduction plus every
acceptance command. The complete result is appended as an auditable Session
receipt.

This project is derived from `omdsh-dev/dsh-inspect` at commit
`9876349054f0fec33114f7f594b4901b7e9420f1`. It retains the upstream MIT notice
but does not retain the CHECKUP, FIX, or REVIEW product behavior.

## Safety model

A run can return `fixed` only when all of these hold:

- the initial tracked and untracked Git worktree is clean;
- the wrapper's current reproduction process starts and exactly matches the
  declared failure exit rule and every case-sensitive literal;
- the reproduction command leaves the worktree unchanged;
- one writer at a time edits only after exact RED;
- the wrapper, not the writer's prose, reruns post-fix reproduction and all
  declared acceptance commands;
- the patch fingerprint is unchanged before and after final validation;
- the receipt is appended as the log-only `reprofix/receipt` Session event.

The plugin never commits, pushes, creates branches or worktrees, resets, checks
out, cleans, deploys, or deletes user changes. A failed repair remains in the
worktree for the user to inspect.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- a Git repository launched at, or resolvable to, its top-level directory
- DSH `0.1.0-rc.6` packages and `@deepseek-ai/cordis@4.0.1`

The fixed source baseline was DSH commit
`47f943859bef60e4160492346772ded9b24f765a` (`0.1.0-rc.5`). That release
candidate is not available from npm, so this standalone package uses exact
published rc.6 dependencies. See `docs/discovery.md` for the verified API delta.

## Install

Install the bundle into the profile you run:

```sh
dsh plugin --profile web add dsh-reprofix
```

The bundle overlay is intentionally empty: installing a package must not attach
a mutation guard to every Agent. Register the packaged preset in an Agent Preset
root instead. For the default user-authored root:

```sh
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
mkdir -p "$DSH_HOME/.agent-presets/reprofix"
cp "$PROFILE/node_modules/dsh-reprofix/preset/reprofix/agent.cordis.yml" \
  "$PROFILE/node_modules/dsh-reprofix/preset/reprofix/preset.yml" \
  "$DSH_HOME/.agent-presets/reprofix/"
```

Restart DSH after first installation, select the **ReproFix** Agent Preset, and
open the Git repository to repair as the workspace. A deployment with custom
preset roots should register `preset/reprofix` under one of those roots instead.
The profile installation keeps the bare `dsh-reprofix` plugin package resolvable
for the copied composition.

## Use

Ask the ReproFix agent to repair a failure and provide deterministic evidence:

```json
{
  "task": "Fix add() so the regression test passes without changing its API.",
  "failureLog": "Optional context only; this never unlocks writing.",
  "repro": {
    "command": "pnpm test -- add.test.ts",
    "timeoutMs": 120000,
    "failure": {
      "exitCodes": [1],
      "outputIncludes": ["expected 4, received 3"]
    },
    "success": {
      "exitCodes": [0]
    }
  },
  "acceptance": [
    { "name": "typecheck", "command": "pnpm typecheck" },
    { "name": "unit", "command": "pnpm test" }
  ],
  "maxRepairRounds": 2
}
```

Commands run at the canonical Git root. Do not put tokens or other secrets in a
command string: receipts retain commands for auditability. `failureLog` is
context, never reproduction evidence, and is persisted only as a digest.

## Result examples

The model receives structured JSON; the full canonical receipt remains in the
Session log. Representative summaries follow.

### Fixed

```json
{
  "ok": true,
  "status": "fixed",
  "summary": "Exact failure reproduced; wrapper-owned reproduction and 2 acceptance checks passed.",
  "attempts": 1,
  "residualRisks": []
}
```

### Not reproduced

The command failed, but its output did not contain every declared literal, so no
writer was started:

```json
{
  "ok": false,
  "status": "not_reproduced",
  "summary": "The current command result did not match the declared failure signature.",
  "attempts": 0,
  "residualRisks": ["No source changes were attempted."]
}
```

### Dirty workspace

Tracked or untracked user work exists at startup:

```json
{
  "ok": false,
  "status": "blocked_dirty_workspace",
  "summary": "ReproFix requires a clean tracked and untracked Git baseline.",
  "attempts": 0,
  "residualRisks": ["Existing workspace changes were preserved."]
}
```

### Validation failed

A patch exists, but post-fix reproduction, an acceptance command, or the final
fingerprint check failed:

```json
{
  "ok": false,
  "status": "validation_failed",
  "summary": "The final patch did not pass wrapper-owned validation.",
  "attempts": 2,
  "residualRisks": ["The writer patch remains in the worktree for inspection."]
}
```

## Receipt and patch score

`reprofix/run-state` records each transition. `reprofix/receipt` stores the
canonical `reprofix.receipt/v1` JSON with command digests and bounded output
tails. See `docs/receipt-schema.md`.

The reported score observes one final patch:

```text
added + deleted + 10 * changed files + 50 * manifest files + 100 * binary files
```

It does **not** compare multiple candidates and does not claim that a globally
minimal passing patch was selected.

## Compatibility

| DSH mode/version | Status | Notes |
| --- | --- | --- |
| Native Tool mode, `0.1.0-rc.6` | Supported | Exact standalone dependencies; ReproFix preset mounts standard coding tools and one workflow worker. |
| Fixed source commit `47f9438` / rc.5 | API reference | Verified source baseline, but rc.5 is not npm-published for independent installation. |
| Code Mode / `run_code` | Unsupported | No published Code preset until a real mounted DSH smoke proves nested write and shell dispatch are denied before exact RED. |
| Older `ctx.workflows` / unscoped `cordis` plugins | Unsupported | Obsolete scaffold APIs are intentionally not carried forward. |

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
pnpm test:preset-smoke
pnpm pack:check
```

`pack:check` runs `pnpm pack`, installs the generated tarball into a fresh
temporary project, and imports `dsh-reprofix` through its public export. The
preset smoke owns real DSH mounting and native guard behavior; unit mocks are not
a substitute for that check.

## Risks and limits

- DSH is a Developer Preview; a future tool roster or lifecycle change requires
  rerunning the preset and pack smoke tests and updating `docs/discovery.md`.
- Tool classification is fail-closed. New model-facing tools remain denied while
  locked until explicitly reviewed and tested.
- Commands use the platform shell service and may not be portable between POSIX
  shells and PowerShell; callers own command portability.
- Ignored files are outside the patch fingerprint. Repositories must correctly
  ignore generated caches and coverage output.
- A timed-out process must cooperate with the DSH shell adapter's process-tree
  termination. Host cancellation is reported as `cancelled`, never `fixed`.
- Code Mode is deliberately unsupported rather than inferred from unit behavior.

## License

MIT. See `LICENSE` and `NOTICE.md`.
