import type { PiLikeContext } from "../pi-context.js";
import { runChorus } from "../chorus.js";
import { renderResult } from "../ui/result.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { setChorusStatus } from "../runtime/pi-ui.js";

export async function chorusAnswerTool(
  ctx: PiLikeContext,
  rawArgs: unknown,
  onUpdate?: (update: unknown) => void
): Promise<unknown> {
  const args = rawArgs as { prompt?: unknown; presetName?: unknown };
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw new Error("chorus_answer requires prompt");
  }
  const registry = await registryModels(ctx);
  const config = await loadOrBootstrap(ctx, registry);
  const presetName = typeof args.presetName === "string" ? args.presetName : config.activePresetName;
  const preset = config.presets.find((candidate) => candidate.name === presetName);
  if (!preset) throw new Error(`unknown chorus preset "${presetName}"`);
  const result = await runChorus({
    runConfig: {
      presetName: preset.name,
      voices: preset.voices,
      conductor: preset.conductor,
      mode: preset.mode,
      strategy: preset.strategy,
      includeSessionHistory: preset.includeSessionHistory ?? false
    },
    prompt: args.prompt,
    registry,
    ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
    signal: ctx.signal ?? new AbortController().signal,
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    ...(ctx.storePaths ? { storePaths: ctx.storePaths } : {}),
    ...(preset.voiceTimeoutMs ? { voiceTimeoutMs: preset.voiceTimeoutMs } : {}),
    ...(preset.conductorTimeoutMs ? { conductorTimeoutMs: preset.conductorTimeoutMs } : {}),
    onProgress: (updates) => {
      for (const update of updates) {
        const message = update.kind === "conductor"
          ? `chorus conductor ${update.status}`
          : `chorus voice[${update.voiceIndex}] ${update.status}`;
        setChorusStatus(ctx, message);
        onUpdate?.({ message, update });
      }
    }
  });
  return {
    content: [{ type: "text", text: renderResult(result).finalAnswer }],
    details: { result, rendered: renderResult(result) }
  };
}
