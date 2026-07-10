import type { ChorusConfigFile, ChorusPreset, ChorusRunConfig, ChorusVoice, ModelInfo } from "../types.js";
import { ValidationError } from "./errors.js";
import { assertModelRef, modelRefToPiArg, sameModelRef } from "./ref.js";
import { resolveModel } from "./resolve.js";

export function validatePreset(preset: ChorusPreset, registry: ModelInfo[] = []): void {
  validatePresetName(preset.name);
  validateRunConfig(
    {
      presetName: preset.name,
      voices: preset.voices,
      conductor: preset.conductor,
      mode: preset.mode,
      strategy: preset.strategy
    },
    registry
  );
  if (preset.optimizeBeforeAsk !== false) {
    throw new ValidationError(`preset ${preset.name} has unsupported optimizeBeforeAsk=true`);
  }
  if (preset.includeSessionHistory !== undefined && typeof preset.includeSessionHistory !== "boolean") {
    throw new ValidationError(`preset ${preset.name} includeSessionHistory must be boolean`);
  }
  if (preset.voiceTimeoutMs !== undefined) {
    validateTimeoutMs(preset.voiceTimeoutMs, `preset ${preset.name} voiceTimeoutMs`);
  }
  if (preset.conductorTimeoutMs !== undefined) {
    validateTimeoutMs(preset.conductorTimeoutMs, `preset ${preset.name} conductorTimeoutMs`);
  }
}

export function validateRunConfig(runConfig: ChorusRunConfig, registry: ModelInfo[] = []): void {
  if (runConfig.strategy !== "A") throw new ValidationError("chorus v1 only supports strategy A");
  if (runConfig.mode !== "direct" && runConfig.mode !== "subagent") {
    throw new ValidationError(`invalid mode "${String(runConfig.mode)}"`);
  }
  if (runConfig.includeSessionHistory !== undefined && typeof runConfig.includeSessionHistory !== "boolean") {
    throw new ValidationError("includeSessionHistory must be boolean");
  }
  validateVoiceCount(runConfig.voices);
  for (const [index, voice] of runConfig.voices.entries()) {
    assertModelRef(voice.model);
    if (registry.length > 0) {
      try {
        resolveModel(voice.model, registry);
      } catch {
        throw new ValidationError(`voice[${index}] ${modelRefToPiArg(voice.model)} is not in your model registry`);
      }
    }
  }
  assertModelRef(runConfig.conductor);
  const collision = runConfig.voices.findIndex((voice) => sameModelRef(voice.model, runConfig.conductor));
  if (collision >= 0) {
    throw new ValidationError(`conductor ${modelRefToPiArg(runConfig.conductor)} must not also be voice[${collision}]`);
  }
  if (registry.length > 0) {
    try {
      resolveModel(runConfig.conductor, registry);
    } catch {
      throw new ValidationError(`conductor ${modelRefToPiArg(runConfig.conductor)} is not in your model registry`);
    }
  }
}

export function validateConfigFile(config: ChorusConfigFile, registry: ModelInfo[] = []): void {
  if (config.configVersion !== 1) {
    throw new ValidationError(
      `unsupported chorus configVersion ${String(config.configVersion)}; upgrade this extension or migrate config`
    );
  }
  if (!Array.isArray(config.presets)) throw new ValidationError("config presets must be an array");
  const seen = new Set<string>();
  for (const preset of config.presets) {
    if (seen.has(preset.name)) throw new ValidationError(`duplicate preset name "${preset.name}"`);
    seen.add(preset.name);
    validatePreset(preset, registry);
  }
  if (!seen.has(config.activePresetName)) {
    throw new ValidationError(`activePresetName "${config.activePresetName}" does not match any preset`);
  }
}

export function validatePresetName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new ValidationError(`invalid preset name "${name}", expected lowercase-hyphen`);
  }
}

export function validateVoiceCount(voices: ChorusVoice[]): void {
  if (!Array.isArray(voices) || voices.length < 2 || voices.length > 8) {
    throw new ValidationError("voices length must be between 2 and 8");
  }
}

function validateTimeoutMs(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1_000 || value > 21_600_000) {
    throw new ValidationError(`${label} must be between 1000 and 21600000`);
  }
}
