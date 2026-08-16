# DSH API discovery

## Fixed inputs

- Specification baseline: `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`.
- The checkout at that commit reports the workspace package version `0.1.0-rc.5`.
- Scaffold baseline: `omdsh-dev/dsh-inspect@9876349054f0fec33114f7f594b4901b7e9420f1`.
- Release dependencies used by this standalone package: `@deepseek-ai/dsh-*@0.1.0-rc.6`, `@deepseek-ai/cordis@4.0.1`, and `@deepseek-ai/schemastery@3.18.1`.
- Validation toolchain: Node `^22.19.0 || >=24.0.0`, pnpm `11.7.0`, TypeScript `6.0.3`.

The fixed DSH source commit is the behavioral reference, but its `0.1.0-rc.5`
packages are not published on npm. The independently installable package therefore
uses the next published release candidate, exact `0.1.0-rc.6` dependencies rather
than an untested range.

## Confirmed API surface

Source and installed declaration inspection confirmed these seams:

- Plugin context is imported from `@deepseek-ai/cordis`; ReproFix injects `tools`
  and `workflowEngine`.
- Tools are registered with `ctx.tools.register(defineTool(...))` from
  `@deepseek-ai/dsh-tools`.
- The current schema DSL marks required object properties with property-level
  `required: true`; `defineTool` requires a canonical output schema and renderer.
- `ctx.tools.guard()` is the monotonic authorization boundary. It runs after the
  extensible `tools/pre-execute` stage and returns the first denial string.
- Session evidence is appended with `agent.session.append(name, losslessJson)`;
  ReproFix declares `reprofix/run-state` and `reprofix/receipt` by declaration
  merging `@deepseek-ai/dsh-session/types`.
- Workflow execution uses `ctx.workflowEngine.start({ script, meta, args, parent,
  signal, maxTotalAgents: 1 })`; `run.result` is inspected and every created run
  is disposed in `finally`.
- The fixed script receives task data through `args`; user text is never
  interpolated into workflow JavaScript.
- The production command adapter uses the DSH shell service directly. Repro and
  acceptance commands do not call the model-facing `bash`/`pwsh` tools.

## rc.5 to rc.6 release delta

The installed rc.6 declarations preserve the source-baseline contracts used by
ReproFix: `defineTool`, property-level required schema nodes, canonical output
rendering, `ctx.tools.guard`, scoped tool execution, workflow start/result/dispose,
and Session append. The relevant packaging delta is that rc.6 is npm-available
and its peer manifests resolve to published `^0.1.0-rc.6` packages and Cordis
`^4.0.1`; the fixed checkout uses workspace ranges and labels itself rc.5.

No compatibility shim for the obsolete scaffold APIs was retained. In particular,
ReproFix does not import unscoped `cordis`, does not use `ctx.workflows`, and does
not publish a source or `lib/types/index.js` entry.

## Preset and tool classification

`preset/reprofix/agent.cordis.yml` is a minimal native Tool-mode derivation of the
fixed standard preset. It mounts:

- standard filesystem tools: `read`, `write`, `edit`;
- standard search tools: `glob`, `grep`;
- the platform shell tool: `bash` or `pwsh`;
- one isolated `workflowEngine` realm with `@deepseek-ai/dsh-workflow-worker-thread`;
- the `dsh-coding-agent` plugin in that same realm.

The locked-state allowlist is `read`, `glob`, `grep`, and `repair_failure`.
`write`, `edit`, `bash`, and `pwsh` are denied before the exact RED gate; unknown
tools are denied. After RED, the writer allowlist is `read`, `glob`, `grep`,
`write`, `edit`, and DSH's schema-result control channel `structured_output`;
shell and unknown capability tools remain denied. Terminal states relock the
gate. The package bundle overlay is empty deliberately: installing the package
must not install a process-global guard. The preset must be registered under a
configured Agent Preset root.

The V0.1 CLI disables the headless profile's process-global agent-plane rows,
mounts the selected project Preset through `@deepseek-ai/dsh-agent-presets`, and
uses `src/cli-runner.ts` as the one-shot driver. `repair.json` is normalized and
confirmed before launch, persisted in a mode-`0600` temporary context, and
fingerprinted with the canonical Git root. The runner verifies that fingerprint
and calls `repair_failure` directly; reproduction and acceptance commands never
pass through model text.

## Code Mode decision

Code Mode is **unsupported** in this release. Although rc.6 routes `run_code`
sub-dispatches through the same tool runtime, this package does not publish a Code
Mode preset because a real mounted-preset smoke proving nested write/shell denial
has not been included. The native standard Tool path is the only supported mode;
`run_code` is not mounted by the ReproFix preset.

## Executable evidence

The repository verification commands are:

```text
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
pnpm test:preset-smoke
pnpm pack:check
```

`test:preset-smoke` owns real DSH preset mounting and native guard checks.
`test/cli.test.ts` covers trusted launch context, non-TTY confirmation, argv
isolation, timeout, and signal termination. `test/workspace-lock.test.ts`
includes a real second-process lock owner and stale recovery.
`pack:check` packs the package, installs that tarball into a fresh temporary
project, and imports the public package export. A passing source import alone is
not release evidence.
