import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ModelInfo, ModelRef, RegistryLike, ResolvedModel, TokenUsage } from "./types.js";
import { modelRefToPiArg, sameModelRef } from "./utils/models.js";
import { assertSafeEndpoint } from "./providers/adapters.js";

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
  resolved: ResolvedModel;
}

export async function callPiModel(args: PiModelCallArgs): Promise<PiModelCallResult> {
  const runtimeModel = resolveRuntimeModel(args.model, args.registry, args.modelRegistry);
  assertSafeEndpoint(runtimeModel.baseUrl);
  const auth = args.modelRegistry.getApiKeyAndHeaders
    ? await args.modelRegistry.getApiKeyAndHeaders(runtimeModel)
    : { ok: true as const };
  if (!auth.ok) {
    throw new Error(`Model auth unavailable for ${modelRefToPiArg(args.model)}: ${auth.error}`);
  }

  const options: SimpleStreamOptions = {
    ...(runtimeModelHasReasoning(runtimeModel) ? { reasoning: "medium" as const } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
    ...(auth.env !== undefined ? { env: auth.env } : {})
  };
  const context: Context = {
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    messages: [{ role: "user" as const, content: args.prompt, timestamp: Date.now() }]
  };
  const assistant = await completeSimple(runtimeModel, context, options);
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
    resolved: resolvedRuntimeModel(runtimeModel, args.model),
    ...(assistant.usage ? { usage: normalizePiUsage(assistant.usage) } : {})
  };
}

function resolvedRuntimeModel(model: Model<Api>, ref: ModelRef): ResolvedModel {
  return {
    ref,
    apiKind: model.api,
    endpoint: model.baseUrl,
    headers: {},
    costPerMTokens: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite
    },
    contextWindow: model.contextWindow,
    reasoning: model.reasoning
  };
}

function resolveRuntimeModel(model: ModelRef, registry: ModelInfo[], modelRegistry: RegistryLike): Model<Api> {
  const found = modelRegistry.find?.(model.provider, model.modelId);
  if (found) return asPiModel(found, model);
  const normalized = registry.find((candidate) => sameModelRef(candidate, model));
  if (normalized?.sourceModel) return asPiModel(normalized.sourceModel, model);
  throw new Error(`model ${modelRefToPiArg(model)} is not available in Pi model registry`);
}

function asPiModel(value: unknown, ref: ModelRef): Model<Api> {
  if (!value || typeof value !== "object") throw incompatibleModel(ref);
  const model = value as Record<string, unknown>;
  const cost = model.cost as Record<string, unknown> | undefined;
  const valid = typeof model.id === "string"
    && typeof model.name === "string"
    && typeof model.api === "string"
    && typeof model.provider === "string"
    && typeof model.baseUrl === "string"
    && typeof model.reasoning === "boolean"
    && Array.isArray(model.input)
    && model.input.every((item) => item === "text" || item === "image")
    && cost !== undefined
    && cost !== null
    && finiteNumber(cost.input)
    && finiteNumber(cost.output)
    && finiteNumber(cost.cacheRead)
    && finiteNumber(cost.cacheWrite)
    && finiteNumber(model.contextWindow)
    && finiteNumber(model.maxTokens);
  if (!valid) throw incompatibleModel(ref);
  return value as Model<Api>;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function runtimeModelHasReasoning(model: Model<Api>): boolean {
  return model.reasoning;
}

function normalizePiUsage(usage: Usage): TokenUsage {
  return {
    input: numberOrZero(usage.input),
    output: numberOrZero(usage.output),
    cacheRead: numberOrZero(usage.cacheRead),
    cacheWrite: numberOrZero(usage.cacheWrite)
  };
}

function incompatibleModel(ref: ModelRef): Error {
  return new Error(`model ${modelRefToPiArg(ref)} is incompatible with the pi-ai Model contract`);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
