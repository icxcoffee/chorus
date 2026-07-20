# Chorus Review Engine 指南

Chorus 把可替换模型组织成无状态评审流程。Reviewer Role 提出 Finding，源码验证器核对引用，有界 Challenge 阶段质疑重要结论，Integrator 最终生成版本化 `ReviewReport`。模型输出只是来源记录，不是事实证据。

## 运行前提

- Node.js 22.19 或更高版本
- 本机 `pi` 命令可正常执行
- Chorus 已配置足够的可调用模型
- 使用 diff scope 时，当前目录必须是 Git 仓库

Review Engine 目前只存在于仓库工作区，尚未发布为新的 npm 版本。本地运行：

```bash
cd /path/to/chorus
npm install
npm run build
pi -e ./src/index.ts
```

进入 Pi 后先运行 `/chorus config`。Review Role 使用 Pi subagent，默认继承当前 preset 的 `read-only` 权限配置。

## Workflow

| Workflow | 默认专家 | 支持的 scope |
| --- | --- | --- |
| `code-review` | 架构、安全、性能、可维护性 | Repository、files、Git diff |
| `architecture-review` | 架构、可靠性、安全、可运维性 | Repository、files、document |
| `design-review` | 架构、安全、可维护性 | 仅 files 或 document |

所有内置 workflow 使用相同的受策略约束阶段：

1. `independent-review`
2. `cross-review`
3. `devil`
4. `integrate`

Independent Review 使用有界调度：默认全局最多同时运行五个专家；由于不同 provider/model 的并发限制不同，共用同一 provider 的 reviewer 默认串行。Cross Review 复用同一调度器和限制，不再逐条串行等待 challenge；候选在应用 profile 上限前，会按严重程度、角色多样性、状态、置信度和证据质量确定性排序。Preset 的 `maxConcurrency` 和 `providerConcurrency` 可以显式覆盖这些限制。`/chorus watch` 会显示当前 stage，并实时更新每个角色的 running 状态、工具活动、partial output、失败和完成状态。结果目录在启动时就会创建，其中包含 `review-request.json` 和有界的 `review-progress.json`，因此即使模型响应缓慢或进程中断，最终报告提交前也有可诊断信息。

单个 Reviewer 节点失败不会中断 Workflow。其他 Reviewer 和 Integrator 会继续执行；Global Devil 只在存在可挑战 Finding 时运行。失败角色保留 error 状态。Role 产出 Finding、积极观察或明确的干净空结果时计为有效；只返回覆盖缺口问题的结果会记为空结果 Role。决策和 CI 完整性使用有效 Role，报告仍分别保留完成数和空结果角色。报告涉及文件是显式 Scope 路径与实际引用源码路径的并集，并分别报告两部分数量；它不表示 Reviewer 打开过的全部文件。简洁的覆盖缺口进入 unresolved questions；技术故障按 stage、role 和 category 聚合到独立的“执行诊断”（最多 20 组），完整错误链保留在 stage/execution artifact。Integrator 可以关闭已被归一化证据回答的早期问题，但不能删除确定性的覆盖缺口。Coverage 和 stage status 记录未完成工作，必要覆盖不完整时确定性决策为 `needs-investigation`。执行覆盖不足时 Job 状态为 `degraded`，与评审决策分开表达；报告 Duration 使用端到端墙钟耗时。即使全部独立 Reviewer 都失败，Chorus 仍会输出可审计的不完整报告。请求或 Scope 非法、配置不可用、artifact 持久化失败以及框架内部异常仍属于 Job 级失败。

Reviewer 必须以结构化 JSON 结束。Quick/deep 通过各阶段的工具调用和 agent turn 上限控制扫描深度，不设置 workflow 总时限或单次 execution 的墙钟 deadline。扫描达到任一深度边界时，Chorus 会保留已经收集的材料，并执行一次禁止工具调用的结构化收尾。Preset voice timeout 在 Review 中作为无输出保护，每个 stdout/stderr chunk 都会刷新计时。无输出超时、无正文或进程成功退出但结果不可用时，仍保留 partial assistant output、activity context、usage 和 cost；完整 partial JSON 会被挽救，否则由独立的收尾 prompt 接收有界恢复上下文，不再重复源码检查任务。Auto assignment 优先使用同 provider runtime fallback；存在其他 committee provider 时，会在最多两个候选槽位中保留一个跨 provider 候选。DSL 显式 fallback 顺序也可以跨 provider。每次模型尝试前，运行中的任务都会把调度许可转移到实际 provider，因此 fallback 不会绕过 provider 并发限制。Settings 中显式指定的逐角色模型仍固定使用该模型。

