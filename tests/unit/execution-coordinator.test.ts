import { describe, expect, it } from "vitest";
import { executeVoices } from "../../src/runtime/execution-coordinator.js";
import { preset, voiceResult } from "./fixtures.js";

describe("execution coordinator", () => {
    it("preserves voice order while isolating failures", async () => {
        const result = await executeVoices({
            voices: preset.voices,
            startedAt: 1,
            signal: new AbortController().signal,
            execute: async ({ voice, voiceIndex }) => {
                if (voiceIndex === 0) throw new Error("unavailable");
                return { ...voiceResult(voiceIndex), voice };
            },
        });
        expect(result.voices.map((voice) => voice.status)).toEqual(["error", "success"]);
        expect(result.voices[0]?.voice).toEqual(preset.voices[0]);
        expect(result.successfulVoices).toBe(1);
    });

    it("bounds concurrent work for subagent-style execution", async () => {
        const voices = [...preset.voices, ...preset.voices, ...preset.voices];
        let active = 0;
        let maximum = 0;
        const result = await executeVoices({
            voices,
            bounded: true,
            concurrency: 2,
            startedAt: 1,
            signal: new AbortController().signal,
            execute: async ({ voice, voiceIndex }) => {
                active += 1;
                maximum = Math.max(maximum, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return { ...voiceResult(voiceIndex), voice };
            },
        });
        expect(result.successfulVoices).toBe(voices.length);
        expect(maximum).toBe(2);
    });

    it("defaults omitted bounded execution to five concurrent voices", async () => {
        const voices = Array.from({ length: 6 }, (_, index) => preset.voices[index % preset.voices.length]!);
        let active = 0;
        let maximum = 0;
        await executeVoices({
            voices,
            startedAt: 1,
            signal: new AbortController().signal,
            execute: async ({ voice, voiceIndex }) => {
                active += 1;
                maximum = Math.max(maximum, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return { ...voiceResult(voiceIndex), voice };
            },
        });
        expect(maximum).toBe(5);
    });

    it("preserves explicitly requested unbounded execution", async () => {
        const voices = Array.from({ length: 6 }, (_, index) => preset.voices[index % preset.voices.length]!);
        let active = 0;
        let maximum = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const running = executeVoices({
            voices,
            bounded: false,
            startedAt: 1,
            signal: new AbortController().signal,
            execute: async ({ voice, voiceIndex }) => {
                active += 1;
                maximum = Math.max(maximum, active);
                if (active === voices.length) release();
                await barrier;
                return { ...voiceResult(voiceIndex), voice };
            },
        });
        await barrier;
        await running;
        expect(maximum).toBe(voices.length);
    });
});
