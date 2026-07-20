import { renderJob, renderJobs } from "../render/jobs.js";
import type { StorePaths } from "../store.js";
import { getJobStore } from "../jobs/store.js";
import { watchChorusJob } from "../ui/watch.js";
import type { ChorusJobStore } from "../jobs.js";
import { createCheckpoint, planResume } from "../runtime/checkpoint.js";
import { reusableVoiceResults } from "../runtime/checkpoint.js";
import type { PiLikeContext } from "../pi-context.js";
import { registryModels } from "../models/registry.js";
import { runChorus, type RunChorusArgs } from "../chorus.js";
import { bindJobToHostSignal, runChorusCommandJob } from "../runtime/job-runner.js";
import { renderResult } from "../ui/result.js";
import { resultDirForJob } from "../artifacts.js";
import { readFile } from "node:fs/promises";
import { planReviewResume, restrictReviewReuse, type ReviewCheckpoint } from "../review/checkpoint.js";
import { runReviewService } from "../review/service.js";
import { showPersistentResult, setChorusStatus } from "../runtime/pi-ui.js";
import { reviewExecutionStatus } from "../review/status.js";

export interface JobsCommandContext {
  storePaths?: StorePaths;
  chorusJobStore?: ChorusJobStore;
  modelRegistry?: PiLikeContext["modelRegistry"];
  cwd?: string;
  signal?: AbortSignal;
  resumeRun?: typeof runChorus;
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
  const initialVoiceIndex = voiceIndexText === "conductor" ? job.voices.length : voiceIndexText ? Number(voiceIndexText) : 0;
  if (!Number.isInteger(initialVoiceIndex) || initialVoiceIndex < 0 || initialVoiceIndex > job.voices.length) {
    notify(ctx, `agent index must be between 0 and ${Math.max(0, job.voices.length - 1)}, or conductor`, "warning");
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
  await jobs.flush().catch(() => undefined);
  show(ctx, `chorus job canceled: ${jobId}`);
}

export async function handleResume(ctx: JobsCommandContext, rawArgs: string): Promise<void> {
  const jobs = getJobStore(ctx);
  await jobs.initialize(ctx.storePaths ?? {});
  const [jobId] = rawArgs.trim().split(/\s+/).filter(Boolean);
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) { notify(ctx, `Usage: /chorus resume <jobId>`, "warning"); return; }
  if (job.kind === "review") { await resumeReviewJob(ctx, jobs, job); return; }
  const runConfig = job.result?.runConfigSnapshot;
  if (!runConfig) { notify(ctx, `job ${job.id} has no resumable run configuration snapshot`, "error"); return; }
  const checkpoint = await createCheckpoint(job);
  const { plan, results } = await reusableVoiceResults(checkpoint, job);
  const registry = await registryModels(ctx as PiLikeContext);
  const resumed = jobs.create({ kind: job.kind, title: `${job.title} (resumed)`, presetName: runConfig.presetName, prompt: job.prompt, ...(job.optimizedPrompt ? { optimizedPrompt: job.optimizedPrompt } : {}), command: `/chorus resume ${job.id}`, voices: runConfig.voices });
  const artifactDir = job.kind === "agent" ? resultDirForJob(resumed.id, ctx.storePaths) : undefined;
  show(ctx, `chorus resume ${job.id} -> ${resumed.id}\nReused voices: ${plan.reusedVoices.join(", ") || "none"}\nRerun voices: ${plan.rerunVoices.join(", ") || "none"}\nRerun conductor: ${plan.rerunConductor ? "yes" : "no"}${plan.warnings.length ? `\nWarnings: ${plan.warnings.join("; ")}` : ""}`);
  runChorusCommandJob(ctx as PiLikeContext, {
    job: resumed,
    kind: job.kind,
    title: resumed.title,
    presetName: runConfig.presetName,
    prompt: job.prompt,
    ...(job.optimizedPrompt ? { optimizedPrompt: job.optimizedPrompt } : {}),
    ...(artifactDir ? { outputDir: artifactDir } : {}),
    initialStatus: "resuming",
    widgetTitle: "Chorus resuming",
    workingMessage: "Chorus is resuming incomplete work...",
    actorLabel: job.kind === "agent" ? "agent" : "voice",
    actorPlural: job.kind === "agent" ? "agents" : "voices",
    statusPattern: /^(voice\[\d+\]|agent\[\d+\]|conductor)\s+(.+)$/,
    failedStatus: "resume failed",
    failedMessagePrefix: "chorus resume failed",
    run: async ({ onProgress, signal }) => {
      const result = await (ctx.resumeRun ?? runChorus)({
        runConfig,
        prompt: job.prompt,
        ...(job.optimizedPrompt ? { optimizedPrompt: job.optimizedPrompt } : {}),
        registry,
        signal,
        ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        ...(ctx.storePaths ? { storePaths: ctx.storePaths } : {}),
        ...(artifactDir ? { artifactDir } : {}),
        synthesisMode: job.kind === "agent" ? "agent" : "direct",
        reuseVoiceResults: results,
        resumedFromJobId: job.id,
        ...(job.result?.totalCostUsd !== undefined ? { resumedPreviousCostUsd: job.result.totalCostUsd } : {}),
        onProgress,
      });
      return { result, text: renderResult(result, job.kind === "agent" ? { title: "Chorus Agent Result", summaryLabel: "Agents", actorLabel: "agent", actorPlural: "agents", outputsTitle: "Agent Outputs" } : {}).expanded };
    },
    details: (response) => ({ kind: "resume", jobId: resumed.id, resumedFromJobId: job.id, runId: response.result.runId, reusedVoices: plan.reusedVoices, rerunVoices: plan.rerunVoices }),
  });
}

