import { describe, expect, it } from "vitest";
import type { ChorusJob } from "../../src/jobs.js";
import { applyReviewCompletion, applyReviewExecution } from "../../src/jobs/review.js";
import type { ReviewWorkflowResult } from "../../src/workflows/contracts.js";

describe("review job completion", () => {
    it("preserves rejected reviewer errors and marks an omitted Devil as skipped", () => {
        const job = reviewJob();
        job.voices[0]!.status = "error";
        job.voices[0]!.errorMessage = "stage=independent-review role=architect category=output-format";
        job.voices[1]!.status = "error";
        job.voices[2]!.status = "error";
        job.voices[4]!.status = "success";

        const result = reviewResult([]);
        result.stages[0]!.diagnostics = ["stage=independent-review role=security model=p/m attempts=2 retryLimit=3 category=unknown: pi produced no assistant text"];

        applyReviewCompletion(job, result, "report", [], "degraded");

        expect(job.voices.map((voice) => voice.status)).toEqual(["error", "error", "error", "skipped", "success"]);
        expect(job.voices[0]?.errorMessage).toContain("output-format");
        expect(job.voices[1]?.errorMessage).toContain("pi produced no assistant text");
        expect(job.voices[3]?.output).toContain("no independent reviewer completed");
        expect(job.voices[4]?.errorMessage).toBeUndefined();
    });

    it("infers accepted independent roles from the normalized stage output", () => {
        const job = reviewJob();
        applyReviewCompletion(job, reviewResult(["architect", "security", "performance"]), "report", [], "success");
        expect(job.voices.map((voice) => voice.status)).toEqual(["success", "success", "success", "skipped", "success"]);
    });

    it("marks completed reviewers without usable signal as empty", () => {
        const job = reviewJob();
        const result = reviewResult(["architect", "security", "performance"]);
        result.stages[0]!.output = { completedRoles: ["architect", "security", "performance"], usableRoles: ["architect", "performance"], emptyRoles: ["security"] };
        applyReviewCompletion(job, result, "report", [], "degraded");
        expect(job.voices.map((voice) => voice.status)).toEqual(["success", "empty", "success", "skipped", "success"]);
    });

    it("resets per-stage live fields when a role is reused in a later stage", () => {
        const job = reviewJob();
        applyReviewExecution(job, { roleId: "architect", stage: "independent-review", status: "error", partialOutput: "truncated finding", activityLog: "independent activity", errorMessage: "output-format", durationMs: 10 });
        applyReviewExecution(job, { roleId: "architect", stage: "cross-review", status: "running", partialOutput: "checking another finding", durationMs: 2 });

        expect(job.voices[0]).toEqual(expect.objectContaining({
            stage: "cross-review",
            status: "running",
            partialOutput: "checking another finding",
            durationMs: 2,
        }));
        expect(job.voices[0]?.activityLog).toBeUndefined();
        expect(job.voices[0]?.errorMessage).toBeUndefined();
    });

    it("uses the primary stage status and metrics when completing a reused expert role", () => {
        const job = reviewJob();
        applyReviewExecution(job, { roleId: "architect", stage: "cross-review", status: "success", partialOutput: "cross result", activityLog: "cross activity", durationMs: 99 });
        const result = reviewResult([]);
        result.stages[0]!.diagnostics = ["stage=independent-review role=architect category=output-format: truncated output"];
        result.executions.push({ roleId: "architect", stage: "cross-review", output: "challenge", durationMs: 99, costUsd: 0, inputTokens: 1, outputTokens: 1 });

        applyReviewCompletion(job, result, "report", [], "degraded");

        expect(job.voices[0]).toEqual(expect.objectContaining({ status: "error", durationMs: 1, errorMessage: expect.stringContaining("truncated output") }));
        expect(job.voices[0]?.partialOutput).toBeUndefined();
        expect(job.voices[0]?.activityLog).toBeUndefined();
        expect(job.voices[0]?.output).toContain("## cross-review");
    });
});

function reviewJob(): ChorusJob {
    const roles = ["architect", "security", "performance", "devil", "integrator"];
    return {
        id: "review-job",
        kind: "review",
        title: "Chorus Review",
        presetName: "default",
        prompt: "review",
        command: "/chorus review",
        status: "running",
        startedAt: 1,
        voices: roles.map((roleId, index) => ({ index, roleId, label: roleId, status: "pending" })),
        conductor: { status: "pending" },
        abortController: new AbortController(),
    };
}

function reviewResult(completedRoles: string[]): ReviewWorkflowResult {
    const execution = (roleId: string, stage: "independent-review" | "integrate") => ({ roleId, stage, output: "{}", durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 });
    return {
        plan: {
            version: 1,
            workflowId: "code-review",
            workflowVersion: 1,
            request: { version: 1, workflow: "code-review", objective: [], constraints: [], scope: { kind: "repository" }, profile: "quick", renderer: "markdown", language: "zh-CN" },
            scope: { kind: "repository", workspaceRoot: "/repo", includePaths: [], excludePaths: [] },
            assignments: [],
            stages: ["independent-review", "cross-review", "devil", "integrate"],
            createdAt: 1,
        },
        stages: [{
            stage: "independent-review",
            status: completedRoles.length === 3 ? "success" : "error",
            output: { completedRoles },
            diagnostics: [],
            startedAt: 1,
            finishedAt: 2,
        }, {
            stage: "devil",
            status: "skipped",
            diagnostics: ["Global Devil skipped because no independent reviewer completed"],
            startedAt: 2,
            finishedAt: 2,
        }, {
            stage: "integrate",
            status: "success",
            diagnostics: [],
            startedAt: 2,
            finishedAt: 3,
        }],
        executions: [
            ...["architect", "security", "performance"].map((roleId) => execution(roleId, "independent-review")),
            execution("integrator", "integrate"),
        ],
        report: {
            version: 1,
            reviewId: "review",
            workflowId: "code-review",
            language: "zh-CN",
            decision: "needs-investigation",
            executiveSummary: "summary",
            findings: [],
            requiredActions: [],
            positiveObservations: [],
            unresolvedQuestions: [],
            coverage: { requestedRoles: 3, completedRoles: completedRoles.length, reviewedFiles: 0, omittedStages: [] },
            run: { durationMs: 2, costUsd: 0, inputTokens: 4, outputTokens: 4 },
            createdAt: 3,
        },
    };
}
