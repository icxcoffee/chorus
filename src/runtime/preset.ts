import type { RunChorusArgs } from "../chorus.js";
import type { ChorusMode, ChorusPreset } from "../types.js";

export interface PresetRunOverrides {
    mode?: ChorusMode;
    includeSessionHistory?: boolean;
    synthesisMode?: RunChorusArgs["synthesisMode"];
    voiceTimeoutMs?: number;
    conductorTimeoutMs?: number;
}

export type PresetRunOptions = Pick<
    RunChorusArgs,
    "runConfig" | "voiceConcurrency" | "permissionProfile" | "budget" | "cachePolicy" | "voiceTimeoutMs" | "conductorTimeoutMs" | "synthesisMode"
>;

export function runOptionsFromPreset(preset: ChorusPreset, overrides: PresetRunOverrides = {}): PresetRunOptions {
    const voiceTimeoutMs = overrides.voiceTimeoutMs ?? preset.voiceTimeoutMs;
    const conductorTimeoutMs = overrides.conductorTimeoutMs ?? preset.conductorTimeoutMs;
    return {
        runConfig: {
            presetName: preset.name,
            voices: preset.voices,
            conductor: preset.conductor,
            mode: overrides.mode ?? preset.mode,
            strategy: preset.strategy,
            includeSessionHistory: overrides.includeSessionHistory ?? preset.includeSessionHistory ?? false,
            ...(preset.maxConcurrency !== undefined ? { maxConcurrency: preset.maxConcurrency } : {}),
            ...(preset.providerConcurrency ? { providerConcurrency: preset.providerConcurrency } : {}),
            ...(preset.permissionProfile ? { permissionProfile: preset.permissionProfile } : {}),
        },
        ...(preset.maxConcurrency !== undefined ? { voiceConcurrency: preset.maxConcurrency } : {}),
        ...(preset.permissionProfile ? { permissionProfile: preset.permissionProfile } : {}),
        ...(preset.budget ? { budget: preset.budget } : {}),
        ...(preset.cachePolicy ? { cachePolicy: preset.cachePolicy } : {}),
        ...(voiceTimeoutMs !== undefined ? { voiceTimeoutMs } : {}),
        ...(conductorTimeoutMs !== undefined ? { conductorTimeoutMs } : {}),
        ...(overrides.synthesisMode ? { synthesisMode: overrides.synthesisMode } : {}),
    };
}
