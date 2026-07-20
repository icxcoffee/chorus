import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleBatch } from "../../../src/commands/batch.js";
import { config, registry, voiceResult } from "../fixtures.js";
import { saveConfig } from "../../../src/store.js";

describe("batch command", () => {
    it("writes resumable per-case and aggregate reports", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-batch-command-"));
        const dataset = join(dir, "cases.jsonl");
        await writeFile(dataset, '{"id":"case-1","prompt":"question","reference":"expected"}\n');
        await saveConfig(config, { baseDir: dir }, registry);
        const shown: string[] = [];
        await handleBatch({ storePaths: { baseDir: dir }, modelRegistry: { models: registry }, ui: { show: (content) => shown.push(content) }, runBatchCase: async (args) => ({ runId: "r", presetName: args.runConfig.presetName, prompt: args.prompt, voices: [voiceResult(0), voiceResult(1)], synthesis: "answer", totalDurationMs: 5, totalCostUsd: 0.01, successfulVoices: 2, totalVoices: 2, startedAt: 1, finishedAt: 6 }) }, dataset);
        const outputDir = shown[0]!.split("\n")[1]!.replace("Directory: ", "");
        expect(await readFile(join(outputDir, "report.md"), "utf8")).toContain("case-1");
        expect(await readFile(join(outputDir, "report.csv"), "utf8")).toContain("successRate");
        expect(await readFile(join(outputDir, "checkpoint.json"), "utf8")).toContain("case-1");
    });

    it("honors preset execution limits while isolating batch cases from session history", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-batch-options-"));
        const dataset = join(dir, "cases.jsonl");
        await writeFile(dataset, '{"id":"case-1","prompt":"question"}\n');
        const configured = structuredClone(config);
        Object.assign(configured.presets[0]!, {
            includeSessionHistory: true,
            voiceTimeoutMs: 12_000,
            conductorTimeoutMs: 34_000,
            maxConcurrency: 3,
            providerConcurrency: { deepseek: 1 },
            permissionProfile: "workspace-write",
            budget: { maxVoices: 2 },
            cachePolicy: { enabled: true, allowSessionHistory: true },
        });
        await saveConfig(configured, { baseDir: dir }, registry);
        const run = vi.fn(async (args) => ({ runId: "r", presetName: args.runConfig.presetName, prompt: args.prompt, voices: [voiceResult(0), voiceResult(1)], synthesis: "answer", totalDurationMs: 5, totalCostUsd: 0.01, successfulVoices: 2, totalVoices: 2, startedAt: 1, finishedAt: 6 }));
        await handleBatch({ storePaths: { baseDir: dir }, modelRegistry: { models: registry }, ui: { show: () => undefined }, runBatchCase: run }, dataset);

        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            runConfig: expect.objectContaining({ includeSessionHistory: false, maxConcurrency: 3, providerConcurrency: { deepseek: 1 }, permissionProfile: "workspace-write" }),
            voiceConcurrency: 3,
            permissionProfile: "workspace-write",
            voiceTimeoutMs: 12_000,
            conductorTimeoutMs: 34_000,
            budget: { maxVoices: 2 },
            cachePolicy: { enabled: true, allowSessionHistory: true },
        }));
    });
});
