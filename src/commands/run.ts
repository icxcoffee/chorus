import type { ChorusConfigFile, ChorusPreset, ModelInfo } from "../types.js";
import type { ChorusJob, ChorusJobStore } from "../jobs.js";
import type { PiLikeContext } from "../pi-context.js";
import { composePrompt } from "../ui/prompt.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { getJobStore } from "../jobs/store.js";
import { notify, showPersistentOptimization } from "../runtime/pi-ui.js";

export interface RunCommandSpec {
    kind: "ask" | "agent";
    title: string;
    placeholder: string;
    usage: string;
    commandName: string;
}

export interface PreparedRunCommand {
    jobs: ChorusJobStore;
    job: ChorusJob;
    prompt: string;
    optimizedPrompt?: string;
    config: ChorusConfigFile;
    active: ChorusPreset | undefined;
    registry: ModelInfo[];
}

export async function prepareRunCommand(ctx: PiLikeContext, input: string, spec: RunCommandSpec, onConfigure: () => Promise<void>): Promise<PreparedRunCommand | null> {
    const jobs = getJobStore(ctx);
    await jobs.initialize(ctx.storePaths ?? {});
    const registry = await registryModels(ctx);
    let config = await loadOrBootstrap(ctx, registry);
    let active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
    const composed = input ? { original: input, prompt: input } : await composePrompt({
        ui: ctx.ui ?? {}, title: spec.title, placeholder: spec.placeholder, registry,
        signal: ctx.signal ?? new AbortController().signal,
        ...(active?.conductor ? { model: active.conductor } : {}),
        ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
        context: () => [
            `Preset: ${active?.name ?? config.activePresetName} | Strategy: ${active?.strategy ?? "-"}`,
            `Execution: ${spec.kind === "agent" ? "subagent" : (active?.mode ?? "-")} | Voices: ${active?.voices.length ?? 0}`,
        ],
        onOptimized: (result) => showPersistentOptimization(ctx, result, spec.title),
        onConfigure: async () => {
            await onConfigure();
            config = await loadOrBootstrap(ctx, registry);
            active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
        },
    });
    const prompt = composed?.original ?? composed?.prompt ?? "";
    if (!prompt) { notify(ctx, spec.usage, "warning"); return null; }
    const job = jobs.create({
        kind: spec.kind, title: spec.title, presetName: active?.name ?? config.activePresetName,
        prompt, ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}),
        command: `/chorus ${spec.commandName} ${prompt}`, voices: active?.voices ?? [],
    });
    return { jobs, job, prompt, ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}), config, active, registry };
}
