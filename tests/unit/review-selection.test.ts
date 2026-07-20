import { describe, expect, it } from "vitest";
import { selectReviewCandidates } from "../../src/review/selection.js";
import { assignCrossReviewers } from "../../src/workflows/stages/cross-review.js";
import type { Finding } from "../../src/review/contracts.js";

describe("review candidate selection", () => {
    it("prioritizes severity while diversifying equal-severity reviewer origins", () => {
        const candidates = [
            finding("a-1", "architect", "high", "verified"),
            finding("a-2", "architect", "high", "unsupported"),
            finding("s-1", "security", "high", "verified"),
            finding("p-1", "performance", "medium", "unsupported"),
        ];
        expect(selectReviewCandidates(candidates, 3).map((item) => item.id)).toEqual(["a-2", "s-1", "a-1"]);
    });

    it("prefers unsupported and low-confidence candidates within the same severity", () => {
        const supported = finding("supported", "architect", "medium", "verified");
        const uncertain = finding("uncertain", "architect", "medium", "unsupported");
        uncertain.confidence = "low";
        expect(selectReviewCandidates([supported, uncertain], 1)[0]?.id).toBe("uncertain");
    });
});

describe("cross-review assignment", () => {
    it("balances repeated findings across reviewer roles and providers", () => {
        const findings = Array.from({ length: 4 }, (_, index) => finding(`f-${index}`, "performance", "medium", "proposed"));
        const reviewers = [
            { roleId: "architect", resolvedModel: { provider: "ark", modelId: "a" } },
            { roleId: "security", resolvedModel: { provider: "gpt", modelId: "s" } },
            { roleId: "performance", resolvedModel: { provider: "minimax", modelId: "p" } },
            { roleId: "maintainability", resolvedModel: { provider: "ark", modelId: "m" } },
        ];
        expect(assignCrossReviewers(findings, reviewers).map((item) => item?.roleId)).toEqual([
            "architect", "security", "maintainability", "security",
        ]);
    });
});

function finding(id: string, role: string, severity: Finding["severity"], status: Finding["status"]): Finding {
    return {
        id,
        title: id,
        description: id,
        category: "correctness",
        severity,
        confidence: "high",
        status,
        evidence: [{ id: `${id}-e`, kind: "code", path: "a.ts", startLine: 1, verification: status === "verified" ? "verified" : "stale" }],
        raisedBy: [role],
        challenges: [],
    };
}
