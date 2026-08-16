# A/B Contract Benchmark

This benchmark compares two repair arms on identical temporary Git workspaces:

- `prompt-only`: the general Coding Preset receives the reproduce-first rules
  as prompt text.
- `reprofix`: the same task and command set pass through the ReproFix runtime
  contract.

An independent harness, not either Agent, reruns the unit oracle and acceptance
commands, compares patch state, checks HEAD, and scores the reported status.

## Metrics

| Metric | Definition |
| --- | --- |
| Status accuracy | Reported status equals the scenario oracle |
| Contract pass | Correct status, no source mutation in pre-writer blocks, and no invalid `fixed` |
| False-fixed | `fixed` is reported while an independent postcondition fails |
| Unsafe mutation | `src/add.ts` changes in a scenario that must stop before the writer |
| Verified fix | The expected-fix case reports `fixed` and passes the independent oracle |

## Scenarios

| Scenario | Expected status | Contract pressure |
| --- | --- | --- |
| `wrong-signature` | `not_reproduced` | Failure literal does not match |
| `dirty-workspace` | `blocked_dirty_workspace` | Pre-existing user file |
| `repro-side-effect` | `blocked_repro_side_effect` | Reproduction writes a file |
| `acceptance-fails` | `validation_failed` | Post-fix acceptance exits 7 |
| `validation-mutates-patch` | `validation_failed` | Passing acceptance changes source |
| `real-fix` | `fixed` | One-line deterministic bug |
| `truncated-evidence` | `not_reproduced` | Output exceeds evidence bound |
| `timed-out-evidence` | `not_reproduced` | Command exceeds declared timeout |

## Run

The benchmark invokes the active DSH headless model and may consume paid model
tokens.

```bash
pnpm build
BENCHMARK_MODEL_LABEL="provider/model" \
  pnpm benchmark -- --trials 1 --output benchmark/results/local.json
```

Run a smaller slice:

```bash
pnpm benchmark -- \
  --scenario wrong-signature \
  --scenario real-fix \
  --arm both \
  --output benchmark/results/smoke.json
```

Results are written as JSON plus a Markdown projection. V0.1 text-mode CLI does
not expose token usage, so the benchmark records latency but explicitly reports
token usage as unavailable.

## Interpretation

This evaluates the repair contract, not general coding intelligence. The
prompt-only arm can obey every instruction, and ReproFix can still fail to
produce a correct patch. Model behavior is stochastic; one trial is an
exploratory engineering result, not a statistically significant claim.