async function resumeReviewJob(ctx: JobsCommandContext, jobs: ChorusJobStore, job: NonNullable<ReturnType<ChorusJobStore["get"]>>): Promise<void> {
  if (!job.reviewRequest || !job.reviewResult || !job.reviewArtifacts) { notify(ctx, `review job ${job.id} has no resumable review snapshot`, "error"); return; }
  const checkpointArtifact = job.reviewArtifacts.find((artifact) => artifact.label === "review-checkpoint");
  if (!checkpointArtifact) { notify(ctx, `review job ${job.id} has no review checkpoint`, "error"); return; }
  let checkpoint: ReviewCheckpoint;
  try { checkpoint = JSON.parse(await readFile(checkpointArtifact.path, "utf8")) as ReviewCheckpoint; }
  catch (error) { notify(ctx, `review checkpoint could not be read: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
  const plan = await planReviewResume(checkpoint, job.reviewResult, job.reviewArtifacts);
  const reuse = restrictReviewReuse(job.reviewResult, plan.reusableStages);
  const resumed = jobs.create({
    kind: "review",
    title: `${job.title} (resumed)`,
    presetName: job.presetName,
    prompt: job.prompt,
    command: `/chorus resume ${job.id}`,
    voices: job.reviewResult.plan.assignments.filter((assignment) => assignment.resolvedModel).map((assignment) => ({ model: assignment.resolvedModel! })),
    actorIds: job.reviewResult.plan.assignments.filter((assignment) => assignment.resolvedModel).map((assignment) => assignment.roleId),
    actorLabels: job.reviewResult.plan.assignments.filter((assignment) => assignment.resolvedModel).map((assignment) => assignment.roleId),
    reviewRequest: job.reviewRequest,
    ...(job.reviewDefinition ? { reviewDefinition: job.reviewDefinition } : {}),
  });
  show(ctx, `chorus review resume ${job.id} -> ${resumed.id}\nReusable stages: ${plan.reusableStages.join(", ") || "none"}\nRerun stages: ${plan.rerunStages.join(", ") || "none"}${plan.warnings.length ? `\nWarnings: ${plan.warnings.join("; ")}` : ""}`);
  const unbind = bindJobToHostSignal(resumed, ctx.signal);
  void (async () => {
    try {
      const response = await runReviewService(ctx as PiLikeContext, job.reviewRequest!, {
        jobId: resumed.id,
        signal: resumed.abortController.signal,
        reuse,
        ...(job.reviewDefinition ? { definition: job.reviewDefinition } : {}),
        onStageStart: (stage) => { jobs.updateReviewStage(resumed.id, stage, "running"); setChorusStatus(ctx as PiLikeContext, `${stage} running`); },
        onStage: (stage) => { jobs.updateReviewStage(resumed.id, stage.stage, stage.status); setChorusStatus(ctx as PiLikeContext, `${stage.stage} ${stage.status}`); },
        onExecution: (progress) => jobs.updateReviewExecution(resumed.id, progress),
      });
      const status = resumed.abortController.signal.aborted ? "aborted" : reviewExecutionStatus(response.result);
      jobs.finishReview(resumed.id, response.result, response.text, response.artifacts, status);
      showPersistentResult(ctx as PiLikeContext, response.text, { kind: "review-resume", jobId: resumed.id, resumedFromJobId: job.id, reusableStages: plan.reusableStages, report: response.result.report });
    } catch (error) {
      jobs.fail(resumed.id, error);
      notify(ctx, `chorus review resume failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally { unbind(); }
  })();
}

function show(ctx: JobsCommandContext, content: string): void {
  if (ctx.ui?.show) ctx.ui.show(content);
  else notify(ctx, content, "info");
}

function notify(ctx: JobsCommandContext, content: string, level: "info" | "warning" | "error" | "success"): void {
  if (ctx.ui?.notify) ctx.ui.notify(content, level === "success" ? "info" : level);
  else console.log(content);
}
