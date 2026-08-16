# Architecture Decision Records

These ADRs record decisions already implemented in DSH Coding Agent.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-compose-dsh-instead-of-reimplementing-runtime.md) | Compose DSH instead of reimplementing the Agent runtime | Accepted |
| [0002](0002-authorize-repair-commands-at-cli-boundary.md) | Authorize repair commands at the CLI boundary | Accepted |
| [0003](0003-reproduce-first-shell-free-single-writer.md) | Use a reproduce-first gate and a shell-free single writer | Accepted |
| [0004](0004-bind-validation-to-canonical-workspace-and-patch.md) | Bind validation to a canonical workspace and final patch | Accepted |
| [0005](0005-persist-bounded-fail-closed-receipts.md) | Persist bounded, fail-closed repair Receipts | Accepted |

## Format

Each record contains:

- the engineering context and threat being addressed;
- the chosen mechanism;
- rejected alternatives;
- positive and negative consequences;
- implementation and verification evidence.

ADRs explain why the system has its current shape. The normative product
contract remains [SPEC.md](../../SPEC.md).
