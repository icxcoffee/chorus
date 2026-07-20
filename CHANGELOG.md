# Changelog

All notable changes to Chorus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-20

### Changed

- Config v2 migrates legacy strategy IDs to stable identifiers and removes unsupported `optimizeBeforeAsk`.
- `runChorus` delegates bounded voice work to shared execution, scheduling, budget, retry, evidence, and persistence contracts.
- Review profiles no longer impose five/fifteen-minute wall-clock deadlines. Review subagents instead reset the preset timeout whenever stdout or stderr activity arrives, and stalled executions retain partial context for a no-tool finalization attempt and same-provider fallback.
- Review reports default to Simplified Chinese across reviewer prompts, integration output, Markdown, and GitHub rendering; interactive Settings, `--language en`, and Review DSL `language: en` retain explicit English output.
- Quick Review reserves execution capacity per stage so Cross Review cannot consume the Global Devil or Integrator slots; excess challenge candidates are recorded as omitted.
- Quick and Deep Review now bound findings per expert and per Global Devil pass, prioritize challenge candidates deterministically, and run Cross Review through the provider-aware scheduler.
- Global voice and reviewer concurrency now defaults to five; explicit preset and per-provider limits remain authoritative.
- Review coverage now distinguishes usable and empty-result roles, labels cited/explicit paths as files represented in the report instead of exhaustive inspection coverage, and shows units for per-stage counts; decisions and CI completeness use usable review signal.
- Review coverage now records planned, attempted, usable, failed, and omitted work per stage; malformed or missing Global Devil challenges produce partial coverage.
- Source citation verification no longer automatically accepts a Finding. Independent support promotes its verified evidence into a source-backed proposal, and structured Integrator resolutions can dispute or reject it after validating counter-evidence.
- The Integrator can close duplicated prior questions answered by normalized evidence, while deterministic coverage gaps remain in the final report.
- Reviewer normalization records now stay in stage artifacts, while reports expose bounded execution diagnostics separately from user-facing unresolved questions.
- Preset execution options are derived through one shared mapping for Ask, Agent, tool, and batch runs; batch still isolates session history while honoring concurrency, permissions, timeouts, budgets, and cache policy.
- Direct and main-agent synthesis now share successful-output selection and bounded evidence preparation without coupling their execution mechanisms.

### Fixed

