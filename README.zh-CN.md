# Chorus

[![npm version](https://img.shields.io/npm/v/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![npm downloads](https://img.shields.io/npm/dm/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![license](https://img.shields.io/npm/l/@icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/blob/main/LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/releases/latest)

[English](README.md) | **中文**

Chorus 是一个 Pi 扩展，它把同一个 prompt 并行发送给多个 LLM "voice"（声音），再由一个独立的 conductor（指挥）模型把成功的响应综合成最终答案。

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

## 模式

Direct（直连）模式通过适配器调用各 provider 的 API，并根据 provider 返回的用量和模型定价计算成本。Subagent（子智能体）模式通过派生 `pi --mode json -p --no-session --model provider/modelId` 来进行感知代码库的 voice 运行，并解析 NDJSON 格式的用量/成本事件。

默认情况下，子智能体会话隔离。使用 `/chorus config history on` 可让子智能体继承当前 Pi 会话的历史；使用 `/chorus config history off` 恢复隔离。`/chorus agent` 的 conductor / 主校验智能体始终隔离，它接收的是子智能体的证据文件，而非父会话历史。

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
