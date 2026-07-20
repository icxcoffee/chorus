import type {
    ChorusVoice,
    ModelInfo,
    ModelRef,
    PartialVoiceProgress,
    RegistryLike,
    ResolvedModel,
    TokenUsage,
    VoiceResult,
} from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { callPiModel } from "./pi-compat.js";
import { computeUsageCost } from "./utils/cost.js";
import { getProviderAdapter, resolveModel } from "./utils/models.js";
import { redactSensitive } from "./utils/redact.js";
import { assertSafeEndpoint } from "./providers/adapters.js";
import { VoiceTimeoutError, withTimeout } from "./utils/timeout.js";
import { retry, RetryError, type RetryPolicy } from "./runtime/retry.js";

export { redactSensitive as sanitizeProviderMessage } from "./utils/redact.js";

export interface DirectVoiceArgs {
    voice: ChorusVoice;
    prompt: string;
    registry: ModelInfo[];
    modelRegistry?: RegistryLike;
    voiceIndex?: number;
    timeoutMs: number;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    onProgress?: (update: PartialVoiceProgress) => void;
    retryPolicy?: RetryPolicy;
}

export interface DirectModelCallArgs {
    model: ModelRef;
    prompt: string;
    systemPrompt: string;
    registry: ModelInfo[];
    modelRegistry?: RegistryLike;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    structuredOutput?: boolean;
}

export interface DirectModelCallResult {
    output: string;
    usage?: TokenUsage;
    costUsd: number | null;
    resolved: ResolvedModel;
}

export async function runDirectVoice(
    args: DirectVoiceArgs,
): Promise<VoiceResult> {
    const startedAt = Date.now();
    const voiceIndex = args.voiceIndex ?? 0;
    args.onProgress?.({ voiceIndex, voice: args.voice, status: "running" });
    try {
        const call = (voiceSignal: AbortSignal) => callDirectModel({
                    model: args.voice.model,
                    prompt: args.prompt,
                    systemPrompt: ROLE_SYSTEM_PROMPTS[args.voice.role ?? "balanced"],
                    registry: args.registry,
                    ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
                    signal: voiceSignal,
                    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
                });
        const execute = async (voiceSignal: AbortSignal) => args.retryPolicy
            ? (await retry(() => call(voiceSignal), args.retryPolicy!, voiceSignal)).value
            : call(voiceSignal);
        const result = await withTimeout(execute, args.timeoutMs, args.signal);
        const voiceResult: VoiceResult = {
            voice: args.voice,
            status: "success",
            output: result.output,
            durationMs: Date.now() - startedAt,
            costUsd: result.costUsd,
            startedAt,
            ...(result.usage ? { usage: result.usage } : {}),
        };
        args.onProgress?.({
            voiceIndex,
            voice: args.voice,
            status: "success",
            durationMs: voiceResult.durationMs,
            costUsd: voiceResult.costUsd,
            ...(voiceResult.usage ? { usage: voiceResult.usage } : {}),
        });
        return voiceResult;
    } catch (error) {
        const aborted =
            args.signal.aborted && !(error instanceof VoiceTimeoutError);
        const voiceResult: VoiceResult = {
            voice: args.voice,
            status: aborted ? "aborted" : "error",
            durationMs: Date.now() - startedAt,
            costUsd: null,
            startedAt,
            errorMessage: formatDirectError(error),
        };
        args.onProgress?.({
            voiceIndex,
            voice: args.voice,
            status: voiceResult.status,
            durationMs: voiceResult.durationMs,
            costUsd: null,
            ...(voiceResult.errorMessage
                ? { errorMessage: voiceResult.errorMessage }
                : {}),
        });
        return voiceResult;
    }
}

export async function callDirectModel(
    args: DirectModelCallArgs,
): Promise<DirectModelCallResult> {
    if (!args.fetchImpl && args.modelRegistry) {
        const result = await callPiModel({
            model: args.model,
            prompt: args.prompt,
            systemPrompt: args.systemPrompt,
            registry: args.registry,
            modelRegistry: args.modelRegistry,
            signal: args.signal,
        });
        return {
            output: result.output,
            costUsd: result.costUsd,
            resolved: result.resolved,
            ...(result.usage ? { usage: result.usage } : {}),
        };
    }
    const resolved = resolveModel(args.model, args.registry);
    if (!resolved.endpoint) {
        throw new Error(
            `model ${resolved.ref.provider}/${resolved.ref.modelId} has no endpoint; run inside Pi with modelRegistry or configure an endpoint`,
        );
    }
    assertSafeEndpoint(resolved.endpoint);
    const adapter = getProviderAdapter(resolved.apiKind);
    const request = adapter.buildRequest({
        resolved,
        prompt: args.prompt,
        systemPrompt: args.systemPrompt,
        signal: args.signal,
        ...(args.structuredOutput ? { structuredOutput: true } : {}),
    });
    const fetchImpl = args.fetchImpl ?? fetch;
    const response = await fetchImpl(request.url, { ...request.init, redirect: "error" });
    const responseJson = await safeJson(response);
    if (!response.ok) {
        throw new RetryError(redactSensitive(adapter.parseError(responseJson, response.status)), undefined, response.status);
    }
    const parsed = adapter.parseResponse(responseJson);
    return {
        output: parsed.output,
        costUsd: computeUsageCost(parsed.usage, resolved),
        resolved,
        ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
}

async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return {};
    }
}

function formatDirectError(error: unknown): string {
    if (error instanceof VoiceTimeoutError)
        return `timed out after ${error.timeoutMs}ms`;
    if (error instanceof Error) return redactSensitive(error.message);
    return String(error);
}
