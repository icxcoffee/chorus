import type { PiLikeContext } from "../pi-context.js";
import { runAskUi } from "../ui/ask.js";
import { composePrompt } from "../ui/prompt.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { getJobStore } from "../jobs/store.js";
import { runChorusCommandJob } from "../runtime/job-runner.js";
import { notify, showPersistentOptimization } from "../runtime/pi-ui.js";
import { handleConfig } from "./config.js";

export async function handleAsk(ctx: PiLikeContext, promptArg: string): Promise<void> {
  const jobs = getJobStore(ctx);
  await jobs.initialize(ctx.storePaths ?? {});
  const registry = await registryModels(ctx);
  let config = await loadOrBootstrap(ctx, registry);
  let active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
  let configuredFromComposer = false;
  const composed = promptArg
    ? { original: promptArg, prompt: promptArg }
    : await composePrompt({
        ui: ctx.ui ?? {},
        title: "Chorus Question",
        placeholder: "Question",
        registry,
        signal: ctx.signal ?? new AbortController().signal,
        ...(active?.conductor ? { model: active.conductor } : {}),
        ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
        onOptimized: (result) => showPersistentOptimization(ctx, result, "Chorus Question"),
        onConfigure: async () => {
          configuredFromComposer = true;
          await handleConfig(ctx, "");
        }
      });
  const prompt = composed?.original ?? "";
  if (!prompt) {
    notify(ctx, "Usage: /chorus ask <question> or /chorus-ask <question>", "warning");
    return;
  }
  if (configuredFromComposer) {
    config = await loadOrBootstrap(ctx, registry);
    active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
  }
  const job = jobs.create({
    kind: "ask",
    title: "Chorus Question",
    presetName: active?.name ?? config.activePresetName,
    prompt,
    ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}),
    command: `/chorus ask ${prompt}`,
    voices: active?.voices ?? []
  });
  runChorusCommandJob(ctx, {
    job,
    kind: "ask",
    title: "Chorus Question",
    presetName: active?.name ?? config.activePresetName,
    prompt,
    ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}),
    initialStatus: "starting",
    widgetTitle: "Chorus running",
    workingMessage: "Chorus is asking voices...",
    actorLabel: "voice",
    actorPlural: "voices",
    statusPattern: /^(voice\[\d+\]|conductor)\s+(.+)$/,
    failedStatus: "failed",
    failedMessagePrefix: "chorus ask failed",
    run: async ({ onProgress, onStatus, signal }) =>
      await runAskUi({
        prompt,
        ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}),
        config,
        registry,
        ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
        signal,
        ...(ctx.storePaths ? { storePaths: ctx.storePaths } : {}),
        ...(active?.voiceTimeoutMs ? { voiceTimeoutMs: active.voiceTimeoutMs } : {}),
        ...(active?.conductorTimeoutMs ? { conductorTimeoutMs: active.conductorTimeoutMs } : {}),
        onProgress,
        onStatus
      }),
    details: (response) => ({
      kind: "ask",
      jobId: job.id,
      runId: response.result.runId,
      presetName: response.result.presetName,
      successfulVoices: response.result.successfulVoices,
      totalVoices: response.result.totalVoices
    })
  });
}
