# Chorus

[![npm version](https://img.shields.io/npm/v/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![npm downloads](https://img.shields.io/npm/dm/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![license](https://img.shields.io/npm/l/@icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/blob/main/LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/releases/latest)

[English](README.md) | **中文**

**Chorus 是一个可编程的 AI Review Engine。** 它把多个专家角色组织成有界评审流程，输出有来源证据的决策，而不是简单聚合多个模型回答。模型是可替换的参与者；Workflow、Role、源码证据、Challenge 和 ReviewReport 才是稳定合同。

## 基于证据的评审

```text
/chorus review code-review --profile quick --base origin/main --head HEAD 评审安全性和 API 兼容性
```

内置 code-review 会执行独立专家评审、有限交叉评审、一次 Global Devil 挑战、源码引用验证和确定性决策整合。`quick` 使用三个专家角色；`deep` 使用架构、安全、性能和可维护性完整委员会。Architecture Review 则使用架构、可靠性、安全和可运维性角色，以及系统级 Prompt 和决策策略。报告会明确区分已验证、有争议、已拒绝和缺少证据的 Finding。

`quick` 用较少角色和挑战次数服务 diff 评审。每个专家最多保留 3 条重要 Finding，Global Devil 最多检查 5 条。它的 7 次执行配额固定预留给 3 个独立专家、最多 2 次交叉评审、1 次 Global Devil 和 1 次 Integrator。执行次数、源码检查工具调用和 agent turns 是硬限制；input、output 和成本只能在单次模型调用结束后核算，因为 Pi 子进程无法在结构化 JSON 响应中途可靠停止。实际超额会记录并把执行状态降级，下游阶段的预留份额仍然可用。`deep` 使用完整委员会、更高 Finding 上限和更大预算服务仓库或架构评审。两种 profile 都不会根据已运行的墙钟时间停止评审；Duration 仅作为实际观测指标记录。

原有 ask/agent fan-out API 继续作为兼容工作流保留。

### 本地运行

```bash
npm install
npm run build
pi -e ./src/index.ts
```

进入 Pi 后配置模型并运行评审：

```text
/chorus config
/chorus review code-review --profile quick 评审安全性和 API 兼容性
/chorus review code-review --staged --fail-on high --summary /tmp/chorus-summary.json 评审本次改动
```

常用参数：

| 参数 | 用途 |
| --- | --- |
| `--profile quick\|deep` | 选择有界交互评审或完整委员会评审 |
| `--staged` | 评审 staged Git diff |
| `--base <ref> --head <ref>` | 评审 Git revision 范围，必须成对使用 |
| `--constraint <text>` | 增加评审约束，可重复指定 |
| `--format markdown\|json\|github\|sarif` | 选择界面显示的 renderer |
| `--language zh-CN\|en` | 选择报告语言，默认简体中文 |
| `--file <definition.yaml>` | 加载受限 Review DSL 定义 |
| `--fail-on <severity> --summary <path>` | 执行 CI policy 并写入 JSON 摘要 |

不带 objective 运行 `/chorus review` 会打开交互式 Review 编写器。提交前会直接显示实际生效的 workflow、profile、scope 和 renderer。`Settings` 只修改本次评审，不会污染 Agent/Ask 使用的当前 preset；切换 workflow 时还会自动移除不兼容的 scope。

```text
------------------------------------------------------------------------
 Chorus Review draft
 Workflow: code-review | Profile: quick
 Scope: repository | Output: markdown

 Optional focus (blank = workflow default)

 [Submit]   Settings    Optimize    Cancel
------------------------------------------------------------------------
```

关注点字段是可选的。留空提交会使用当前 workflow 的内置目标；填写时只需要描述本次额外重点，例如“重点检查鉴权和 API 兼容性，不提出大规模重构”。Review 报告默认使用简体中文；需要英文时可在 Settings 选择 `Language: en`，或传入 `--language en`。Settings 面板还可以切换 workflow、quick/deep profile、逐角色模型（`Auto` 或任意当前可调用模型）、repository/files/document/diff scope、working/staged diff、逗号分隔的路径，以及 Markdown/JSON/GitHub/SARIF 输出。在模型行按 Enter 或直接输入字符，可按 provider、模型 ID 或显示名称搜索；左右键仍可快速轮换。角色模型会作为当前 Chorus preset 的默认值持久化，后续交互式和命令行 Review 自动复用；选择 `Auto` 会删除该角色的已保存覆盖。显式 Review DSL 中的模型策略仍然优先。最终解析出的角色模型会显示在持久化启动详情卡中。打开或关闭 Settings 都不会丢失草稿。Optimize 之后实际提交的是优化后的 objective，同时 job 元数据仍保留原始 objective。

Review 运行期间，编辑器上方会持续显示紧凑状态 widget，其中包含当前 stage 和每个 `角色 provider/model: 状态`。`/chorus watch <jobId>` 会把节点错误摘要固定显示在可滚动的 partial output 和工具活动上方。调度器默认全局最多五个 reviewer、同一 provider 最多一个；可通过 preset 的 `maxConcurrency` 和 `providerConcurrency` 显式调整。Quick/deep 不设置 workflow 总时限或单次 execution 时限。对 Review subagent 而言，preset voice timeout 仍是无输出保护，只要 Pi 持续产生 stdout 或 stderr 就会重新计时。限流、网络、无输出超时和 provider 5xx 最多进行三次有界退避重试。停滞后仍保留 partial output 和有界 activity 上下文，并交给一次禁止工具调用的 JSON 收尾；仍失败时，Auto 路由优先尝试同 provider 模型，并在可用时保留一个有界的跨 provider committee fallback；DSL 也可以显式配置跨 provider fallback。每次切换都会把调度许可转移到实际 provider，因此不会绕过 provider 并发限制。永久错误不会重试，并会明确显示 stage、role、实际 model、尝试次数和失败分类。

Reviewer 节点故障彼此隔离：其余角色和集成阶段继续运行，覆盖不完整时输出 `needs-investigation` 报告，并把 Job 标记为 `degraded`，不再显示成完整成功。Cross Review 会按严重程度与证据质量选择候选，并复用 Independent Review 的全局和 provider 并发控制。Markdown 会把 Complete/Degraded 执行状态与评审决策分开显示，并列出带单位的各阶段 planned/usable/failed/omitted、端到端墙钟耗时、有效/空结果角色，以及由引用或显式 Scope 表示的报告涉及文件；该数量不表示完整的源码扫描轨迹。压缩后的执行诊断与面向用户的待确认问题分开；完整错误链和归一化记录保留在 stage/execution artifact。常见且可安全确定的字段形态偏差会先归一化，再执行严格证据验证，包括缺失 evidence ID/kind 和数字行号数组；无法恢复的单条 evidence、Finding 或 Devil challenge 会被隔离，不再丢弃同一输出中的有效兄弟项。源码引用验证与 Finding 结论接受已经分离：引用匹配只让 Finding 保持 proposed；独立 support 会把自身通过验证的证据并入 Finding 后再进入 verified。有源码支持的 object/correct 会将其争议或驳回。Integrator 使用同一套结构化、经源码验证的 resolution 回写状态，也可以关闭已经被归一化证据回答的前序问题，但确定性覆盖缺口始终保留。Evidence 读取限制为 2 MiB，并使用 4 个 worker。Role 只有在归一化结果通过验证后才显示 `success`，有意省略的阶段显示 `skipped`。文件与 diff 内容会建立快照；评审期间发生变化的被引用源码会标为 stale，并使执行覆盖降级。没有 Finding 可供挑战时会跳过 Global Devil。只有请求或配置、Scope、持久化以及框架内部异常才会终止流程。

完整 workflow scope 规则、DSL、artifact、CI 退出码、`chorus_review` 工具、live evaluation、安全边界和当前限制见 [Review Engine 指南](docs/REVIEW_ENGINE.zh-CN.md)。

Review 恢复使用独立于精简 activity log、不会单独持久化的有界源码上下文，并向收尾阶段提供完整 JSON 契约。只产生覆盖缺口的已完成 Role 显示为 `empty`；前序 unresolved questions 会保留到最终报告，除非 Integrator 根据归一化证据明确关闭它们；并发预算按 stage 累计，流式 activity snapshot 也不再重复追加增长中的 partial output。

## Ask 兼容示例

同一个 prompt 并行发送给多个 voice，再由独立的 conductor 模型综合出**共识**、**分歧**和**最终答案**。

```text
/chorus ask 你怎么看待pi agent
```

```text
# Chorus Result
Preset: default | Voices: 2/2 | Duration: 46.6s | Cost: $0.008

## Final Answer

### Consensus
- 两个声音都高度赞赏 pi 的代码导航与理解能力，特别提到 `ast-grep`/`tree-sitter`/LSP 以及 `module_report` / `read_symbol` 等工具，认为比传统 grep 或读取整个文件精确高效得多。
- 双方都认可 pi 的 "read-before-edit"（读后保护）机制，要求修改代码前必须先读取相关符号，防止 AI 凭空瞎改。
- 两个声音都肯定了 pi 的扩展体系（Skills、Extensions、Custom Tools/Providers）以及多代理编排能力。
- 双方一致认为 pi 是实用主义、工具向、符合 AI 工作方式的 coding 框架，不花哨但长期可用。

### Disagreements
- **子代理的上下文与控制**：voice[0] 赞扬子代理可通过 `small / medium / big` 显式分级控制成本和质量；voice[1]（自称该功能作者）吐槽子代理每次都是全新上下文，没有自动继承父 session 的 code context。
- **安全机制的“度”**：voice[0] 认为工具 API 设计“相对克制，只暴露必要面”；voice[1] 觉得部分安全设计（如 `ast_grep_replace` 默认 dry-run、`edit` 要求精确匹配）偶尔“过度保护”。
- **任务执行模式**：voice[0] 指出 pi 缺乏显式的“先 plan 再执行”两段式主路径；voice[1] 则更侧重称赞其 token 效率和 turn-end advisory 提醒。

### Final Answer
作为运行在 pi 内部的 AI 视角，双方对 pi 的评价整体高度赞赏且务实。pi 的核心优势在于原生的代码理解能力与工具化设计——它没有简单地把 IDE 按钮暴露给 AI，而是提供了基于 `ast-grep`、LSP、`tree-sitter` 的工具原语（如 `module_report`、`read_symbol`），配合严格的 read-before-edit 守卫。仍需打磨的是子代理上下文传递，以及安全默认值与效率之间的平衡。

## Run Summary
- OK voice[0] model A | 17.7s | $0.008
- OK voice[1] model B | 18.2s | $0.000
- OK conductor | $0.000
```

每个 voice 的完整输出持久化在 `~/.pi/agent/chorus/results/<jobId>/`，可用 `/chorus watch <jobId>` 实时查看。

### Agent 示例：架构审查

`/chorus agent` 感知代码库。子智能体默认使用 `read-only` 权限配置；可写配置必须显式开启。随后主校验智能体（conductor）会对照真实代码交叉核验它们的结论。

```text
/chorus agent review the architecture of this project: where are the seams that could split into modules, and what logic is duplicated across direct and subagent mode?
```

```text
# Chorus Result
Preset: default | Agents: 2/2 | Duration: 14m | Cost: $0.016

## Final Answer

### Verified findings
- **模式重复** - 两个智能体都指出 `runDirectVoice` 和 `runSubagentVoice` 暴露了不同的 provider 与进程边界。已解决：`runtime/execution-coordinator.ts` 现已统一负责 voice 扇出、超时、预算、重试和结果拼装。
- **硬编码并发** - 两个智能体发现 voice 并发数曾固定为 3，预设无法覆盖。已解决：现在可通过 preset 配置，默认值为 5。

### Overstated / rejected
- agent[1] 声称 `malformedLines` 是死代码 - 不正确，它在 `subagent.ts:141` 被抛出。
- agent[0] 把 registry 为空的路径定为严重问题；默认的 `callPiModel` 路径会绕过它，实际严重度低。

### Final Answer
运行时现在复用有界执行逻辑，并通过 preset 暴露并发设置。两条被否决的结论说明了校验步骤的价值：智能体可能很自信，但却是错的。

## Run Summary
- OK agent[0] model A | 11m | $0.009
- OK agent[1] model B | 9m | $0.007
- OK conductor (主校验) | 3m | $0.000
```

子智能体写入 `agent-N.md` + `agent-N-activity.md`（完整工具轨迹）；conductor 写入 `final-report.md`。全部持久化在 `~/.pi/agent/chorus/results/<jobId>/`。

### 交互式编写器（无参数调用）

不带参数运行 `/chorus agent`（或 `/chorus ask`）会打开一个交互式编写器，而不是失败或留空。你可以直接键入或粘贴 prompt，也可以从同一个界面跳到预设配置或 prompt 优化：

```text
------------------------------------------------------------------------
 Chorus Agent Task draft
 Preset: default | Strategy: parallel
 Execution: subagent | Voices: 3

 Agent task

 [Submit]   Config    Optimize    Cancel

 Type/paste prompt - up/down scroll - left/right/tab action - enter confirm - backspace delete - esc cancel
------------------------------------------------------------------------
```

- **Submit** 通过当前预设运行 prompt。
- **Config** 在原位打开预设管理器（也可通过 `/chorus config` 进入）；编写器不会关闭，配置完后可以接着输入。
- **Optimize** 用 conductor 的优化器模型重写 prompt。优化后，状态会从 `draft` 翻转为 `optimized`，按钮标签变为 `Optimize again`——选中它可以对最新文本再次运行优化器。
- **Cancel** 取消编写器。

`/chorus ask` 会打开标题为 `Chorus Question`、占位符为 `Question` 的相同 UI，按钮行一致，仅标题和占位符随命令变化。

## 安装

以 Pi 包的形式从 npm 安装：

```bash
pi install npm:@icxcoffee/chorus
```

或者不改配置直接试用：

```bash
pi -e npm:@icxcoffee/chorus
```

安装后，`/chorus` 斜杠命令和 `chorus_answer` 工具即可在任意 Pi 会话中使用。

### Codex 与 Claude Code Skill

一行命令把包内 Chorus Agent Skill 安装到当前用户的 Codex 与 Claude Code，之后所有项目都可以使用：

```bash
npx --yes --package=@icxcoffee/chorus@latest chorus-skill-install --scope user
```

在新机器上，一行 shell 命令同时安装 Pi 扩展和用户级 Skill：

```bash
pi install npm:@icxcoffee/chorus && npx --yes --package=@icxcoffee/chorus@latest chorus-skill-install --scope user
```

更新两个用户级安装时加 `--force`。如果只想把可提交的副本安装到某个项目：

```bash
cd /path/to/target-project
npx --yes --package=@icxcoffee/chorus@latest chorus-skill-install .
```

用户级安装写入 `$CODEX_HOME/skills`（默认 `~/.codex/skills`）和 `$CLAUDE_CONFIG_DIR/skills`（默认 `~/.claude/skills`）。项目级安装生成 `.agents/skills/chorus-agent` 和 `.claude/skills/chorus-agent`，可随目标项目一起提交。从长期存在的本地 Chorus 仓库开发时，可以先构建再使用 link 模式，让 Skill 修改立即被两个宿主共享：

```bash
npm run build
node /path/to/chorus/dist/cli/install-skill.js /path/to/target-project --mode link
```

在 Codex 中使用 `$chorus-agent`，在 Claude Code 中使用 `/chorus-agent`。

## 开发

```bash
npm install
npm run typecheck
npm run test:unit
pi -e ./src/index.ts
```

本扩展注册了以下命令：

- `/chorus config` 用于预设管理和首次运行校验。
- `/chorus ask [question...]` 用于运行当前激活的预设。
- `/chorus agent [task...]` 用于感知代码库的多智能体运行。子智能体先运行，随后 conductor 作为主校验智能体（main verification agent）在其输出之上运行。
- `/chorus review [workflow] [objective...]` 用于基于角色和证据的代码、架构或设计评审，支持 profile、git diff 范围、renderer、DSL 文件和 CI policy。
- `/chorus review-eval --live <manifest.json>` 显式运行会产生模型费用的单 Reviewer 与委员会对照；CI 不会隐式执行。
- `/chorus jobs` 列出最近的后台任务。
- `/chorus job <jobId>` 显示某个任务的快照，并在可用时指向结果文件。
- `/chorus watch <jobId> [agent-index]` 为某个运行中或已完成的任务打开带语义颜色的实时 TUI 视图。使用左/右或 Tab 切换角色，上/下逐行滚动，PageUp/PageDown 翻页，Home/End 或 `g`/`G` 跳到开头/结尾。Pi 的自定义组件 API 暂不暴露鼠标滚轮输入。
- `/chorus cancel <jobId>` 中止正在运行的任务。
- `/chorus resume <jobId>` 校验并复用已提交 voice，创建新的恢复 attempt。
- `/chorus history list|search|show|compare|replay|export|prune` 管理历史；replay 必须选择 `snapshot` 或 `current`。
- `/chorus batch <dataset.jsonl> [preset...]` 执行可恢复批处理，并生成逐 case 文件和 Markdown/JSON/CSV 报告。
- `/chorus optimize [prompt...]` 仅用于手动改写 prompt。
- `chorus_answer`，参数为 `{ "prompt": string, "presetName"?: string }`，供智能体作为工具调用。
- `chorus_review`，接收 objective 或受限 JSON/YAML `definitionPath`，供智能体调用结构化评审。

自由文本命令各有两种等价形式——子命令与直接别名——参数解析完全一致：

```text
/chorus ask <question>      ≡  /chorus-ask <question>
/chorus agent <task>        ≡  /chorus-agent <task>
/chorus review <objective>  ≡  /chorus-review <objective>
/chorus optimize <prompt>   ≡  /chorus-optimize <prompt>
/chorus config [action]     ≡  /chorus-config [action]
```

任选其一即可，两种形式喂给 voice 的 prompt 字符串相同。（带引号或多词的 prompt 两种形式都会做相同的归一化。）

## 模式

Direct（直连）模式通过适配器调用各 provider 的 API，并根据 provider 返回的用量和模型定价计算成本。Subagent（子智能体）模式通过派生 `pi --mode json -p --no-session --model provider/modelId` 来进行感知代码库的 voice 运行，并解析 NDJSON 格式的用量/成本事件。

预设可选配置 `budget` 与 `cachePolicy`。预算运行串行启动 voice，从而依据实际 USD/token 使用量停止排队任务；subagent 或共享 session-history 的运行默认禁用缓存。`permissionProfile` 支持 `read-only`、`workspace-write`、`full`：只读通过 Pi 原生 `--tools read,grep,find,ls` 强制执行，可写与 full 均要求显式环境确认。

### 会话历史共享

默认情况下，subagent 模式下派生的子智能体是**会话隔离的**——它们只能看到你提交的 Chorus 任务本身，看不到周围 Pi 对话中的内容。这样你的草稿、旁白和无关话题都不会进模型上下文。该设置为预设级，存储在 `~/.pi/agent/chorus/config.json` 的 `includeSessionHistory` 字段中。

通过以下命令切换：

```text
/chorus config history on    # 子智能体可见当前会话
/chorus config history off   # 子智能体只看到任务本身
```

哪些组件遵循这个开关、哪些不：

- **subagent 模式的 voice**（工作子智能体）遵循预设。`on` 时，衍生的 `pi` 进程不会带 `--no-session`，会继承父 Pi 会话。
- **direct 模式的 voice** 不受影响——它们直接调用 provider API，永远拿不到会话历史。
- **`/chorus agent` 的主校验 conductor** 始终隔离，即便 `history on` 也一样。它只接收子智能体的证据文件作为上下文，从而能在不被用户对话干扰的前提下核验 agent 的实际输出。
- **`chorus_answer` 工具**（被其他 agent 调用）也遵循预设——调用方选 `presetName: foo` 时会继承 foo 的会话策略。

权衡：`history on` 让智能体能理解上下文线索（比如"我上面提到过……"），但会撑大 prompt 并可能让不相干的任务泄露前面的对话。除非任务明确依赖上下文对话，否则保持 `off`。

使用配置命令切换模式和超时：

```text
/chorus config mode direct
/chorus config mode subagent
/chorus config history on
/chorus config history off
/chorus config timeout voice 2h
/chorus config timeout conductor 1h
/chorus config timeout conductor default
```

`/chorus config timeout <duration>` 仍是 voice / agent 超时的简写。时长支持毫秒、`Ns`、`Nm`、`Nh` 或 `default`。

## Ask vs. agent

`/chorus ask` 和 `/chorus agent` **不是** "direct 模式 / subagent 模式" 的对应关系——它们是两种不同的运行形态：

- **`/chorus ask`** 运行当前激活预设里的 voice，再综合它们的响应。预设的 `mode`（direct 或 subagent，通过 `/chorus config mode` 配置）决定每个 voice 如何被调用。用于不需要访问代码仓库的开放性问题。
- **`/chorus agent`** 始终是 subagent 模式，且始终感知代码库：子智能体使用配置的权限 profile（默认只读），产出证据文件存到 `results/<jobId>/`。随后一个独立的**主校验 conductor** 作为全新 agent 在证据文件上运行，逐条验证或否决子智能体的结论。用于需要智能体实际去探索代码库的任务。

其他具体差异：

| | `/chorus ask` | `/chorus agent` |
| --- | --- | --- |
| Mode | 预设的 `mode`（可配） | 硬编码 `subagent` |
| 综合方式 | 在 voice 输出上做简单综合 | 在证据文件上跑主校验 agent |
| 代码库访问 | 仅 subagent 模式下有 | 始终有 |
| 持久化产物 | 每个 voice 的输出 + 综合结果 | `request.md`、`main-agent-input.md`、`agent-N.md`、`agent-N-activity.md`、`main-agent-activity.md`、`final-report.md`、`result.json` |
| conductor 会话 | 隔离（看不到父对话） | 隔离（只能看证据文件） |

一句话：`ask` 适合"让 N 个模型各答一遍并对比"；`agent` 适合"让 N 个智能体实际调研代码库并互相校验"。

## 配置与历史

配置和历史存放在 `~/.pi/agent/chorus/` 下：

- `config.json` 存储 `{ configVersion: 2, activePresetName, presets }`，每个 preset 可以包含经过校验的 `reviewRoleModels` 默认值。版本 1 会在校验通过后原子迁移；旧策略 `A/B/C` 分别映射为 `parallel/debate/rank`。可选字段 `includeSessionHistory` 默认关闭，voice/conductor 超时默认 30 分钟。v2 不再包含 `optimizeBeforeAsk`；旧配置若为 `true` 会被拒绝，因为 prompt 优化仍是显式工作流。
- `history.jsonl` 每次运行追加一条完整的 `ChorusResult`。
- `jobs.json` 存储最近的后台任务快照。来自上一个 Pi 进程的运行中任务会被标记为 `stale`（陈旧），因为重载后无法重新接管它们。
- `results/<jobId>/` 存储智能体运行产物，例如 `request.md`、`main-agent-input.md`、`agent-0.md`、`agent-0-activity.md`、`main-agent-activity.md`、`final-report.md` 和 `result.json`。

文件在平台支持时以仅所有者可访问的权限创建。v1 无限期保留历史，不提供历史浏览器或保留策略。

## 隐私

Chorus 会把**每一次 prompt、voice 响应、conductor 综合、活动日志和错误消息的完整内容**持久化到 `~/.pi/agent/chorus/`（权限 0o600）。该目录可能包含私有代码库上下文、provider 堆栈中回显的密钥或其他敏感内容。请像对待 `.env` 文件那样对待它：**不要**提交到版本库，**不要**在未加密的情况下同步到云备份，并考虑将其从 shell 历史和编辑器会话恢复中排除。

错误消息在进入历史前会脱敏常见的凭据形态（Bearer token、`sk-...` API key、`Authorization` / `x-api-key` / `proxy-authorization` / `set-cookie` 头、`key=value` 查询参数（包括 `api_key`/`token`）、JSON 密钥字段，以及 URL 中的 `userinfo:password@` 凭据）。这是尽力而为，可能无法覆盖所有 provider 的错误格式。

历史默认最多保留最近的 **1000 次运行**；追加新记录时旧的运行会被自动清理。运行 `/chorus history prune [N]` 可手动裁剪到最近 `N` 条。该目录以仅所有者权限创建（目录 `0o700`，文件 `0o600`）。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run build
```
