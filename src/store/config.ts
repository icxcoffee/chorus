import type { ChorusConfigFile, ModelInfo } from "../types.js";
import { computeDefaultPresets } from "../defaults.js";
import { bootstrapConfigIfAbsent, configExists, loadConfig, loadConfigUnchecked, type StorePaths } from "../store.js";

export interface ConfigContext {
  storePaths?: StorePaths;
}

export async function loadOrBootstrap(ctx: ConfigContext, registry: ModelInfo[]): Promise<ChorusConfigFile> {
  const config =
    (await bootstrapConfigIfAbsent({
      registry,
      computePresets: computeDefaultPresets,
      ...(ctx.storePaths ? { paths: ctx.storePaths } : {})
    })) ??
    (await loadConfig(ctx.storePaths, registry));
  return config;
}

export async function loadOrBootstrapForConfig(ctx: ConfigContext, registry: ModelInfo[]): Promise<ChorusConfigFile> {
  if (await configExists(ctx.storePaths)) {
    return loadConfigUnchecked(ctx.storePaths);
  }
  const config = await bootstrapConfigIfAbsent({
    registry,
    computePresets: computeDefaultPresets,
    ...(ctx.storePaths ? { paths: ctx.storePaths } : {})
  });
  if (config) return config;
  return loadConfig(ctx.storePaths, registry);
}
