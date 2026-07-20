import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compareReviewModes, evaluateReview, renderReviewComparison, type ReviewEvaluationFixture } from "../../src/review/evaluation.js";
import type { ReviewReport } from "../../src/review/contracts.js";

describe("review evaluation", () => {
    it("scores recall, false positives, citations, severity, decision, and cost transparently", async () => {
        const manifest = JSON.parse(await readFile("tests/fixtures/review/manifest.json", "utf8")) as { cases: ReviewEvaluationFixture[] };
        const fixture = manifest.cases[0]!;
        const metrics = evaluateReview(report("request-changes", true, true), fixture, { actionability: 4, developerAcceptance: true });
        expect(metrics).toEqual(expect.objectContaining({ recall: 1, citationValidity: 1, severityCalibration: 1, decisionCorrect: true, validFindings: 1, costPerValidFinding: 0.1 }));
        expect(metrics.human).toEqual({ actionability: 4, developerAcceptance: true });
    });

    it("compares the same fixtures without collapsing metrics into an opaque score", async () => {
        const fixture: ReviewEvaluationFixture = {
            id: "case",
            description: "case",
            expectedDecision: "request-changes",
            expectedFindings: [{ id: "expected", category: "security", severity: "high", locations: [{ path: "routes.js", startLine: 1, endLine: 3 }] }],
        };
        const comparison = await compareReviewModes([fixture], async (_case, mode) => report(mode === "committee" ? "request-changes" : "approve", mode === "committee", true));
        expect(comparison.summary.single.recall).toBe(0);
        expect(comparison.summary.committee.recall).toBe(1);
        expect(renderReviewComparison(comparison)).toContain("| Recall | 0.0% | 100.0% |");
    });
});

function report(decision: ReviewReport["decision"], includeFinding: boolean, verifiedCitation: boolean): ReviewReport {
    return {
        version: 1,
        reviewId: "review",
        workflowId: "code-review",
        decision,
        executiveSummary: "summary",
        findings: includeFinding ? [{
            id: "finding",
            title: "Missing authorization",
            description: "Protected data is returned without authorization.",
            category: "security",
            severity: "high",
            confidence: "high",
            status: "verified",
            evidence: [{ id: "e", kind: "code", path: "routes.js", startLine: 2, verification: verifiedCitation ? "verified" : "stale" }],
            raisedBy: ["security"],
            challenges: [],
        }] : [],
        requiredActions: [],
        positiveObservations: [],
        unresolvedQuestions: [],
        coverage: { requestedRoles: 1, completedRoles: 1, reviewedFiles: 1, omittedStages: [] },
        run: { durationMs: 10, costUsd: 0.1, inputTokens: 10, outputTokens: 10 },
        createdAt: 1,
    };
}
