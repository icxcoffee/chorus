# Changelog

All notable changes to Chorus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-10

### Added

- Initial public release of Chorus as a Pi extension.
- `/chorus config` command for preset management and first-run validation.
- `/chorus ask [question...]` to run the active preset through fan-out voices and synthesize the result.
- `/chorus agent [task...]` for codebase-aware multi-agent runs with a separate main verification conductor.
- `/chorus jobs`, `/chorus job <jobId>`, `/chorus watch <jobId>`, `/chorus cancel <jobId>` for background job lifecycle.
- `/chorus optimize [prompt...]` for manual prompt rewriting without invoking a preset.
- `chorus_answer` LLM tool that fans a prompt out to multiple voices and returns the synthesized answer.
- Direct mode (provider API adapters) and subagent mode (`pi --mode json -p` child agents).
- Per-job artifact persistence under `~/.pi/agent/chorus/results/<jobId>/` (request, agent-N, conductor, final report).
- Configurable timeouts for voice and conductor runs (`/chorus config timeout`).
- Opt-in session-history sharing for child agents (`/chorus config history on|off`); conductor stays isolated by default.
- NDJSON usage and cost parsing for subagent runs.
- Token usage and cost rollup across voices and the conductor.
- Bearer-token redaction in provider error messages.
- Unit test suite covering orchestration, models, subagent mode, jobs, store, defaults, and UI rendering.

### Security

- Files under `~/.pi/agent/chorus/` are written with owner-only permissions where supported.

[0.1.0]: https://github.com/icxcoffee/chorus/releases/tag/v0.1.0
