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
import { executeVoices } from "./runtime/execution-coordinator.js";
import { DEFAULT_MAX_CONCURRENCY } from "./runtime/scheduler.js";
import type { ChorusEventSink, ChorusResultPersister, SynthesisExecutor, VoiceExecutor } from "./runtime/contracts.js";
import type { RetryPolicy } from "./runtime/retry.js";
import type { RunBudget } from "./runtime/budget.js";
import { BudgetTracker, estimateBudget, estimateModelBudget } from "./runtime/budget.js";
import { cacheKeyWhenEnabled, RunCache, type CachePolicy } from "./runtime/cache.js";
import { resolveStorePaths } from "./store.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { getStrategyRunner, type StrategyResult } from "./strategies/runner.js";
import type { QualityMetrics, StructuredSynthesis } from "./synthesis/quality.js";

export const DEFAULT_VOICE_TIMEOUT_MS = 1_800_000;
export const DEFAULT_CONDUCTOR_TIMEOUT_MS = 1_800_000;
export const DEFAULT_SUBAGENT_CONCURRENCY = DEFAULT_MAX_CONCURRENCY;

export interface RunChorusArgs {
    runConfig: ChorusRunConfig;
    prompt: string;
    optimizedPrompt?: string;
    voiceTimeoutMs?: number;
    conductorTimeoutMs?: number;
    registry: ModelInfo[];
    modelRegistry?: RegistryLike;
    onProgress?: ChorusEventSink;
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
    voiceConcurrency?: number;
    retryPolicy?: RetryPolicy;
    permissionProfile?: import("./types.js").SubagentPermissionProfile;
    budget?: RunBudget;
    cachePolicy?: CachePolicy;
    onSynthesisDelta?: (text: string) => void;
    reuseVoiceResults?: Map<number, VoiceResult>;
    resumedFromJobId?: string;
    resumedPreviousCostUsd?: number | null;
}

