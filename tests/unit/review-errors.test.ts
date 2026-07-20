import { describe, expect, it } from "vitest";
import { reviewFailureCategory } from "../../src/review/errors.js";
import { compactReviewDiagnostics, qualifyReviewDiagnostics } from "../../src/review/diagnostics.js";

describe("review failure categories", () => {
    it("classifies schema contract failures as output-format", () => {
        expect(reviewFailureCategory("finding.evidence[0].kind must be one of code, document, log")).toBe("output-format");
        expect(reviewFailureCategory("finding.evidence[0].startLine must be a positive integer")).toBe("output-format");
        expect(reviewFailureCategory("challenge[0].evidence[0].endLine must be a positive integer")).toBe("output-format");
        expect(reviewFailureCategory("pi produced no assistant text")).toBe("empty-output");
        expect(reviewFailureCategory("turn limit exceeded (4 allowed)")).toBe("budget");
    });

    it("preserves operational failure categories", () => {
        expect(reviewFailureCategory("HTTP 429 too many requests")).toBe("rate-limit");
        expect(reviewFailureCategory("network socket timeout")).toBe("timeout");
    });

    it("qualifies local stage diagnostics before global compaction", () => {
        const qualified = qualifyReviewDiagnostics("integrate", "integrator", ["integrator resolution references unknown finding missing"]);
        expect(compactReviewDiagnostics(qualified)).toEqual(["integrate/integrator: unknown-finding"]);
        expect(qualifyReviewDiagnostics("devil", "devil", ["stage=devil role=devil category=output-format: invalid"])).toEqual([
            "stage=devil role=devil category=output-format: invalid",
        ]);
    });
});
