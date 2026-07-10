import type { PiLikeContext } from "../pi-context.js";
import { resultDirForJob } from "../artifacts.js";
import { runAgentUi } from "../ui/agent.js";
import { composePrompt } from "../ui/prompt.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { getJobStore } from "../jobs/store.js";
import { runChorusCommandJob } from "../runtime/job-runner.js";
import { notify, showPersistentOptimization } from "../runtime/pi-ui.js";
import { handleConfig } from "./config.js";

export async function handleAgent(ctx: PiLikeContext, taskArg: string): Promise<void> {
  const jobs = getJobStore(ctx);
  await jobs.initialize(ctx.storePaths ?? {});
  const registry = await registryModels(ctx);
  let config = await loadOrBootstrap(ctx, registry);
  let active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
  let configuredFromComposer = false;
  const composed = taskArg
    ? { original: taskArg, prompt: taskArg }
    : await composePrompt({
        ui: ctx.ui ?? {},
        title: "Chorus Agent Task",
        placeholder: "Agent task",
        registry,
        signal: ctx.signal ?? new AbortController().signal,
        ...(active?.conductor ? { model: active.conductor } : {}),
        ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
        onOptimized: (result) => showPersistentOptimization(ctx, result, "Chorus Agent Task"),
        onConfigure: async () => {
          configuredFromComposer = true;
          await handleConfig(ctx, "");
        }
      });
  const task = composed?.original ?? composed?.prompt ?? "";
  if (!task) {
    notify(ctx, "Usage: /chorus agent <task> or /chorus-agent <task>", "warning");
    return;
  }
  if (configuredFromComposer) {
    config = await loadOrBootstrap(ctx, registry);
    active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
  }
  const job = jobs.create({
    kind: "agent",
    title: "Chorus Agent Task",
    presetName: active?.name ?? config.activePresetName,
    prompt: task,
    ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}),
    command: `/chorus agent ${task}`,
    voices: active?.voices ?? []
  });
  const outputDir = resultDirForJob(job.id, ctx.storePaths);
  runChorusCommandJob(ctx, {
    job,
    kind: "agent",
    title: "Chorus Agent Task",
    presetName: active?.name ?? config.activePresetName,
    prompt: task,
    ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}),
    outputDir,
    initialStatus: "agents starting",
    widgetTitle: "Chorus agents running",
    workingMessage: "Chorus agents are running...",
    actorLabel: "agent",
    actorPlural: "agents",
    statusPattern: /^(agent\[\d+\]|conductor)\s+(.+)$/,
    failedStatus: "agents failed",
    failedMessagePrefix: "chorus agent failed",
    run: async ({ onProgress, onStatus, signal }) =>
      await runAgentUi({
        task,
        config,
        registry,
        ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
        signal,
        ...(composed?.optimizedPrompt ? { optimizedPrompt: composed.optimizedPrompt } : {}),
        ...(ctx.storePaths ? { storePaths: ctx.storePaths } : {}),
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        ...(active?.voiceTimeoutMs ? { voiceTimeoutMs: active.voiceTimeoutMs } : {}),
        ...(active?.conductorTimeoutMs ? { conductorTimeoutMs: active.conductorTimeoutMs } : {}),
        artifactDir: outputDir,
        onProgress,
        onStatus
      }),
    details: (response) => ({
      kind: "agent",
      jobId: job.id,
      runId: response.result.runId,
      presetName: response.result.presetName,
      successfulAgents: response.result.successfulVoices,
      totalAgents: response.result.totalVoices,
      outputDir: response.result.outputDir
    })
  });
}
