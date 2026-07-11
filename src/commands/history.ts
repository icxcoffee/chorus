import type { StorePaths } from "../store.js";
import { pruneHistory, resolveStorePaths } from "../store.js";
import { splitCommandArgs } from "./args.js";

const DEFAULT_HISTORY_MAX_ENTRIES = 1000;

export interface HistoryCommandContext {
    storePaths?: StorePaths;
    ui?: {
        notify?: (content: string, level?: "info" | "warning" | "error") => void;
        show?: (content: string) => void;
    };
}

export async function handleHistory(
    ctx: HistoryCommandContext,
    rawArgs = "",
): Promise<void> {
    const [action, ...rest] = splitCommandArgs(rawArgs);
    if (action !== "prune") {
        notify(ctx, "Usage: /chorus history prune [max-entries]", "warning");
        return;
    }
    const [maxEntriesArg] = rest;
    const maxEntries = parseMaxEntries(maxEntriesArg);
    if (maxEntries === null) {
        notify(ctx, "Usage: /chorus history prune [max-entries]", "warning");
        return;
    }
    await pruneHistory(ctx.storePaths ?? {}, maxEntries);
    const { historyPath } = resolveStorePaths(ctx.storePaths ?? {});
    notify(
        ctx,
        `chorus history pruned to the last ${maxEntries} entries at ${historyPath}`,
        "info",
    );
}

function parseMaxEntries(value: string | undefined): number | null {
    if (value === undefined) return DEFAULT_HISTORY_MAX_ENTRIES;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return parsed;
}

function notify(
    ctx: HistoryCommandContext,
    content: string,
    level: "info" | "warning" | "error",
): void {
    if (ctx.ui?.notify) ctx.ui.notify(content, level);
    else console.log(content);
}
