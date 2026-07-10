import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelInfo, ModelRef, RegistryLike, TokenUsage } from "./types.js";
import { modelRefToPiArg, sameModelRef } from "./utils/models.js";

export interface PiModelCallArgs {
  model: ModelRef;
  prompt: string;
  systemPrompt: string;
  registry: ModelInfo[];
  modelRegistry: RegistryLike;
  signal: AbortSignal;
}

export interface PiModelCallResult {
  output: string;
  usage?: TokenUsage;
  costUsd: number | null;
}

export async function callPiModel(args: PiModelCallArgs): Promise<PiModelCallResult> {
  const runtimeModel = resolveRuntimeModel(args.model, args.registry, args.modelRegistry);
  const auth = args.modelRegistry.getApiKeyAndHeaders
    ? await args.modelRegistry.getApiKeyAndHeaders(runtimeModel)
    : { ok: true as const };
  if (!auth.ok) {
    throw new Error(`Model auth unavailable for ${modelRefToPiArg(args.model)}: ${auth.error}`);
  }

  const options = {
    ...(runtimeModelHasReasoning(runtimeModel) ? { reasoning: "medium" as const } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
    ...(auth.env !== undefined ? { env: auth.env } : {})
  };
  const context = {
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    messages: [{ role: "user" as const, content: args.prompt, timestamp: Date.now() }]
  };
  const callCompleteSimple = completeSimple as PiCompleteSimple;
  const assistant = await callCompleteSimple(runtimeModel, context, options);
  if (assistant.errorMessage) throw new Error(assistant.errorMessage);
  const output = assistant.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!output) throw new Error(`model ${modelRefToPiArg(args.model)} returned no text`);
  return {
    output,
    costUsd: typeof assistant.usage?.cost?.total === "number" ? assistant.usage.cost.total : null,
    ...(assistant.usage ? { usage: normalizePiUsage(assistant.usage) } : {})
  };
}

function resolveRuntimeModel(model: ModelRef, registry: ModelInfo[], modelRegistry: RegistryLike): unknown {
  const found = modelRegistry.find?.(model.provider, model.modelId);
  if (found) return found;
  const normalized = registry.find((candidate) => sameModelRef(candidate, model));
  if (normalized?.sourceModel) return normalized.sourceModel;
  throw new Error(`model ${modelRefToPiArg(model)} is not available in Pi model registry`);
}

function runtimeModelHasReasoning(model: unknown): boolean {
  return Boolean((model as { reasoning?: unknown }).reasoning);
}

function normalizePiUsage(usage: {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}): TokenUsage {
  return {
    input: numberOrZero(usage.input),
    output: numberOrZero(usage.output),
    cacheRead: numberOrZero(usage.cacheRead),
    cacheWrite: numberOrZero(usage.cacheWrite)
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface PiAssistantMessage {
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: {
      total?: number;
    };
  };
  errorMessage?: string;
}

type PiCompleteSimple = (
  model: unknown,
  context: {
    systemPrompt?: string;
    messages: Array<{ role: "user"; content: string; timestamp: number }>;
  },
  options: {
    reasoning?: "medium";
    signal?: AbortSignal;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }
) => Promise<PiAssistantMessage>;
