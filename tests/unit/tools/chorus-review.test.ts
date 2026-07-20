import { describe, expect, it, vi } from "vitest";
import { chorusReviewTool } from "../../../src/tools/chorus-review.js";
import type { RunReviewServiceResult } from "../../../src/review/service.js";

describe("chorus_review tool", () => {
    it("normalizes input, streams stages, and returns report details", async () => {
        const updates: unknown[] = [];
        const service = vi.fn(async (_ctx, request, options) => {
            options?.onStage?.({ stage: "integrate", status: "success", diagnostics: [], startedAt: 1, finishedAt: 2 });
            return response(request);
        });
        const result = await chorusReviewTool(
            { cwd: "/tmp" },
            { objective: "Review authorization", constraints: ["preserve API"] },
            (update) => updates.push(update),
            { runReviewServiceImpl: service },
        ) as { content: Array<{ text: string }>; details: { result: { report: { decision: string } } } };
        expect(service).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workflow: "code-review", scope: { kind: "repository", root: "/tmp" }, language: "zh-CN" }), expect.anything());
        expect(updates).toEqual([expect.objectContaining({ message: "chorus review integrate success" })]);
        expect(result.content[0]?.text).toContain("Approve");
        expect(result.details.result.report.decision).toBe("approve");
    });

    it("requires a meaningful objective", async () => {
        await expect(chorusReviewTool({}, {})).rejects.toThrow("requires objective");
    });
});

function response(request: RunReviewServiceResult["request"]): RunReviewServiceResult {
    const report = {
        version: 1 as const,
        reviewId: "r",
        workflowId: "code-review",
        decision: "approve" as const,
        executiveSummary: "No blocking findings.",
        findings: [],
        requiredActions: [],
        positiveObservations: [],
        unresolvedQuestions: [],
        coverage: { requestedRoles: 4, completedRoles: 4, reviewedFiles: 1, omittedStages: [] },
        run: { durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 },
        createdAt: 1,
    };
    return {
        request,
        result: {
            plan: { version: 1, workflowId: "code-review", workflowVersion: 1, request, scope: { kind: "repository", workspaceRoot: "/tmp", includePaths: [], excludePaths: [] }, assignments: [], stages: [], createdAt: 1 },
            report,
            stages: [],
            executions: [],
        },
        text: "# Review\n\nDecision: Approve\n",
        artifacts: [],
        outputDir: "/tmp/review",
    };
}
