import type { ModelInfo, ModelRef, RegistryLike, ResolvedModel } from "../types.js";
import { assertModelRef, modelRefToPiArg, parseModelRef } from "./ref.js";

export class ModelNotResolvable extends Error {
  constructor(readonly ref: ModelRef, message?: string) {
    super(message ?? `${modelRefToPiArg(ref)} is not in your model registry`);
    this.name = "ModelNotResolvable";
  }
}

export async function getRegistryModels(registry?: RegistryLike | ModelInfo[]): Promise<ModelInfo[]> {
  if (Array.isArray(registry)) return registry.map(normalizeRegistryEntry);
  if (registry?.models) return registry.models.map(normalizeRegistryEntry);
  if (registry?.getAllModels) return (await registry.getAllModels()).map(normalizeRegistryEntry);
  if (registry?.getAvailable) return (await registry.getAvailable()).map(normalizeRegistryEntry);
  if (registry?.getAll) return (await registry.getAll()).map(normalizeRegistryEntry);
  return [];
}

export function resolveModel(ref: ModelRef, registry: ModelInfo[] = []): ResolvedModel {
  assertModelRef(ref);
  const found = registry.find((model) => model.provider === ref.provider && model.modelId === ref.modelId);
  if (!found) throw new ModelNotResolvable(ref);
  return normalizeModelInfo(found);
}

export function resolveFirstAvailable(
  registry: ModelInfo[],
  candidates: Array<string | ModelRef>
): ResolvedModel | null {
  for (const candidate of candidates) {
    const ref = parseModelRef(candidate);
    try {
      return resolveModel(ref, registry);
    } catch (error) {
      if (!(error instanceof ModelNotResolvable)) throw error;
    }
  }
  return null;
}

export function normalizeModelInfo(model: ModelInfo): ResolvedModel {
  const ref = { provider: model.provider, modelId: model.modelId ?? model.id };
  assertModelRef(ref);
  const cost = model.costPerMTokens;
  return {
    ref,
    apiKind: model.apiKind ?? model.api ?? "generic-json",
    endpoint: model.endpoint ?? model.baseUrl ?? "",
    headers: model.headers ?? {},
    costPerMTokens:
      cost == null
        ? null
        : {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cacheRead ?? 0,
            cacheWrite: cost.cacheWrite ?? 0
          },
    contextWindow: model.contextWindow ?? 0,
    reasoning: model.reasoning ?? false
  };
}

function normalizeRegistryEntry(model: ModelInfo | { provider: string; id: string; reasoning?: boolean }): ModelInfo {
  if ("modelId" in model && typeof model.modelId === "string") {
    return { ...model, sourceModel: model.sourceModel ?? model };
  }
  const id = typeof model.id === "string" ? model.id : "";
  const maybe = model as {
    name?: string;
    api?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    contextWindow?: number;
    reasoning?: boolean;
  };
  return {
    provider: model.provider,
    id,
    modelId: id,
    sourceModel: model,
    ...(typeof maybe.name === "string" ? { name: maybe.name } : {}),
    ...(typeof maybe.api === "string" ? { api: maybe.api, apiKind: maybe.api } : {}),
    ...(typeof maybe.baseUrl === "string" ? { baseUrl: maybe.baseUrl, endpoint: maybe.baseUrl } : {}),
    ...(maybe.headers ? { headers: maybe.headers } : {}),
    ...(maybe.cost
      ? {
          costPerMTokens: {
            input: maybe.cost.input,
            output: maybe.cost.output,
            cacheRead: maybe.cost.cacheRead ?? 0,
            cacheWrite: maybe.cost.cacheWrite ?? 0
          }
        }
      : {}),
    ...(typeof maybe.contextWindow === "number" ? { contextWindow: maybe.contextWindow } : {}),
    ...(typeof maybe.reasoning === "boolean" ? { reasoning: maybe.reasoning } : {})
  };
}
