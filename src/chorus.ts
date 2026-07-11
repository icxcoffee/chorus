import { randomUUID } from "node:crypto";
import type {
    ChorusProgress,
    ChorusResult,
    ChorusRunConfig,
    ModelInfo,
    PartialVoiceProgress,
    RegistryLike,
    VoiceResult,
} from "./types.js";
import { synthesizeWithMainAgent } from "./agent-synthesis.js";
import { writeRunArtifacts } from "./artifacts.js";
import { runDirectVoice } from "./direct-api.js";
import { runSubagentVoice } from "./subagent.js";
import { synthesize, type SynthesisResult } from "./synthesize.js";
import { redactSensitive } from "./utils/redact.js";
import {
    appendHistory as appendHistoryDefault,
    type StorePaths,
} from "./store.js";
import { aggregateTotalCost } from "./utils/cost.js";
import { validateRunConfig } from "./utils/models.js";
import { withTimeout } from "./utils/timeout.js";

export const DEFAULT_VOICE_TIMEOUT_MS = 1_800_000;
export const DEFAULT_CONDUCTOR_TIMEOUT_MS = 1_800_000;
export const DEFAULT_SUBAGENT_CONCURRENCY = 3;

export interface RunChorusArgs {
    runConfig: ChorusRunConfig;
    prompt: string;
    optimizedPrompt?: string;
    voiceTimeoutMs?: number;
    conductorTimeoutMs?: number;
    registry: ModelInfo[];
    modelRegistry?: RegistryLike;
    onProgress?: (update: ChorusProgress[]) => void;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    cwd?: string;
    storePaths?: StorePaths;
    appendHistory?: (result: ChorusResult) => Promise<void>;
    runVoiceDirect?: typeof runDirectVoice;
    runVoiceSubagent?: typeof runSubagentVoice;
    synthesizeFn?: typeof synthesize;
    synthesizeAgentFn?: typeof synthesizeWithMainAgent;
    synthesisMode?: "direct" | "agent";
    artifactDir?: string;
    subagentConcurrency?: number;
}

/**
 * Runs one Chorus prompt through all configured voices, optionally synthesizes
 * their successful outputs, writes requested artifacts/history, and returns the
 * complete run record. Voice execution is direct HTTP/Pi API for direct mode and
 * rate-limited child-agent processes for subagent mode.
 */
