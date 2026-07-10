import type { ChorusConfigFile, ChorusPreset, ModelInfo, ModelRef } from "../types.js";
import { computeDefaultPresetResult } from "../defaults.js";
import { saveConfig, type StorePaths } from "../store.js";
import { formatDurationMs } from "../utils/format.js";
import { familyWarnings, modelRefToPiArg, sameModelRef, validateConfigFile } from "../utils/models.js";
import type { CustomUiLike } from "./select.js";
import { runCustomComponent } from "./component.js";
import { matchesUiCancel, matchesUiKeybinding, parseUiKey } from "./keys.js";
import { truncateToWidth } from "./width.js";

export interface ConfigViewModel {
  config: ChorusConfigFile | null;
  healthMessage?: string;
  voiceWarnings: string[];
  availableConductors: ModelRef[];
}

export type ConfigMenuAction =
  | "show"
  | "models"
  | "mode-direct"
  | "mode-subagent"
  | "history-on"
  | "history-off"
  | "timeout"
  | "timeout-default"
  | "conductor-timeout"
  | "conductor-timeout-default";

interface ConfigMenuItem {
  action: ConfigMenuAction;
  label: string;
  description: string;
}

export function buildConfigViewModel(args: {
  config: ChorusConfigFile | null;
  registry: ModelInfo[];
  selectedVoices?: ModelRef[];
}): ConfigViewModel {
  const bootstrap = args.config ? undefined : computeDefaultPresetResult(args.registry);
  const voices = args.selectedVoices ?? args.config?.presets[0]?.voices.map((voice) => voice.model) ?? [];
  return {
    config: args.config,
    voiceWarnings: args.config?.presets[0] ? familyWarnings(args.config.presets[0].voices) : [],
    availableConductors: conductorOptions(args.registry, voices),
    ...(bootstrap?.healthMessage ? { healthMessage: bootstrap.healthMessage } : {})
  };
}

export async function saveConfigFromUi(args: {
  config: ChorusConfigFile;
  registry: ModelInfo[];
  paths?: StorePaths;
}): Promise<void> {
  validateConfigFile(args.config, args.registry);
  await saveConfig(args.config, args.paths, args.registry);
}