export type { ChorusEventSink, ChorusResultPersister, SynthesisExecutor, VoiceExecutor } from "./runtime/contracts.js";

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
    const budgetTracker = args.budget ? new BudgetTracker(args.budget) : undefined;
    let budgetTerminationReason: string | undefined;
    let cacheHits = 0;
    let cacheMisses = 0;
    const cacheEnabled = args.cachePolicy?.enabled === true && (args.runConfig.mode === "direct" || args.cachePolicy.allowSessionHistory === true) && (!args.runConfig.includeSessionHistory || args.cachePolicy.allowSessionHistory === true);
    const cache = cacheEnabled
        ? new RunCache<VoiceResult>(`${resolveStorePaths(args.storePaths).baseDir}/cache`, { ...(args.cachePolicy ?? { enabled: false }), enabled: true })
        : undefined;
    const executeVoice = (roundPrompt: string, allowReuse: boolean): VoiceExecutor => async ({ voice, voiceIndex }) => {
            const reusable = allowReuse ? args.reuseVoiceResults?.get(voiceIndex) : undefined;
            if (reusable && reusable.status === "success" && reusable.voice.model.provider === voice.model.provider && reusable.voice.model.modelId === voice.model.modelId) {
                return { ...reusable, voice, durationMs: 0, costUsd: 0, startedAt: Date.now(), reused: true };
            }
            const registryModel = args.registry.find((model) => model.provider === voice.model.provider && model.modelId === voice.model.modelId);
            const endpoint = registryModel?.endpoint ?? registryModel?.baseUrl;
            const key = cacheKeyWhenEnabled(Boolean(cache), { prompt: roundPrompt, model: `${voice.model.provider}/${voice.model.modelId}`, role: voice.role ?? "balanced", systemPrompt: ROLE_SYSTEM_PROMPTS[voice.role ?? "balanced"], strategy: args.runConfig.strategy, stage: roundPrompt === effectivePrompt ? "initial" : "iterative", apiKind: registryModel?.apiKind ?? registryModel?.api ?? "pi-native", ...(endpoint ? { endpoint } : {}), mode: args.runConfig.mode, policyVersion: "voice-v3:endpoint:evidence-v1" });
            const cached = key ? await cache?.get(key) : undefined;
            if (cached && key) {
                cacheHits += 1;
                return { ...cached, voice, startedAt: Date.now(), durationMs: 0, costUsd: 0, cacheHit: true, cacheKey: key };
            }
            cacheMisses += cacheEnabled ? 1 : 0;
            const modelEstimate = estimateModelBudget(voice.model, roundPrompt, args.registry);
            const allowed = budgetTracker?.canStart(modelEstimate);
            if (allowed && !allowed.allowed) {
                budgetTerminationReason ??= allowed.reason;
                return { voice, status: args.signal.aborted ? "aborted" : "error", durationMs: 0, costUsd: null, startedAt: Date.now(), errorMessage: `run budget: ${allowed.reason}` };
            }
            const onProgress = (update: PartialVoiceProgress) =>
                args.onProgress?.([update]);
            let result: VoiceResult;
            if (args.runConfig.mode === "subagent") {
                result = await runVoiceSubagent({
                    voice,
                    prompt: roundPrompt,
                    voiceIndex,
                    timeoutMs: voiceTimeoutMs,
                    includeSessionHistory: args.runConfig.includeSessionHistory ?? false,
                    signal: args.signal,
                    onProgress,
                    ...(args.cwd ? { cwd: args.cwd } : {}),
                    permissionProfile: args.permissionProfile ?? args.runConfig.permissionProfile ?? "read-only",
                });
            } else result = await runVoiceDirect({
                voice,
                prompt: roundPrompt,
                registry: args.registry,
                ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
                voiceIndex,
                timeoutMs: voiceTimeoutMs,
                signal: args.signal,
                onProgress,
                ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
                ...(args.retryPolicy ? { retryPolicy: args.retryPolicy } : {}),
            });
            budgetTracker?.record(result.usage, result.costUsd);
            if (result.status === "success" && key) await cache?.set(key, result);
            return result;
        };
    const estimate = args.budget
        ? estimateBudget({ voices: args.runConfig.voices, conductor: args.runConfig.conductor, prompt: effectivePrompt, registry: args.registry })
        : undefined;
    const maxVoices = args.budget?.maxVoices === undefined
        ? args.runConfig.voices.length
        : Math.max(0, Math.min(args.runConfig.voices.length, args.budget.maxVoices));
    const strategy = getStrategyRunner(args.runConfig.strategy);
    strategy.validate?.(args.runConfig);
    const strategyResult: StrategyResult = await strategy.run({
        runConfig: { ...args.runConfig, voices: args.runConfig.voices.slice(0, maxVoices) },
        prompt: effectivePrompt,
        registry: args.registry,
        signal: args.signal,
        ...(args.budget ? { budget: args.budget } : {}),
        executeRound: async (roundVoices, roundPrompt, roundName) => (await executeVoices({
            voices: roundVoices,
            execute: executeVoice(roundPrompt, roundName === "answers" || roundName === "drafts"),
            bounded: true,
            concurrency: args.budget ? 1 : args.voiceConcurrency ?? args.runConfig.maxConcurrency ?? args.subagentConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY,
            startedAt: Date.now(),
            signal: args.signal,
            ...(args.runConfig.providerConcurrency ? { providerLimits: args.runConfig.providerConcurrency } : {}),
        })).voices,
    });
    const skippedVoices = args.runConfig.voices.slice(maxVoices).map((voice) => ({ voice, status: "error" as const, durationMs: 0, costUsd: null, startedAt, errorMessage: "run budget maxVoices reached" }));
    const voices = [...strategyResult.voices, ...skippedVoices];
    const synthesisVoices = strategyResult.synthesisVoices;
    const successfulVoices = voices.filter((voice) => voice.status === "success").length;
    let synthesisText: string | null = null;
    let fallbackNote: string | undefined;
    let conductorUsage: SynthesisResult["usage"];
    let conductorCostUsd: number | null | undefined;
    let conductorActivityLog: string | undefined;
    let structuredQuality: StructuredSynthesis | undefined;
    let qualityMetrics: QualityMetrics | undefined;
    let rawConductorOutput: string | undefined;
    let conductorExecuted = false;
    if (successfulVoices < 2) {
        fallbackNote =
            successfulVoices === 0
                ? `all ${voices.length} voices failed; no synthesis`
                : `${successfulVoices}/${voices.length} voices responded; skipping synthesis`;
    } else {
        const conductorAllowed = budgetTracker?.canStart(estimateModelBudget(args.runConfig.conductor, args.prompt, args.registry), false);
        if (conductorAllowed && !conductorAllowed.allowed) {
            budgetTerminationReason ??= conductorAllowed.reason;
            fallbackNote = `conductor skipped: ${conductorAllowed.reason}; raw voice outputs shown`;
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
            let lastDelta = "";
            let lastDeltaAt = 0;
            const onDelta = (text: string) => {
                if (!text || text === lastDelta) return;
                const now = Date.now();
                const isLikelyFinal = !text.startsWith(lastDelta);
                if (!isLikelyFinal && now - lastDeltaAt < 50 && text.length - lastDelta.length < 128) return;
                lastDelta = text;
                lastDeltaAt = now;
                args.onSynthesisDelta?.(text);
                args.onProgress?.([{ kind: "conductor", conductor: args.runConfig.conductor, status: "running", partialOutput: text }]);
            };
            const synthesizeResult = await withTimeout(
                (signal) =>
                    args.synthesisMode === "agent"
                        ? (args.synthesizeAgentFn ?? synthesizeWithMainAgent)({
                                conductor: args.runConfig.conductor,
                                prompt: args.prompt,
                                voices: synthesisVoices,
                                totalVoices: synthesisVoices.length,
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
                                onDelta,
                            })
                        : (args.synthesizeFn ?? synthesize)({
                                conductor: args.runConfig.conductor,
                                prompt: args.prompt,
                                voices: synthesisVoices,
                                totalVoices: synthesisVoices.length,
                                registry: args.registry,
                                ...(args.modelRegistry
                                    ? { modelRegistry: args.modelRegistry }
                                    : {}),
                                signal,
                                ...(args.optimizedPrompt
                                    ? { optimizedPrompt: args.optimizedPrompt }
                                    : {}),
                                ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
                                onDelta,
                            }),
                conductorTimeoutMs,
                args.signal,
            );
            synthesisText = synthesizeResult.synthesis;
            if (synthesisText !== lastDelta) {
                lastDelta = synthesisText;
                args.onSynthesisDelta?.(synthesisText);
                args.onProgress?.([{ kind: "conductor", conductor: args.runConfig.conductor, status: "running", partialOutput: synthesisText }]);
            }
            conductorUsage = synthesizeResult.usage;
            conductorCostUsd = synthesizeResult.costUsd;
            const enriched = synthesizeResult as SynthesisResult;
            structuredQuality = enriched.structured;
            qualityMetrics = enriched.qualityMetrics;
            rawConductorOutput = enriched.rawOutput;
            budgetTracker?.record(conductorUsage, conductorCostUsd);
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
        strategy: {
            id: args.runConfig.strategy,
            rounds: strategyResult.rounds,
            ...(typeof strategyResult.metadata?.rationale === "string" ? { rationale: strategyResult.metadata.rationale } : {}),
        },
        runConfigSnapshot: args.runConfig,
        ...(args.budget && estimate ? { budget: { configured: args.budget, estimate, ...(budgetTracker ? { actual: budgetTracker.actual } : {}), ...(budgetTerminationReason || maxVoices < args.runConfig.voices.length ? { terminationReason: budgetTerminationReason ?? "maxVoices budget reached" } : {}) } } : {}),
        ...(args.cachePolicy ? { cache: { enabled: cacheEnabled, hits: cacheHits, misses: cacheMisses } } : {}),
        ...(structuredQuality && qualityMetrics && rawConductorOutput ? { quality: { structured: structuredQuality, metrics: qualityMetrics, raw: rawConductorOutput } } : {}),
        totalCostUsd: aggregateTotalCost({
            voices: strategyResult.rounds.flatMap((round) => round.voices).concat(skippedVoices),
            conductorExecuted,
            ...(conductorCostUsd !== undefined ? { conductorCostUsd } : {}),
        }),
    };
    if (args.resumedFromJobId) {
        const previous = args.resumedPreviousCostUsd;
        result.attempt = {
            resumedFromJobId: args.resumedFromJobId,
            reusedVoices: [...(args.reuseVoiceResults?.keys() ?? [])],
            rerunVoices: args.runConfig.voices.map((_voice, index) => index).filter((index) => !args.reuseVoiceResults?.has(index)),
            ...(previous !== undefined ? { previousCostUsd: previous } : {}),
            cumulativeCostUsd: previous == null || result.totalCostUsd == null ? null : previous + result.totalCostUsd,
        };
    }
    if (args.artifactDir) {
        result = await writeRunArtifacts({
            result,
            outputDir: args.artifactDir,
            actorLabel: args.runConfig.mode === "subagent" ? "agent" : "voice",
        });
    }
    const appendHistory: ChorusResultPersister =
        args.appendHistory ??
        ((entry: ChorusResult) => appendHistoryDefault(entry, args.storePaths));
    void appendHistory(result).catch((error) => {
        console.error(
            "chorus history append failed:",
            redactSensitive(error instanceof Error ? error.message : String(error)),
        );
    });
    return result;
}
