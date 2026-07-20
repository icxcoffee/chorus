import { describe, expect, it } from "vitest";
import { parseFinding, parseReviewReport, parseReviewRequest } from "../../src/review/validation.js";

describe("review domain contracts", () => {
    it("normalizes a versioned request without provider or model coupling", () => {
        expect(parseReviewRequest({
            version: 1,
            workflow: "code-review",
            objective: ["security"],
            constraints: ["preserve API"],
            scope: { kind: "repository" },
            profile: "quick",
            renderer: "markdown",
        })).toEqual(expect.objectContaining({
            workflow: "code-review",
            scope: { kind: "repository" },
            profile: "quick",
            language: "zh-CN",
        }));
    });

    it("strictly rejects forward versions, malformed ranges, duplicates, and oversized input", () => {
        expect(() => parseReviewRequest({ version: 2, workflow: "x", scope: { kind: "repository" } })).toThrow("unsupported review schema version");
        expect(() => parseFinding({
            id: "f", title: "x", description: "x", category: "security", severity: "high", confidence: "high",
            evidence: [{ id: "e", kind: "code", path: "a.ts", startLine: 0 }], raisedBy: ["security"],
        })).toThrow("positive integer");
        expect(() => parseFinding({
            id: "f", title: "x", description: "x", category: "security", severity: "high", confidence: "high",
            evidence: [], raisedBy: ["security", "security"],
        })).toThrow("duplicates");
        expect(() => parseReviewRequest({ version: 1, workflow: "x".repeat(5_000), objective: [], constraints: [], scope: { kind: "repository" } })).toThrow("exceeds");
        expect(() => parseReviewRequest({ version: 1, workflow: "code-review", objective: [], constraints: [], scope: { kind: "diff", base: "--ext-diff", head: "HEAD" } })).toThrow("scope.base must not start");
        expect(() => parseReviewRequest({ version: 1, workflow: "code-review", objective: [], constraints: [], scope: { kind: "diff", base: "main\n--output=x", head: "HEAD" } })).toThrow("whitespace or control");
    });

    it("round-trips a complete report without fabricating fields", () => {
        const report = {
            version: 1,
            reviewId: "review-1",
            workflowId: "code-review",
            decision: "approve",
            executiveSummary: "No blocking findings.",
            findings: [],
            requiredActions: [],
            positiveObservations: ["Input validation is centralized."],
            unresolvedQuestions: [],
            executionDiagnostics: ["integrate/integrator: budget"],
            coverage: { requestedRoles: 4, completedRoles: 4, reviewedFiles: 3, omittedStages: [] },
            run: { durationMs: 10, costUsd: 0, inputTokens: 1, outputTokens: 2 },
            createdAt: 1,
        };
        expect(parseReviewReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    });
});
