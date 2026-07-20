import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PiLikeContext } from "../pi-context.js";
import { registryModels } from "../models/registry.js";
import { createSubagentReviewExecutor } from "../review/executor.js";
import { compareReviewModes, renderReviewComparison, type ReviewEvaluationFixture } from "../review/evaluation.js";
import { runSingleReviewerBaseline } from "../review/single-reviewer.js";
import { runReview } from "../review/runner.js";
import { defaultReviewWorkflowRegistry } from "../workflows/registry.js";
import { show } from "../runtime/pi-ui.js";
import type { ReviewRequest } from "../review/contracts.js";
import { registerBuiltinReviewComponents } from "../workflows/builtins.js";

interface ManifestCase extends ReviewEvaluationFixture { root: string; workflow?: string; scopePaths?: string[]; }

export async function handleReviewEval(ctx: PiLikeContext, rawArgs: string): Promise<void> {
    registerBuiltinReviewComponents();
    const match = /^--live\s+(.+)$/.exec(rawArgs.trim());
    if (!match) { ctx.ui?.notify?.("Usage: /chorus review-eval --live <manifest.json> (runs paid model calls)", "warning"); return; }
    const manifestPath = resolve(ctx.cwd ?? process.cwd(), match[1]!);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: number; cases: ManifestCase[] };
    if (manifest.version !== 1 || !Array.isArray(manifest.cases)) throw new Error("review evaluation manifest must use version 1");
    const registry = await registryModels(ctx);
    const primary = registry[0];
    if (!primary) throw new Error("review evaluation requires at least one model");
    const model = { provider: primary.provider, modelId: primary.modelId };
    const executor = createSubagentReviewExecutor({ ...(ctx.cwd ? { cwd: ctx.cwd } : {}) });
    const report = await compareReviewModes(manifest.cases, async (fixture, mode) => {
        const item = fixture as ManifestCase;
        const root = resolve(dirname(manifestPath), item.root);
        const workflow = item.workflow ?? "code-review";
        const baseDefinition = defaultReviewWorkflowRegistry.get(workflow).definition;
        const definition = { ...baseDefinition, roles: baseDefinition.roles.map((assignment) => ({ roleId: assignment.roleId, modelPolicy: { preferred: [model] } })) };
        const request: ReviewRequest = { version: 1, workflow, objective: [item.description], constraints: [], scope: item.scopePaths ? { kind: "files", root, paths: item.scopePaths } : { kind: "repository", root }, profile: "deep", renderer: "json" };
        return mode === "single"
            ? await runSingleReviewerBaseline({ request, registry: [primary], executor, ...(ctx.signal ? { signal: ctx.signal } : {}), cwd: root })
            : (await runReview({ request, registry, executor, definition, ...(ctx.signal ? { signal: ctx.signal } : {}), cwd: root })).report;
    });
    show(ctx, renderReviewComparison(report));
}
