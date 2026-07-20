import type { ChorusConfigFile, ModelRef } from "../types.js";

export function applyReviewRoleModelPreferences(
    config: ChorusConfigFile,
    presetName: string,
    roleModels: Record<string, ModelRef> = {},
): ChorusConfigFile {
    if (!config.presets.some((preset) => preset.name === presetName)) {
        throw new Error(`cannot save Review model defaults: preset "${presetName}" is missing`);
    }
    const entries = Object.entries(roleModels);
    return {
        ...config,
        presets: config.presets.map((preset) => {
            if (preset.name !== presetName) return preset;
            const { reviewRoleModels: _previous, ...withoutPreferences } = preset;
            return {
                ...withoutPreferences,
                ...(entries.length ? {
                    reviewRoleModels: Object.fromEntries(entries.map(([roleId, model]) => [roleId, { ...model }])),
                } : {}),
            };
        }),
    };
}
