# Chorus

[![npm version](https://img.shields.io/npm/v/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![npm downloads](https://img.shields.io/npm/dm/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![license](https://img.shields.io/npm/l/@icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/blob/main/LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/releases/latest)

[English](README.md) | **中文**

Chorus 是一个 Pi 扩展，它把同一个 prompt 并行发送给多个不同的 LLM "voice"（声音）——比如 Claude、GPT、GLM、DeepSeek，或者你在 Pi 模型注册表中能配置的任何 provider——再由一个独立的 conductor（指挥）模型把成功的响应综合成最终答案。

## 示例

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

`/chorus agent` 是感知代码库的。每个子智能体都在仓库内运行，拥有完整工具权限（读文件、跑构建、追踪调用路径），随后主校验智能体（conductor）会对照真实代码交叉核验它们的结论。

```text
/chorus agent review the architecture of this project: where are the seams that could split into modules, and what logic is duplicated across direct and subagent mode?
```

```text
# Chorus Result
Preset: default | Agents: 2/2 | Duration: 14m | Cost: $0.016

## Final Answer

### Verified findings
- **模式重复** - 两个智能体都指出 `runDirect` 和 `runSubagent` 各自重新实现了 voice 扇出、超时处理和成本汇总。已核实：`runtime/voice-runner.ts` 是共享的，但 direct/subagent 入口仍然重复了结果结构的拼装。
- **硬编码并发** - 两个智能体都注意到 voice 并发数固定为 3，预设无法覆盖。在 `runtime/job-runner.ts` 中已核实。

### Overstated / rejected
- agent[1] 声称 `malformedLines` 是死代码 - 不正确，它在 `subagent.ts:141` 被抛出。
- agent[0] 把 registry 为空的路径定为严重问题；默认的 `callPiModel` 路径会绕过它，实际严重度低。

### Final Answer
把 direct/subagent 的结果拼装收敛到一个 helper 之后，把并发数作为预设字段暴露出来。两条被否决的结论说明了校验步骤的价值：智能体可能很自信，但却是错的。

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
- `/chorus jobs` 列出最近的后台任务。
- `/chorus job <jobId>` 显示某个任务的快照，并在可用时指向结果文件。
- `/chorus watch <jobId> [agent-index]` 为某个运行中或已完成的任务打开实时 TUI 视图。
- `/chorus cancel <jobId>` 中止正在运行的任务。
- `/chorus optimize [prompt...]` 仅用于手动改写 prompt。
- `chorus_answer`，参数为 `{ "prompt": string, "presetName"?: string }`，供智能体作为工具调用。

自由文本命令各有两种等价形式——子命令与直接别名——参数解析完全一致：

```text
/chorus ask <question>      ≡  /chorus-ask <question>
/chorus agent <task>        ≡  /chorus-agent <task>
/chorus optimize <prompt>   ≡  /chorus-optimize <prompt>
/chorus config [action]     ≡  /chorus-config [action]
```

任选其一即可，两种形式喂给 voice 的 prompt 字符串相同。（带引号或多词的 prompt 两种形式都会做相同的归一化。）

## 模式

Direct（直连）模式通过适配器调用各 provider 的 API，并根据 provider 返回的用量和模型定价计算成本。Subagent（子智能体）模式通过派生 `pi --mode json -p --no-session --model provider/modelId` 来进行感知代码库的 voice 运行，并解析 NDJSON 格式的用量/成本事件。

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
- **`/chorus agent`** 始终是 subagent 模式，且始终感知代码库：子智能体拥有完整工具权限（读文件、bash、git 等），产出证据文件存到 `results/<jobId>/`。随后一个独立的**主校验 conductor** 作为全新 agent 在证据文件上运行，逐条验证或否决子智能体的结论。用于需要智能体实际去探索代码库的任务。

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

- `config.json` 存储 `{ configVersion: 1, activePresetName, presets }`。
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
