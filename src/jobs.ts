import { randomUUID } from "node:crypto";
import type { ChorusProgress, ChorusResult, VoiceResult } from "./types.js";
import { loadJsonFile, resolveStorePaths, saveJsonFile, type StorePaths } from "./store.js";
import { modelRefToPiArg } from "./utils/models.js";
import { redactSensitive } from "./utils/redact.js";
import { mergeActivitySnapshots } from "./utils/activity-log.js";
import type { ReviewArtifact, ReviewDefinition, ReviewRequest } from "./review/index.js";
import type { ReviewRoleExecutionProgress, ReviewWorkflowResult } from "./workflows/contracts.js";
import { applyReviewCompletion, applyReviewExecution, applyReviewFailure, applyReviewStage } from "./jobs/review.js";
export type ChorusJobKind = "ask" | "agent" | "review";
export type ChorusJobStatus = "running" | "success" | "degraded" | "error" | "aborted" | "stale";
export interface ChorusJobVoice {
  index: number;
  roleId?: string;
  stage?: ReviewRoleExecutionProgress["stage"];
  label: string;
  status: VoiceResult["status"] | "pending" | "skipped" | "empty";
  partialOutput?: string;
  activityLog?: string;
  output?: string;
  outputPath?: string;
  activityPath?: string;
  errorMessage?: string;
  durationMs?: number;
  costUsd?: number | null;
}
export interface ChorusJob {
  id: string;
  kind: ChorusJobKind;
  title: string;
  presetName: string;
  prompt: string;
  optimizedPrompt?: string;
  command: string;
  status: ChorusJobStatus;
  startedAt: number;
  finishedAt?: number;
  voices: ChorusJobVoice[];
  abortController: AbortController;
  result?: ChorusResult;
  reviewRequest?: ReviewRequest;
  reviewDefinition?: ReviewDefinition;
  reviewResult?: ReviewWorkflowResult;
  reviewArtifacts?: ReviewArtifact[];
  reviewStage?: { id: string; status: string };
  renderedText?: string;
  errorMessage?: string;
  conductor?: {
    status: VoiceResult["status"] | "pending" | "skipped";
    partialOutput?: string;
    activityLog?: string;
    errorMessage?: string;
    durationMs?: number;
  };
}
type Listener = (job: ChorusJob) => void;
type PersistedChorusJob = Omit<ChorusJob, "abortController">;
const MAX_JOBS = 20;
const MAX_ACTIVITY_LOG_CHARS = 80_000;
const TRUNCATED_MARKER = "[older activity truncated]";
const PERSIST_DEBOUNCE_MS = 250;
export interface CreateChorusJobArgs {
  kind: ChorusJobKind;
  title: string;
  presetName: string;
  prompt: string;
  optimizedPrompt?: string;
  command: string;
  voices: Array<{ model: { provider: string; modelId: string } }>;
  actorLabels?: string[];
  actorIds?: string[];
  reviewRequest?: ReviewRequest;
  reviewDefinition?: ReviewDefinition;
}
export class ChorusJobStore {
  private readonly jobs = new Map<string, ChorusJob>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private paths: StorePaths | undefined;
  private loadedJobsPath: string | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingPersist: Promise<void> | undefined;
  private persistDirty = false;
  private readonly persistenceErrorListeners = new Set<(error: string) => void>();
  constructor(paths: StorePaths = {}) {
    this.configure(paths);
  }
  configure(paths: StorePaths = {}): void {
    this.paths = paths;
  }
  async initialize(paths: StorePaths = {}): Promise<void> {
    this.configure(paths);
    const jobsPath = resolveStorePaths(paths).jobsPath;
    if (this.loadedJobsPath === jobsPath) return;
    let snapshots: PersistedChorusJob[];
    try {
      snapshots = await loadJsonFile<PersistedChorusJob[]>(jobsPath, []);
    } catch (error) {
      snapshots = [];
      this.reportPersistenceError(error);
    }
    for (const snapshot of snapshots) {
      if (this.jobs.has(snapshot.id)) continue;
      const status: ChorusJobStatus = snapshot.status === "running" ? "stale" : snapshot.status;
      this.jobs.set(snapshot.id, {
        ...snapshot,
        status,
        ...(status === "stale" && !snapshot.errorMessage
          ? { errorMessage: "job was running before reload and cannot be reattached" }
          : {}),
        abortController: new AbortController()
      });
    }
    this.loadedJobsPath = jobsPath;
    this.prune();
    await this.persist();
  }
  create(args: CreateChorusJobArgs): ChorusJob {
    const job: ChorusJob = {
      id: `chorus-${randomUUID().slice(0, 8)}`,
      kind: args.kind,
      title: args.title,
      presetName: args.presetName,
      prompt: args.prompt,
      ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {}),
      command: args.command,
      status: "running",
      startedAt: Date.now(),
      voices: args.voices.map((voice, index) => ({
        index,
        ...(args.actorIds?.[index] ? { roleId: args.actorIds[index] } : {}),
        label: args.actorLabels?.[index] ?? `${args.kind === "agent" ? "agent" : args.kind === "review" ? "reviewer" : "voice"}[${index}] ${modelRefToPiArg(voice.model)}`,
        status: "pending"
      })),
      abortController: new AbortController(),
      conductor: { status: "pending" },
      ...(args.reviewRequest ? { reviewRequest: args.reviewRequest } : {}),
      ...(args.reviewDefinition ? { reviewDefinition: args.reviewDefinition } : {})
    };
    this.jobs.set(job.id, job);
    this.prune();
    this.schedulePersist();
    return job;
  }
  updateProgress(jobId: string, updates: ChorusProgress[]): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const update of updates) {
      if (update.kind === "conductor") {
        job.conductor ??= { status: "pending" };
        job.conductor.status = update.status;
        if (update.partialOutput !== undefined) job.conductor.partialOutput = update.partialOutput;
        if (update.activityLog !== undefined) job.conductor.activityLog = mergeActivityLog(job.conductor.activityLog, update.activityLog);
        if (update.errorMessage !== undefined) job.conductor.errorMessage = update.errorMessage;
        if (update.durationMs !== undefined) job.conductor.durationMs = update.durationMs;
        continue;
      }
      const voice = job.voices[update.voiceIndex];
      if (!voice) continue;
      voice.status = update.status;
      if (update.partialOutput !== undefined) voice.partialOutput = update.partialOutput;
      if (update.activityLog !== undefined) voice.activityLog = mergeActivityLog(voice.activityLog, update.activityLog);
      if (update.durationMs !== undefined) voice.durationMs = update.durationMs;
      if (update.costUsd !== undefined) voice.costUsd = update.costUsd;
      if (update.errorMessage !== undefined) voice.errorMessage = update.errorMessage;
    }
    this.emit(job);
    this.schedulePersist();
  }
  finish(jobId: string, result: ChorusResult, renderedText: string, status: "success" | "aborted" = "success"): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.finishedAt = result.finishedAt;
    job.result = result;
    job.renderedText = renderedText;
    const previousConductor = job.conductor;
    job.conductor = {
      status: result.synthesis ? "success" : status === "aborted" ? "aborted" : result.fallbackNote?.startsWith("conductor failed") ? "error" : "skipped",
      ...(result.synthesis ? { partialOutput: result.synthesis } : previousConductor?.partialOutput ? { partialOutput: previousConductor.partialOutput } : {}),
      ...(result.conductorActivityLog ? { activityLog: result.conductorActivityLog } : {})
    };
    job.voices = result.voices.map((voice, index) => ({
      index,
      label: `${job.kind === "agent" ? "agent" : "voice"}[${index}] ${modelRefToPiArg(voice.voice.model)}`,
      status: voice.status,
      ...(voice.partialOutput ? { partialOutput: voice.partialOutput } : {}),
      ...(voice.activityLog ? { activityLog: voice.activityLog } : {}),
      ...(voice.output ? { output: voice.output } : {}),
      ...(voice.outputPath ? { outputPath: voice.outputPath } : {}),
      ...(voice.activityPath ? { activityPath: voice.activityPath } : {}),
      ...(voice.errorMessage ? { errorMessage: voice.errorMessage } : {}),
      durationMs: voice.durationMs,
      costUsd: voice.costUsd
    }));
    this.emit(job);
    this.schedulePersist();
  }
  finishReview(jobId: string, result: ReviewWorkflowResult, renderedText: string, artifacts: ReviewArtifact[], status: "success" | "degraded" | "aborted" = "success"): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    applyReviewCompletion(job, result, renderedText, artifacts, status);
    this.emit(job);
    this.schedulePersist();
  }
  updateReviewStage(jobId: string, stage: string, status: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    applyReviewStage(job, stage, status);
    this.emit(job);
    this.schedulePersist();
  }
  updateReviewExecution(jobId: string, update: ReviewRoleExecutionProgress): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    applyReviewExecution(job, update);
    this.emit(job);
    this.schedulePersist();
  }
  fail(jobId: string, error: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = job.abortController.signal.aborted ? "aborted" : "error";
    job.finishedAt = Date.now();
    job.errorMessage = error instanceof Error ? error.message : String(error);
    if (job.kind === "review") applyReviewFailure(job, job.status === "aborted" ? "aborted" : "error", job.errorMessage);
    this.emit(job);
    this.schedulePersist();
  }
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return false;
    job.status = "aborted";
    job.finishedAt = Date.now();
    job.abortController.abort();
    if (job.kind === "review") applyReviewFailure(job, "aborted", "review cancelled");
    this.emit(job);
    this.schedulePersist();
    return true;
  }
  get(jobId: string): ChorusJob | undefined {
    return this.jobs.get(jobId);
  }
  list(): ChorusJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  subscribe(jobId: string, listener: Listener): () => void {
    const set = this.listeners.get(jobId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(jobId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(jobId);
    };
  }

  async persist(): Promise<void> {
    if (!this.paths) return;
    const path = resolveStorePaths(this.paths).jobsPath;
    const snapshots = this.list().map(serializeJob);
    try {
      await saveJsonFile(path, snapshots);
    } catch (error) {
      this.reportPersistenceError(error);
      throw error;
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.pendingPersist) await this.pendingPersist;
    this.persistDirty = false;
    await this.persist();
  }

  onPersistenceError(listener: (error: string) => void): () => void {
    this.persistenceErrorListeners.add(listener);
    return () => this.persistenceErrorListeners.delete(listener);
  }

  reset(): void {
    this.jobs.clear();
    this.listeners.clear();
    this.paths = undefined;
    this.loadedJobsPath = undefined;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.pendingPersist = undefined;
    this.persistDirty = false;
  }

  private emit(job: ChorusJob): void {
    const set = this.listeners.get(job.id);
    if (!set) return;
    for (const listener of set) listener(job);
  }

  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistTimer || this.pendingPersist) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistDirty = false;
      this.pendingPersist = this.persist().catch(() => undefined).finally(() => {
        this.pendingPersist = undefined;
        if (this.persistDirty) this.schedulePersist();
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  private reportPersistenceError(error: unknown): void {
    const message = redactSensitive(error instanceof Error ? error.message : String(error));
    for (const listener of this.persistenceErrorListeners) listener(message);
  }

  private prune(): void {
    const all = this.list();
    let excess = Math.max(0, all.length - MAX_JOBS);
    for (const job of all.slice().reverse()) {
      if (excess === 0) break;
      if (job.status !== "running") {
        this.jobs.delete(job.id);
        excess -= 1;
      }
    }
  }
}
const defaultJobStore = new ChorusJobStore();

export function configureChorusJobStore(paths: StorePaths = {}): void {
  defaultJobStore.configure(paths);
}
export async function initializeChorusJobs(paths: StorePaths = {}): Promise<void> {
  await defaultJobStore.initialize(paths);
}
export function createChorusJob(args: CreateChorusJobArgs): ChorusJob {
  return defaultJobStore.create(args);
}

export function updateChorusJobProgress(jobId: string, updates: ChorusProgress[]): void {
  defaultJobStore.updateProgress(jobId, updates);
}

export function finishChorusJob(jobId: string, result: ChorusResult, renderedText: string, status: "success" | "aborted" = "success"): void {
  defaultJobStore.finish(jobId, result, renderedText, status);
}

export function failChorusJob(jobId: string, error: unknown): void {
  defaultJobStore.fail(jobId, error);
}

export function cancelChorusJob(jobId: string): boolean {
  return defaultJobStore.cancel(jobId);
}

export function getChorusJob(jobId: string): ChorusJob | undefined {
  return defaultJobStore.get(jobId);
}

export function listChorusJobs(): ChorusJob[] {
  return defaultJobStore.list();
}

export function subscribeChorusJob(jobId: string, listener: Listener): () => void {
  return defaultJobStore.subscribe(jobId, listener);
}

export async function persistChorusJobs(): Promise<void> {
  await defaultJobStore.flush();
}

export function resetChorusJobsForTest(): void {
  defaultJobStore.reset();
}

function serializeJob(job: ChorusJob): PersistedChorusJob {
  const { abortController: _abortController, ...snapshot } = job;
  const voices = snapshot.voices.map((voice) => ({ ...voice, ...(voice.partialOutput ? { partialOutput: retainActivityLog(voice.partialOutput) } : {}) }));
  const conductor = snapshot.conductor
    ? { ...snapshot.conductor, ...(snapshot.conductor.partialOutput ? { partialOutput: retainActivityLog(snapshot.conductor.partialOutput) } : {}) }
    : undefined;
  return {
    ...snapshot,
    voices,
    ...(conductor ? { conductor } : {}),
  };
}

function mergeActivityLog(existing: string | undefined, next: string): string {
  return retainActivityLog(mergeActivitySnapshots(existing, next));
}

function retainActivityLog(value: string): string {
  if (value.length <= MAX_ACTIVITY_LOG_CHARS) return value;
  return `${TRUNCATED_MARKER}\n${value.slice(value.length - MAX_ACTIVITY_LOG_CHARS)}`;
}
