# Changelog

All notable changes to Chorus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-07-11

### Fixed

- `/chorus-ask`, `/chorus-agent`, and `/chorus-optimize` now parse their arguments identically to their `/chorus ask` / `/chorus agent` / `/chorus optimize` counterparts. Previously the direct aliases passed `args.trim()` straight through, while the subcommand form routed through shell-style quote stripping (`splitCommandArgs`), so quoted or multi-space prompts fed different prompt strings to the voices depending on which alias was used. Both forms now go through the same `joinArgs()` normalization.

### Changed

- README example uses generic `model A` / `model B` placeholders instead of specific provider/model ids.

[0.1.3]: https://github.com/icxcoffee/chorus/releases/tag/v0.1.3

## [0.1.2] - 2026-07-11

### Added

- Chinese translation of the README (`README.zh-CN.md`), linked from the English README via a language switcher. Shipped in the npm tarball alongside `README.md`.

### Changed

- Sync `package-lock.json` to `@earendil-works/pi-ai@0.80.6` so `npm ci` succeeds in CI (the 0.1.1 lockfile still pinned 0.80.3 while `package.json` required `>=0.80.6`).
- Remove `SECURITY.md`; vulnerability reporting now relies solely on GitHub Private Vulnerability Reporting (the PVR button works independently of this file).
- Gitignore local-only `AGENTS.md` (AI operational notes, not shipped).

[0.1.2]: https://github.com/icxcoffee/chorus/releases/tag/v0.1.2

## [0.1.1] - 2026-07-11

### Security

- Harden `assertSafeEndpoint()` to block IPv4-mapped IPv6 forms of cloud-metadata IPs (e.g. `https://[::ffff:169.254.169.254]/`) that previously bypassed the link-local/metadata guard.
- Block DNS-based cloud metadata service hostnames (`metadata.google.internal`, `metadata`, `metadata.aws.internal`) in direct mode.
- Redact credentials in the `chorus history append failed` error path before printing to stderr.
- Owner-only permissions (`0o700`/`0o600`) now documented and enforced for `~/.pi/agent/chorus/`.
- History retention capped at 1000 runs with `/chorus history prune [N]` manual control.

### Fixed

- Replace tab indentation with spaces in `src/chorus.ts`, `src/role-prompts.ts`, and two test files so `npm run lint` passes and CI is green.
- Disable source maps / declaration maps in the build config so `dist/` ships without `.map` files and the CI map check succeeds.
- `npm audit` step in CI no longer silently skipped (`continue-on-error` removed).
- `npm pack` tarball relies on the `files` allowlist; redundant `.npmignore` removed.
- README verification section now references public commands instead of gitignored `.ai/verification/` scripts.
- Add `publishConfig.access: public` so scoped package publishes stay public.

[0.1.1]: https://github.com/icxcoffee/chorus/releases/tag/v0.1.1

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
