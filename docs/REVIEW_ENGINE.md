# Chorus Review Engine Guide

Chorus organizes replaceable models into a stateless review process. Review roles propose findings, source validators check citations, bounded challenge stages test material claims, and the integrator produces a versioned `ReviewReport`. Model output is provenance, not factual evidence.

## Prerequisites

- Node.js 22.19 or newer
- A working `pi` binary
- A Chorus configuration with enough callable models for reviewer assignments
- A Git repository when using diff scope

The Review Engine currently exists in the repository worktree and has not been released as a new npm version. Run it locally:

```bash
cd /path/to/chorus
npm install
npm run build
pi -e ./src/index.ts
```

Inside Pi, run `/chorus config` before the first review. Review roles use Pi subagents and default to the active preset's `read-only` permission profile.

## Workflows

| Workflow | Default experts | Supported scope |
| --- | --- | --- |
| `code-review` | Architecture, security, performance, maintainability | Repository, files, Git diff |
| `architecture-review` | Architecture, reliability, security, operability | Repository, files, documents |
| `design-review` | Architecture, security, maintainability | Files or document scope only |

Every built-in workflow uses the same policy-enforced stage vocabulary:

1. `independent-review`
2. `cross-review`
3. `devil`
4. `integrate`

Independent expert roles use bounded scheduling: at most five run globally by default, and reviewers sharing a provider run one at a time by default because provider/model concurrency limits vary. Cross-review uses the same scheduler and limits instead of serially awaiting every challenge. Candidates are deterministically prioritized by severity, role diversity, status, confidence, and evidence quality before the profile limit is applied. Preset `maxConcurrency` and `providerConcurrency` can explicitly override those limits. `/chorus watch` reports the active stage and streams each role's running state, tool activity, partial output, failure, and completion. The result directory is created at startup with `review-request.json` and a bounded `review-progress.json`, so a slow or interrupted model call remains diagnosable before the final report is committed.

A reviewer-node failure is isolated from the workflow. Other reviewers and the Integrator continue; Global Devil runs only when there are findings to challenge. Failed roles remain visible as errors. A completed role is counted as usable when it produced findings, positive observations, or a clean empty result; a response containing only coverage-gap questions is recorded as an empty-result role. Decisions and CI completeness use usable roles, while reports retain completed and empty-role counts. Represented files are the union of explicitly scoped paths and cited source paths, with both components reported separately; this metric is not an exhaustive trace of every file opened by a reviewer. Concise coverage gaps enter unresolved questions, while technical failures are grouped by stage, role, and category in the separate Execution Diagnostics section (at most 20 groups); complete chains remain in stage/execution artifacts. The Integrator may resolve a prior question when normalized evidence answers it, but it cannot remove deterministic coverage gaps. Coverage and stage status record incomplete work, and the deterministic decision becomes `needs-investigation` when required coverage is incomplete. Incomplete execution is reported as Job status `degraded`, separately from the review decision, and report Duration is end-to-end wall-clock time. Even if every independent reviewer fails, Chorus still produces an auditable incomplete report. Invalid requests/scopes, unusable configuration, artifact persistence failure, and internal framework exceptions remain job-level failures.

Reviewer source inspection must finish with structured JSON. Quick/deep control scan depth with stage-specific tool-call and agent-turn limits and do not impose workflow or per-execution wall-clock deadlines. When inspection reaches either depth boundary, Chorus retains the material already collected and runs a no-tool structured finalization. The preset voice timeout acts as an inactivity guard for Review and resets on every stdout/stderr chunk. Inactivity-timeout, no-text, and successful-but-unusable results retain partial assistant output, activity context, usage, and cost; complete partial JSON is salvaged, otherwise a standalone finalization prompt receives the bounded recovered context without repeating the source-inspection task. Auto assignments prefer same-provider runtime fallbacks and reserve one of two bounded candidate slots for a different committee provider when available. Explicit DSL fallback order may also cross providers. Before each model attempt, the running task transfers its scheduler permit to the actual provider, so fallback cannot bypass provider concurrency limits. Explicit per-role Settings overrides stay pinned to the selected model.

