# Chorus Architecture

## Product Boundary

Chorus is a stateless AI Review Engine. Review workflows organize stable expert roles into evidence-backed findings and decisions. Models, providers, scheduling, and retries are replaceable execution infrastructure. Persisted history and checkpoints are operational records; they are not a belief graph or cross-session reasoning state.

## Review Data Flow

`/chorus review` and `chorus_review` normalize a versioned `ReviewRequest`, resolve an explicit workspace or diff scope, select a built-in or constrained DSL workflow, and map logical reviewer roles to available models. The workflow runner executes independent review, prioritized provider-aware Cross Review, one Global Devil challenge, and integration. Source verification and Finding acceptance are separate state transitions: matching evidence leaves a proposal source-backed but proposed; complete original evidence plus independent support verifies it, while validated objections can dispute or reject it. Integrator corrections use the same structured resolution path instead of mutating report prose only.

The normalized `ReviewReport` is the source of truth. Markdown, JSON, GitHub, SARIF, and CI policy outputs consume that object directly and never recover semantics by parsing prose. Review artifacts persist the request, resolved plan, every stage, raw role output, normalized reports, and a checkpoint containing artifact and cited-source hashes.

## Data Flow

`activate()` registers commands and the `chorus_answer` tool. Run-shaped commands share `commands/run.ts`, create a durable job, then call `runChorus()` as the compatibility lifecycle entry point. Voice work passes through the execution coordinator and shared scheduler. Direct and subagent executors return the same `VoiceResult` contract. Successful outputs are packed as bounded, escaped evidence before conductor synthesis. Artifacts commit before final result metadata; jobs and history use atomic owner-only persistence. Terminal background-run and cancel paths flush the job store before returning so the durable status is not left behind a debounce timer.

## Ownership

- `runtime/`: coordination, scheduling, budgets, retry, events, checkpoints, cache, streaming, and batch execution.
- `strategies/`: stable strategy registry plus parallel, debate, rank, and refine runners.
- `providers/`: credential-free adapter registry, capabilities, and endpoint safety.
- `synthesis/`: evidence packing and structured quality normalization.
- `review/`: versioned review contracts, validation, scope, model policy, findings, runner, profiles, evaluation, DSL, CI policy, checkpoints, and service entry point.
- `roles/`: stable reviewer responsibilities independent of providers and models.
- `workflows/`: policy-enforced stages plus code, architecture, and design workflow definitions.
- `evidence/`: source validation and optional namespaced validation policies.
- `renderers/`: Markdown, JSON, GitHub review, and SARIF projections over `ReviewReport`.
- `store.ts`, `jobs.ts`, `artifacts.ts`: config, history, job, and artifact durability.
- `commands/`, `ui/`, `render/`: Pi integration and presentation.

## Compatibility And Defaults

`runChorus()` and existing commands remain compatible. Config v1 migrates atomically to v2; `A/B/C` become `parallel/debate/rank`. Session history, dynamic routing, budgets, retry, cache, streaming, batch execution, and write-capable subagent profiles are opt-in. Global voice/reviewer concurrency defaults to five, while Review keeps a default per-provider limit of one. Evidence reserves conductor output space and never replaces full artifacts.

Review work uses read-only Pi subagents by default. `quick` limits expert roles, findings, challenges, executions, tokens, and cost for interactive diff review; `deep` expands those budgets for repository review. Execution and resource allocations are reserved separately for Cross Review, Global Devil, and Integrator so concurrent expert overshoot cannot starve downstream work. Neither profile imposes a workflow or per-execution wall-clock deadline; elapsed Duration is observational. Integrator consumes already normalized, source-validated finding packets without repository tools. Cross-review receives normalized finding packets rather than raw reviewer transcripts and reuses the provider-aware scheduler. Normalization audit records stay in stage artifacts, while compact operational diagnostics are a separate report field. Coverage records planned, attempted, usable, failed, and omitted work per stage, and distinguishes completed roles from usable signal and explicitly scoped files from cited sources. Review scopes snapshot explicit files and cited repository sources so mid-run mutations degrade coverage instead of silently validating stale evidence. Scope hashing and Evidence validation canonicalize containment, stream or bound file reads, cache per-path content, and use bounded worker pools. Custom workflow definitions may compose only registered policy-enforced stages and cannot contain executable hooks.

Subagents default to `read-only`; `workspace-write` and `full` require explicit environment confirmation. Child environments are allowlisted. Retained stderr is a 256 KiB tail with omitted-byte accounting. Detached child process groups are tracked and receive a best-effort SIGTERM during normal parent exit; an uncatchable parent SIGKILL remains an operating-system limitation. Review progress persistence uses immediate state-transition scheduling, 500 ms text coalescing, and one active plus one dirty snapshot. History, local event journals, metrics, cache entries, and batch datasets remain local but may contain task-derived metadata; cache and session sharing should stay disabled for sensitive or mutable work. History pruning caches the observed entry count and size and performs a full read only after external mutation or when retention is exceeded.

Strategy runners own round prompts and return every round for cost and artifact accounting. Resume validates artifact hashes, reuses only the initial successful round, and starts a new attempt for incomplete work; cumulative cost is retained separately. Structured-capable adapters use native JSON Schema, while other conductors may append a validated tagged payload after compatible Markdown output.

Review resume separately validates workflow version, stage artifacts, and every cited source hash. A changed source or tampered artifact invalidates reuse. Review definitions reject path escapes, YAML aliases, unknown fields/stages, oversized documents, excessive roles, and unbounded challenge counts.

Provider endpoints are checked before registry-managed authentication or model invocation as well as before raw HTTPS calls. Raw direct calls reject automatic redirects. Loopback HTTP remains available for local development; cloud metadata and other unsafe endpoints are rejected consistently. Retry classification prefers structured HTTP status/provider codes before bounded text fallback. The `@earendil-works/pi-ai` peer range is intentionally limited to compatible `0.80.x` releases (`>=0.80.6 <0.81.0`), and the runtime model-shape guard remains at the compatibility boundary. Expand that range only after the new minor line passes the compatibility-boundary unit tests and the full build gate.

## Upgrade And Rollback

Back up `~/.pi/agent/chorus/` before upgrading. The first successful config load validates and rewrites v1 as v2. To roll back to a v1 release, restore the backup because older versions do not understand v2. Cache and event files are optional and may be deleted; result artifacts and JSONL history remain readable.
