import type { PiLikeContext } from "../pi-context.js";
import { runAskUi } from "../ui/ask.js";
import { runChorusCommandJob } from "../runtime/job-runner.js";
import { handleConfig } from "./config.js";
import { prepareRunCommand } from "./run.js";

export async function handleAsk(ctx: PiLikeContext, promptArg: string): Promise<void> {
  const prepared = await prepareRunCommand(ctx, promptArg, { kind: "ask", title: "Chorus Question", placeholder: "Question", usage: "Usage: /chorus ask <question> or /chorus-ask <question>", commandName: "ask" }, async () => handleConfig(ctx, ""));
  if (!prepared) return;
  const { jobs, job, prompt, optimizedPrompt, config, active, registry } = prepared;
  runChorusCommandJob(ctx, {
    job,
    kind: "ask",
    title: "Chorus Question",
    presetName: active?.name ?? config.activePresetName,
    prompt,
    ...(optimizedPrompt ? { optimizedPrompt } : {}),
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
        ...(optimizedPrompt ? { optimizedPrompt } : {}),
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
