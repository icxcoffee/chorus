import { describe, expect, it } from "vitest";
import { budgetAllows, BudgetTracker, estimateBudget, estimateModelBudget } from "../../src/runtime/budget.js";
import { preset, registry } from "./fixtures.js";

describe("run budgets", () => {
    it("estimates known pricing and flags unknown pricing", () => {
        const estimate = estimateBudget({ voices: preset.voices, conductor: preset.conductor, prompt: "hello", registry });
        expect(estimate.usd).not.toBeNull();
        expect(estimate.voices).toBe(2);
        expect(budgetAllows(estimate, { maxVoices: 2 })).toBe(true);
        expect(budgetAllows(estimate, { maxVoices: 1 })).toBe(false);
    });
    it("tracks actual spend while reserving conductor budget", () => {
        const tracker = new BudgetTracker({ maxUsd: 1, conductorReserveUsd: 0.2 });
        tracker.record({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, 0.7);
        expect(tracker.canSpend(0.11)).toBe(false);
        expect(tracker.actual).toEqual({ usd: 0.7, inputTokens: 10, outputTokens: 20 });
    });
    it("preserves Unicode code-point counting without allocating a character array", () => {
        const estimate = estimateModelBudget(preset.voices[0]!.model, "😀😀😀😀", registry);
        expect(estimate.inputTokens).toBe(1);
    });
});