常见且可确定的形态偏差会在验证前归一化：单个 Finding/evidence 对象包装为数组，缺失 evidence ID 自动生成，仅在行号或 source 字段含义明确时推断缺失 kind，`lines: "start-end"` 或正整数行号数组转换为 `startLine/endLine`，`path:start-end - excerpt` 引用字符串转换为未验证 code evidence，异常 `raisedBy` 替换为当前 Role，描述型 observation/question 对象转换为文本。Cross Review、Global Devil 和 Integrator resolution 使用同一套 evidence 归一化，`partial-support` 等常见 verdict 别名会映射到受支持枚举。非结构化 challenge、含义不明确的 evidence 和单条非法 challenge/Finding 会被隔离并留下记录，不再丢弃有效兄弟项；可恢复的 Devil 新 Finding 使用与 Independent Review 相同的宽容解析器。归一化记录只保留在对应 stage artifact，不再淹没 unresolved questions；所有生成证据仍必须通过源码和 Scope 校验。归一化不会编造缺失行号，也不会把模型输出直接升级为 verified evidence。源码匹配后、尚未被 challenge 的 Finding 保持 proposed；完整原始证据加 support 才进入 verified，correct 进入 disputed，带已验证反证的 object 可以进入 rejected。原始证据混合 stale/unavailable 或为空时仍保持 unsupported。

Cross Review 只接收归一化 Finding packet，不接收完整 Reviewer transcript。Global Devil 最多运行一次，对每条输入 Finding 返回 verdict，没有 Finding 时跳过。Integrator 可以提交结构化 Finding resolution，但只有经源码验证后才能改变状态。

Cross Review 首先选择达到 workflow 严重程度阈值、置信度较低或仍为 unsupported 的 Finding；有界选择器优先考虑严重程度、提出角色多样性、不确定性和薄弱证据。每条入选 Finding 会尽量交给原提出者之外的专家。该专家检查源码后只返回一种 verdict：`support`、`object`、`correct` 或 `abstain`，新的事实主张必须附带证据。Challenge 在全局和 provider 并发限制内并行运行，单条失败互不影响，最后按稳定的 Finding 顺序合并。它不能绕过源码验证：原始证据不完整时，Finding 仍保持 unsupported。

`code-review` 面向缺陷：重点是正确性、回归、兼容性、安全、性能、可维护性和测试缺口，通常要求行级证据。已验证的 medium/high/critical Finding 会触发 `Request Changes`。

`architecture-review` 面向系统：重点是模块边界、依赖方向、故障域、信任边界、可部署性、可观测性和演化约束，并拒绝 diff scope。报告会单独生成系统边界、关键数据流、架构权衡和分阶段建议。只有 critical Finding 直接触发 `Request Changes`；high/medium 系统性风险进入 `Needs Investigation`，作为明确架构决策继续处理。

## Profile

恢复收尾会接收一份独立于精简 UI activity log 的有界源码上下文，以及完整的 stage JSON 契约。该恢复专用上下文只由 Review 请求，不会加入普通 ask/agent 结果，也不会作为独立 artifact 持久化。含义明确时，`risk`、`sourceEvidence`、`observation`、`claim` 等常见恢复字段会被规范化。

并发 Reviewer 共享同一个 stage usage 计数器，因此已完成的超限只按最终累计用量报告一次。完成但只产生覆盖缺口的 Reviewer 显示为 `empty`。前序阶段的 unresolved questions 会传给无工具 Integrator；空 integration 响应不会删除它们，但 Integrator 可以根据归一化证据显式关闭已经回答的问题。Activity snapshot 会替换当前快照，同时保留 retry/recovery/fallback 的阶段转换记录，避免重复 partial output 填满日志。

`quick` 使用三个专家角色以及较小的 execution 次数、token、成本、工具调用和 agent turn 预算。Independent Review、Cross Review、Global Devil 的单次扫描上限分别为 12/6/4 次工具调用和 16/10/8 个 turn。每个独立 Reviewer 最多保留 3 条重要 Finding，Global Devil 最多接收 5 条经过选择的 Finding。它的 7 次 execution 按阶段预留为 3 次独立评审、最多 2 次 Cross Review、1 次 Global Devil 和 1 次 Integrator；下游阶段拥有独立资源份额。超出每项上限的 Finding 会记录在 stage artifact。`deep` 使用 code-review 的四个完整专家角色，每个专家最多保留 6 条、Devil 最多接收 10 条，使用更大预算，并把上述扫描上限提高到 24/12/8 次工具调用和 28/16/12 个 turn。Integrator 只整合已经验证的证据包，因此始终禁用工具并最多运行 4 个 turn。两种 profile 都保留 Devil 和 Integrator 阶段，但没有可挑战内容时会跳过 Devil。Profile 不设置 workflow 或单次 execution 的墙钟 deadline。

