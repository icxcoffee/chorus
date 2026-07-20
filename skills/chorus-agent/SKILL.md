---
name: chorus-agent
description: Run the @icxcoffee/chorus Pi extension from Codex CLI or Claude Code for multi-agent repository investigation, evidence-based code/architecture/design review, or multi-model Ask synthesis. Use when the user asks an agent to invoke Chorus, run /chorus agent or /chorus review, perform a Chorus audit, compare configured models, monitor a Chorus job, or return its persisted final report.
---

# Chorus Agent

Invoke Chorus through the installed `pi` CLI, keep its interactive process alive until the background job reaches a terminal state, and return the persisted result to the user.

## Select One Extension Source

Run `command -v pi` and `pi list` first.

- Use plain `pi` when `npm:@icxcoffee/chorus` is enabled.
- If the npm package is absent or marked `filtered`, use `$CHORUS_REPO/src/index.ts` with `pi -e` when `CHORUS_REPO` identifies a local Chorus checkout.
- Never load npm and local copies together. Duplicate copies register suffixed commands such as `/chorus:1` and `/chorus:2` with unstable provenance.
- If neither source is available, stop and request `pi install npm:@icxcoffee/chorus` or a valid `CHORUS_REPO`.

## Choose The Workflow

- Repository investigation with verification conductor: `/chorus agent <task>`.
- Evidence-backed audit: `/chorus review <workflow> [options] <objective>`.
- Multi-model answer synthesis: `/chorus ask <question>`.

Review workflows are `code-review`, `architecture-review`, and `design-review`. Prefer `quick` for bounded change review and `deep` for repository-wide or architecture review. Useful scopes include `--staged` and `--base origin/main --head HEAD`.

## Run And Monitor

1. Set the command working directory to the repository being analyzed. Chorus derives repository scope and subagent cwd from it.
2. Inspect `~/.pi/agent/chorus/jobs.json` before launch so a new job can be distinguished from old runs.
3. Start Pi in a PTY-capable shell session and yield quickly. Codex should use its long-running command session; Claude Code should use its long-running Bash session. Examples:

```bash
pi "/chorus agent analyze module boundaries, duplicated logic, and high-risk code"
pi "/chorus review code-review --profile quick --staged audit security and regression risks"
pi -e "$CHORUS_REPO/src/index.ts" "/chorus review architecture-review --profile deep audit this repository"
```

4. Keep the shell session open. Poll its output frequently and extract the new `chorus-...` job ID. If terminal output is noisy, identify the newly added job in `~/.pi/agent/chorus/jobs.json` by creation time, kind, and prompt.
5. Poll the matching job until `status` is one of `success`, `degraded`, `error`, or `aborted`. Do not treat the initial started card as completion. Do not use `pi -p "/chorus agent ..."` or `pi -p "/chorus review ..."`; these slash commands launch detached work and print mode may exit early.
6. After the job is terminal and artifacts are flushed, close the Pi session gracefully with `/quit`. Use an interrupt only after confirming terminal job state.
7. Read and return the canonical artifact:
   - Agent or Ask: `~/.pi/agent/chorus/results/<jobId>/final-report.md`, with `result.json` for structured details.
   - Review: `~/.pi/agent/chorus/results/<jobId>/review-report.md`, with `review-report.json` and `review-result.json` for structured details.
8. If the job fails, read `jobs.json` plus available activity/error artifacts and report the concrete stage, role, model, and failure reason.

## Synchronous Review Alternative

For a non-interactive review, expose only the synchronous tool and instruct the outer Pi model to call it exactly once:

```bash
pi -p --no-session --tools chorus_review \
  'Call chorus_review exactly once with {"objective":"audit this repository","workflow":"code-review","profile":"quick","renderer":"markdown","language":"zh-CN"}. Return only the tool result.'
```

This costs one outer Pi model turn in addition to the Chorus review. Chorus 0.2.0 has no equivalent synchronous `chorus_agent` tool; use the monitored PTY workflow for the verified Agent pipeline.

## Report Back

Lead with the Chorus decision or final answer. Include the job ID, terminal status, important verified findings, failures or incomplete coverage, and artifact directory. State whether npm or a local checkout supplied the extension when that affects reproducibility.
