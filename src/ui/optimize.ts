import type { ModelInfo, ModelRef, RegistryLike } from "../types.js";
import { optimizePrompt, type OptimizeResult } from "../optimize.js";

export async function runOptimizeUi(args: {
  prompt: string;
  registry: ModelInfo[];
  model?: ModelRef;
  modelRegistry?: RegistryLike;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  emit?: (message: string) => void;
}): Promise<OptimizeResult> {
  const result = await optimizePrompt(args);
  if (result.errorMessage) args.emit?.(result.errorMessage);
  return result;
}
