# dsh-reprofix

[![CI](https://github.com/still0123/dshagent/actions/workflows/ci.yml/badge.svg)](https://github.com/still0123/dshagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-4e51e8)](https://github.com/deepseek-ai/deepseek-harness)

**一个基于 DeepSeek Harness 的专用代码修复 Agent：只有在真实失败被精确复现后，
才允许修改代码。**

ReproFix 解决的是常见的 AI 修复问题：模型看到一段报错后直接改代码，最后声称
“已经修好”，但它可能没有复现原始问题，也没有运行完整验收。

ReproFix 把修复过程变成一个受控流程：

```text
检查 Git 工作区干净
        ↓
运行用户声明的复现命令
        ↓
退出码 + 失败文本精确匹配（RED）
        ↓
临时开放一个 writer Agent 修改代码
        ↓
插件重新运行复现命令和全部验收命令（GREEN）
        ↓
确认验证前后的补丁指纹没有变化
        ↓
写入可审计的 Session Receipt
```

ReproFix 是专用 Coding Agent，不是通用 Coding Agent，也不重复实现底层 Agent
Runtime。它由三部分组成：

```text
ReproFix Agent
├── Agent Preset：定义角色、工具和工作模式
├── ReproFix Plugin：实现 RED Gate、修复流程和 Receipt
└── DSH Runtime：提供 Agent Loop、Session、Shell、Sandbox 和 Workflow
```

用户实际运行的是 ReproFix Agent；Plugin 是该 Agent 在 DSH 中实现专用修复能力的
内部组件。

> [!IMPORTANT]
> 当前版本为 `0.1.0`，仅支持从源码运行，尚未发布到 npm 或 GitHub Releases。

## ReproFix Agent 如何工作

ReproFix 向 DSH 注册一个模型工具：

```text
repair_failure
```

调用该工具时，插件会：

1. 找到当前工作区的 Git 根目录。
2. 拒绝包含 tracked 或 untracked 改动的工作区。
3. 运行 `repro.command`。
4. 同时校验退出码和所有大小写敏感的 `outputIncludes` 文本。
5. 只有匹配成功才开放写文件和 Shell 工具。
6. 启动最多一个 writer Agent 诊断并修改代码。
7. 由插件重新运行复现命令和最多 10 条验收命令。
8. 比较验证前后的 Git 补丁指纹，防止测试过程继续改动补丁。
9. 把结果写入 `reprofix/receipt` Session 事件。

失败日志 `failureLog` 只作为诊断上下文，永远不能代替当前机器上的真实复现结果。

## 适合与不适合

适合：

- 已经有稳定复现命令的单元测试、集成测试或构建错误。
- 希望限制 Agent 在确认原始故障前修改代码。
- 需要保存退出码、输出摘要、补丁信息和验收结果。
- 希望失败修复保留在工作区，便于人工检查。

不适合：

- 没有可重复复现方式的模糊问题。
- 需要同时修改多个仓库的任务。
- 需要自动创建 PR、提交或推送代码的流程。
- 需要 Code Mode / `run_code` 的 Agent。
- 需要隔离容器或临时 Git worktree 的不可信任务。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- Git
- DSH `0.1.0-rc.6`
- 已配置可用模型的 DSH 环境

## 快速体验：本地客户端

这是目前最简单的运行方式。客户端会在本机启动一个只监听 `127.0.0.1` 的页面，
每次提交启动一个独立的 DSH headless 进程。

```bash
git clone https://github.com/still0123/dshagent.git
cd dshagent

npm install -g pnpm@11.7.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm build

# 使用环境变量或 DSH 凭据文件配置模型
export DEEPSEEK_API_KEY="your-key"

pnpm client
```

Windows PowerShell：

```powershell
git clone https://github.com/still0123/dshagent.git
cd dshagent

npm install -g pnpm@11.7.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm build

$env:DEEPSEEK_API_KEY = "your-key"
pnpm client
```

启动后浏览器会自动打开本地页面。页面需要两个输入：

- **Git workspace**：待修复仓库的绝对路径。
- **repair_failure JSON**：任务、复现规则和验收命令。

可选参数：

```bash
pnpm exec dsh-reprofix-client --no-open
pnpm exec dsh-reprofix-client --port 4317
```

## 安装到已有 DSH Web

先构建本项目，并把本地 checkout 安装到 `web` profile：

```bash
git clone https://github.com/still0123/dshagent.git
cd dshagent

npm install -g pnpm@11.7.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm build

npm install -g @deepseek-ai/dsh@0.1.0-rc.6
dsh plugin --profile web add .
```

然后注册项目自带的 Agent Preset：

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
TARGET="$DSH_HOME/.agent-presets/reprofix"

mkdir -p "$TARGET"
cp "$PROFILE/node_modules/dsh-reprofix/preset/reprofix/agent.cordis.yml" \
  "$PROFILE/node_modules/dsh-reprofix/preset/reprofix/preset.yml" \
  "$TARGET/"

dsh web
```

在新建会话时选择 **ReproFix**，并把待修复 Git 仓库设为工作区。

安装包的 `cordis.patch.yml` 故意保持为空。ReproFix Guard 只应挂载到 ReproFix
Preset，不能全局限制其他 DSH Agent。

## 输入示例

```json
{
  "task": "修复 add()，不要改变公开 API。",
  "failureLog": "可选的历史报错，只用于帮助诊断。",
  "repro": {
    "command": "pnpm test -- add.test.ts",
    "timeoutMs": 120000,
    "failure": {
      "exitCodes": [1],
      "outputIncludes": [
        "expected 4, received 3"
      ]
    },
    "success": {
      "exitCodes": [0]
    }
  },
  "acceptance": [
    {
      "name": "typecheck",
      "command": "pnpm typecheck"
    },
    {
      "name": "unit",
      "command": "pnpm test"
    }
  ],
  "maxRepairRounds": 2
}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `task` | writer Agent 收到的修复目标 |
| `failureLog` | 可选上下文，不参与 RED 判定，Receipt 只保留摘要 |
| `repro.command` | 插件实际执行的复现命令 |
| `repro.failure.exitCodes` | 被视为原始故障的退出码；省略时要求非零 |
| `repro.failure.outputIncludes` | 必须全部出现的大小写敏感文本，至少一条 |
| `repro.success` | 修复后复现命令的 GREEN 判定，默认退出码为 `0` |
| `acceptance` | 修复后额外执行的验收命令，最多 10 条 |
| `maxRepairRounds` | writer 最大轮数，范围 `1-3`，默认 `1` |

## 返回状态

| 状态 | 含义 |
| --- | --- |
| `fixed` | 已精确复现，补丁通过复现与全部验收，验证期间补丁未变化 |
| `not_reproduced` | 当前命令结果没有匹配声明的失败特征，没有启动 writer |
| `blocked_dirty_workspace` | 启动时工作区不干净，没有运行复现命令 |
| `blocked_repro_side_effect` | 复现后工作区发生变化，没有启动 writer |
| `blocked_active_run` | 当前 Session 已经有一个 ReproFix 任务 |
| `repair_failed` | writer 没有产出可验证补丁或 Workflow 失败 |
| `validation_failed` | 已有补丁，但复现、验收或补丁指纹检查失败 |
| `cancelled` | 外部取消或命令执行被中止 |

只有 `fixed` 会返回 `ok: true`。

## 机械保证

以下行为由代码执行，不依赖 writer 的自然语言声明：

- dirty 工作区不会启动复现或 writer。
- 截断、超时、取消、Sandbox 拒绝或未启动的命令不能成为 RED/GREEN。
- RED 必须同时满足退出码规则和全部文本规则。
- RED 之前，`write`、`edit`、`bash`、`pwsh` 及未知工具均被 Guard 拒绝。
- GREEN 由插件重新运行，不采信 writer 声称“测试已通过”。
- tracked diff 与 untracked 文件共同进入版本化补丁指纹。
- 最终验证改变补丁时，任务不能返回 `fixed`。
- 每个终态都会写入 `reprofix/receipt`，包括失败和取消。

命令输出每个流最多保留 256 KiB。任何截断都会导致匹配失败，而不是用不完整输出
推断成功。

## 当前安全边界

ReproFix 限制了 writer 的启动时机，但它不是完整的命令隔离系统：

- `repro.command` 和 `acceptance.command` 是调用方提供的真实 Shell 命令，只能使用
  你信任的命令。
- 复现命令先执行，插件随后检查工作区是否变化。如果该命令修改或删除文件，插件会
  返回 `blocked_repro_side_effect`，但当前版本不会自动恢复这些改动。
- 活跃任务锁目前按 Session 生效，不是按 Git 工作区全局生效。不要让多个 Session
  同时修复同一个仓库。
- writer 被明确提示不要执行 commit、push、reset、checkout 或 clean，但当前版本尚未
  对所有此类 Shell 命令做机械拦截。
- Git ignored 文件、仓库外文件、网络请求和远端副作用不在补丁指纹内。
- Receipt 保存命令文本。不要把 Token、密码或其他秘密直接写入命令。

建议先在临时分支、临时 worktree 或可丢弃仓库中使用，并在运行后检查 `git diff`
和 `git status`。

## Receipt 与补丁信息

`reprofix/receipt` 使用 `reprofix.receipt/v1`，记录：

- Git 根目录、初始 HEAD 和 clean 状态；
- 复现命令的退出码、耗时、输出摘要和尾部；
- writer 的诊断与代码位置；
- changed files、增删行、manifest/binary 文件和补丁指纹；
- 每条最终验证命令；
- Workflow 轮次、终止原因和剩余风险。

补丁分数为：

```text
added + deleted + 10 × changed files + 50 × manifest files + 100 × binary files
```

它只描述当前补丁的修改规模，不证明该补丁是所有方案中的全局最小值。

完整字段见 [Receipt Schema](docs/receipt-schema.md)。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 注册 `repair_failure` 工具及输入/输出 Schema |
| `src/repair.ts` | RED、writer、GREEN 和终态编排 |
| `src/guard.ts` | 在 RED 前锁定写入与 Shell 工具 |
| `src/runner.ts` | DSH Shell 调用、Git clean 检查和补丁指纹 |
| `src/workflow.ts` | 单 writer Workflow 与结构化诊断结果 |
| `src/receipt.ts` | Receipt 指纹与 Markdown 展示 |
| `client/server.mjs` | 仅本机访问的跨平台启动页面 |
| `preset/reprofix` | ReproFix Agent Preset |
| `test` | 单元、集成、Preset、客户端和真实 Git fixture 测试 |

## 开发与验证

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
pnpm test:preset-smoke
pnpm pack:check
```

CI 还会在 macOS 和 Windows 上单独运行客户端测试与打包检查。

## 兼容性

| DSH 模式/版本 | 状态 |
| --- | --- |
| Native Tool mode，`0.1.0-rc.6` | 支持 |
| 固定源码基线 `47f9438` / rc.5 | API 研究基线，不用于独立安装 |
| Code Mode / `run_code` | 不支持 |
| 旧版 `ctx.workflows` 或未作用域 Cordis 插件 | 不支持 |

详细 API 核验见 [DSH API Discovery](docs/discovery.md)。

## 项目来源

本项目基于 `omdsh-dev/dsh-inspect` 的提交
`9876349054f0fec33114f7f594b4901b7e9420f1` 派生，保留其 MIT 声明，但未保留
原项目的 CHECKUP、FIX 或 REVIEW 产品行为。详情见 [NOTICE.md](NOTICE.md)。

## License

[MIT](LICENSE)
