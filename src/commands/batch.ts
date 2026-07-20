import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PiLikeContext } from "../pi-context.js";
import type { ChorusResult } from "../types.js";
import { runBatch, type BatchReport } from "../runtime/batch.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { runChorus } from "../chorus.js";
import { resolveStorePaths } from "../store.js";
import { splitCommandArgs } from "./args.js";
import { createHash } from "node:crypto";
import { runOptionsFromPreset } from "../runtime/preset.js";
import { atomicPrivateWrite } from "../utils/private-file.js";

export interface BatchCommandContext extends PiLikeContext { runBatchCase?: typeof runChorus; }

export async function handleBatch(ctx: BatchCommandContext, rawArgs: string): Promise<void> {
    const [datasetPath, ...presetNames] = splitCommandArgs(rawArgs);
    if (!datasetPath) { ctx.ui?.notify?.("Usage: /chorus batch <dataset.jsonl> [preset...]", "warning"); return; }
    const registry = await registryModels(ctx);
    const config = await loadOrBootstrap(ctx, registry);
    const names = presetNames.length ? presetNames : [config.activePresetName];
    const presets = names.map((name) => config.presets.find((preset) => preset.name === name)).filter((preset) => preset !== undefined);
    if (presets.length !== names.length) { ctx.ui?.notify?.("Unknown batch preset", "error"); return; }
    const batchId = `${basename(datasetPath).replace(/\W+/g, "-")}-${createHash("sha256").update(`${datasetPath}\0${names.join("\0")}`).digest("hex").slice(0, 12)}`;
    const outputDir = join(resolveStorePaths(ctx.storePaths).baseDir, "batches", batchId);
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const checkpointPath = join(outputDir, "checkpoint.json");
    const previous: { completed?: string[] } = await readFile(checkpointPath, "utf8").then((value) => JSON.parse(value) as { completed?: string[] }).catch(() => ({}));
    const completed = new Set(previous.completed ?? []);
    const report = await runBatch(datasetPath, async (item) => {
        const caseResults: Record<string, ChorusResult> = {};
        for (const preset of presets) {
            const result = await (ctx.runBatchCase ?? runChorus)({ ...runOptionsFromPreset(preset, { includeSessionHistory: false }), prompt: item.prompt, registry, signal: ctx.signal ?? new AbortController().signal, ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}), ...(ctx.cwd ? { cwd: ctx.cwd } : {}), ...(ctx.storePaths ? { storePaths: ctx.storePaths } : {}) });
            caseResults[preset.name] = result;
        }
        await atomicPrivateWrite(join(outputDir, `${item.id.replace(/\W+/g, "-")}.json`), `${JSON.stringify({ case: item, results: caseResults }, null, 2)}\n`);
        completed.add(item.id);
        await atomicPrivateWrite(checkpointPath, `${JSON.stringify({ version: 1, completed: [...completed] }, null, 2)}\n`);
        return caseResults;
    }, completed, ctx.signal);
    await writeBatchReports(outputDir, report);
    ctx.ui?.show?.(`chorus batch complete\nDirectory: ${outputDir}\nCompleted: ${report.completed.length}\nFailed: ${report.failed.length}\nInvalid: ${report.invalid.length}`);
}

async function writeBatchReports(outputDir: string, report: BatchReport): Promise<void> {
    const summaries = Object.entries(report.results).flatMap(([caseId, value]) => Object.entries(value as Record<string, ChorusResult>).map(([preset, result]) => ({ caseId, preset, costUsd: result.totalCostUsd, durationMs: result.totalDurationMs, successRate: result.totalVoices ? result.successfulVoices / result.totalVoices : 0, qualityCoverage: result.quality?.metrics.coverage ?? null })));
    const aggregate = { ...report, summaries, evaluatorCostUsd: 0 };
    await atomicPrivateWrite(join(outputDir, "report.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
    await atomicPrivateWrite(join(outputDir, "report.csv"), `${["caseId,preset,costUsd,durationMs,successRate,qualityCoverage", ...summaries.map((row) => `${row.caseId},${row.preset},${row.costUsd ?? ""},${row.durationMs},${row.successRate},${row.qualityCoverage ?? ""}`)].join("\n")}\n`);
    await atomicPrivateWrite(join(outputDir, "report.md"), `# Chorus Batch Report\n\n- Completed: ${report.completed.length}\n- Failed: ${report.failed.length}\n- Invalid: ${report.invalid.length}\n- Evaluator cost: $0\n\n${summaries.map((row) => `- ${row.caseId} / ${row.preset}: ${row.successRate * 100}% success, ${row.durationMs}ms, cost ${row.costUsd ?? "unknown"}`).join("\n")}\n`);
}