Common deterministic shape deviations are normalized before validation: a single Finding/evidence object becomes an array, missing evidence IDs are generated, a missing kind is inferred only from unambiguous line/source fields, `lines: "start-end"` or a positive numeric line array becomes `startLine/endLine`, a `path:start-end - excerpt` citation string becomes unverified code evidence, the active role replaces malformed `raisedBy`, and descriptive observation/question objects become text. The same evidence normalization applies to Cross Review, Global Devil, and Integrator resolutions. Common Devil verdict aliases such as `partial-support` normalize to a supported enum. Unstructured challenges, ambiguous evidence, and individually invalid challenge or Finding items are isolated and recorded without discarding valid siblings; recoverable Devil-created findings use the same tolerant Finding parser as independent review. Normalization notes remain in the relevant stage artifact instead of flooding unresolved questions, and all resulting evidence still passes the same source and scope validation. Normalization never invents a missing line number or turns model output directly into verified evidence. Matching source evidence leaves an unchallenged Finding proposed. Complete original evidence plus support verifies it; correct disputes it; an objection with verified counter-evidence may reject it. Mixed verified/stale, verified/unavailable, or empty original evidence remains unsupported.

Cross-review receives normalized finding packets instead of complete reviewer transcripts. The Global Devil runs at most once, returns one verdict per supplied Finding, and is skipped when no findings exist. Integrator may submit structured Finding resolutions, but their evidence is normalized and source-validated before status changes.

Cross-review first selects findings that meet the workflow severity threshold, have low confidence, or remain unsupported. The bounded candidate selector prioritizes severity, reviewer diversity, uncertainty, and weak evidence. Each selected Finding is assigned to an expert other than its original author where possible. That expert inspects the source and returns one verdict: `support`, `object`, `correct`, or `abstain`, plus evidence for any new factual claim. Challenges run concurrently within the global and per-provider limits, fail independently, and merge back in deterministic Finding order. They never replace source validation: incomplete original evidence keeps the Finding unsupported.

`code-review` is defect-oriented: it prioritizes correctness, regressions, compatibility, security, performance, maintainability, and test gaps, usually with line-level evidence. Verified medium/high/critical findings request changes.

`architecture-review` is system-oriented: it evaluates module boundaries, dependency direction, failure domains, trust boundaries, deployability, observability, and evolutionary constraints. Diff scope is rejected. Its report asks for system boundaries, key data flows, architectural tradeoffs, and phased recommendations. Only critical findings directly request changes; high/medium systemic risks produce `Needs Investigation` so they can be resolved as explicit architectural decisions.

## Profiles

Recovery finalization receives a bounded source context that is separate from the compact UI activity log, together with the complete stage JSON contract. This recovery-only context is requested by Review and is not added to ordinary ask/agent results or persisted as a separate artifact. Common recovery aliases such as `risk`, `sourceEvidence`, `observation`, and `claim` are normalized when their meaning is unambiguous.

Concurrent reviewers share one stage usage counter, so completed overruns are reported once with final cumulative usage. A completed reviewer that produced only coverage gaps is shown as `empty`. Prior-stage unresolved questions are passed to the tool-free Integrator and preserved in the final report instead of being erased by an empty integration response. Activity snapshots replace the current snapshot while retry/recovery/fallback transition records remain visible, preventing repeated partial output from filling the retained log.

`quick` selects three expert roles with smaller execution-count, token, cost, tool-call, and agent-turn budgets. Execution-count, tool-call, and turn limits are enforced before or during execution. Token and cost allocations are accounted after each model call; overruns are recorded and degrade execution status because a Pi subprocess cannot reliably stop midway through a structured JSON response. Its per-execution inspection limits are 12/6/4 tool calls and 16/10/8 turns for Independent Review, Cross Review, and Global Devil. Each independent reviewer retains at most three material findings, and Global Devil sees at most five selected findings. Its seven executions are stage-reserved as three independent reviews, at most two Cross Reviews, one Global Devil, and one Integrator. Cross Review, Devil, and Integrator have dedicated resource allocations. Eligible findings beyond each limit are counted in stage artifacts instead of silently expanding prompts. `deep` selects all four code-review experts, retains at most six findings per expert and ten for Devil, uses larger budgets, and raises those limits to 24/12/8 tool calls and 28/16/12 turns. Integrator is always tool-free and limited to four turns because it resolves the validated evidence packet rather than scanning source. Both profiles retain the Devil and Integrator stages, but Devil is skipped when there is nothing to challenge. Profiles do not impose workflow or per-execution wall-clock deadlines.