Token、成本和执行次数会在启动前分配单次 execution 的 prompt 目标，并在观察到真实阶段额度超限后阻止该阶段的后续 Role。最终 usage 只能在完成后获得，因此并发调用仍可能超出阶段或全局边界；这类已完成超限仍会写入诊断和 coverage 计数，但仅仅超过建议性的单次目标不再报告为预算故障。预算边界如果确实阻止必要节点启动，受影响阶段仍会降级。预算错误会准确指出耗尽维度、已用量和有效上限。当前 preset 的 voice timeout 仍用于保护持续无输出的 Review subagent；它独立于 quick/deep，并在持续产生输出时刷新。stderr 最多保留 256 KiB，并报告省略字节数。明确的限流、网络、无输出超时和 provider 5xx 最多重试三次，使用有界指数退避并遵守 `Retry-After`；结构化 HTTP status/code 优先于有边界的消息匹配。认证、配置校验、安全拦截和取消不会重试。raw direct API 请求拒绝自动重定向。重试、恢复、fallback 与最终错误都会标出 stage、role、provider/model、尝试次数和失败分类。

Usage 与成本统计包含每次 retry、禁止工具的恢复收尾和模型 fallback。最终失败的 Reviewer 会把已知 usage 写入运行总计和 execution artifact，但不会计入 completed/usable role；只要任一尝试的成本未知，聚合成本就保持未知，避免以部分总额低报实际消耗。

## 命令

```text
/chorus review [workflow] [options] <objective>
/chorus-review [workflow] [options] <objective>
```

示例：

```text
/chorus review code-review --profile quick 评审安全性和 API 兼容性
/chorus review code-review --staged 评审 staged 改动
/chorus review code-review --base origin/main --head HEAD --profile deep 评审这个 PR
/chorus review architecture-review --profile deep 评审模块边界和故障隔离
```

不带 objective 时，`/chorus review` 会打开交互式编写器。标题下方始终显示实际生效的 workflow/profile 和 scope/renderer。选择 `Settings` 可以原位修改本次运行，往返设置面板不会丢失 objective 草稿。面板支持受 workflow 约束的 scope、working/staged diff、file/document 路径、profile、renderer 和报告语言。报告默认使用简体中文，且不会把这些临时选择写入全局配置。

| 参数 | 行为 |
| --- | --- |
| `--profile quick\|deep` | 选择评审 profile |
| `--staged` | 解析 staged Git 变更 |
| `--base <ref> --head <ref>` | 解析 base/head Git 范围，必须同时提供 |
| `--constraint <text>` | 添加约束，可重复指定 |
| `--format <id>` | 显示 `markdown`、`json`、`github` 或 `sarif` |
| `--language zh-CN\|en` | 选择报告语言，默认 `zh-CN` |
| `--file <path>` | 加载相对当前 workspace 的 JSON/YAML 定义 |
| `--fail-on <severity>` | 对归一化 Finding 执行 CI policy |
| `--summary <path>` | 与 `--fail-on` 一起使用时写出 CI 摘要 |

目前还没有 `--working` 命令行参数。默认是 repository review；如需 unstaged working-tree diff，可以在交互式 Settings 中选择 `diff:working`，或通过 DSL 指定 `scope.kind: diff` 和 `selection: working`。

## Review DSL

定义文件支持 `.json`、`.yaml` 和 `.yml`。DSL 只能表达数据：未知字段、未知 stage、YAML alias、可执行 hook、路径逃逸、超大文件、过多 Role 和无界 Challenge 都会被拒绝。

```yaml
version: 1
workflow: design-review
profile: deep
language: zh-CN

objective:
  - 评审迁移安全性
  - 找出缺失的回滚步骤

constraints:
  - 保持向后兼容

scope:
  kind: files
  root: .
  paths:
    - docs/design.md

committee:
  - role: architect
  - role: security
  - role: maintainability
  - role: devil
  - role: integrator

stages:
  - independent-review
  - cross-review
  - devil
  - integrate

crossReview:
  severityAtLeast: high
  maxChallengesPerFinding: 1

devil:
  enabled: true

output:
  - markdown
  - json
```

运行：

```text
/chorus review --file review.yaml
```

`output` 中第一个 renderer 决定界面显示内容。Artifact 始终包含归一化 Markdown 和 JSON；GitHub 和 SARIF 可以作为界面 renderer。

