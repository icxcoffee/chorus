import { mkdtemp, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    appendHistory,
    bootstrapConfigIfAbsent,
    HISTORY_MAX_ENTRIES,
    HISTORY_WARNING_BYTES,
    loadConfig,
    pruneHistory,
    saveConfig,
} from "../../src/store.js";
import { config, preset, registry, voiceResult } from "./fixtures.js";

describe("store", () => {
    it("writes, loads, chmods, and validates config", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-"));
        await saveConfig(config, { baseDir: dir }, registry);
        await expect(loadConfig({ baseDir: dir }, registry)).resolves.toEqual(
            config,
        );
        const mode = (await stat(join(dir, "config.json"))).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it("rejects invalid config states", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-"));
        await expect(
            saveConfig(
                { ...config, activePresetName: "x" },
                { baseDir: dir },
                registry,
            ),
        ).rejects.toThrow("activePresetName");
        await expect(
            saveConfig(
                { ...config, configVersion: 2 as 1 },
                { baseDir: dir },
                registry,
            ),
        ).rejects.toThrow("unsupported chorus configVersion");
        await expect(
            saveConfig(
                {
                    ...config,
                    presets: [
                        { ...preset, conductor: { provider: "missing", modelId: "x" } },
                    ],
                },
                { baseDir: dir },
                registry,
            ),
        ).rejects.toThrow("conductor missing/x");
    });

    it("appends history as jsonl", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-"));
        await appendHistory(
            {
                runId: "r1",
                presetName: "default",
                prompt: "p",
                voices: [voiceResult(0)],
                synthesis: "s",
                totalDurationMs: 1,
                totalCostUsd: 0.1,
                successfulVoices: 1,
                totalVoices: 1,
                startedAt: 1,
                finishedAt: 2,
            },
            { baseDir: dir },
        );
        expect(
            (await readFile(join(dir, "history.jsonl"), "utf8")).trim(),
        ).toContain('"runId":"r1"');
    });

    it("warns when history grows past the retention threshold", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-large-history-"));
        const historyPath = join(dir, "history.jsonl");
        await writeFile(historyPath, "");
        await truncate(historyPath, HISTORY_WARNING_BYTES + 1);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            await appendHistory(
                {
                    runId: "r1",
                    presetName: "default",
                    prompt: "p",
                    voices: [voiceResult(0)],
                    synthesis: "s",
                    totalDurationMs: 1,
                    totalCostUsd: 0.1,
                    successfulVoices: 1,
                    totalVoices: 1,
                    startedAt: 1,
                    finishedAt: 2,
                },
                { baseDir: dir },
            );
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("chorus history is"),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("prunes history beyond the entry retention limit", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-prune-"));
        const historyPath = join(dir, "history.jsonl");
        const overLimit = HISTORY_MAX_ENTRIES + 5;
        await writeFile(
            historyPath,
            `${Array.from({ length: overLimit }, (_, index) => JSON.stringify({ runId: `old-${index}` })).join("\n")}\n`,
        );
        await pruneHistory({ baseDir: dir });
        const kept = (await readFile(historyPath, "utf8")).trim().split("\n");
        expect(kept).toHaveLength(HISTORY_MAX_ENTRIES);
        expect(kept[0]).toContain("old-5");
        expect(kept.at(-1)).toContain(`old-${overLimit - 1}`);
    });

    it("bootstraps first-run defaults only when absent", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-"));
        const bootstrapped = await bootstrapConfigIfAbsent({
            paths: { baseDir: dir },
            registry,
            computePresets: () => [preset],
        });
        expect(bootstrapped?.activePresetName).toBe("default");
        const loaded = await bootstrapConfigIfAbsent({
            paths: { baseDir: dir },
            registry,
            computePresets: () => [],
        });
        expect(loaded?.presets).toHaveLength(1);
    });
});
