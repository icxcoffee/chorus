import { describe, expect, it } from "vitest";
import { getStrategyRunner, registerStrategy } from "../../src/strategies/runner.js";
import { preset, registry, voiceResult } from "./fixtures.js";

describe("strategy runner contract", () => {
    it("runs the default parallel strategy through shared execution", async () => {
        const result = await getStrategyRunner("parallel").run({
            runConfig: { presetName: "default", voices: preset.voices, conductor: preset.conductor, mode: "direct", strategy: "parallel" },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            executeRound: async (voices) => voices.map((voice, voiceIndex) => ({ ...voiceResult(voiceIndex), voice })),
        });
        expect(result.rounds).toHaveLength(1);
        expect(result.voices).toHaveLength(2);
    });
    it("supports registration and gives migration-aware unknown errors", async () => {
        registerStrategy({ id: "test", run: async () => ({ voices: [], synthesisVoices: [], rounds: [] }) });
        expect((await getStrategyRunner("test").run({} as never)).rounds).toEqual([]);
        expect(() => getStrategyRunner("missing")).toThrow("migrate config");
    });
});
