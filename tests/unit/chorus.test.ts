import { describe, expect, it } from "vitest";
import { runChorus } from "../../src/chorus.js";
import { preset, registry, voiceResult } from "./fixtures.js";
import type {
    ChorusProgress,
    ChorusResult,
    ChorusVoice,
    VoiceResult,
} from "../../src/types.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("orchestrator", () => {
    it("fans out voices, synthesizes successes, aggregates cost, and appends history", async () => {
        const history: ChorusResult[] = [];
        const progress: ChorusProgress[] = [];
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "direct",
                strategy: "parallel",
            },
            prompt: "original",
            optimizedPrompt: "optimized",
            registry,
            signal: new AbortController().signal,
            runVoiceDirect: async (args) => ({
                ...voiceResult(args.voiceIndex ?? 0),
                voice: args.voice,
            }),
            synthesizeFn: async (args) => {
                expect(args.prompt).toBe("original");
                expect(args.optimizedPrompt).toBe("optimized");
                return {
                    synthesis: "final",
                    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                    costUsd: 0.003,
                };
            },
            appendHistory: async (entry) => {
                history.push(entry);
            },
            onProgress: (updates) => progress.push(...updates),
        });
        expect(result.synthesis).toBe("final");
        expect(result.successfulVoices).toBe(2);
        expect(result.totalCostUsd).toBe(0.006);
        expect(history).toHaveLength(1);
        const conductorStatuses = progress
            .filter((update) => update.kind === "conductor")
            .map((update) => update.status);
        expect(conductorStatuses[0]).toBe("running");
        expect(conductorStatuses.at(-1)).toBe("success");
    });

    it("skips synthesis with one success", async () => {
        const result = await runWithVoices([
            voiceResult(0),
            { ...voiceResult(1, "error"), errorMessage: "boom" },
        ]);
        expect(result.synthesis).toBeNull();
        expect(result.fallbackNote).toContain("1/2 voices responded");
    });

    it("reports all voice failures", async () => {
        const result = await runWithVoices([
            { ...voiceResult(0, "error"), errorMessage: "a" },
            { ...voiceResult(1, "error"), errorMessage: "b" },
        ]);
        expect(result.fallbackNote).toContain("all 2 voices failed");
    });

    it("keeps raw voices when conductor fails", async () => {
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "direct",
                strategy: "parallel",
            },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            runVoiceDirect: async (args) => ({
                ...voiceResult(args.voiceIndex ?? 0),
                voice: args.voice,
            }),
            synthesizeFn: async () => {
                throw new Error("conductor down");
            },
            appendHistory: async () => undefined,
        });
        expect(result.synthesis).toBeNull();
        expect(result.fallbackNote).toContain("conductor failed");
        expect(result.totalCostUsd).toBeNull();
    });

    it("times out direct synthesis independently and keeps raw voices", async () => {
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "direct",
                strategy: "parallel",
            },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            conductorTimeoutMs: 1,
            runVoiceDirect: async (args) => ({
                ...voiceResult(args.voiceIndex ?? 0),
                voice: args.voice,
            }),
            synthesizeFn: async () => await new Promise<never>(() => undefined),
            appendHistory: async () => undefined,
        });
        expect(result.synthesis).toBeNull();
        expect(result.fallbackNote).toContain("timed out after 1ms");
        expect(result.voices[0]?.output).toContain("answer");
    });

    it("passes conductor timeout into main-agent synthesis", async () => {
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "subagent",
                strategy: "parallel",
            },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            conductorTimeoutMs: 12_345,
            runVoiceSubagent: async (args) => ({
                ...voiceResult(args.voiceIndex ?? 0),
                voice: args.voice,
            }),
            synthesisMode: "agent",
            synthesizeAgentFn: async (args) => {
                expect(args.timeoutMs).toBe(12_345);
                return { synthesis: "agent final", costUsd: 0 };
            },
            appendHistory: async () => undefined,
        });
        expect(result.synthesis).toBe("agent final");
    });

    it("passes session-history setting to child agents", async () => {
        const seen: boolean[] = [];
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "subagent",
                strategy: "parallel",
                includeSessionHistory: true,
            },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            runVoiceSubagent: async (args) => {
                seen.push(args.includeSessionHistory ?? false);
                return { ...voiceResult(args.voiceIndex ?? 0), voice: args.voice };
            },
            synthesizeAgentFn: async () => ({ synthesis: "agent final", costUsd: 0 }),
            synthesisMode: "agent",
            appendHistory: async () => undefined,
        });
        expect(result.synthesis).toBe("agent final");
        expect(seen).toEqual([true, true]);
    });

    it("dispatches to subagent mode", async () => {
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "subagent",
                strategy: "parallel",
            },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            runVoiceSubagent: async (args) => ({
                ...voiceResult(args.voiceIndex ?? 0),
                voice: args.voice,
            }),
            synthesizeFn: async () => ({ synthesis: "final", costUsd: 0 }),
            appendHistory: async () => undefined,
        });
        expect(result.synthesis).toBe("final");
    });

    it("uses the default subagent fan-out concurrency", async () => {
        const voiceModelIndexes = [0, 1, 2, 4, 0];
        const voices: ChorusVoice[] = voiceModelIndexes.map(
            (modelIndex, index) => ({
                model: {
                    provider: registry[modelIndex]!.provider,
                    modelId: registry[modelIndex]!.modelId,
                },
                role: index % 2 === 0 ? "reasoning" : "balanced",
            }),
        );
        let active = 0;
        let maxActive = 0;
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices,
                conductor: preset.conductor,
                mode: "subagent",
                strategy: "parallel",
            },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            runVoiceSubagent: async (args) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 10));
                active -= 1;
                return { ...voiceResult(args.voiceIndex ?? 0), voice: args.voice };
            },
            synthesizeAgentFn: async () => ({ synthesis: "agent final", costUsd: 0 }),
            synthesisMode: "agent",
            appendHistory: async () => undefined,
        });
        expect(result.successfulVoices).toBe(5);
        expect(maxActive).toBe(5);
    });

    it("does not block returning on history append", async () => {
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "direct",
                strategy: "parallel",
            },
            prompt: "p",
            registry,
            signal: new AbortController().signal,
            runVoiceDirect: async (args) => ({
                ...voiceResult(args.voiceIndex ?? 0),
                voice: args.voice,
            }),
            synthesizeFn: async () => ({ synthesis: "final", costUsd: 0 }),
            appendHistory: async () => await new Promise<never>(() => undefined),
        });
        expect(result.synthesis).toBe("final");
    });

    it("refuses to run with an empty model registry", async () => {
        await expect(
            runChorus({
                runConfig: {
                    presetName: "default",
                    voices: preset.voices,
                    conductor: preset.conductor,
                    mode: "direct",
                    strategy: "parallel",
                },
                prompt: "p",
                registry: [],
                signal: new AbortController().signal,
                appendHistory: async () => undefined,
            }),
        ).rejects.toThrow("empty model registry");
    });

    it("marks rejected voice runners as aborted when parent aborts", async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await runChorus({
            runConfig: {
                presetName: "default",
                voices: preset.voices,
                conductor: preset.conductor,
                mode: "direct",
                strategy: "parallel",
            },
            prompt: "p",
            registry,
            signal: controller.signal,
            runVoiceDirect: async () => {
                throw new Error("cancel");
            },
            appendHistory: async () => undefined,
        });
        expect(result.voices.every((voice) => voice.status === "aborted")).toBe(
            true,
        );
    });

    it("enforces token budgets before launching voices and conductor", async () => {
        let calls = 0;
        const result = await runChorus({
            runConfig: { presetName: "default", voices: preset.voices, conductor: preset.conductor, mode: "direct", strategy: "parallel" },
            prompt: "budgeted prompt",
            registry,
            signal: new AbortController().signal,
            budget: { maxInputTokens: 1 },
            runVoiceDirect: async (args) => { calls += 1; return { ...voiceResult(args.voiceIndex ?? 0), voice: args.voice }; },
            appendHistory: async () => undefined,
        });
        expect(calls).toBe(0);
        expect(result.budget?.terminationReason).toContain("input token");
        expect(result.synthesis).toBeNull();
    });

    it("uses opt-in direct cache without double-counting provider cost", async () => {
        const baseDir = await mkdtemp(join(tmpdir(), "chorus-run-cache-"));
        let calls = 0;
        const run = (models = registry) => runChorus({
            runConfig: { presetName: "default", voices: preset.voices, conductor: preset.conductor, mode: "direct" as const, strategy: "parallel" as const },
            prompt: "cacheable",
            registry: models,
            signal: new AbortController().signal,
            storePaths: { baseDir },
            cachePolicy: { enabled: true },
            runVoiceDirect: async (args) => { calls += 1; return { ...voiceResult(args.voiceIndex ?? 0), voice: args.voice }; },
            synthesizeFn: async () => ({ synthesis: "final", costUsd: 0 }),
            appendHistory: async () => undefined,
        });
        await run();
        const cached = await run();
        expect(calls).toBe(2);
        expect(cached.cache).toEqual({ enabled: true, hits: 2, misses: 0 });
        expect(cached.voices.every((voice) => voice.cacheHit && voice.costUsd === 0)).toBe(true);
        const changedEndpoint = await run(registry.map((model) => ({ ...model, endpoint: `${model.endpoint}/changed` })));
        expect(calls).toBe(4);
        expect(changedEndpoint.cache).toEqual({ enabled: true, hits: 0, misses: 2 });
    });

});

async function runWithVoices(voices: VoiceResult[]): Promise<ChorusResult> {
    return runChorus({
        runConfig: {
            presetName: "default",
            voices: preset.voices,
            conductor: preset.conductor,
            mode: "direct",
            strategy: "parallel",
        },
        prompt: "p",
        registry,
        signal: new AbortController().signal,
        runVoiceDirect: async (args) => ({
            ...voices[args.voiceIndex ?? 0]!,
            voice: args.voice,
        }),
        appendHistory: async () => undefined,
    });
}
