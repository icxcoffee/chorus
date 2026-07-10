import type { PiLikeContext } from "../pi-context.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { runOptimizeUi } from "../ui/optimize.js";
import { notify, setChorusStatus, showPersistentOptimization } from "../runtime/pi-ui.js";

export async function handleOptimize(ctx: PiLikeContext, promptArg: string): Promise<void> {
  const registry = await registryModels(ctx);
  const config = await loadOrBootstrap(ctx, registry);
  const active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
  const prompt = promptArg || (await ctx.ui?.input?.("Prompt")) || "";
  if (!prompt) {
    notify(ctx, "Usage: /chorus optimize <prompt> or /chorus-optimize <prompt>", "warning");
    return;
  }
  try {
    setChorusStatus(ctx, "optimizing prompt");
    ctx.ui?.setWorkingMessage?.("Optimizing prompt...");
    ctx.ui?.setWorkingVisible?.(true);
    const result = await runOptimizeUi({
      prompt,
      registry,
      ...(active?.conductor ? { model: active.conductor } : {}),
      ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
      signal: ctx.signal ?? new AbortController().signal,
      emit: (message) => setChorusStatus(ctx, message)
    });
    showPersistentOptimization(ctx, result, "Chorus Optimize");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setChorusStatus(ctx, "optimize failed");
    notify(ctx, `chorus optimize failed: ${message}`, "error");
  } finally {
    ctx.ui?.setWorkingMessage?.();
    ctx.ui?.setWorkingVisible?.(false);
  }
}
