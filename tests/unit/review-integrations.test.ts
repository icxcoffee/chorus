import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateReviewPolicy, REVIEW_EXIT_CODES, writeReviewCiSummary } from "../../src/review/ci.js";
import { renderGitHubReview } from "../../src/renderers/github.js";
import { renderSarif } from "../../src/renderers/sarif.js";
import type { ReviewReport } from "../../src/review/contracts.js";

describe("review CI contract", () => {
    it("distinguishes policy failure, incomplete review, and pass", async () => {
        const report = fixtureReport();
        const failed = evaluateReviewPolicy(report, { failOn: "high", minimumConfidence: "medium", requireVerifiedEvidence: true, incomplete: "fail" });
        expect(failed.exitCode).toBe(REVIEW_EXIT_CODES.policyFailure);
        const incomplete = evaluateReviewPolicy({ ...report, coverage: { ...report.coverage, completedRoles: 2 } }, { failOn: "critical", incomplete: "fail" });
        expect(incomplete.exitCode).toBe(REVIEW_EXIT_CODES.incomplete);
        const overBudget = evaluateReviewPolicy({ ...report, coverage: { ...report.coverage, budgetOverruns: 1 } }, { failOn: "critical", incomplete: "fail" });
        expect(overBudget.exitCode).toBe(REVIEW_EXIT_CODES.incomplete);
        expect(overBudget.incompleteReasons).toContain("1 execution budget overrun(s)");
        const passed = evaluateReviewPolicy(report, { failOn: "critical", incomplete: "allow" });
        expect(passed.exitCode).toBe(REVIEW_EXIT_CODES.pass);
        const dir = await mkdtemp(join(tmpdir(), "chorus-ci-"));
        const path = join(dir, "summary.json");
        await writeReviewCiSummary(path, failed);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(failed);
        expect((await stat(path)).mode & 0o077).toBe(0);
    });
});

describe("GitHub and SARIF renderers", () => {
    it("renders only verified non-contextual code evidence as inline comments", () => {
        const report = fixtureReport();
        const payload = renderGitHubReview(report);
        expect(payload.event).toBe("REQUEST_CHANGES");
        expect(payload.comments).toEqual([{ path: "src/auth.ts", line: 12, side: "RIGHT", body: expect.stringContaining("Missing authorization") }]);
        expect(payload.body).toContain("需要修改");
    });

    it("emits deterministic SARIF rules, levels, locations, and fingerprints", () => {
        const first = renderSarif(fixtureReport());
        const second = renderSarif(fixtureReport());
        expect(first).toEqual(second);
        const run = (first.runs as Array<Record<string, unknown>>)[0]!;
        const results = run.results as Array<Record<string, unknown>>;
        expect(results[0]).toEqual(expect.objectContaining({ ruleId: "chorus/security", level: "error", partialFingerprints: { chorusFindingId: expect.any(String) } }));
    });
});

function fixtureReport(): ReviewReport {
    return {
        version: 1,
        reviewId: "r",
        workflowId: "code-review",
        decision: "request-changes",
        executiveSummary: "Blocking issue.",
        findings: [{
            id: "f",
            title: "Missing authorization",
            description: "Data is loaded before authorization.",
            category: "security",
            severity: "high",
            confidence: "high",
            status: "verified",
            evidence: [
                { id: "e1", kind: "code", path: "src/auth.ts", startLine: 10, endLine: 12, verification: "verified" },
                { id: "e2", kind: "code", path: "src/context.ts", startLine: 2, contextual: true, verification: "verified" },
                { id: "e3", kind: "document", path: "README.md", verification: "verified" },
            ],
            raisedBy: ["security"],
            challenges: [],
        }],
        requiredActions: ["Authorize first."],
        positiveObservations: [],
        unresolvedQuestions: [],
        coverage: { requestedRoles: 4, completedRoles: 4, reviewedFiles: 2, omittedStages: [] },
        run: { durationMs: 1, costUsd: 0.1, inputTokens: 1, outputTokens: 1 },
        createdAt: 1,
    };
}
