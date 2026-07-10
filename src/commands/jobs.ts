import { renderJob, renderJobs } from "../render/jobs.js";
import type { StorePaths } from "../store.js";
import { getJobStore } from "../jobs/store.js";
import { watchChorusJob } from "../ui/watch.js";
import type { ChorusJobStore } from "../jobs.js";

export interface JobsCommandContext {
  storePaths?: StorePaths;
  chorusJobStore?: ChorusJobStore;
  ui?: {
    show?: (content: string) => void;
    notify?: (content: string, level?: "info" | "warning" | "error") => void;
    custom?: <T>(
      factory: (
        tui: { requestRender?: () => void },
        theme: { fg?: (color: string, text: string) => string; bold?: (text: string) => string },
        keybindings: unknown,
        done: (result: T) => void
      ) => { render(width: number): string[]; handleInput(data: unknown): void; invalidate?: () => void }
    ) => Promise<T>;
  };
}

export async function handleJobs(ctx: JobsCommandContext): Promise<void> {
  const jobs = getJobStore(ctx);
  await jobs.initialize(ctx.storePaths ?? {});
  show(ctx, renderJobs(jobs.list()));
}

export async function handleJob(ctx: JobsCommandContext, rawArgs: string): Promise<void> {
  const jobs = getJobStore(ctx);
  await jobs.initialize(ctx.storePaths ?? {});
  const [jobId] = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (!jobId) {
    notify(ctx, "Usage: /chorus job <jobId>", "warning");
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    notify(ctx, `unknown chorus job "${jobId}"`, "error");
    return;
  }
  show(ctx, renderJob(job));
}

export async function handleWatch(ctx: JobsCommandContext, rawArgs: string): Promise<void> {
  const jobs = getJobStore(ctx);
  await jobs.initialize(ctx.storePaths ?? {});
  const [jobId, voiceIndexText] = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (!jobId) {
    notify(ctx, "Usage: /chorus watch <jobId> [agent-index]", "warning");
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    notify(ctx, `unknown chorus job "${jobId}"`, "error");
    return;
  }
  const initialVoiceIndex = voiceIndexText ? Number(voiceIndexText) : 0;
  if (!Number.isInteger(initialVoiceIndex) || initialVoiceIndex < 0 || initialVoiceIndex >= job.voices.length) {
    notify(ctx, `agent index must be between 0 and ${Math.max(0, job.voices.length - 1)}`, "warning");
    return;
  }
  if (!ctx.ui?.custom) {
    show(ctx, renderJob(job));
    return;
  }
  await watchChorusJob({
    ui: ctx.ui,
    job,
    initialVoiceIndex,
    subscribe: (listener) => jobs.subscribe(job.id, listener)
  });
}

export async function handleCancel(ctx: JobsCommandContext, rawArgs: string): Promise<void> {
  const jobs = getJobStore(ctx);
  await jobs.initialize(ctx.storePaths ?? {});
  const [jobId] = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (!jobId) {
    notify(ctx, "Usage: /chorus cancel <jobId>", "warning");
    return;
  }
  if (!jobs.cancel(jobId)) {
    notify(ctx, `no running chorus job "${jobId}"`, "warning");
    return;
  }
  show(ctx, `chorus job canceled: ${jobId}`);
}

function show(ctx: JobsCommandContext, content: string): void {
  if (ctx.ui?.show) ctx.ui.show(content);
  else notify(ctx, content, "info");
}

function notify(ctx: JobsCommandContext, content: string, level: "info" | "warning" | "error" | "success"): void {
  if (ctx.ui?.notify) ctx.ui.notify(content, level === "success" ? "info" : level);
  else console.log(content);
}
