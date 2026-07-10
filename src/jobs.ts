import { randomUUID } from "node:crypto";
import type { ChorusProgress, ChorusResult, VoiceResult } from "./types.js";
import { loadJsonFile, resolveStorePaths, saveJsonFile, type StorePaths } from "./store.js";
import { modelRefToPiArg } from "./utils/models.js";

export type ChorusJobKind = "ask" | "agent";
export type ChorusJobStatus = "running" | "success" | "error" | "aborted" | "stale";

export interface ChorusJobVoice {
  index: number;
  label: string;
  status: VoiceResult["status"] | "pending";
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
  renderedText?: string;
  errorMessage?: string;
}

type Listener = (job: ChorusJob) => void;
type PersistedChorusJob = Omit<ChorusJob, "abortController">;
const MAX_JOBS = 20;
const MAX_ACTIVITY_LOG_CHARS = 80_000;
const TRUNCATED_MARKER = "[older activity truncated]";

export interface CreateChorusJobArgs {
  kind: ChorusJobKind;
  title: string;
  presetName: string;
  prompt: string;
  optimizedPrompt?: string;
  command: string;
  voices: Array<{ model: { provider: string; modelId: string } }>;
}

export class ChorusJobStore {
  private readonly jobs = new Map<string, ChorusJob>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private paths: StorePaths | undefined;
  private loadedJobsPath: string | undefined;

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
    const snapshots = await loadJsonFile<PersistedChorusJob[]>(jobsPath, []);
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
        label: `${args.kind === "agent" ? "agent" : "voice"}[${index}] ${modelRefToPiArg(voice.model)}`,
        status: "pending"
      })),
      abortController: new AbortController()
    };
    this.jobs.set(job.id, job);
    this.prune();
    void this.persist();
    return job;
  }

  updateProgress(jobId: string, updates: ChorusProgress[]): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const update of updates) {
      if (update.kind === "conductor") continue;
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
    void this.persist();
  }

  finish(jobId: string, result: ChorusResult, renderedText: string, status: "success" | "aborted" = "success"): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.finishedAt = result.finishedAt;
    job.result = result;
    job.renderedText = renderedText;
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
    void this.persist();
  }

  fail(jobId: string, error: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = job.abortController.signal.aborted ? "aborted" : "error";
    job.finishedAt = Date.now();
    job.errorMessage = error instanceof Error ? error.message : String(error);
    this.emit(job);
    void this.persist();
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return false;
    job.status = "aborted";
    job.finishedAt = Date.now();
    job.abortController.abort();
    this.emit(job);
    void this.persist();
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
    await saveJsonFile(path, snapshots);
  }

  reset(): void {
    this.jobs.clear();
    this.listeners.clear();
    this.paths = undefined;
    this.loadedJobsPath = undefined;
  }

  private emit(job: ChorusJob): void {
    const set = this.listeners.get(job.id);
    if (!set) return;
    for (const listener of set) listener(job);
  }

  private prune(): void {
    const all = this.list();
    for (const job of all.slice(MAX_JOBS)) {
      if (job.status !== "running" && job.status !== "stale") this.jobs.delete(job.id);
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
  await defaultJobStore.persist();
}

export function resetChorusJobsForTest(): void {
  defaultJobStore.reset();
}

function serializeJob(job: ChorusJob): PersistedChorusJob {
  const { abortController: _abortController, ...snapshot } = job;
  return snapshot;
}

function mergeActivityLog(existing: string | undefined, next: string): string {
  if (!existing) return retainActivityLog(next);
  if (next.startsWith(existing)) return retainActivityLog(next);
  if (existing.includes(next)) return retainActivityLog(existing);
  return retainActivityLog(`${existing}\n\n${next}`);
}

function retainActivityLog(value: string): string {
  if (value.length <= MAX_ACTIVITY_LOG_CHARS) return value;
  return `${TRUNCATED_MARKER}\n${value.slice(value.length - MAX_ACTIVITY_LOG_CHARS)}`;
}
