import type { ChorusConfigFile, ChorusPreset, ModelInfo } from "../types.js";
import { runChorus, type RunChorusArgs } from "../chorus.js";
import { renderResult } from "./result.js";
import { modelRefToPiArg } from "../utils/models.js";
import { runOptionsFromPreset } from "../runtime/preset.js";

export interface AskUiResult {
  text: string;
  result: Awaited<ReturnType<typeof runChorus>>;
}

export async function runAskUi(args: {
  prompt: string;
  config: ChorusConfigFile;
  registry: ModelInfo[];
  signal: AbortSignal;
  presetName?: string;
  optimizedPrompt?: string;
  runChorusImpl?: typeof runChorus;
  onStatus?: (message: string) => void;
  onProgress?: RunChorusArgs["onProgress"];
} & Pick<RunChorusArgs, "fetchImpl" | "modelRegistry" | "storePaths" | "appendHistory" | "voiceTimeoutMs" | "conductorTimeoutMs">): Promise<AskUiResult> {
  const preset = findPreset(args.config, args.presetName ?? args.config.activePresetName);
  const result = await (args.runChorusImpl ?? runChorus)({
    ...runOptionsFromPreset(preset, {
      ...(args.voiceTimeoutMs !== undefined ? { voiceTimeoutMs: args.voiceTimeoutMs } : {}),
      ...(args.conductorTimeoutMs !== undefined ? { conductorTimeoutMs: args.conductorTimeoutMs } : {})
    }),
    prompt: args.prompt,
    registry: args.registry,
    signal: args.signal,
    ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
    ...(args.storePaths ? { storePaths: args.storePaths } : {}),
    ...(args.appendHistory ? { appendHistory: args.appendHistory } : {}),
    onProgress: (updates) => {
      args.onProgress?.(updates);
      for (const update of updates) {
        if (update.kind === "conductor") {
          args.onStatus?.(`conductor ${modelRefToPiArg(update.conductor)} ${update.status}`);
        } else {
          args.onStatus?.(`voice[${update.voiceIndex}] ${modelRefToPiArg(update.voice.model)} ${update.status}`);
        }
      }
    }
  });
  return { result, text: renderResult(result).expanded };
}

export function findPreset(config: ChorusConfigFile, presetName: string): ChorusPreset {
  const preset = config.presets.find((candidate) => candidate.name === presetName);
  if (!preset) throw new Error(`unknown chorus preset "${presetName}"`);
  return preset;
}

export function inlineOptimizeDecision(args: {
  original: string;
  optimized: string;
  accepted: boolean;
}): { prompt: string; optimizedPrompt?: string } {
  if (!args.accepted || args.optimized === args.original) return { prompt: args.original };
  return { prompt: args.original, optimizedPrompt: args.optimized };
}
