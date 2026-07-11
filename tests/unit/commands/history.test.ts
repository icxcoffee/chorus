import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleHistory } from "../../../src/commands/history.js";
import { HISTORY_MAX_ENTRIES } from "../../../src/store.js";

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
});