export async function runChorus(args: RunChorusArgs): Promise<ChorusResult> {
    validateRunConfig(args.runConfig, args.registry);
    if (args.registry.length === 0) {
        throw new Error(
            "chorus refuses to run with an empty model registry; configure at least one model before launching a run",
        );
    }
    const startedAt = Date.now();
    const runId = randomUUID();
    const effectivePrompt = args.optimizedPrompt ?? args.prompt;
    const runVoiceDirect = args.runVoiceDirect ?? runDirectVoice;
    const runVoiceSubagent = args.runVoiceSubagent ?? runSubagentVoice;
    const voiceTimeoutMs = args.voiceTimeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
    const conductorTimeoutMs =
        args.conductorTimeoutMs ?? DEFAULT_CONDUCTOR_TIMEOUT_MS;
    const voiceTasks = args.runConfig.voices.map(
        (voice, voiceIndex) => async (): Promise<VoiceResult> => {
            const onProgress = (update: PartialVoiceProgress) =>
                args.onProgress?.([update]);
            if (args.runConfig.mode === "subagent") {
                return runVoiceSubagent({
                    voice,
                    prompt: effectivePrompt,
                    voiceIndex,
                    timeoutMs: voiceTimeoutMs,
                    includeSessionHistory: args.runConfig.includeSessionHistory ?? false,
                    signal: args.signal,
                    onProgress,
                    ...(args.cwd ? { cwd: args.cwd } : {}),
                });
            }
            return runVoiceDirect({
                voice,
                prompt: effectivePrompt,
                registry: args.registry,
                ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
                voiceIndex,
                timeoutMs: voiceTimeoutMs,
                signal: args.signal,
                onProgress,
                ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
            });
        },
    );
    const settled =
        args.runConfig.mode === "subagent"
            ? await settleWithConcurrency(
                    voiceTasks,
                    args.subagentConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY,
                )
            : await Promise.allSettled(voiceTasks.map((task) => task()));
    const voices = settled.map((entry, index): VoiceResult => {
        if (entry.status === "fulfilled") return entry.value;
        const voice = args.runConfig.voices[index];
        if (!voice) throw entry.reason;
        return {
            voice,
            status: args.signal.aborted ? "aborted" : "error",
            durationMs: Date.now() - startedAt,
            costUsd: null,
            startedAt,
            errorMessage:
                entry.reason instanceof Error
                    ? entry.reason.message
                    : String(entry.reason),
        };
    });
    const successfulVoices = voices.filter(
        (voice) => voice.status === "success",
    ).length;
    let synthesisText: string | null = null;
    let fallbackNote: string | undefined;
    let conductorUsage: SynthesisResult["usage"];
    let conductorCostUsd: number | null | undefined;
    let conductorActivityLog: string | undefined;
    let conductorExecuted = false;
    if (successfulVoices < 2) {
        fallbackNote =
            successfulVoices === 0
                ? `all ${voices.length} voices failed; no synthesis`
                : `${successfulVoices}/${voices.length} voices responded; skipping synthesis`;
    } else {
        conductorExecuted = true;
        const conductorStartedAt = Date.now();
        args.onProgress?.([
            {
                kind: "conductor",
                conductor: args.runConfig.conductor,
                status: "running",
            },
        ]);
        try {
            const synthesizeResult = await withTimeout(
                (signal) =>
                    args.synthesisMode === "agent"
                        ? (args.synthesizeAgentFn ?? synthesizeWithMainAgent)({
                                conductor: args.runConfig.conductor,
                                prompt: args.prompt,
                                voices,
                                totalVoices: voices.length,
                                registry: args.registry,
                                ...(args.modelRegistry
                                    ? { modelRegistry: args.modelRegistry }
                                    : {}),
                                signal,
                                timeoutMs: conductorTimeoutMs,
                                ...(args.optimizedPrompt
                                    ? { optimizedPrompt: args.optimizedPrompt }
                                    : {}),
                                ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
                                ...(args.cwd ? { cwd: args.cwd } : {}),
                                ...(args.artifactDir ? { artifactDir: args.artifactDir } : {}),
                            })
                        : (args.synthesizeFn ?? synthesize)({
                                conductor: args.runConfig.conductor,
                                prompt: args.prompt,
                                voices,
                                totalVoices: voices.length,
                                registry: args.registry,
                                ...(args.modelRegistry
                                    ? { modelRegistry: args.modelRegistry }
                                    : {}),
                                signal,
                                ...(args.optimizedPrompt
                                    ? { optimizedPrompt: args.optimizedPrompt }
                                    : {}),
                                ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
                            }),
                conductorTimeoutMs,
                args.signal,
            );
            synthesisText = synthesizeResult.synthesis;
            conductorUsage = synthesizeResult.usage;
            conductorCostUsd = synthesizeResult.costUsd;
            const activityLog = (synthesizeResult as { activityLog?: unknown })
                .activityLog;
            conductorActivityLog =
                typeof activityLog === "string" ? activityLog : undefined;
            args.onProgress?.([
                {
                    kind: "conductor",
                    conductor: args.runConfig.conductor,
                    status: "success",
                    durationMs: Date.now() - conductorStartedAt,
                    ...(conductorUsage ? { usage: conductorUsage } : {}),
                    costUsd: conductorCostUsd,
                    ...(conductorActivityLog
                        ? { activityLog: conductorActivityLog }
                        : {}),
                },
            ]);
        } catch (error) {
            conductorCostUsd = null;
            args.onProgress?.([
                {
                    kind: "conductor",
                    conductor: args.runConfig.conductor,
                    status: args.signal.aborted ? "aborted" : "error",
                    durationMs: Date.now() - conductorStartedAt,
                    costUsd: null,
                    errorMessage: error instanceof Error ? error.message : String(error),
                },
            ]);
            fallbackNote = `conductor failed: ${error instanceof Error ? error.message : String(error)}; raw voice outputs shown`;
        }
    }
    const finishedAt = Date.now();
    const resultBase = {
        runId,
        presetName: args.runConfig.presetName,
        prompt: args.prompt,
        ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {}),
        voices,
        synthesis: synthesisText,
        ...(fallbackNote ? { fallbackNote } : {}),
        ...(conductorUsage ? { conductorUsage } : {}),
        totalDurationMs: finishedAt - startedAt,
        successfulVoices,
        totalVoices: voices.length,
        startedAt,
        finishedAt,
    };
    let result: ChorusResult = {
        ...resultBase,
        ...(conductorExecuted && conductorCostUsd !== undefined
            ? { conductorCostUsd }
            : {}),
        ...(conductorActivityLog ? { conductorActivityLog } : {}),
        totalCostUsd: aggregateTotalCost({
            voices,
            conductorExecuted,
            ...(conductorCostUsd !== undefined ? { conductorCostUsd } : {}),
        }),
    };
    if (args.artifactDir) {
        result = await writeRunArtifacts({
            result,
            outputDir: args.artifactDir,
            actorLabel: args.runConfig.mode === "subagent" ? "agent" : "voice",
        });
    }
    const appendHistory =
        args.appendHistory ??
        ((entry: ChorusResult) => appendHistoryDefault(entry, args.storePaths));
    void appendHistory(result).catch((error) => {
        console.error(
            "chorus history append failed:",
            redactSensitive(
                error instanceof Error ? error.message : String(error),
            ),
        );
    });
    return result;
}

async function settleWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number,
): Promise<Array<PromiseSettledResult<T>>> {
    const results: Array<PromiseSettledResult<T> | undefined> = new Array(
        tasks.length,
    );
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < workerCount; w += 1) {
        workers.push(
            (async (): Promise<void> => {
                while (nextIndex < tasks.length) {
                    const index = nextIndex;
                    nextIndex += 1;
                    const task = tasks[index];
                    if (!task) continue;
                    try {
                        results[index] = { status: "fulfilled", value: await task() };
                    } catch (reason) {
                        results[index] = { status: "rejected", reason };
                    }
                }
                return;
            })(),
        );
    }
    await Promise.all(workers);
    return results.map((result, index) => {
        if (result) return result;
        return {
            status: "rejected",
            reason: new Error(`voice task ${index} did not run`),
        };
    });
}