export function validateConfigFromUi(config: ChorusConfigFile, registry: ModelInfo[]): string[] {
  try {
    validateConfigFile(config, registry);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function conductorOptions(registry: ModelInfo[], selectedVoiceModels: ModelRef[]): ModelRef[] {
  const voices = new Set(selectedVoiceModels.map(modelRefToPiArg));
  return registry
    .map((model) => ({ provider: model.provider, modelId: model.modelId }))
    .filter((model) => !voices.has(modelRefToPiArg(model)))
    .filter((model, index, all) => all.findIndex((other) => sameModelRef(other, model)) === index);
}

export function describePreset(preset: ChorusPreset): string {
  const voices = preset.voices.map((voice) => modelRefToPiArg(voice.model)).join(", ");
  return `${preset.name}: ${voices}; conductor ${modelRefToPiArg(preset.conductor)}; ${preset.mode}`;
}

export async function pickConfigMenuAction(args: {
  ui: CustomUiLike;
  title: string;
  active: ChorusPreset | undefined;
  defaultTimeoutMs: number;
  warnings?: string[];
}): Promise<ConfigMenuAction | null> {
  if (!args.ui.custom) return null;
  return runCustomComponent<ConfigMenuAction | null>(args.ui, ({ theme, keybindings, done, refresh }) => {
    let cursor = 0;
    const items = configMenuItems(args.active);
    return {
      render(width) {
        const safeWidth = Math.max(40, width);
        const color = (name: string, text: string) => theme.fg?.(name, text) ?? text;
        const bold = (text: string) => theme.bold?.(text) ?? text;
        const lines = [
          color("accent", "-".repeat(safeWidth)),
          ` ${color("accent", bold(args.title))}`,
          ` Active: ${args.active?.name ?? "-"} | Mode: ${args.active?.mode ?? "-"} | History: ${args.active?.includeSessionHistory ? "include" : "isolated"} | Voice timeout: ${formatDurationMs(args.active?.voiceTimeoutMs ?? args.defaultTimeoutMs)} | Conductor: ${formatDurationMs(args.active?.conductorTimeoutMs ?? args.defaultTimeoutMs)}`,
          ...(args.warnings?.length ? ["", color("warning", ` Config needs repair: ${args.warnings[0] ?? ""}`)] : []),
          "",
          ...items.map((item, index) => {
            const pointer = index === cursor ? color("accent", "> ") : "  ";
            const label = index === cursor ? color("accent", item.label) : item.label;
            return `${pointer}${label} - ${item.description}`;
          }),
          "",
          " up/down move - enter confirm - esc close",
          color("accent", "-".repeat(safeWidth))
        ];
        return lines.map((line) => truncateToWidth(line, safeWidth));
      },
      handleInput(data) {
        const key = parseUiKey(data);
        if (matchesUiCancel(keybindings, data, key)) {
          done(null);
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
          cursor = cursor === 0 ? items.length - 1 : cursor - 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down" || key.key === "tab") {
          cursor = cursor === items.length - 1 ? 0 : cursor + 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.confirm") || key.key === "enter") {
          done(items[cursor]?.action ?? null);
        }
      }
    };
  });
}

export async function pickTimeoutMs(args: {
  ui: CustomUiLike;
  title: string;
  currentMs: number;
}): Promise<number | null> {
  if (!args.ui.custom) return null;
  const options = [
    { value: 300_000, label: "5m" },
    { value: 1_800_000, label: "30m" },
    { value: 3_600_000, label: "1h" },
    { value: 7_200_000, label: "2h" },
    { value: 14_400_000, label: "4h" },
    { value: 21_600_000, label: "6h" }
  ];
  return runCustomComponent<number | null>(args.ui, ({ theme, keybindings, done, refresh }) => {
    let cursor = Math.max(0, options.findIndex((option) => option.value === args.currentMs));
    return {
      render(width) {
        const safeWidth = Math.max(36, width);
        const color = (name: string, text: string) => theme.fg?.(name, text) ?? text;
        const bold = (text: string) => theme.bold?.(text) ?? text;
        const lines = [
          color("accent", "-".repeat(safeWidth)),
          ` ${color("accent", bold(args.title))}`,
          ` Current: ${formatDurationMs(args.currentMs)}`,
          "",
          ...options.map((option, index) => {
            const pointer = index === cursor ? color("accent", "> ") : "  ";
            const label = index === cursor ? color("accent", option.label) : option.label;
            return `${pointer}${label}`;
          }),
          "",
          " up/down move - enter confirm - esc back",
          color("accent", "-".repeat(safeWidth))
        ];
        return lines.map((line) => truncateToWidth(line, safeWidth));
      },
      handleInput(data) {
        const key = parseUiKey(data);
        if (matchesUiCancel(keybindings, data, key)) {
          done(null);
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
          cursor = cursor === 0 ? options.length - 1 : cursor - 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down" || key.key === "tab") {
          cursor = cursor === options.length - 1 ? 0 : cursor + 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.confirm") || key.key === "enter") {
          done(options[cursor]?.value ?? null);
        }
      }
    };
  });
}

function configMenuItems(active: ChorusPreset | undefined): ConfigMenuItem[] {
  return [
    { action: "show", label: "Show", description: "print current config" },
    { action: "models", label: "Models", description: "choose voices and conductor" },
    {
      action: active?.mode === "direct" ? "mode-subagent" : "mode-direct",
      label: active?.mode === "direct" ? "Mode: subagent" : "Mode: direct",
      description: "switch execution mode"
    },
    {
      action: active?.includeSessionHistory ? "history-off" : "history-on",
      label: active?.includeSessionHistory ? "History: isolated" : "History: include",
      description: active?.includeSessionHistory ? "child agents only see the task" : "child agents can see this chat"
    },
    { action: "timeout", label: "Timeout", description: "set per voice/agent limit" },
    { action: "timeout-default", label: "Reset timeout", description: "use default voice/agent limit" },
    { action: "conductor-timeout", label: "Conductor timeout", description: "set synthesis/main-agent limit" },
    { action: "conductor-timeout-default", label: "Reset conductor", description: "use default synthesis limit" }
  ];
}
