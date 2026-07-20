import type { ChorusConfigFile, ChorusPreset, ChorusVoice, ModelInfo, ModelRef } from "../types.js";
import type { PiLikeContext } from "../pi-context.js";
import { DEFAULT_CONDUCTOR_TIMEOUT_MS, DEFAULT_VOICE_TIMEOUT_MS } from "../chorus.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrapForConfig } from "../store/config.js";
import { pickConfigMenuAction, pickTimeoutMs, saveConfigFromUi } from "../ui/config.js";
import { pickConductorModel, pickVoiceModels } from "../ui/select.js";
import { describePresetForCommand, renderConfig, validateConfigForDisplay } from "../render/config.js";
import { formatDurationMs } from "../utils/format.js";
import { modelRefToPiArg, parseModelRef, sameModelRef } from "../utils/models.js";
import { notify, show } from "../runtime/pi-ui.js";
import { parseDurationMs, splitCommandArgs } from "./args.js";

const DEFAULT_ROLES: Array<ChorusVoice["role"]> = ["reasoning", "balanced", "heterodox", "fast", "breadth"];

export async function handleConfig(ctx: PiLikeContext, rawArgs = ""): Promise<void> {
  const registry = await registryModels(ctx);
  const config = await loadOrBootstrapForConfig(ctx, registry);
  const [action, ...rest] = splitCommandArgs(rawArgs);
  if (!action || action === "show") {
    if (!action && ctx.ui?.custom) {
      await handleInteractiveConfig(ctx, config, registry);
      return;
    }
    show(ctx, renderConfig(config, registry));
    return;
  }
  if (action === "active") {
    const [presetName] = rest;
    if (!presetName) {
      notify(ctx, "Usage: /chorus config active <preset-name>", "warning");
      return;
    }
    if (!config.presets.some((preset) => preset.name === presetName)) {
      notify(ctx, `unknown chorus preset "${presetName}"`, "error");
      return;
    }
    const updated = { ...config, activePresetName: presetName };
    await saveConfigFromUi({ config: updated, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
    show(ctx, `chorus config active preset: ${presetName}`);
    return;
  }
  if (action === "mode") {
    const [mode] = rest;
    if (mode !== "direct" && mode !== "subagent") {
      notify(ctx, "Usage: /chorus config mode <direct|subagent>", "warning");
      return;
    }
    const active = config.presets.find((preset) => preset.name === config.activePresetName);
    if (!active) {
      notify(ctx, `active preset "${config.activePresetName}" is missing`, "error");
      return;
    }
    const updatedPreset: ChorusPreset = { ...active, mode };
    const updated = {
      ...config,
      presets: config.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
    };
    await saveConfigFromUi({ config: updated, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
    show(ctx, `chorus config mode: ${mode}\n${describePresetForCommand(updatedPreset)}`);
    return;
  }
  if (action === "history") {
    const includeSessionHistory = parseHistorySetting(rest[0]);
    if (includeSessionHistory === null) {
      notify(ctx, "Usage: /chorus config history <on|off>", "warning");
      return;
    }
    const active = config.presets.find((preset) => preset.name === config.activePresetName);
    if (!active) {
      notify(ctx, `active preset "${config.activePresetName}" is missing`, "error");
      return;
    }
    const updatedPreset = applyPresetSessionHistory(active, includeSessionHistory);
    const updated = {
      ...config,
      presets: config.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
    };
    await saveConfigFromUi({ config: updated, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
    show(ctx, `chorus config history: ${includeSessionHistory ? "include" : "isolated"}\n${describePresetForCommand(updatedPreset)}`);
    return;
  }
  if (action === "timeout") {
    const target = rest[0] === "voice" || rest[0] === "conductor" ? rest[0] : "voice";
    const value = rest[0] === "voice" || rest[0] === "conductor" ? rest[1] : rest[0];
    const timeout = parseDurationMs(value);
    if (timeout === null) {
      notify(ctx, "Usage: /chorus config timeout [voice|conductor] <milliseconds|Ns|Nm|Nh|default>", "warning");
      return;
    }
    const active = config.presets.find((preset) => preset.name === config.activePresetName);
    if (!active) {
      notify(ctx, `active preset "${config.activePresetName}" is missing`, "error");
      return;
    }
    const updatedPreset = applyPresetTimeout(active, target, timeout);
    const updated = {
      ...config,
      presets: config.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
    };
    await saveConfigFromUi({ config: updated, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
    const defaultTimeout = target === "conductor" ? DEFAULT_CONDUCTOR_TIMEOUT_MS : DEFAULT_VOICE_TIMEOUT_MS;
    show(ctx, `chorus config ${target} timeout: ${formatDurationMs(timeout ?? defaultTimeout)}\n${describePresetForCommand(updatedPreset)}`);
    return;
  }
  if (action === "models") {
    const preset = buildPresetFromModelArgs(rest, registry);
    if (typeof preset === "string") {
      notify(ctx, preset, "warning");
      return;
    }
    const previousReviewRoleModels = config.presets.find((candidate) => candidate.name === preset.name)?.reviewRoleModels;
    const updatedPreset: ChorusPreset = {
      ...preset,
      ...(previousReviewRoleModels ? { reviewRoleModels: previousReviewRoleModels } : {})
    };
    const updated = {
      ...config,
      activePresetName: updatedPreset.name,
      presets: [updatedPreset, ...config.presets.filter((candidate) => candidate.name !== updatedPreset.name)]
    };
    await saveConfigFromUi({ config: updated, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
    show(ctx, `chorus config saved\n${describePresetForCommand(updatedPreset)}`);
    return;
  }
  notify(ctx, "Usage: /chorus config [show|active <name>|mode <direct|subagent>|history <on|off>|timeout [voice|conductor] <Ns|Nm|Nh|default>|models <voice...> --conductor <model>]", "warning");
}

async function handleInteractiveConfig(
  ctx: PiLikeContext,
  config: ChorusConfigFile,
  registry: ModelInfo[]
): Promise<void> {
  let currentConfig = config;
  while (true) {
    const active = currentConfig.presets.find((preset) => preset.name === currentConfig.activePresetName) ?? currentConfig.presets[0];
    const action = await pickConfigMenuAction({
      ui: ctx.ui ?? {},
      title: "Chorus Config",
      active,
      defaultTimeoutMs: DEFAULT_VOICE_TIMEOUT_MS,
      warnings: validateConfigForDisplay(currentConfig, registry)
    });
    if (!action) return;
    if (action === "show") {
      show(ctx, renderConfig(currentConfig, registry));
      return;
    }
    if (action === "mode-direct" || action === "mode-subagent") {
      if (!active) return;
      const mode = action === "mode-direct" ? "direct" : "subagent";
      const updatedPreset: ChorusPreset = { ...active, mode };
      currentConfig = {
        ...currentConfig,
        presets: currentConfig.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
      };
      await saveConfigFromUi({ config: currentConfig, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
      show(ctx, `chorus config mode: ${mode}\n${describePresetForCommand(updatedPreset)}`);
      continue;
    }
    if (action === "history-on" || action === "history-off") {
      if (!active) return;
      const includeSessionHistory = action === "history-on";
      const updatedPreset = applyPresetSessionHistory(active, includeSessionHistory);
      currentConfig = {
        ...currentConfig,
        presets: currentConfig.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
      };
      await saveConfigFromUi({ config: currentConfig, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
      show(ctx, `chorus config history: ${includeSessionHistory ? "include" : "isolated"}\n${describePresetForCommand(updatedPreset)}`);
      continue;
    }
    if (action === "timeout-default") {
      if (!active) return;
      const updatedPreset = applyPresetTimeout(active, "voice", undefined);
      currentConfig = {
        ...currentConfig,
        presets: currentConfig.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
      };
      await saveConfigFromUi({ config: currentConfig, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
      show(ctx, `chorus config timeout: ${formatDurationMs(DEFAULT_VOICE_TIMEOUT_MS)}\n${describePresetForCommand(updatedPreset)}`);
      continue;
    }
    if (action === "conductor-timeout-default") {
      if (!active) return;
      const updatedPreset = applyPresetTimeout(active, "conductor", undefined);
      currentConfig = {
        ...currentConfig,
        presets: currentConfig.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
      };
      await saveConfigFromUi({ config: currentConfig, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
      show(ctx, `chorus config conductor timeout: ${formatDurationMs(DEFAULT_CONDUCTOR_TIMEOUT_MS)}\n${describePresetForCommand(updatedPreset)}`);
      continue;
    }
    if (action === "timeout") {
      if (!active) return;
      const timeoutMs = await pickTimeoutMs({
        ui: ctx.ui ?? {},
        title: "Chorus Timeout",
        currentMs: active.voiceTimeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS
      });
      if (!timeoutMs) continue;
      const updatedPreset = applyPresetTimeout(active, "voice", timeoutMs);
      currentConfig = {
        ...currentConfig,
        presets: currentConfig.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
      };
      await saveConfigFromUi({ config: currentConfig, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
      show(ctx, `chorus config timeout: ${formatDurationMs(timeoutMs)}\n${describePresetForCommand(updatedPreset)}`);
      continue;
    }
    if (action === "conductor-timeout") {
      if (!active) return;
      const timeoutMs = await pickTimeoutMs({
        ui: ctx.ui ?? {},
        title: "Chorus Conductor Timeout",
        currentMs: active.conductorTimeoutMs ?? DEFAULT_CONDUCTOR_TIMEOUT_MS
      });
      if (!timeoutMs) continue;
      const updatedPreset = applyPresetTimeout(active, "conductor", timeoutMs);
      currentConfig = {
        ...currentConfig,
        presets: currentConfig.presets.map((preset) => (preset.name === active.name ? updatedPreset : preset))
      };
      await saveConfigFromUi({ config: currentConfig, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
      show(ctx, `chorus config conductor timeout: ${formatDurationMs(timeoutMs)}\n${describePresetForCommand(updatedPreset)}`);
      continue;
    }
    if (action !== "models") continue;
    if (!active) return;
    const pickedVoices = await pickVoiceModels({
      ui: ctx.ui ?? {},
      title: "Chorus voices",
      models: registry,
      initial: active?.voices.map((voice) => voice.model) ?? []
    });
    if (!pickedVoices) continue;
    const conductor = await pickConductorModel({
      ui: ctx.ui ?? {},
      title: "Chorus conductor",
      models: registry,
      voices: pickedVoices,
      ...(active?.conductor ? { initial: active.conductor } : {})
    });
    if (!conductor) continue;
    const preset: ChorusPreset = {
      ...active,
      voices: pickedVoices.map((model, index) => ({ model, role: DEFAULT_ROLES[index] ?? "balanced" })),
      conductor,
      strategy: "parallel",
    };
    currentConfig = {
      ...currentConfig,
      activePresetName: preset.name,
      presets: [preset, ...currentConfig.presets.filter((candidate) => candidate.name !== preset.name)]
    };
    await saveConfigFromUi({ config: currentConfig, registry, ...(ctx.storePaths ? { paths: ctx.storePaths } : {}) });
    show(ctx, `chorus config saved\n${describePresetForCommand(preset)}`);
  }
}

function buildPresetFromModelArgs(args: string[], registry: ModelInfo[]): ChorusPreset | string {
  const conductorFlags = args.map((arg, index) => (arg === "--conductor" ? index : -1)).filter((index) => index >= 0);
  if (conductorFlags.length > 1) return "Use --conductor only once";
  const conductorFlag = conductorFlags[0] ?? -1;
  const voiceArgs = conductorFlag >= 0 ? args.slice(0, conductorFlag) : args.slice(0, -1);
  const conductorArg = conductorFlag >= 0 ? args[conductorFlag + 1] : args.at(-1);
  if (!conductorArg || voiceArgs.length < 2) {
    return "Usage: /chorus config models <voice1> <voice2> [voice3...] --conductor <model>";
  }
  if (conductorFlag >= 0 && args.length > conductorFlag + 2) {
    return "Unexpected arguments after conductor model";
  }
  let conductor: ModelRef;
  let voices: ChorusVoice[];
  try {
    conductor = parseModelRef(conductorArg);
    voices = voiceArgs.map((value, index) => ({
      model: parseModelRef(value),
      role: DEFAULT_ROLES[index] ?? "balanced"
    }));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  for (const ref of [...voices.map((voice) => voice.model), conductor]) {
    if (!registry.some((model) => sameModelRef(model, ref))) return `${modelRefToPiArg(ref)} is not in your model registry`;
  }
  return {
    name: "default",
    voices,
    conductor,
    mode: "direct",
    strategy: "parallel"
  };
}

function applyPresetTimeout(preset: ChorusPreset, target: "voice" | "conductor", value: number | undefined): ChorusPreset {
  if (target === "conductor") return value === undefined ? omitPresetConductorTimeout(preset) : { ...preset, conductorTimeoutMs: value };
  return value === undefined ? omitPresetTimeout(preset) : { ...preset, voiceTimeoutMs: value };
}

function parseHistorySetting(value: string | undefined): boolean | null {
  if (value === "on" || value === "include" || value === "true") return true;
  if (value === "off" || value === "isolated" || value === "false") return false;
  return null;
}

function applyPresetSessionHistory(preset: ChorusPreset, includeSessionHistory: boolean): ChorusPreset {
  if (includeSessionHistory) return { ...preset, includeSessionHistory: true };
  return omitPresetSessionHistory(preset);
}

function omitPresetTimeout(preset: ChorusPreset): ChorusPreset {
  const { voiceTimeoutMs: _voiceTimeoutMs, ...rest } = preset;
  return rest;
}

function omitPresetConductorTimeout(preset: ChorusPreset): ChorusPreset {
  const { conductorTimeoutMs: _conductorTimeoutMs, ...rest } = preset;
  return rest;
}

function omitPresetSessionHistory(preset: ChorusPreset): ChorusPreset {
  const { includeSessionHistory: _includeSessionHistory, ...rest } = preset;
  return rest;
}