Token, cost, and execution limits reserve a per-execution prompt target before launch and stop subsequent launches within a stage after a real stage boundary is observed. Concurrent calls may still overshoot a stage or global boundary because final usage arrives after completion. Such completed overruns remain visible as diagnostics and coverage counts, but a miss of the advisory per-execution target alone is not reported as a budget failure. A boundary that prevents required work from launching still degrades the affected stage. Exhaustion diagnostics name the exact dimension, observed usage, and effective limit. The active preset's voice timeout remains an inactivity safeguard for a continuously silent Review subagent; it is independent of quick/deep and resets while output continues. Retained stderr is capped at 256 KiB and records omitted bytes. Explicit rate-limit, network, inactivity-timeout, and provider 5xx failures retry up to three attempts with bounded exponential backoff and `Retry-After` support. Structured HTTP status/code takes precedence over bounded message matching. Authentication, configuration validation, safety, and cancellation failures do not retry. Raw direct API requests reject automatic redirects. Retry, recovery, fallback, and terminal activity identify the stage, role, provider/model, attempt count, and failure category.

Usage and cost accounting includes every retry, no-tool recovery, and model fallback attempt. A terminally failed reviewer contributes its known usage to run totals and execution artifacts without being counted as a completed or usable role; if any attempt has unknown cost, the aggregate cost remains unknown instead of under-reporting a partial total.

## Command Syntax

```text
/chorus review [workflow] [options] <objective>
/chorus-review [workflow] [options] <objective>
```

Examples:

```text
/chorus review code-review --profile quick review security and API compatibility
/chorus review code-review --staged review the staged change
/chorus review code-review --base origin/main --head HEAD --profile deep review this pull request
/chorus review architecture-review --profile deep review module boundaries and failure isolation
```

With no objective, `/chorus review` opens an interactive composer. Its header always shows the effective workflow/profile and scope/renderer. Select `Settings` to change the current run in place; the objective draft survives the round trip. The panel supports workflow-aware scope choices, working or staged diff selection, file/document paths, profiles, renderers, and report language. Reports default to Simplified Chinese. It does not persist these choices globally.

Options:

| Option | Behavior |
| --- | --- |
| `--profile quick\|deep` | Select the review profile |
| `--staged` | Resolve staged Git changes |
| `--base <ref> --head <ref>` | Resolve a base/head Git range; both are required |
| `--constraint <text>` | Add a constraint; repeat the option for multiple constraints |
| `--format <id>` | Display `markdown`, `json`, `github`, or `sarif` output |
| `--language zh-CN\|en` | Select the report language; default `zh-CN` |
| `--file <path>` | Load a JSON/YAML review definition relative to the workspace |
| `--fail-on <severity>` | Evaluate normalized findings against CI policy |
| `--summary <path>` | Write the CI summary when `--fail-on` is also present |

There is no `--working` command-line option yet. A repository review is the default; choose `diff:working` in the interactive Settings panel or use a DSL definition with `scope.kind: diff` and `selection: working`.

## Review DSL

Review definitions accept `.json`, `.yaml`, or `.yml`. They are data-only: unknown fields, unknown stages, YAML aliases, executable hooks, path escapes, oversized documents, excessive roles, and unbounded challenge counts are rejected.

