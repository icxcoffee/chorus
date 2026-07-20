import type { OptimizeResult } from "../optimize.js";
import type { PiLikeContext } from "../pi-context.js";
import { renderPromptOptimization, renderRunStarted } from "../render/run.js";
import type { ReviewRequest } from "../review/contracts.js";

export function show(ctx: PiLikeContext, content: string): void {
  if (ctx.ui?.show) ctx.ui.show(content);
  else notify(ctx, content, "info");
}

export function showPersistentResult(ctx: PiLikeContext, content: string, details: unknown): void {
  if (ctx.hasUI && ctx.sendMessage) {
    try {
      ctx.sendMessage({ customType: "chorus-result", content, display: true, details });
      return;
    } catch {
      ctx.ui?.notify?.("Chorus result could not be pinned; showing it in the transient output panel.", "warning");
    }
  }
  show(ctx, content);
}

export function showPersistentOptimization(ctx: PiLikeContext, result: OptimizeResult, source: string): void {
  const content = renderPromptOptimization(result, source);
  const details = {
    kind: "prompt-optimization",
    source,
    original: result.original,
    optimized: result.optimized,
    ...(result.model ? { model: result.model } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {})
  };
  if (ctx.hasUI && ctx.sendMessage) {
    try {
      ctx.sendMessage({ customType: "chorus-prompt-optimization", content, display: true, details });
      return;
    } catch {
      ctx.ui?.notify?.("Chorus prompt optimization could not be pinned; showing it in the transient output panel.", "warning");
    }
  }
  show(ctx, content);
}

export function showReviewStarted(ctx: PiLikeContext, args: { jobId: string; presetName: string; request: ReviewRequest; assignments: Array<{ roleId: string; model: { provider: string; modelId: string } }>; outputDir: string }): void {
  const scope = args.request.scope.kind === "diff"
    ? `${args.request.scope.kind}:${args.request.scope.selection ?? "working"}`
    : args.request.scope.paths?.length ? `${args.request.scope.kind}: ${args.request.scope.paths.join(", ")}` : args.request.scope.kind;
  const experts = args.assignments.filter((assignment) => assignment.roleId !== "devil" && assignment.roleId !== "integrator");
  const workflowRoles = args.assignments.filter((assignment) => assignment.roleId === "devil" || assignment.roleId === "integrator");
  const content = [
    "# Chorus Review Started",
    "",
    `Job: \`${args.jobId}\``,
    `Preset: \`${args.presetName}\``,
    `Workflow: \`${args.request.workflow}\` | Profile: \`${args.request.profile}\``,
    `Scope: \`${scope}\` | Output: \`${args.request.renderer}\` | Language: \`${args.request.language ?? "zh-CN"}\``,
    "",
    "## Expert Reviewers",
    ...experts.map((assignment) => `- \`${assignment.roleId}\` -> \`${assignment.model.provider}/${assignment.model.modelId}\` · queued`),
    ...(workflowRoles.length > 0 ? [
      "",
      "## Workflow Roles",
      ...workflowRoles.map((assignment) => `- \`${assignment.roleId}\` -> \`${assignment.model.provider}/${assignment.model.modelId}\` · queued`),
    ] : []),
    "",
    "## Objective",
    args.request.objective.join("\n"),
    ...(args.request.constraints.length ? ["", "## Constraints", ...args.request.constraints.map((constraint) => `- ${constraint}`)] : []),
    "",
    `Artifacts: \`${args.outputDir}\``,
    `Watch: \`/chorus watch ${args.jobId}\``,
    `Cancel: \`/chorus cancel ${args.jobId}\``,
  ].join("\n");
  const details = { kind: "review-started", ...args };
  if (ctx.hasUI && ctx.sendMessage) {
    try {
      ctx.sendMessage({ customType: "chorus-review-started", content, display: true, details });
      return;
    } catch {
      ctx.ui?.notify?.("Chorus review details could not be pinned; showing them in the transient output panel.", "warning");
    }
  }
  show(ctx, content);
}

export function showRunStarted(
  ctx: PiLikeContext,
  args: {
    jobId?: string;
    kind: "ask" | "agent";
    title: string;
    presetName: string;
    prompt: string;
    optimizedPrompt?: string;
    outputDir?: string;
  }
): void {
  const content = renderRunStarted(args);
  const details = {
    kind: `${args.kind}-started`,
    ...(args.jobId ? { jobId: args.jobId } : {}),
    presetName: args.presetName,
    prompt: args.prompt,
    ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {}),
    ...(args.outputDir ? { outputDir: args.outputDir } : {})
  };
  if (ctx.hasUI && ctx.sendMessage) {
    try {
      ctx.sendMessage({ customType: "chorus-run-started", content, display: true, details });
      return;
    } catch {
      ctx.ui?.notify?.("Chorus run start could not be pinned; showing it in the transient output panel.", "warning");
    }
  }
  show(ctx, content);
}

export function notify(ctx: PiLikeContext, content: string, level: "info" | "warning" | "error" | "success"): void {
  if (ctx.ui?.notify) ctx.ui.notify(content, level === "success" ? "info" : level);
  else console.log(content);
}

export function setChorusStatus(ctx: PiLikeContext, message: string | undefined): void {
  ctx.ui?.setStatus?.("chorus", message);
}

export function setChorusWidget(ctx: PiLikeContext, lines: string[] | undefined): void {
  ctx.ui?.setWidget?.("chorus", lines, { placement: "aboveEditor" });
}