## Agent 工具

其他 Agent 可以调用 `chorus_review`：

```json
{
  "objective": "评审鉴权和 API 兼容性",
  "workflow": "code-review",
  "constraints": ["保持公共 API"],
  "scope": {
    "kind": "diff",
    "selection": "staged",
    "root": "/absolute/path/to/repository"
  },
  "profile": "quick",
  "renderer": "json"
}
```

也可以用 `definitionPath` 替代 `objective`。

## Job 与 Artifact

Review 命令会创建后台 job：

```text
/chorus jobs
/chorus job <jobId>
/chorus watch <jobId>
/chorus cancel <jobId>
/chorus resume <jobId>
```

Watch 视图使用语义颜色区分 stage 与角色状态，同时保留文字标签。左/右或 Tab 切换角色，上/下逐行滚动，PageUp/PageDown 翻动一屏，Home/End 或 `g`/`G` 跳到开头/结尾；界面同时显示当前可见行范围与滚动百分比。Pi 目前不会把鼠标滚轮事件暴露给扩展自定义组件。

Artifact 以 owner-only 权限保存到 `~/.pi/agent/chorus/results/<jobId>/`：

```text
review-request.json
review-plan.json
stage-*.json
execution-*.json
execution-*-raw.txt
review-scope.diff
review-report.md
review-report.json
review-result.json
review-checkpoint.json
```

`review-scope.diff` 只在 diff scope 中生成，用于保存实际评审的完整 patch。Files/document/diff scope 在解析时记录源码 SHA-256；repository scope 在文件首次被引用时建立基线。如果同一次评审中被引用源码随后发生变化，该证据会以 `referenced source changed during the review` 标为 stale，报告记录变化文件数，执行状态降级。仅代码片段移动但内容仍存在时，会单独报告行号漂移。

Resume 会验证 workflow 版本、artifact 哈希和被引用源码哈希，才会复用连续完成的阶段。源码变化或 artifact 不匹配会触发重跑。如果进程在最终 review artifact 提交前崩溃，目前不会留下可恢复的 review snapshot。

## CI Policy

Pi 中运行：

```text
/chorus review code-review --staged --fail-on high --summary /tmp/chorus-summary.json 评审本次改动
```

Slash command 会报告 policy 状态，但不会终止 Pi 进程。需要 shell 退出码时使用构建后的 CLI：

```bash
node dist/cli/review-policy.js \
  ~/.pi/agent/chorus/results/<jobId>/review-report.json \
  --fail-on high \
  --summary /tmp/chorus-summary.json
```

| 退出码 | 含义 |
| ---: | --- |
| 0 | 通过 |
| 1 | 命中阻断 Finding |
| 2 | 评审不完整 |
| 3 | 输入无效 |
| 4 | 运行失败 |

## Renderer

- Markdown：面向人的评审报告
- JSON：无损版本化 `ReviewReport`
- GitHub：review event、摘要 body 和已验证 changed-line comment
- SARIF 2.1.0：带稳定 rule 和 fingerprint 的已验证代码 Finding

GitHub renderer 只生成 payload，不会调用 GitHub 或修改 PR。

## 效果评测

Seeded case 位于 `tests/fixtures/review/manifest.json`。显式运行付费 live 对照：

```text
/chorus review-eval --live tests/fixtures/review/manifest.json
```

每个 fixture 都会使用相同主模型偏好分别运行单 Generalist Reviewer 和委员会。指标包括召回率、未匹配 Finding、引用有效率、严重程度校准、决策正确率、耗时、成本和每个有效 Finding 的成本。

该命令可能产生数十次模型调用，CI 永远不会隐式执行。目前实现提供了测量机制，但尚未证明委员会在 live model 或真实开发者接受度上优于单 Reviewer。

## 自动化验证

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run verify
npm run prepublishOnly
```

只运行 Review Engine 单元测试：

```bash
npx vitest run 'tests/unit/review-*.test.ts'
```

最近一次完整门禁通过了 313 个 unit test、4 个 integration test、build、typecheck 和 lint。本次未运行付费 live-model 评测。

## 当前限制

- Review Engine 尚未发布为新的 npm 版本。
- 尚未通过 live 数据证明委员会优于单 Reviewer。
- GitHub 输出只是 payload renderer，不是网络集成。
- DSL 只有第一个 `output` renderer 决定界面响应。
- Working-tree diff 尚无命令参数，需要使用 DSL scope。
- Review 历史目前由 job 和 artifact 表达，不是长期 Belief 或 Case Management 系统。
- Review resume 需要已经提交的完整 review snapshot。