- Preserve subagent partial output, activity, usage, and cost when Pi times out or exits without assistant text instead of discarding recoverable work.
- Normalize safe, common reviewer JSON shape deviations before strict source evidence validation, and skip Global Devil when no findings exist to challenge.
- Mark incomplete Review jobs as `degraded`, show execution completeness in Markdown, and report end-to-end wall-clock duration instead of summing successful nodes only.
- Normalize recoverable Cross Review and Global Devil evidence shapes before strict validation, including missing IDs and line-range aliases.
- Detect cited sources that change during a Review, mark their evidence stale, and degrade coverage; diff reviews also persist the exact owner-only `review-scope.diff` artifact.
- Coalesce subagent progress updates, decode split UTF-8 safely, and finalize trailing NDJSON without retaining and reparsing all stdout.
- Evict RunCache entries by filesystem modification time without reading and parsing every cached value, clean corrupt entries when they are read, and avoid sort work while the cache is within its limit.
- Expand the Pi 0.80 credential environment contract passed to allowlisted subagents, including MiniMax China, Hugging Face, GitHub Copilot, Vertex AI, temporary AWS credentials, and container/web-identity AWS authentication.
- Preserve bounded activity and recovery context in successful Review finalization artifacts instead of retaining it only for terminal failures.
- Use pi-ai's exported model, context, options, and usage contracts at the compatibility boundary with runtime model-shape validation.
- Recover unambiguous reviewer evidence with missing kinds or numeric line arrays, isolate invalid evidence/Finding items, and classify remaining schema failures as `output-format` instead of dropping an entire reviewer response.
- Keep Review role status `running` until normalized output passes validation; completion now preserves reviewer errors and renders intentionally omitted stages such as Global Devil as `skipped` rather than `error`.
- Reserve input-token, output-token, and cost capacity for Global Devil and Integrator, with dimension-specific budget diagnostics, so verbose earlier stages cannot starve terminal review work.
- Isolate malformed Global Devil challenges, normalize supported verdict aliases, and recover valid Devil-created findings without discarding sibling output.
- Require non-empty, entirely verified evidence before a Finding can become verified; mixed stale or unavailable evidence remains unsupported.
- Flush terminal and canceled job state before background runners return, and track detached subagent process groups for best-effort cleanup on normal parent exit.
- Bound repository scope hashing with canonical containment, streaming SHA-256, and a four-worker pool; avoid full history reads until retention or external mutation requires recounting.
- Apply endpoint safety checks to registry-managed Pi model calls before authentication or invocation, and constrain the pi-ai peer compatibility range to `>=0.80.6 <0.81.0`.
- Guarantee dedicated Cross Review resource capacity even when concurrent Independent Review exceeds its target allocation.
- Bound Evidence reads to 2 MiB plus one byte, reuse canonical file content within a set, and validate files with four ordered workers.
- Retain only a 256 KiB subagent stderr tail with omitted-byte accounting and credential redaction.
- Coalesce text-only Review progress snapshots at 500 ms with one active write and one latest dirty state; terminal flush propagates persistence failures.
- Prefer structured HTTP status/provider codes for retry classification and reject automatic redirects in raw direct API calls.
- Register built-in strategies, Review workflows/stages, and renderers explicitly and idempotently so `sideEffects: false` consumers retain them after tree-shaking.
- Treat source-inspection-only reviewer output as a coverage failure and try the next configured fallback model; bounded recovery can retain up to four source citations for one finding.
- Collapse empty-role inspection gaps into one deterministic final-report coverage message while preserving raw per-role questions in stage artifacts.
- Use one owner-only atomic replacement primitive for config/store snapshots, run and Review artifacts, CI summaries, and resumable batch checkpoints/reports.
- Continue independent-review fallback across natural Chinese source-inspection gap wording, and collapse every raw question from an empty role into the deterministic coverage summary.
- Preserve a cross-provider committee fallback within the two-candidate bound and transfer scheduler permits when a running reviewer changes provider, so fallback diversity does not bypass provider concurrency limits.
- Mark Settings model overrides as explicitly pinned so committee fallback augmentation cannot silently replace the selected per-role model contract; DSL policies retain their existing fallback semantics.
- Skip prompt serialization, SHA-256 cache-key generation, and cache get/set calls entirely when run caching is disabled by policy.
- Snapshot stage outputs before later challenges mutate shared Findings, and clone resumed Findings before rerunning an incomplete stage prefix.
- Include the resolved model endpoint in RunCache identity, delete TTL-expired entries on read, and avoid stale hits after endpoint changes.
- Relocate uniquely matching code evidence across common indentation and blank-line differences, and retry an empty source inspection once before no-tool finalization.
- Degrade Review execution and CI completeness on measured token/cost overruns, and search Windows `PATHEXT` entries individually when resolving Pi.

### Added

- Strategy and provider registries, typed events and metrics, routing, budgets, retry/fallback, cache, streaming, batch execution, quality evaluation, and resumable checkpoints.
- Streaming history list/search/export, atomic artifact writes, private subagent profiles, and expanded integration/security coverage.
- A versioned Review Engine domain with expert roles, source-backed findings, bounded code/design/architecture workflows, cross-review, Global Devil challenge, and normalized decision reports.
- `/chorus review`, `chorus_review`, quick/deep profiles, constrained JSON/YAML review definitions, resumable review artifacts, Markdown/JSON/GitHub/SARIF renderers, git diff scope, and CI policy exit codes.
- Seeded review evaluation fixtures, transparent quality metrics, and a same-model single-reviewer baseline.
- Bundler regression coverage that executes advanced strategies and resolves every built-in Review workflow after esbuild tree-shaking.

### Security

- Conductor evidence is escaped and context-bounded; child environments use a centralized Pi credential allowlist and write-capable profiles require explicit opt-in.
- Reject Git base/head values that could be interpreted as options at CLI, request-validation, and final argv boundaries.

## [0.1.3] - 2026-07-11

### Fixed

- `/chorus-ask`, `/chorus-agent`, and `/chorus-optimize` now parse their arguments identically to their `/chorus ask` / `/chorus agent` / `/chorus optimize` counterparts. Previously the direct aliases passed `args.trim()` straight through, while the subcommand form routed through shell-style quote stripping (`splitCommandArgs`), so quoted or multi-space prompts fed different prompt strings to the voices depending on which alias was used. Both forms now go through the same `joinArgs()` normalization.

### Added

- README: an `/chorus agent` example showing a codebase architecture review - child agents explore the repo and the main verification conductor cross-checks their claims against the actual code (verifying, rejecting, and restating findings).
- README: document that `/chorus ask` / `/chorus agent` / `/chorus optimize` / `/chorus config` each have an equivalent direct alias (`/chorus-ask`, `/chorus-agent`, `/chorus-optimize`, `/chorus-config`) that parses arguments identically.

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
