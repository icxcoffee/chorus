import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReviewCheckpoint, planReviewResume, restrictReviewReuse } from "../../src/review/checkpoint.js";
import { writeReviewArtifacts } from "../../src/review/artifacts.js";
import { runReview } from "../../src/review/runner.js";
import type { ReviewWorkflowResult } from "../../src/workflows/contracts.js";
import { registry } from "./fixtures.js";

describe("review checkpoints", () => {
    it("reuses a validated stage prefix and invalidates it when source evidence changes", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-checkpoint-"));
        const source = join(root, "source.ts");
        await writeFile(source, "const safe = true;\n");
        const result = fixtureResult(root);
        const artifacts = await writeReviewArtifacts({ result, outputDir: join(root, "artifacts") });
        const checkpoint = createReviewCheckpoint(result, artifacts);
        const valid = await planReviewResume(await checkpoint, result, artifacts);
        expect(valid.reusableStages).toEqual(["independent-review", "cross-review", "devil", "integrate"]);
        expect(valid.rerunStages).toEqual([]);

        await writeFile(source, "const safe = false;\n");
        const changed = await planReviewResume(await checkpoint, result, artifacts);
        expect(changed.reusableStages).toEqual([]);
        expect(changed.warnings.join(" ")).toContain("source changed");
    });

    it("hydrates reused stages without calling reviewers again", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-reuse-"));
        await writeFile(join(root, "source.ts"), "const safe = true;\n");
        const prior = fixtureResult(root);
        const executor = { execute: vi.fn() };
        const result = await runReview({
            request: prior.plan.request,
            registry,
            executor,
            reuse: restrictReviewReuse(prior, ["independent-review", "cross-review", "devil", "integrate"]),
        });
        expect(executor.execute).not.toHaveBeenCalled();
        expect(result.report.reviewId).toBe("review-1");
        expect(result.stages.every((stage) => stage.diagnostics.includes("reused from validated review checkpoint"))).toBe(true);
    });

    it("filters executions with the same reusable successful-stage set", () => {
        const result = fixtureResult("/tmp");
        result.stages[1] = { ...result.stages[1]!, status: "error" };
        result.executions = [
            { roleId: "architect", stage: "independent-review", output: {}, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 },
            { roleId: "security", stage: "cross-review", output: {}, durationMs: 2, costUsd: 0, inputTokens: 2, outputTokens: 2 },
        ];
        const restricted = restrictReviewReuse(result, ["independent-review", "cross-review"]);
        expect(restricted.stages.map((stage) => stage.stage)).toEqual(["independent-review"]);
        expect(restricted.executions.map((execution) => execution.stage)).toEqual(["independent-review"]);
    });
});

function fixtureResult(root: string): ReviewWorkflowResult {
    const request = { version: 1 as const, workflow: "code-review", objective: ["review"], constraints: [], scope: { kind: "repository" as const, root }, profile: "quick" as const, renderer: "markdown" };
    const finding = {
        id: "finding-1",
        title: "Example",
        description: "Example source-backed finding.",
        category: "security",
        severity: "low" as const,
        confidence: "high" as const,
        status: "verified" as const,
        evidence: [{ id: "e", kind: "code" as const, path: "source.ts", startLine: 1, verification: "verified" as const }],
        raisedBy: ["security"],
        challenges: [],
    };
    const report = {
        version: 1 as const,
        reviewId: "review-1",
        workflowId: "code-review",
        decision: "approve" as const,
        executiveSummary: "Approved.",
        findings: [finding],
        requiredActions: [],
        positiveObservations: [],
        unresolvedQuestions: [],
        coverage: { requestedRoles: 4, completedRoles: 4, reviewedFiles: 1, omittedStages: [] },
        run: { durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 },
        createdAt: 1,
    };
    return {
        plan: {
            version: 1,
            workflowId: "code-review",
            workflowVersion: 2,
            request,
            scope: { kind: "repository", workspaceRoot: root, includePaths: [], excludePaths: [] },
            assignments: [],
            stages: ["independent-review", "cross-review", "devil", "integrate"],
            createdAt: 1,
        },
        report,
        stages: [
            { stage: "independent-review", status: "success", output: { findings: [finding], positiveObservations: [], unresolvedQuestions: [], completedRoles: [], executions: [] }, diagnostics: [], startedAt: 1, finishedAt: 2 },
            { stage: "cross-review", status: "success", output: { findings: [finding], executions: [] }, diagnostics: [], startedAt: 2, finishedAt: 3 },
            { stage: "devil", status: "success", output: { findings: [finding], executions: [], missingAreaProposals: [] }, diagnostics: [], startedAt: 3, finishedAt: 4 },
            { stage: "integrate", status: "success", output: report, diagnostics: [], startedAt: 4, finishedAt: 5 },
        ],
        executions: [],
    };
}
