import type { PiLikeContext } from "../pi-context.js";
import { resultDirForJob } from "../artifacts.js";
import { runAgentUi } from "../ui/agent.js";
import { runChorusCommandJob } from "../runtime/job-runner.js";
import { handleConfig } from "./config.js";
import { prepareRunCommand } from "./run.js";

export async function handleAgent(ctx: PiLikeContext, taskArg: string): Promise<void> {
  const prepared = await prepareRunCommand(ctx, taskArg, { kind: "agent", title: "Chorus Agent Task", placeholder: "Agent task", usage: "Usage: /chorus agent <task> or /chorus-agent <task>", commandName: "agent" }, async () => handleConfig(ctx, ""));
  if (!prepared) return;
  const { jobs, job, prompt: task, optimizedPrompt, config, active, registry } = prepared;
  const outputDir = resultDirForJob(job.id, ctx.storePaths);
  runChorusCommandJob(ctx, {
    job,
    kind: "agent",
    title: "Chorus Agent Task",
    presetName: active?.name ?? config.activePresetName,
    prompt: task,
    ...(optimizedPrompt ? { optimizedPrompt } : {}),
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
        ...(optimizedPrompt ? { optimizedPrompt } : {}),
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
