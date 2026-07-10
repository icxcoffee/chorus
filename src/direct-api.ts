import type { ChorusVoice, ModelInfo, ModelRef, PartialVoiceProgress, RegistryLike, ResolvedModel, TokenUsage, VoiceResult } from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { callPiModel } from "./pi-compat.js";
import { computeUsageCost } from "./utils/cost.js";
import { getProviderAdapter, resolveModel } from "./utils/models.js";
import { VoiceTimeoutError, withTimeout } from "./utils/timeout.js";

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
}

export interface DirectModelCallArgs {
  model: ModelRef;
  prompt: string;
  systemPrompt: string;
  registry: ModelInfo[];
  modelRegistry?: RegistryLike;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface DirectModelCallResult {
  output: string;
  usage?: TokenUsage;
  costUsd: number | null;
  resolved: ResolvedModel;
}

export async function runDirectVoice(args: DirectVoiceArgs): Promise<VoiceResult> {
  const startedAt = Date.now();
  const voiceIndex = args.voiceIndex ?? 0;
  args.onProgress?.({ voiceIndex, voice: args.voice, status: "running" });
  try {
    const result = await withTimeout(
      (voiceSignal) =>
        callDirectModel({
          model: args.voice.model,
          prompt: args.prompt,
          systemPrompt: ROLE_SYSTEM_PROMPTS[args.voice.role ?? "balanced"],
          registry: args.registry,
          ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
          signal: voiceSignal,
          ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {})
        }),
      args.timeoutMs,
      args.signal
    );
    const voiceResult: VoiceResult = {
      voice: args.voice,
      status: "success",
      output: result.output,
      durationMs: Date.now() - startedAt,
      costUsd: result.costUsd,
      startedAt,
      ...(result.usage ? { usage: result.usage } : {})
    };
    args.onProgress?.({
      voiceIndex,
      voice: args.voice,
      status: "success",
      durationMs: voiceResult.durationMs,
      costUsd: voiceResult.costUsd,
      ...(voiceResult.usage ? { usage: voiceResult.usage } : {})
    });
    return voiceResult;
  } catch (error) {
    const aborted = args.signal.aborted && !(error instanceof VoiceTimeoutError);
    const voiceResult: VoiceResult = {
      voice: args.voice,
      status: aborted ? "aborted" : "error",
      durationMs: Date.now() - startedAt,
      costUsd: null,
      startedAt,
      errorMessage: formatDirectError(error)
    };
    args.onProgress?.({
      voiceIndex,
      voice: args.voice,
      status: voiceResult.status,
      durationMs: voiceResult.durationMs,
      costUsd: null,
      ...(voiceResult.errorMessage ? { errorMessage: voiceResult.errorMessage } : {})
    });
    return voiceResult;
  }
}

export async function callDirectModel(args: DirectModelCallArgs): Promise<DirectModelCallResult> {
  const resolved = resolveModel(args.model, args.registry);
  if (!args.fetchImpl && args.modelRegistry) {
    const result = await callPiModel({
      model: args.model,
      prompt: args.prompt,
      systemPrompt: args.systemPrompt,
      registry: args.registry,
      modelRegistry: args.modelRegistry,
      signal: args.signal
    });
    return {
      output: result.output,
      costUsd: result.costUsd,
      resolved,
      ...(result.usage ? { usage: result.usage } : {})
    };
  }
  if (!resolved.endpoint) {
    throw new Error(
      `model ${resolved.ref.provider}/${resolved.ref.modelId} has no endpoint; run inside Pi with modelRegistry or configure an endpoint`
    );
  }
  const adapter = getProviderAdapter(resolved.apiKind);
  const request = adapter.buildRequest({ resolved, prompt: args.prompt, systemPrompt: args.systemPrompt, signal: args.signal });
  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(request.url, request.init);
  const responseJson = await safeJson(response);
  if (!response.ok) {
    throw new Error(sanitizeProviderMessage(adapter.parseError(responseJson, response.status)));
  }
  const parsed = adapter.parseResponse(responseJson);
  return {
    output: parsed.output,
    costUsd: computeUsageCost(parsed.usage, resolved),
    resolved,
    ...(parsed.usage ? { usage: parsed.usage } : {})
  };
}

export function sanitizeProviderMessage(message: string): string {
  const redactionPatterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]"],
    [/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]"],
    [/\b(api[_-]?key|access[_-]?token|token)([=:]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2[redacted]"],
    [/Authorization:\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, "Authorization: [redacted]"]
  ];
  return redactionPatterns.reduce((sanitized, [pattern, replacement]) => sanitized.replace(pattern, replacement), message);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function formatDirectError(error: unknown): string {
  if (error instanceof VoiceTimeoutError) return `timed out after ${error.timeoutMs}ms`;
  if (error instanceof Error) return sanitizeProviderMessage(error.message);
  return String(error);
}
