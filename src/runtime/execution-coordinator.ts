import type { ChorusVoice, VoiceResult } from "../types.js";
import type { VoiceExecutionResult, VoiceExecutor } from "./contracts.js";
import { DEFAULT_MAX_CONCURRENCY, scheduleTasks } from "./scheduler.js";

export interface ExecutionCoordinatorOptions {
    voices: ChorusVoice[];
    execute: VoiceExecutor;
    concurrency?: number;
    bounded?: boolean;
    startedAt: number;
    signal: AbortSignal;
    providerLimits?: Record<string, number>;
}

/** Runs voice work with deterministic output ordering and isolated failures. */
export async function executeVoices(
    options: ExecutionCoordinatorOptions,
): Promise<VoiceExecutionResult> {
    const tasks = options.voices.map((voice, voiceIndex) => ({
        id: `voice-${voiceIndex}`,
        provider: voice.model.provider,
        voice,
        voiceIndex,
        run: () => options.execute({ voice, voiceIndex }),
    }));
    const bounded = options.bounded ?? true;
    const settled = bounded
        ? await scheduleTasks({
            tasks,
            maxConcurrency: options.concurrency ?? DEFAULT_MAX_CONCURRENCY,
            signal: options.signal,
            ...(options.providerLimits ? { providerLimits: options.providerLimits } : {}),
        })
        : await Promise.allSettled(tasks.map((task) => task.run()));
    const voices = settled.map((entry, index): VoiceResult => {
        if (entry.status === "fulfilled") return entry.value;
        const voice = options.voices[index];
        if (!voice) throw entry.reason;
        return {
            voice,
            status: options.signal.aborted ? "aborted" : "error",
            durationMs: Date.now() - options.startedAt,
            costUsd: null,
            startedAt: options.startedAt,
            errorMessage: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        };
    });
    return {
        voices,
        successfulVoices: voices.filter((voice) => voice.status === "success").length,
    };
}
