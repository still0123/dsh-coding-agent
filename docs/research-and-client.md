# Research notes and local client choice

## Comparable projects

- [SWE-agent](https://github.com/SWE-agent/SWE-agent) (MIT): strong precedent for issue-to-repair task envelopes and replayable trajectories. ReproFix keeps only the reproduce/test evidence idea; it does not add remote issue intake, PR automation, or container orchestration.
- [OpenHands](https://github.com/All-Hands-AI/OpenHands) (MIT core; enterprise directories have separate terms): demonstrates a browser UI over an agent runtime. ReproFix deliberately avoids copying its large server/sandbox stack and keeps DSH as the only repair runtime.
- [Aider](https://github.com/Aider-AI/aider) (Apache-2.0): useful precedent for Git-aware local editing and clear diff reporting. No Aider source is copied; ReproFix remains commit-free and wrapper-validated.
- [Continue](https://github.com/continuedev/continue) (Apache-2.0): supports shared CLI/editor workflows. ReproFix borrows only the product lesson that one local runtime can serve multiple frontends; it does not add an editor extension.

## Client decision

A Node standard-library loopback Web client is the smallest cross-platform client that preserves the plugin boundary:

- one code path for macOS, Windows, and Linux;
- no Electron runtime, native bundler, code signing, updater, or new UI framework;
- no Tauri/Rust toolchain or platform WebView variance;
- the browser UI starts a dedicated `dsh --profile headless` process, so DSH remains the runtime and ReproFix remains the repair transaction;
- the server binds only to `127.0.0.1`, uses a random per-process token, accepts one run at a time, limits request bodies, launches with `shell: false`, and terminates the child on shutdown.

The client is intentionally a launcher, not a queue, session store, credential manager, or replacement desktop runtime. Those features should be considered only after measured usage demonstrates a need.
