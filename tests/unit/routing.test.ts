import { describe, expect, it } from "vitest";
import { routeModels } from "../../src/models/routing.js";
import { registry } from "./fixtures.js";

describe("dynamic model routing", () => {
    it("is opt-in and explains deterministic choices", () => {
        expect(() => routeModels({ models: registry, policy: { enabled: false } })).toThrow("disabled");
        const decision = routeModels({ models: registry, policy: { enabled: true, taskClass: "deep-reasoning", voiceCount: 2 }, health: { "minimax/MiniMax-M3": { failures: 4 } } });
        expect(decision.voices).toHaveLength(2);
        expect(decision.voices.map((voice) => `${voice.provider}/${voice.modelId}`)).not.toContain("minimax/MiniMax-M3");
        expect(decision.rationale.join(" ")).toContain("task class");
    });
    it("falls back when diversity is impossible", () => {
        const models = registry.slice(0, 2).map((model) => ({ ...model, provider: "same" }));
        const decision = routeModels({ models, policy: { enabled: true, voiceCount: 2 } });
        expect(decision.fallback).toBe(true);
    });
});