```yaml
version: 1
workflow: design-review
profile: deep
language: zh-CN

objective:
  - review migration safety
  - identify missing rollback steps

constraints:
  - preserve backward compatibility

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

Run it with:

```text
/chorus review --file review.yaml
```

The first `output` renderer controls the displayed result. Review artifacts always include normalized Markdown and JSON; GitHub and SARIF can be selected as the displayed renderer.

## Agent Tool

Other agents can invoke `chorus_review`:

```json
{
  "objective": "Review authorization and API compatibility",
  "workflow": "code-review",
  "constraints": ["preserve public API"],
  "scope": {
    "kind": "diff",
    "selection": "staged",
    "root": "/absolute/path/to/repository"
  },
  "profile": "quick",
  "renderer": "json"
}
```

Alternatively pass `definitionPath` instead of `objective`.

## Jobs And Artifacts

Review commands create background jobs:

```text
/chorus jobs
/chorus job <jobId>
/chorus watch <jobId>
/chorus cancel <jobId>
/chorus resume <jobId>
```

The Watch view uses semantic colors for stage and role status while retaining text labels. Left/Right or Tab switches roles, Up/Down scrolls one line, PageUp/PageDown scrolls one viewport, and Home/End or `g`/`G` jumps to the beginning/end. It also shows the visible line range and scroll percentage. Pi does not currently expose mouse wheel events to extension custom components.

Artifacts are owner-only files under `~/.pi/agent/chorus/results/<jobId>/`:

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

`review-scope.diff` is present only for diff scopes and preserves the exact reviewed patch. Files/document/diff scopes record source SHA-256 values when scope is resolved; repository scope records a file baseline when it is first cited. If a cited source changes later in the same run, that evidence becomes stale with `referenced source changed during the review`, the report records the mutated-file count, and execution status becomes degraded. A moved but otherwise matching excerpt is reported separately as a line-range drift.

Resume verifies the workflow version, artifact hashes, and cited-source hashes before reusing a completed stage prefix. A source change or artifact mismatch forces rerun. A process crash before final review artifacts are committed does not currently have a resumable review snapshot.

## CI Policy

Inside Pi:

```text
/chorus review code-review --staged --fail-on high --summary /tmp/chorus-summary.json review this change
```

The slash command reports policy status but does not terminate the Pi process. Use the packaged CLI for shell exit semantics:

```bash
node dist/cli/review-policy.js \
  ~/.pi/agent/chorus/results/<jobId>/review-report.json \
  --fail-on high \
  --summary /tmp/chorus-summary.json
```

| Exit code | Meaning |
| ---: | --- |
| 0 | Passed |
| 1 | Blocking finding matched policy |
| 2 | Review incomplete |
| 3 | Invalid input |
| 4 | Runtime failure |

## Renderers

- Markdown: human review report
- JSON: lossless versioned `ReviewReport`
- GitHub: review event, summary body, and verified changed-line comments
- SARIF 2.1.0: verified code findings with stable rules and fingerprints

The GitHub renderer creates a payload only; it does not call GitHub or mutate a pull request.

## Evaluation

Seeded cases live in `tests/fixtures/review/manifest.json`. Run the paid live comparison explicitly:

```text
/chorus review-eval --live tests/fixtures/review/manifest.json
```

Each fixture runs a single generalist reviewer and a committee using the same primary model preference. Metrics include recall, unmatched findings, citation validity, severity calibration, decision accuracy, duration, cost, and cost per valid finding.

This command can make dozens of model calls. It is never run implicitly by CI. The implementation provides the measurement mechanism; it does not yet prove that the committee beats a single reviewer on live models or real developer acceptance.

## Automated Verification

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run verify
npm run prepublishOnly
```

Run only Review Engine unit tests:

```bash
npx vitest run 'tests/unit/review-*.test.ts'
```

The most recent complete gate passed 313 unit tests, 4 integration tests, build, typecheck, and lint. The paid live-model evaluation was not run.

## Current Limitations

- Review Engine changes are not yet published as a new npm version.
- Live superiority over a single reviewer has not yet been established.
- GitHub output is a payload renderer, not a network integration.
- Only the first DSL `output` renderer controls the displayed response.
- Working-tree diff has no command-line flag yet; use DSL scope.
- Review history is represented by jobs and artifacts; it is not a long-term belief or case-management system.
- Review resume requires a committed completed review snapshot.
