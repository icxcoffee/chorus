# Chorus

[![npm version](https://img.shields.io/npm/v/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![npm downloads](https://img.shields.io/npm/dm/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![license](https://img.shields.io/npm/l/@icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/blob/main/LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/releases/latest)

**English** | [中文](README.zh-CN.md)

Chorus is a Pi extension that sends one prompt to multiple LLM voices in parallel, then asks a distinct conductor model to synthesize the successful responses.

## Example

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
- `/chorus jobs` lists recent background jobs.
- `/chorus job <jobId>` shows one job snapshot and points to result files when available.
- `/chorus watch <jobId> [agent-index]` opens a live TUI view for one running or completed job.
- `/chorus cancel <jobId>` aborts a running job.
- `/chorus optimize [prompt...]` for manual prompt rewriting only.
- `chorus_answer` with `{ "prompt": string, "presetName"?: string }` for Agent tool use.

## Modes

Direct mode calls provider APIs through adapters and computes cost from provider usage and model pricing. Subagent mode spawns `pi --mode json -p --no-session --model provider/modelId` for codebase-aware voice runs and parses NDJSON usage/cost events.

By default, child agents are session-isolated. Use `/chorus config history on` to let child agents inherit the current Pi session history, or `/chorus config history off` to restore isolation. The `/chorus agent` conductor/main verification agent stays isolated and receives the child-agent evidence file instead of the parent session history.

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

## Configuration And History

Config and history live under `~/.pi/agent/chorus/`:

- `config.json` stores `{ configVersion: 1, activePresetName, presets }`.
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
