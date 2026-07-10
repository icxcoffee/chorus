# Chorus

[![npm version](https://img.shields.io/npm/v/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![npm downloads](https://img.shields.io/npm/dm/@icxcoffee/chorus?style=flat-square)](https://www.npmjs.com/package/@icxcoffee/chorus)
[![license](https://img.shields.io/npm/l/@icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/blob/main/LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/icxcoffee/chorus?style=flat-square)](https://github.com/icxcoffee/chorus/releases/latest)

Chorus is a Pi extension that sends one prompt to multiple LLM voices in parallel, then asks a distinct conductor model to synthesize the successful responses.

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

Prompts and model outputs may contain private codebase context. Do not commit files from `~/.pi/agent/chorus/`. Error messages redact bearer tokens from provider errors before rendering.

## Verification

```bash
bash .ai/verification/fast.sh
bash .ai/verification/full.sh
```
