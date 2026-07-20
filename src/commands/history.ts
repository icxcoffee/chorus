import type { StorePaths } from "../store.js";
import { pruneHistory, readHistory, resolveStorePaths } from "../store.js";
import { writeFile } from "node:fs/promises";
import { splitCommandArgs } from "./args.js";
import type { ChorusResult } from "../types.js";
import type { PiLikeContext } from "../pi-context.js";
import { registryModels } from "../models/registry.js";
import { runChorus } from "../chorus.js";
import { renderResult } from "../ui/result.js";
import { handleAsk } from "./ask.js";

const DEFAULT_HISTORY_MAX_ENTRIES = 1000;

export interface HistoryCommandContext {
    storePaths?: StorePaths;
    ui?: {
        notify?: (content: string, level?: "info" | "warning" | "error") => void;
        show?: (content: string) => void;
    };
    modelRegistry?: PiLikeContext["modelRegistry"];
    signal?: AbortSignal;
    cwd?: string;
    replayRun?: typeof runChorus;
}

export async function handleHistory(
    ctx: HistoryCommandContext,
    rawArgs = "",
): Promise<void> {
    const [action, ...rest] = splitCommandArgs(rawArgs);
    if (["list", "search", "show", "compare", "replay", "export"].includes(action ?? "")) {
        const { entries, corruptLines } = await readHistory(ctx.storePaths ?? {});
        if (action === "show") {
            const entry = findRun(entries, rest[0]);
            if (!entry) return notify(ctx, `unknown chorus run "${rest[0] ?? ""}"`, "error");
            return show(ctx, renderResult(entry).expanded);
        }
        if (action === "compare") {
            const left = findRun(entries, rest[0]);
            const right = findRun(entries, rest[1]);
            if (!left || !right) return notify(ctx, "Usage: /chorus history compare <runIdA> <runIdB>", "warning");
            return show(ctx, renderComparison(left, right));
        }
        if (action === "replay") {
            const entry = findRun(entries, rest[0]);
            const mode = rest[1];
            if (!entry || (mode !== "snapshot" && mode !== "current")) return notify(ctx, "Usage: /chorus history replay <runId> snapshot|current", "warning");
            if (mode === "current") return handleAsk(ctx as PiLikeContext, entry.prompt);
            if (!entry.runConfigSnapshot) return notify(ctx, `run ${entry.runId} has no configuration snapshot`, "error");
            const registry = await registryModels(ctx as PiLikeContext);
            const result = await (ctx.replayRun ?? runChorus)({ runConfig: entry.runConfigSnapshot, prompt: entry.prompt, ...(entry.optimizedPrompt ? { optimizedPrompt: entry.optimizedPrompt } : {}), registry, signal: ctx.signal ?? new AbortController().signal, ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}), ...(ctx.cwd ? { cwd: ctx.cwd } : {}), ...(ctx.storePaths ? { storePaths: ctx.storePaths } : {}) });
            return show(ctx, renderResult(result).expanded);
        }
        const keyword = action === "search" ? rest[0] : undefined;
        const filterArgs = action === "search" ? rest.slice(1) : rest;
        let selected = applyHistoryFilters(entries, filterArgs);
        if (keyword) selected = selected.filter((entry) => `${entry.presetName} ${entry.prompt} ${entry.synthesis ?? ""}`.toLowerCase().includes(keyword.toLowerCase()));
        if (action === "export") {
            const pathArg = rest[0];
            const format = rest[1] ?? "json";
            const ids = rest.slice(2);
            if (ids.length) selected = selected.filter((entry) => ids.includes(entry.runId));
            const output = renderHistoryExport(selected, format);
            const path = pathArg ?? `${resolveStorePaths(ctx.storePaths ?? {}).baseDir}/history-export.${format}`;
            await writeFile(path, `${output}\n`, { mode: 0o600 });
            notify(ctx, `chorus history exported ${selected.length} runs to ${path}${corruptLines ? `; skipped ${corruptLines} corrupt lines` : ""}`, "info");
        } else {
            notify(ctx, selected.map((entry) => `${entry.runId} ${entry.presetName} ${new Date(entry.startedAt).toISOString()} ${entry.successfulVoices}/${entry.totalVoices}`).join("\n") || "No history entries", "info");
        }
        return;
    }
    if (action !== "prune") {
        notify(ctx, "Usage: /chorus history list [filters] | search <keyword> [filters] | show <runId> | compare <a> <b> | replay <runId> snapshot|current | export <path> <json|md|csv> [runIds...] | prune [max]", "warning");
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

function findRun(entries: ChorusResult[], runId: string | undefined): ChorusResult | undefined { return entries.find((entry) => entry.runId === runId); }

function applyHistoryFilters(entries: ChorusResult[], args: string[]): ChorusResult[] {
    let selected = entries;
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index]; const value = args[index + 1]; if (!value) break;
        if (flag === "--preset") selected = selected.filter((entry) => entry.presetName === value);
        if (flag === "--model") selected = selected.filter((entry) => entry.voices.some((voice) => `${voice.voice.model.provider}/${voice.voice.model.modelId}` === value));
        if (flag === "--since") selected = selected.filter((entry) => entry.startedAt >= Date.parse(value));
        if (flag === "--until") selected = selected.filter((entry) => entry.startedAt <= Date.parse(value));
        if (flag === "--limit") selected = selected.slice(-Math.max(1, Number(value) || 1));
    }
    return selected;
}

function renderComparison(left: ChorusResult, right: ChorusResult): string {
    const models = (entry: ChorusResult) => entry.voices.map((voice) => `${voice.voice.model.provider}/${voice.voice.model.modelId}`).join(", ");
    return `# Chorus Comparison\n\n| Metric | ${left.runId} | ${right.runId} |\n| --- | --- | --- |\n| Preset | ${left.presetName} | ${right.presetName} |\n| Success | ${left.successfulVoices}/${left.totalVoices} | ${right.successfulVoices}/${right.totalVoices} |\n| Cost | ${left.totalCostUsd ?? "unknown"} | ${right.totalCostUsd ?? "unknown"} |\n| DurationMs | ${left.totalDurationMs} | ${right.totalDurationMs} |\n| Models | ${models(left)} | ${models(right)} |\n| Quality coverage | ${left.quality?.metrics.coverage ?? "n/a"} | ${right.quality?.metrics.coverage ?? "n/a"} |`;
}

function renderHistoryExport(entries: ChorusResult[], format: string): string {
    if (format === "json") return JSON.stringify(entries, null, 2);
    if (format === "md") return entries.map((entry) => `# Run ${entry.runId}\n\n${renderResult(entry).expanded}`).join("\n\n---\n\n");
    if (format === "csv") return ["runId,presetName,startedAt,totalCostUsd,totalDurationMs,successfulVoices,totalVoices,qualityCoverage", ...entries.map((entry) => [entry.runId, entry.presetName, entry.startedAt, entry.totalCostUsd ?? "", entry.totalDurationMs, entry.successfulVoices, entry.totalVoices, entry.quality?.metrics.coverage ?? ""].map(csvCell).join(","))].join("\n");
    throw new Error(`unsupported history export format "${format}"`);
}

function csvCell(value: unknown): string { const text = String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

function show(ctx: HistoryCommandContext, content: string): void { if (ctx.ui?.show) ctx.ui.show(content); else notify(ctx, content, "info"); }

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
