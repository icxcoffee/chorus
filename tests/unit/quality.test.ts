import { describe, expect, it } from "vitest";
import { evaluateQuality, parseStructuredSynthesis } from "../../src/synthesis/quality.js";

describe("structured synthesis quality", () => {
    it("validates normalized output and computes transparent metrics", () => {
        const result = parseStructuredSynthesis(JSON.stringify({ version: 1, answer: "a", claims: [{ text: "claim", evidenceIds: ["voice-0"] }], disagreements: [], confidence: 2, unresolvedQuestions: [] }));
        expect(result?.confidence).toBe(1);
        expect(evaluateQuality(result!, ["voice-0"])).toEqual({ coverage: 1, agreement: 1, evidenceSupport: 1 });
    });
    it("rejects invalid output without fabricating fields", () => { expect(parseStructuredSynthesis("not json")).toBeNull(); expect(parseStructuredSynthesis(JSON.stringify({ version: 2, answer: "x" }))).toBeNull(); });
});
