import type { ModelInfo, RegistryLike } from "../types.js";
import { getRegistryModels } from "../utils/models.js";

export interface RegistryContext {
  modelRegistry?: RegistryLike;
  model?: unknown;
  sessionManager?: { scopedModels?: Array<{ model: unknown }> };
  ui?: { notify?: (content: string, level?: "info" | "warning" | "error") => void };
}

export async function registryModels(ctx: RegistryContext): Promise<ModelInfo[]> {
  const scoped = ctx.sessionManager?.scopedModels?.map((entry) => entry.model).filter(Boolean);
  const registry = scoped && scoped.length > 0 ? await getRegistryModels(scoped as ModelInfo[]) : await getRegistryModels(ctx.modelRegistry);
  const authFiltered = filterConfiguredModels(ctx, registry);
  if (ctx.modelRegistry?.hasConfiguredAuth && registry.length > 0 && authFiltered.length === 0) {
    ctx.ui?.notify?.("Chorus found no models with configured authentication; showing the full model list for configuration and local/no-auth providers.", "warning");
  }
  return sortCurrentModelFirst(ctx, focusChorusModels(authFiltered.length > 0 ? authFiltered : registry));
}

export function filterConfiguredModels(ctx: RegistryContext, registry: ModelInfo[]): ModelInfo[] {
  const modelRegistry = ctx.modelRegistry;
  if (!modelRegistry?.hasConfiguredAuth) return registry;
  return registry.filter((model) => {
    const runtimeModel = model.sourceModel ?? modelRegistry.find?.(model.provider, model.modelId);
    return runtimeModel ? modelRegistry.hasConfiguredAuth?.(runtimeModel) === true : false;
  });
}

export function sortCurrentModelFirst(ctx: RegistryContext, registry: ModelInfo[]): ModelInfo[] {
  const current = ctx.model as { provider?: unknown; id?: unknown } | undefined;
  if (typeof current?.provider !== "string" || typeof current.id !== "string") return registry;
  return [...registry].sort((a, b) => {
    const aCurrent = a.provider === current.provider && a.modelId === current.id;
    const bCurrent = b.provider === current.provider && b.modelId === current.id;
    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;
    const provider = a.provider.localeCompare(b.provider);
    return provider !== 0 ? provider : a.modelId.localeCompare(b.modelId);
  });
}

export function focusChorusModels(registry: ModelInfo[]): ModelInfo[] {
  if (registry.length <= 50) return registry;
  const focused = registry.filter(hasRunnableModelMetadata);
  return focused.length >= 3 ? focused : registry;
}

function hasRunnableModelMetadata(model: ModelInfo): boolean {
  return Boolean(model.endpoint || model.baseUrl || model.api || model.apiKind || model.costPerMTokens);
}
