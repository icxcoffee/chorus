import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleHistory } from "../../../src/commands/history.js";
import { HISTORY_MAX_ENTRIES, readHistory } from "../../../src/store.js";
import { preset, registry, voiceResult } from "../fixtures.js";

describe("history command", () => {
    it("prunes history to a custom max-entries limit", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-history-cmd-"));
        const historyPath = join(dir, "history.jsonl");
        const overLimit = HISTORY_MAX_ENTRIES + 3;
        await writeFile(
            historyPath,
            `${Array.from({ length: overLimit }, (_, index) => JSON.stringify({ runId: `old-${index}` })).join("\n")}\n`,
        );
        const notified: string[] = [];
        await handleHistory(
            {
                storePaths: { baseDir: dir },
                ui: { notify: (content) => notified.push(content) },
            },
            "prune 5",
        );
        const kept = (await readFile(historyPath, "utf8")).trim().split("\n");
        expect(kept).toHaveLength(5);
        expect(kept[0]).toContain(`old-${overLimit - 5}`);
        expect(kept.at(-1)).toContain(`old-${overLimit - 1}`);
        expect(notified[0]).toContain("pruned to the last 5 entries");
    });

    it("rejects an invalid action", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-history-cmd-"));
        const notified: string[] = [];
        await handleHistory(
            {
                storePaths: { baseDir: dir },
                ui: { notify: (content) => notified.push(content) },
            },
            "bogus",
        );
        expect(notified[0]).toContain("Usage");
    });

    it("streams valid entries and skips corrupt lines", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-history-stream-"));
        await writeFile(join(dir, "history.jsonl"), `${JSON.stringify({ runId: "ok", presetName: "default" })}\n{bad\n`);
        const result = await readHistory({ baseDir: dir });
        expect(result.entries).toHaveLength(1);
        expect(result.corruptLines).toBe(1);
    });

    it("shows, compares, filters, and snapshot-replays selected runs", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-history-workflow-"));
        const base = { presetName: "default", prompt: "private prompt", voices: [voiceResult(0), voiceResult(1)], synthesis: "answer", totalDurationMs: 10, totalCostUsd: 0.1, successfulVoices: 2, totalVoices: 2, startedAt: 1, finishedAt: 11, runConfigSnapshot: { presetName: "default", voices: preset.voices, conductor: preset.conductor, mode: "direct" as const, strategy: "parallel" as const } };
        await writeFile(join(dir, "history.jsonl"), `${JSON.stringify({ ...base, runId: "a" })}\n${JSON.stringify({ ...base, runId: "b", totalDurationMs: 20 })}\n`);
        const shown: string[] = [];
        const replayed: string[] = [];
        const ctx = { storePaths: { baseDir: dir }, modelRegistry: { models: registry }, ui: { show: (content: string) => shown.push(content), notify: (content: string) => shown.push(content) }, replayRun: async (args: Parameters<typeof import("../../../src/chorus.js").runChorus>[0]) => { replayed.push(args.prompt); return { ...base, runId: "replayed" }; } };
        await handleHistory(ctx, "compare a b");
        expect(shown.at(-1)).toContain("Chorus Comparison");
        await handleHistory(ctx, "replay a snapshot");
        expect(replayed).toEqual(["private prompt"]);
        await handleHistory(ctx, "list --preset default --limit 1");
        expect(shown.at(-1)?.match(/\n/g)?.length ?? 0).toBe(0);
    });
});
