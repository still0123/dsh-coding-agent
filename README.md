# DSH Coding Agent

**简体中文** | [English](README.en.md)

[![CI](https://github.com/still0123/dsh-coding-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/still0123/dsh-coding-agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/still0123/dsh-coding-agent?display_name=tag)](https://github.com/still0123/dsh-coding-agent/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-4e51e8)](https://github.com/deepseek-ai/deepseek-harness)

![DSH Coding Agent banner](docs/images/readme-banner.svg)

## 当编码 Agent 说「已修复」时,谁来验证?

通用 Coding Agent 的正确性依赖模型自觉:提示词要求它「先复现、再修复、后验证」,但它可能跳过复现直接动手改代码;它汇报「测试已通过」,却没有第三方真正重跑过;任务结束后,也拿不出一份完整的执行证据。

dsh-coding-agent 把这组约定升级为**可审计的执行合同**,由代码而不是自然语言来强制执行:

> **先在当前机器上真实观察到用户声明的失败(RED),才开放唯一的 writer 修改代码;修复后由 wrapper 亲自重新运行复现命令与全部验收命令;验证期间补丁指纹未被改变、全部通过,才允许返回 `fixed`。**

整个流程共有 9 种终态,只有 `fixed` 返回 `ok: true`,其余终态都会携带原因与证据返回。

项目基于 **DeepSeek Harness / Cordis(DSH)** 构建。DSH 提供 Agent Loop、模型适配、工具沙箱、Session 与持久化等基础设施;本项目不重写它们,只在 DSH 的扩展点上实现 Preset、CLI 授权边界、ReproFix Guard、状态机和 Receipt。

## 为什么「在提示词里写清楚」不够

提示词约束本质上是概率性的:模型「大概率」遵守。ReproFix 用机械保证替代这种信任:

| 依赖提示词的 Agent | ReproFix 的执行合同 |
| --- | --- |
| 要求模型「先复现故障再修改」,模型仍可能直接动手 | RED gate:失败特征匹配之前,`write`、`edit`、`bash`、`pwsh` 及未知工具一律被 Guard 拒绝 |
| 模型汇报「测试已通过」,无法核实是否真的跑过 | GREEN 由插件重新运行复现命令与全部验收命令,不采信 writer 的自然语言声明 |
| 截断、超时的输出可能被误判为成功 | 任何截断、超时、取消或 Sandbox 拒绝都不能作为 RED / GREEN 证据,一律视为失败 |
| 任务结束只剩对话记录,难以审计 | 每个终态写入 `reprofix/receipt`:退出码、输出摘要、补丁指纹、验证明细 |

## ReproFix Agent 如何工作

ReproFix 向 DSH 注册一个模型工具:

```text
repair_failure
```

调用该工具时,插件会:

1. 找到当前工作区的 Git 根目录。
2. 拒绝包含 tracked 或 untracked 改动的工作区。
3. 运行 `repro.command`。
4. 同时校验退出码和所有大小写敏感的 `outputIncludes` 文本。
5. 只有匹配成功才向唯一 writer 开放 edit/write,始终不开放 Shell。
6. 启动最多一个 writer Agent 诊断并修改代码。
7. 由插件重新运行复现命令和最多 10 条验收命令。
8. 比较验证前后的 Git 补丁指纹,防止测试过程继续改动补丁。
9. 把结果写入 `reprofix/receipt` Session 事件。

失败日志 `failureLog` 只作为诊断上下文,永远不能代替当前机器上的真实复现结果。

## 机械保证

以下行为由代码执行,不依赖 writer 的自然语言声明:

- dirty 工作区不会启动复现或 writer。
- 截断、超时、取消、Sandbox 拒绝或未启动的命令不能成为 RED/GREEN。
- RED 必须同时满足退出码规则和全部文本规则。
- RED 之前,`write`、`edit`、`bash`、`pwsh` 及未知工具均被 Guard 拒绝。
- RED 之后,writer 的能力工具也只有 `read`、`glob`、`grep`、`edit`、`write`
  (另放行 DSH 的 `structured_output` 结果通道),不能使用 `bash`、`pwsh` 或任意
  命令工具。
- canonical Git root 通过 `$DSH_HOME/dsh-coding-agent/locks` 在进程间互斥。
- reproduction、writer 和 validation 后都会核验 HEAD 未变化。
- GREEN 由插件重新运行,不采信 writer 声称「测试已通过」。
- tracked diff 与 untracked 文件共同进入版本化补丁指纹。
- 最终验证改变补丁时,任务不能返回 `fixed`。
- 每个受控终态都会尝试写入 `reprofix/receipt`;持久化失败会输出到 stderr。

命令输出每个流最多保留 256 KiB。任何截断都会导致匹配失败,而不是用不完整输出
推断成功。

## 架构与所有权

![DSH Coding Agent architecture](docs/images/architecture.svg)

| DSH 提供 | 本项目实现 |
| --- | --- |
| Agent Loop、模型适配、工具运行时 | `coding` / `reprofix` Agent Preset |
| ALLOW / ASK / DENY、Sandbox、Shell | `repair.json` CLI 授权与 fingerprint |
| Session 日志、持久化、Workflow | RED gate、单 writer、wrapper validation |
| 上下文压缩与 Web UI | canonical workspace lock 与 Receipt |

详细设计见 [Architecture](docs/architecture.md) 和 [SPEC](SPEC.md)。

## 内置 Agent Preset

本仓库提供两种互不污染的工作模式:

| Preset | 用途 | 能力 |
| --- | --- | --- |
| `DSHAgent` | 通用编码任务 | 文件与 Shell、搜索、Skills、Todo、提问和上下文压缩 |
| `ReproFix` | 已有稳定复现方式的故障修复 | 精确 RED Gate、单 writer、独立验收和 Receipt |

`DSHAgent` 不挂载 ReproFix Guard;`ReproFix` 在 RED 前拒绝写入,RED 后 writer 的
能力工具也只有 read/search/edit/write(另放行 DSH 的结构化结果终结通道)。所有
命令始终由 wrapper 执行。

## 返回状态

| 状态 | 含义 |
| --- | --- |
| `fixed` | 已精确复现,补丁通过复现与全部验收,验证期间补丁未变化 |
| `not_reproduced` | 当前命令结果没有匹配声明的失败特征,没有启动 writer |
| `blocked_dirty_workspace` | 启动时工作区不干净,没有运行复现命令 |
| `blocked_repro_side_effect` | 复现后工作区发生变化,没有启动 writer |
| `blocked_active_run` | 共享同一 `DSH_HOME` 的进程中已有任务锁定该 canonical Git root |
| `repair_failed` | writer 没有产出可验证补丁或 Workflow 失败 |
| `validation_failed` | 已有补丁,但复现、验收、HEAD 或补丁指纹检查失败 |
| `cancelled` | 外部取消或命令执行被中止 |
| `infrastructure_error` | Git、锁目录、Session 等本地基础设施阻止事务完成 |

只有 `fixed` 会返回 `ok: true`。

## 适合与不适合

适合:

- 已经有稳定复现命令的单元测试、集成测试或构建错误。
- 希望限制 Agent 在确认原始故障前修改代码。
- 需要保存退出码、输出摘要、补丁信息和验收结果。
- 希望失败修复保留在工作区,便于人工检查。

不适合:

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

CLI 使用 DSH 的 `headless` Profile。若默认模型来自 Web Profile 单独安装的第三方
provider,必须把同一 adapter 配置到
`$DSH_HOME/profiles/headless/cordis.patch.yml`;CLI 不会把 Web 插件隐式复制到
headless。缺少 adapter 时,`run` 明确失败,ReproFix 在 RED 后返回带 Receipt 的
`infrastructure_error`。

## 安装 Release

> [!NOTE]
> 当前稳定版本为 `0.1.0`,通过 GitHub Releases 分发(附 `.sha256` 校验文件),尚未
> 发布到 npm registry。

```bash
npm install -g \
  https://github.com/still0123/dsh-coding-agent/releases/download/v0.1.0/dsh-coding-agent-0.1.0.tgz

dshagent --help
dshagent presets install
```

## 快速开始:文本 CLI

```bash
git clone https://github.com/still0123/dsh-coding-agent.git
cd dsh-coding-agent

npm install -g pnpm@11.7.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm build

pnpm dshagent run "检查当前仓库并修复类型错误" --cwd .
pnpm dshagent repair --spec repair.json --cwd .
```

`repair` 会先校验并展示 canonical 工作区、复现命令、失败特征和验收命令。人工确认
后,CLI 对规范化输入和工作区计算 fingerprint,再通过 `0600` 临时上下文直接调用
`repair_failure`;这些命令不会进入模型 Prompt。CI 等非交互环境必须显式使用
`--yes`:

```bash
pnpm dshagent repair --spec repair.json --cwd . --yes --timeout 900000
```

V0.1 CLI 为单次文本模式:创建新 Session,只输出最终文本,不提供 JSONL、Session
ID 或 resume;这些能力计划在 V0.2 加入。

## 一键 Demo

每个 Demo 都会把 `fixtures/buggy-project` 复制到新的临时 Git 仓库,并断言最终状态:

![Verified ReproFix demo outcomes](docs/images/demo-results.svg)

```bash
pnpm demo:not-reproduced
pnpm demo:fixed
pnpm demo:validation-failed
```

`fixed` 和 `validation-failed` 会调用已配置的模型;`not-reproduced` 在 RED gate
直接结束,不产生模型修复轮次。脚本会打印临时工作区路径,便于检查最终 diff。

## 安装到已有 DSH Web

先构建本项目,并把本地 checkout 安装到 `web` profile:

```bash
git clone https://github.com/still0123/dsh-coding-agent.git
cd dsh-coding-agent

npm install -g pnpm@11.7.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm build

npm install -g @deepseek-ai/dsh@0.1.0-rc.6
dsh plugin --profile web add .
```

然后安装项目自带的两套 Agent Preset:

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
node "$DSH_HOME/profiles/web/node_modules/dsh-coding-agent/scripts/install-presets.mjs" install

dsh web
```

安装器会写入:

```text
$DSH_HOME/.agent-presets/dshagent
$DSH_HOME/.agent-presets/reprofix
```

重复执行不会改写相同文件;检测到用户本地修改时会拒绝覆盖。确实需要恢复仓库版本时,
显式增加 `--force`:

```bash
node "$DSH_HOME/profiles/web/node_modules/dsh-coding-agent/scripts/install-presets.mjs" install --force
```

新建普通开发会话时选择 **DSHAgent**;修复已有可复现故障时选择 **ReproFix**。

安装包的 `cordis.patch.yml` 故意保持为空。ReproFix Guard 只应挂载到 ReproFix
Preset,不能全局限制其他 DSH Agent。

## 输入示例

```json
{
  "task": "修复 add(),不要改变公开 API。",
  "failureLog": "可选的历史报错,只用于帮助诊断。",
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

字段说明:

| 字段 | 含义 |
| --- | --- |
| `task` | writer Agent 收到的修复目标 |
| `failureLog` | 可选上下文,不参与 RED 判定,Receipt 只保留摘要 |
| `repro.command` | 插件实际执行的复现命令 |
| `repro.failure.exitCodes` | 被视为原始故障的退出码;省略时要求非零 |
| `repro.failure.outputIncludes` | 必须全部出现的大小写敏感文本,至少一条 |
| `repro.success` | 修复后复现命令的 GREEN 判定,默认退出码为 `0` |
| `acceptance` | 修复后额外执行的验收命令,最多 10 条 |
| `maxRepairRounds` | writer 最大轮数,范围 `1-3`,默认 `1` |

## 当前安全边界

ReproFix 限制了 writer 的启动时机,但它不是完整的命令隔离系统:

- `repro.command` 和 `acceptance.command` 是调用方提供的真实 Shell 命令,只能使用
  你信任的命令。
- 复现命令先执行,插件随后检查工作区是否变化。如果该命令修改或删除文件,插件会
  返回 `blocked_repro_side_effect`,但当前版本不会自动恢复这些改动。
- 工作区锁只覆盖共享同一 `DSH_HOME` 的进程;不同用户、不同 `DSH_HOME` 和网络文件
  系统不在 V0.1 保证范围内。
- writer 没有 Shell,因此不能执行 commit、push、reset、checkout、clean 或自行
  重写验收命令。
- Git ignored 文件、仓库外文件、网络请求和远端副作用不在补丁指纹内。
- reproduction/acceptance 仍在当前工作区原地执行;检测到副作用会停止,但不会自动
  恢复已产生的修改。隔离 worktree/container 属于 V0.2。
- Receipt 保存命令文本。不要把 Token、密码或其他秘密直接写入命令。

建议先在临时分支、临时 worktree 或可丢弃仓库中使用,并在运行后检查 `git diff`
和 `git status`。

## Receipt 与补丁信息

`reprofix/receipt` 使用 `reprofix.receipt/v1`,记录:

- Git 根目录、初始 HEAD 和 clean 状态;
- 复现命令的退出码、耗时、输出摘要和尾部;
- writer 的诊断与代码位置;
- changed files、增删行、manifest/binary 文件和补丁指纹;
- 每条最终验证命令;
- Workflow 轮次、终止原因和剩余风险。

补丁分数为:

```text
added + deleted + 10 × changed files + 50 × manifest files + 100 × binary files
```

它只描述当前补丁的修改规模,不证明该补丁是所有方案中的全局最小值。

完整字段见 [Receipt Schema](docs/receipt-schema.md)。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 注册 `repair_failure` 工具及输入/输出 Schema |
| `src/repair.ts` | RED、writer、GREEN 和终态编排 |
| `src/guard.ts` | RED gate 与 writer 工具 allowlist |
| `src/runner.ts` | DSH Shell 调用、canonical Git/HEAD 和补丁指纹 |
| `src/workspace-lock.ts` | canonical root 的跨进程 owner lock |
| `src/cli-runner.ts` | 可信上下文驱动的 DSH run/repair 执行器 |
| `src/workflow.ts` | 单 writer Workflow 与结构化诊断结果 |
| `src/receipt.ts` | Receipt 指纹与 Markdown 展示 |
| `client/cli.mjs` | `dshagent` 参数、确认、timeout 与 DSH 子进程管理 |
| `client/server.mjs` | 仅本机访问的跨平台启动页面 |
| `preset/coding` / `preset/reprofix` | 两套 Agent Preset |
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

CI 在 Linux 上执行全量验证,并在 macOS 和 Windows 上运行 CLI/客户端测试与打包
检查。架构与 DSH 所有权边界见 [Architecture](docs/architecture.md)。

## 兼容性

| DSH 模式/版本 | 状态 |
| --- | --- |
| Native Tool mode,`0.1.0-rc.6` | 支持 |
| 固定源码基线 `47f9438` / rc.5 | API 研究基线,不用于独立安装 |
| Code Mode / `run_code` | 不支持 |
| 旧版 `ctx.workflows` 或未作用域 Cordis 插件 | 不支持 |

详细 API 核验见 [DSH API Discovery](docs/discovery.md)。

## 项目来源

本项目基于 `omdsh-dev/dsh-inspect` 的提交
`9876349054f0fec33114f7f594b4901b7e9420f1` 派生,保留其 MIT 声明,但未保留
原项目的 CHECKUP、FIX 或 REVIEW 产品行为。详情见 [NOTICE.md](NOTICE.md)。

## License

[MIT](LICENSE)
