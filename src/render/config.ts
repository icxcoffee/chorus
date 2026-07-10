import type { ChorusConfigFile, ChorusPreset, ModelInfo } from "../types.js";
import { DEFAULT_CONDUCTOR_TIMEOUT_MS, DEFAULT_VOICE_TIMEOUT_MS } from "../chorus.js";
import { formatDurationMs } from "../utils/format.js";
import { modelRefToPiArg, validateConfigFile } from "../utils/models.js";

export function renderConfig(config: ChorusConfigFile, registry: ModelInfo[]): string {
  const active = config.presets.find((preset) => preset.name === config.activePresetName);
  const lines = [`chorus config active preset: ${config.activePresetName}`];
  const configErrors = validateConfigForDisplay(config, registry);
  if (configErrors.length > 0) {
    lines.push("");
    lines.push("Config needs repair:");
    for (const error of configErrors) lines.push(`  - ${error}`);
  }
  lines.push("");
  if (active) lines.push(describePresetForCommand(active));
  lines.push("");
  lines.push("Usage:");
  lines.push("  /chorus config models <voice1> <voice2> [voice3...] --conductor <model>");
  lines.push("  /chorus config active <preset-name>");
  lines.push("  /chorus config mode <direct|subagent>");
  lines.push("  /chorus config history <on|off>");
  lines.push("  /chorus config timeout [voice|conductor] <milliseconds|Ns|Nm|Nh|default>");
  lines.push("");
  lines.push(`Available models (${registry.length}):`);
  for (const model of registry.slice(0, 30)) {
    const label = model.name ? ` · ${model.name}` : "";
    lines.push(`  ${model.provider}/${model.modelId}${label}`);
  }
  if (registry.length > 30) lines.push(`  ... ${registry.length - 30} more`);
  return lines.join("\n");
}

export function describePresetForCommand(preset: ChorusPreset): string {
  const voices = preset.voices.map((voice, index) => `voice[${index}] ${modelRefToPiArg(voice.model)}`).join("\n  ");
  return `preset ${preset.name} (${preset.mode})\n  session history ${preset.includeSessionHistory ? "include" : "isolated"}\n  voice timeout ${formatDurationMs(preset.voiceTimeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS)}\n  conductor timeout ${formatDurationMs(preset.conductorTimeoutMs ?? DEFAULT_CONDUCTOR_TIMEOUT_MS)}\n  ${voices}\n  conductor ${modelRefToPiArg(preset.conductor)}`;
}

export function validateConfigForDisplay(config: ChorusConfigFile, registry: ModelInfo[]): string[] {
  try {
    validateConfigFile(config, registry);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
