import { describe, expect, it } from "vitest";
import "../../src/strategies/advanced.js";
import { getStrategyRunner } from "../../src/strategies/runner.js";
import { preset, registry, voiceResult } from "./fixtures.js";

describe("advanced strategies", () => {
    it("runs bounded debate, blinded rank, and refine stages", async () => {
        for (const id of ["debate", "rank", "refine"]) {
            const prompts: string[] = [];
            const result = await getStrategyRunner(id).run({ runConfig: { presetName: "default", voices: preset.voices, conductor: preset.conductor, mode: "direct", strategy: id as "debate" | "rank" | "refine" }, prompt: "p", registry, signal: new AbortController().signal, executeRound: async (voices, prompt) => { prompts.push(prompt); return voices.map((voice, voiceIndex) => ({ ...voiceResult(voiceIndex), voice })); } });
            expect(result.rounds.length).toBeGreaterThan(0);
            expect(result.voices).toHaveLength(2);
            expect(prompts).toHaveLength(2);
            expect(prompts[1]).not.toBe("p");
            if (id === "rank") {
                expect(prompts[1]).not.toContain("deepseek");
                expect(prompts[1]).not.toContain("minimax");
            }
        }
    });
});
