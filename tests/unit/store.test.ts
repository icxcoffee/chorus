import { mkdtemp, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    appendHistory,
    bootstrapConfigIfAbsent,
    HISTORY_MAX_ENTRIES,
    HISTORY_PRUNE_TARGET_ENTRIES,
    HISTORY_WARNING_BYTES,
    loadConfig,
    loadConfigUnchecked,
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
                { ...config, configVersion: 3 as 2 },
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

    it("migrates valid v1 config in memory and persists validated v2", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-v1-"));
        const legacy = {
            configVersion: 1,
            activePresetName: "default",
            presets: [{
                ...preset,
                strategy: "A",
                optimizeBeforeAsk: false,
            }],
        } as const;
        await writeFile(join(dir, "config.json"), `${JSON.stringify(legacy)}\n`);

        const unchecked = await loadConfigUnchecked({ baseDir: dir });
        expect(unchecked).toMatchObject({
            configVersion: 2,
            presets: [{ strategy: "parallel" }],
        });
        expect(await readFile(join(dir, "config.json"), "utf8")).toContain('"configVersion":1');

        await expect(loadConfig({ baseDir: dir }, registry)).resolves.toEqual(unchecked);
        const persisted = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
        expect(persisted.configVersion).toBe(2);
        expect(persisted.presets[0]).not.toHaveProperty("optimizeBeforeAsk");
    });

    it("rejects malformed and future configs without overwriting them", async () => {
        const malformedDir = await mkdtemp(join(tmpdir(), "chorus-store-malformed-"));
        const malformedPath = join(malformedDir, "config.json");
        await writeFile(malformedPath, '{"configVersion":1,"presets":"bad"}\n');
        await expect(loadConfig({ baseDir: malformedDir }, registry)).rejects.toThrow("presets must be an array");
        expect(await readFile(malformedPath, "utf8")).toContain('"configVersion":1');

        const futureDir = await mkdtemp(join(tmpdir(), "chorus-store-future-"));
        const futurePath = join(futureDir, "config.json");
        await writeFile(futurePath, '{"configVersion":99,"presets":[]}\n');
        await expect(loadConfig({ baseDir: futureDir }, registry)).rejects.toThrow("unsupported chorus configVersion 99");
        expect(await readFile(futurePath, "utf8")).toContain('"configVersion":99');
    });

    it("keeps unsupported v1 optimize behavior explicit", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-optimize-"));
        const legacy = {
            configVersion: 1,
            activePresetName: "default",
            presets: [{ ...preset, strategy: "A", optimizeBeforeAsk: true }],
        };
        await writeFile(join(dir, "config.json"), `${JSON.stringify(legacy)}\n`);
        await expect(loadConfig({ baseDir: dir }, registry)).rejects.toThrow("unsupported optimizeBeforeAsk=true");
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

    it("invalidates the cached history count when the file changes externally", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-history-cache-"));
        const historyPath = join(dir, "history.jsonl");
        await appendHistory(historyResult("first"), { baseDir: dir });
        const overLimit = HISTORY_MAX_ENTRIES + 5;
        await writeFile(historyPath, `${Array.from({ length: overLimit }, (_, index) => JSON.stringify({ runId: `external-${index}` })).join("\n")}\n`);
        await appendHistory(historyResult("latest"), { baseDir: dir });
        const kept = (await readFile(historyPath, "utf8")).trim().split("\n");
        expect(kept).toHaveLength(HISTORY_PRUNE_TARGET_ENTRIES);
        expect(kept[0]).toContain(`external-${overLimit - HISTORY_PRUNE_TARGET_ENTRIES + 1}`);
        expect(kept.at(-1)).toContain('"runId":"latest"');
    });

    it("uses a lower automatic prune target to avoid rewriting history on every append", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-store-history-watermark-"));
        const historyPath = join(dir, "history.jsonl");
        await writeFile(historyPath, `${Array.from({ length: HISTORY_MAX_ENTRIES }, (_, index) => JSON.stringify({ runId: `old-${index}` })).join("\n")}\n`);
        await appendHistory(historyResult("overflow"), { baseDir: dir });
        await appendHistory(historyResult("next"), { baseDir: dir });
        const kept = (await readFile(historyPath, "utf8")).trim().split("\n");
        expect(kept).toHaveLength(HISTORY_PRUNE_TARGET_ENTRIES + 1);
        expect(kept.at(-1)).toContain('"runId":"next"');
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

function historyResult(runId: string) {
    return {
        runId,
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
    };
}
