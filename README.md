# Chorus

[![npm version](https://img.shields.io/npm/v/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![npm downloads](https://img.shields.io/npm/dm/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![license](https://img.shields.io/npm/l/@icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/blob/main/LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/releases/latest)

**English** | [中文](README.zh-CN.md)

**Chorus is a programmable AI Review Engine.** It organizes multiple expert roles into a bounded review process and produces evidence-based decisions instead of merely aggregating model responses. Models are replaceable participants; workflows, roles, source evidence, challenges, and review reports are the stable product contracts.

## Evidence-based review

```text
/chorus review code-review --profile quick --base origin/main --head HEAD review security and API compatibility
```

The built-in code workflow runs independent expert review, limited cross-review, one Global Devil challenge, source citation validation, and deterministic decision integration. `quick` uses three expert roles; `deep` uses architecture, security, performance, and maintainability. Architecture review instead uses architecture, reliability, security, and operability roles with system-level prompts and decision policy. Reports keep verified, disputed, rejected, and unsupported findings distinct.

```text
# Chorus 评审报告

结论：需要修改

## 已验证问题

### 高：资源加载发生在鉴权之前
证据：src/routes/users.ts:84-91 [已验证]
提出角色：security | 确认角色：architect

## 存在争议的问题

核对引用的 finally 块后，连接泄漏结论被驳回。
```

`quick` bounds interactive diff review to fewer expert roles and challenges. Each expert contributes at most three material findings, and Global Devil examines at most five. Its seven execution slots are reserved for three independent experts, at most two cross-reviews, one Global Devil, and one Integrator. Execution counts, source-inspection tool calls, and agent turns are hard limits. Input, output, and cost allocations are measured after each model call because the Pi subprocess cannot reliably stop midway through a structured JSON response; an overrun is reported and degrades execution status, while reserved downstream stages remain available. `deep` uses the full committee, larger finding limits, larger budgets, and higher inspection-depth limits for repository or architecture review. Reaching a tool-call or turn boundary stops further inspection and triggers a no-tool structured finalization from the material already collected. Neither profile stops a review based on elapsed wall-clock time; Duration is reported as an observed metric.

The original ask/agent fan-out APIs remain available as compatibility workflows.

### Run locally

```bash
npm install
npm run build
pi -e ./src/index.ts
```

Then configure models and run a review inside Pi:

```text
/chorus config
/chorus review code-review --profile quick review security and API compatibility
/chorus review code-review --staged --fail-on high --summary /tmp/chorus-summary.json review this change
```

Common review options:

| Option | Purpose |
| --- | --- |
| `--profile quick\|deep` | Select bounded interactive or full-committee review |
| `--staged` | Review the staged Git diff |
| `--base <ref> --head <ref>` | Review a Git revision range; use both together |
| `--constraint <text>` | Add a review constraint; repeatable |
| `--format markdown\|json\|github\|sarif` | Select the displayed renderer |
| `--language zh-CN\|en` | Select report language; defaults to Simplified Chinese |
| `--file <definition.yaml>` | Load a constrained Review DSL definition |
| `--fail-on <severity> --summary <path>` | Evaluate CI policy and write a JSON summary |

Run `/chorus review` without an objective to use the interactive review composer. It shows the effective workflow, profile, scope, and renderer before submission. `Settings` changes those values for this run without modifying the active Agent/Ask preset; switching workflows automatically removes incompatible scopes.

```text
------------------------------------------------------------------------
 Chorus Review draft
 Workflow: code-review | Profile: quick
 Scope: repository | Output: markdown

 Optional focus (blank = workflow default)

 [Submit]   Settings    Optimize    Cancel
------------------------------------------------------------------------
```

The focus field is optional. Submit it blank to use the selected workflow's built-in objective, or enter only the extra emphasis for this run, such as `focus on authorization and API compatibility; avoid broad redesign`. Review reports default to Simplified Chinese; select `Language: en` in Settings or pass `--language en` for English. The Settings panel also supports workflow, quick/deep profile, a per-role model override (`Auto` or any callable model), repository/files/document/diff scope, working/staged diff selection, comma-separated paths, and Markdown/JSON/GitHub/SARIF output. On a model row, press Enter or start typing to search by provider, model ID, or display name; left/right still cycles quickly. Role model choices are saved as defaults on the active Chorus preset and reused by later interactive and command-line Reviews; selecting `Auto` removes that role's saved override. Explicit Review DSL model policies remain authoritative. The resolved assignments are shown in the persistent started card. The draft remains intact when opening or closing Settings. Optimize now submits the optimized objective to the review while retaining the original objective in job metadata.

While a Review runs, Chorus keeps a compact widget above the editor showing the active stage plus every `role provider/model: status`. `/chorus watch <jobId>` keeps a node's error summary visible above its scrollable partial output and activity log. The scheduler defaults to five global reviewers and one reviewer per provider; preset `maxConcurrency` and `providerConcurrency` may explicitly change those limits. Quick/deep control inspection depth through stage-specific tool-call limits; they do not impose workflow or per-execution time limits. For Review subagents, the preset voice timeout remains an inactivity guard and resets whenever Pi emits stdout or stderr. Rate-limit, network, inactivity-timeout, and provider 5xx failures retry up to three attempts with bounded backoff. Partial output and bounded activity context survive a stalled inspection, a depth boundary, or an unusable successful response and are passed to a no-tool JSON finalization attempt. If that still fails, Auto routing prefers a same-provider model while retaining a bounded cross-provider committee fallback when available; explicit DSL fallbacks may also cross providers. Every fallback transfers its scheduler permit to the actual provider, preserving provider concurrency limits. Permanent failures report the stage, role, actual model, attempts, and category without retrying.

Reviewer-node failures are isolated: remaining roles and integration continue, and incomplete coverage produces a `needs-investigation` report with Job status `degraded` instead of falsely reporting complete success. Cross-review candidates are severity/evidence prioritized and run through the same global and per-provider concurrency controls as independent reviewers. Markdown reports show Complete/Degraded execution separately from the review decision, per-stage planned/usable/failed/omitted counts with their units, end-to-end wall-clock Duration, usable versus empty-result roles, and files represented by citations or explicit scope. These represented-file counts are not claimed as an exhaustive repository inspection trace. Compact execution diagnostics are kept separate from user-facing unresolved questions; full error chains and normalization notes remain in stage/execution artifacts. Common safe shape deviations are normalized before strict evidence validation, including missing evidence IDs/kinds and numeric line arrays. An invalid evidence item, Finding, or Devil challenge is isolated instead of discarding valid siblings. Source validation and Finding acceptance are separate: matching citations leave a Finding proposed, while a source-backed supporting challenge promotes its verified evidence into the Finding before verification. Source-backed objections may dispute or reject it. Integrator status corrections use the same structured, source-validated resolution contract and can close prior questions answered by normalized evidence, but deterministic coverage gaps remain. Evidence reads are capped at 2 MiB with four-worker validation. Role status becomes `success` only after normalized output passes validation, while an intentionally omitted stage is shown as `skipped`. Files and diff content are snapshotted, and a cited source that changes during the run is marked stale and degrades execution coverage. Global Devil is skipped when there are no findings to challenge. Only request/configuration, scope, persistence, or internal framework failures terminate the workflow.

See [Review Engine Guide](docs/REVIEW_ENGINE.md) for workflow scope rules, DSL, artifacts, CI exit codes, the `chorus_review` tool, live evaluation, security boundaries, and current limitations.

Review recovery uses a non-persisted, bounded source context separate from the compact activity log and supplies the full JSON contract to finalization. Completed roles with only coverage gaps are shown as `empty`; prior unresolved questions remain unless the Integrator closes them from normalized evidence, concurrent budget usage is accumulated per stage, and streaming activity snapshots no longer duplicate growing partial output.

## Ask Compatibility Example

One prompt is fanned out to multiple voices in parallel; a distinct conductor model then synthesizes **consensus**, **disagreements**, and a **final answer**.

```text
/chorus ask what do you think of pi agent
```

```text
# Chorus Result
Preset: default | Voices: 2/2 | Duration: 46.6s | Cost: $0.008

## Final Answer

### Consensus
- Both voices praise pi's native code-understanding stack — `ast-grep` / tree-sitter / LSP, plus `module_report` and `read_symbol` — as far more precise than grep or reading whole files.
- Both acknowledge the read-before-edit guard that blocks editing a symbol until it has been read.
- Both affirm the extension system (Skills, Extensions, Custom Tools) and the multi-agent orchestration story.
- Both position pi as a pragmatic, tool-oriented, AI-native coding framework — unflashy but durable.

### Disagreements
- **Subagent context** — voice[0] praises the explicit `small / medium / big` tiering for cost/quality control; voice[1] (its own author) complains subagents start fresh and don't auto-inherit the parent session's code context.
- **Safety vs. friction** — voice[0] finds the tool API "restrained, exposing only what's needed"; voice[1] feels some defaults (dry-run replace, exact-match edit) are occasionally over-protective.
- **Execution model** — voice[0] misses an explicit plan-then-execute path; voice[1] instead highlights token efficiency and turn-end advisories.

### Final Answer
Both voices rate pi highly and pragmatically. Its core strength is native code understanding and a tool-oriented design: rather than exposing IDE buttons, it offers AI-native primitives (AST search, module outlines, subagent orchestration) plus a strict read-before-edit guard. The remaining rough edges are subagent context inheritance and the balance between safety defaults and friction.

## Run Summary
- OK voice[0] model A | 17.7s | $0.008
- OK voice[1] model B | 18.2s | $0.000
- OK conductor | $0.000
```

Each voice's full output is persisted under `~/.pi/agent/chorus/results/<jobId>/` and can be watched live with `/chorus watch <jobId>`.

### Agent example: architecture review

`/chorus agent` is codebase-aware. Child agents default to the `read-only` permission profile; write-capable profiles require explicit opt-in. A main verification conductor cross-checks their claims against the actual code.

```text
/chorus agent review the architecture of this project: where are the seams that could split into modules, and what logic is duplicated across direct and subagent mode?
```

```text
# Chorus Result
Preset: default | Agents: 2/2 | Duration: 14m | Cost: $0.016

## Final Answer

### Verified findings
- **Mode duplication** - both agents flag that `runDirectVoice` and `runSubagentVoice` expose separate provider and process boundaries. RESOLVED: `runtime/execution-coordinator.ts` now owns shared voice fan-out, timeout, budget, retry, and result assembly.
- **Hardcoded concurrency** - both agents found that voice concurrency was fixed at 3 with no preset override. RESOLVED: concurrency is preset-configurable and now defaults to 5.

### Overstated / rejected
- Agent[1] claimed `malformedLines` is dead code - INCORRECT, it is thrown in `subagent.ts:141`.
- Agent[0] framed the registry-empty path as critical; the default `callPiModel` path bypasses it, so real severity is low.

### Final Answer
The runtime now shares bounded execution and exposes concurrency through presets. The two rejected claims show why the verification step matters: agents can be confident and wrong.

## Run Summary
- OK agent[0] model A | 11m | $0.009
- OK agent[1] model B | 9m | $0.007
- OK conductor (main verification) | 3m | $0.000
```

Child agents write `agent-N.md` + `agent-N-activity.md` (full tool trace); the conductor writes `final-report.md`. All persist under `~/.pi/agent/chorus/results/<jobId>/`.

### Interactive composer (no-arg invocation)

Running `/chorus agent` (or `/chorus ask`) with no arguments opens an interactive composer instead of failing or leaving the prompt empty. You can type or paste the prompt directly, or jump into preset configuration or prompt optimization from the same UI:

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

- **Submit** runs the prompt through the active preset.
- **Config** opens the preset manager in-place (also reachable via `/chorus config`); the composer stays open so you can resume typing afterwards.
- **Optimize** rewrites the prompt with the conductor's optimizer model. After optimizing, the status flips from `draft` to `optimized` and the button label changes to `Optimize again` — select it to re-run the optimizer on the latest text.
- **Cancel** discards the composer.

`/chorus ask` opens the same UI titled `Chorus Question` with placeholder `Question`. The button row is identical; only the title and placeholder change.

## Installation

Install from npm as a Pi package:

```bash
pi install npm:@icxcoffee/chorus
```

Or try it without modifying settings:

```bash
pi -e npm:@icxcoffee/chorus
```

Once installed, the `/chorus` slash commands and the `chorus_answer` tool are available in any Pi session.

### Codex and Claude Code Skill

Install the packaged Chorus Agent Skill for the current user with one command. This makes it available in every Codex and Claude Code project:

```bash
npx --yes --package=@icxcoffee/chorus@latest chorus-skill-install --scope user
```

For a new machine, install both the Pi extension and the user-level Skill in one shell command:

```bash
pi install npm:@icxcoffee/chorus && npx --yes --package=@icxcoffee/chorus@latest chorus-skill-install --scope user
```

Rerun with `--force` to update both user installations. To install a portable copy into one project instead:

```bash
cd /path/to/target-project
npx --yes --package=@icxcoffee/chorus@latest chorus-skill-install .
```

User scope writes under `$CODEX_HOME/skills` (default `~/.codex/skills`) and `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`). Project scope creates `.agents/skills/chorus-agent` and `.claude/skills/chorus-agent`, which can be committed with the target project. When developing from a persistent local Chorus checkout, build once and use link mode so Skill edits are immediately shared:

```bash
npm run build
node /path/to/chorus/dist/cli/install-skill.js /path/to/target-project --mode link
```

Invoke it as `$chorus-agent` in Codex or `/chorus-agent` in Claude Code.

## Development

```bash
npm install
npm run typecheck
npm run test:unit
pi -e ./src/index.ts
```

The extension registers:

- `/chorus config` for preset management and first-run validation.
- `/chorus ask [question...]` for running the active preset.
- `/chorus agent [task...]` for codebase-aware multi-agent runs. Child agents run first, then the conductor runs as a main verification agent over their outputs.
- `/chorus review [workflow] [objective...]` for role-based, evidence-backed code, architecture, or design review. Supports `--profile`, git diff scope, renderer, DSL file, and CI policy options.
- `/chorus review-eval --live <manifest.json>` for an explicit paid single-reviewer versus committee comparison; it never runs implicitly in CI.
- `/chorus jobs` lists recent background jobs.
- `/chorus job <jobId>` shows one job snapshot and points to result files when available.
- `/chorus watch <jobId> [agent-index]` opens a live, color-coded TUI view for one running or completed job. Use left/right or Tab to switch roles, Up/Down to scroll, PageUp/PageDown to move a page, and Home/End or `g`/`G` to jump to the beginning/end. Mouse wheel input is not exposed by Pi's custom-component API.
- `/chorus cancel <jobId>` aborts a running job.
- `/chorus resume <jobId>` validates reusable artifacts and launches a new attempt for incomplete stages.
- `/chorus history list|search|export|prune` manages persisted run history without printing full prompts in compact listings.
- `/chorus history show|compare|replay` inspects, compares, or reruns a selected run; replay requires `snapshot` or `current` explicitly.
- `/chorus batch <dataset.jsonl> [preset...]` runs a resumable dataset and writes per-case plus Markdown/JSON/CSV reports.
- `/chorus optimize [prompt...]` for manual prompt rewriting only.
- `chorus_answer` with `{ "prompt": string, "presetName"?: string }` for Agent tool use.
- `chorus_review` with an objective or constrained JSON/YAML `definitionPath` for structured Review Engine use.

The free-text commands each have two equivalent forms - a subcommand and a direct alias - that parse arguments identically:

```text
/chorus ask <question>      ≡  /chorus-ask <question>
/chorus agent <task>        ≡  /chorus-agent <task>
/chorus review <objective>  ≡  /chorus-review <objective>
/chorus optimize <prompt>   ≡  /chorus-optimize <prompt>
/chorus config [action]     ≡  /chorus-config [action]
```

Use whichever you prefer; both feed the same prompt string to the voices. (Quoted or multi-word prompts are normalized the same way either way.)

## Modes

Direct mode calls provider APIs through adapters and computes cost from provider usage and model pricing. Subagent mode spawns `pi --mode json -p --no-session --model provider/modelId` for codebase-aware voice runs and parses NDJSON usage/cost events.

The evolved runtime also provides stable strategy runners (`parallel`, `debate`, `rank`, `refine`), optional budgets/retry/routing/cache/batch APIs, typed local events, resumable checkpoints, and bounded conductor streaming. See [Architecture](docs/ARCHITECTURE.md) for ownership, defaults, privacy, and rollback details.

Preset JSON may opt into `budget` (`maxUsd`, `maxInputTokens`, `maxOutputTokens`, `maxVoices`, `conductorReserveUsd`) and `cachePolicy` (`enabled`, `ttlMs`, `maxEntries`, `bypass`). Cache is forcibly disabled for subagent/session-history runs unless explicitly allowed. Budgeted runs launch voices serially so actual usage can stop queued work before it exceeds the configured limit.

Subagent `permissionProfile` supports `read-only`, `workspace-write`, and `full`. Read-only is enforced with Pi's `--tools read,grep,find,ls`. Workspace write excludes `bash` and requires `CHORUS_ALLOW_WORKSPACE_WRITE=1`; full requires `CHORUS_ALLOW_FULL_ACCESS=1`. Pi cannot constrain edit/write to the current directory, so write-capable profiles are explicit trust decisions.

### Session history sharing

By default, child agents spawned in subagent mode are **session-isolated** — they only see the Chorus task you submitted, not the surrounding Pi chat. This keeps your scratchpad, side comments, and unrelated conversation out of the model context. The setting is per-preset (stored as `includeSessionHistory` in `~/.pi/agent/chorus/config.json`).

Toggle the default with:

```text
/chorus config history on    # child agents see this chat
/chorus config history off   # child agents only see the task
```

What honors the flag, and what doesn't:

- **Subagent-mode voices** (worker agents) follow the preset. When `on`, the child `pi` process is spawned without `--no-session`, so it inherits the parent Pi session.
- **Direct-mode voices** are unaffected — they call provider APIs directly and never see session history regardless of this flag.
- **`/chorus agent`'s main verification conductor** is always isolated, even when `history on`. It receives only the child-agent evidence file as its context, so it can verify claims against the agents' actual outputs without being biased by the user's chat.
- **The `chorus_answer` tool** (used by other agents) also respects the preset, so a tool caller that picks `presetName: foo` inherits foo's history policy.

Trade-off: `history on` makes the agent understand context cues like "as I mentioned above, …" but widens the prompt and may leak earlier conversation into unrelated tasks. Leave it `off` unless the task explicitly needs the surrounding chat.

Use config commands to switch mode and timeouts:

```text
/chorus config mode direct
/chorus config mode subagent
/chorus config history on
/chorus config history off
/chorus config timeout voice 2h
/chorus config timeout conductor 1h
/chorus config timeout conductor default
```

`/chorus config timeout <duration>` remains a shorthand for the voice/agent timeout. Durations accept milliseconds, `Ns`, `Nm`, `Nh`, or `default`.

## Ask vs. agent

`/chorus ask` and `/chorus agent` are **not** a "direct mode" / "subagent mode" pair — they are two different run shapes:

- **`/chorus ask`** runs the active preset's voices and synthesizes the responses. The preset's `mode` (direct or subagent, configured via `/chorus config mode`) decides how each voice is invoked. Use it for free-form questions where code-repo access is not needed.
- **`/chorus agent`** is always subagent mode and always codebase-aware: child agents use the configured permission profile (read-only by default) and produce evidence under `results/<jobId>/`. A separate **main verification conductor** then runs as a fresh agent over the evidence file to verify or reject the child agents' claims. Use it for tasks that need the agents to actually explore the repo.

Other concrete differences:

| | `/chorus ask` | `/chorus agent` |
| --- | --- | --- |
| Mode | preset's `mode` (configurable) | hardcoded `subagent` |
| Synthesis | simple conductor over voice outputs | main verification agent over evidence |
| Codebase access | only in subagent mode | always |
| Persisted artifacts | per-voice output + synthesis | `request.md`, `main-agent-input.md`, `agent-N.md`, `agent-N-activity.md`, `main-agent-activity.md`, `final-report.md`, `result.json` |
| Conductor session | isolated (no parent chat) | isolated (only the evidence file) |

In short: pick `ask` for "compare answers from these N models" and `agent` for "have N agents investigate this repo and verify each other".

## Configuration And History

Config and history live under `~/.pi/agent/chorus/`:

- `config.json` stores `{ configVersion: 2, activePresetName, presets }`. Each preset may include validated `reviewRoleModels` defaults. Version 1 files are migrated atomically after validation; legacy strategies `A/B/C` map to `parallel/debate/rank`. Optional `includeSessionHistory` defaults to `false`, and voice/conductor timeouts default to 30 minutes. `optimizeBeforeAsk` is no longer part of v2; legacy `true` values are rejected because prompt optimization remains an explicit workflow.
- `history.jsonl` appends one full `ChorusResult` per run.
- `jobs.json` stores recent background job snapshots. Running jobs from a previous Pi process are marked `stale` because they cannot be reattached after reload.
- `results/<jobId>/` stores agent run artifacts such as `request.md`, `main-agent-input.md`, `agent-0.md`, `agent-0-activity.md`, `main-agent-activity.md`, `final-report.md`, and `result.json`.

Files are created with owner-only permissions where the platform supports it. v1 keeps history indefinitely and does not include a history browser or retention policy.

## Privacy

Chorus persists the **full content of every prompt, voice response, conductor synthesis, activity log, and error message** under `~/.pi/agent/chorus/` (mode 0o600). This directory may contain private codebase context, secrets echoed in provider stack traces, or other sensitive content. Treat it as you would `.env` files: do **not** commit it, do **not** sync it to cloud backup without encryption, and consider excluding it from shell history and editor session restore.

Error messages redact common credential shapes (Bearer tokens, `sk-...` API keys, `Authorization` / `x-api-key` / `proxy-authorization` / `set-cookie` headers, `key=value` query parameters including `api_key`/`token`, JSON secret fields, and URL `userinfo:password@` credentials) before they enter history. This is best-effort and may not cover every provider error format.

History is retained up to the most recent **1000 runs** by default; older runs are pruned automatically when new ones are appended. Run `/chorus history prune [N]` to manually prune to the last `N` entries. The directory is created with owner-only permissions (`0o700` for directories, `0o600` for files).

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```
