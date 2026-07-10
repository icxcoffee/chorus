import type { ChorusProgress, ChorusResult } from "../types.js";
import type { ChorusJob } from "../jobs.js";
import type { PiLikeContext } from "../pi-context.js";
import { getJobStore } from "../jobs/store.js";
import { notify, setChorusStatus, setChorusWidget, showPersistentResult, showRunStarted } from "./pi-ui.js";

export interface ChorusCommandJobResponse {
  result: ChorusResult;
  text: string;
}

export interface ChorusCommandJobHooks {
  signal: AbortSignal;
  onProgress: (updates: ChorusProgress[]) => void;
  onStatus: (message: string) => void;
}

export interface ChorusCommandJobOptions {
  job: ChorusJob;
  kind: "ask" | "agent";
  title: string;
  presetName: string;
  prompt: string;
  optimizedPrompt?: string;
  outputDir?: string;
  initialStatus: string;
  widgetTitle: string;
  workingMessage: string;
  actorLabel: "voice" | "agent";
  actorPlural: string;
  statusPattern: RegExp;
  failedStatus: string;
  failedMessagePrefix: string;
  run: (hooks: ChorusCommandJobHooks) => Promise<ChorusCommandJobResponse>;
  details: (response: ChorusCommandJobResponse) => unknown;
}

export function runChorusCommandJob(ctx: PiLikeContext, options: ChorusCommandJobOptions): void {
  const unbindHostCancel = bindJobToHostSignal(options.job, ctx.signal);
  showRunStarted(ctx, {
    jobId: options.job.id,
    kind: options.kind,
    title: options.title,
    presetName: options.presetName,
    prompt: options.prompt,
    ...(options.optimizedPrompt ? { optimizedPrompt: options.optimizedPrompt } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {})
  });
  setChorusStatus(ctx, options.initialStatus);
  const actorStatus = new Map<string, string>();
  setChorusWidget(ctx, [options.widgetTitle, "starting"]);
  ctx.ui?.setWorkingMessage?.(options.workingMessage);
  void (async () => {
    try {
      const response = await options.run({
        signal: options.job.abortController.signal,
        onProgress: (updates) => getJobStore(ctx).updateProgress(options.job.id, updates),
        onStatus: (message) => {
          setChorusStatus(ctx, message);
          const match = options.statusPattern.exec(message);
          if (match) actorStatus.set(match[1]!, `${match[1]} ${match[2]}`);
          setChorusWidget(ctx, [options.widgetTitle, ...Array.from(actorStatus.values())]);
        }
      });
      const status = options.job.abortController.signal.aborted ? "aborted" : "success";
      getJobStore(ctx).finish(options.job.id, response.result, response.text, status);
      setChorusStatus(ctx, `${status === "aborted" ? "aborted" : "done"}: ${response.result.successfulVoices}/${response.result.totalVoices} ${options.actorPlural}`);
      showPersistentResult(ctx, response.text, options.details(response));
    } catch (error) {
      getJobStore(ctx).fail(options.job.id, error);
      const message = error instanceof Error ? error.message : String(error);
      setChorusStatus(ctx, options.failedStatus);
      notify(ctx, `${options.failedMessagePrefix}: ${message}`, "error");
    } finally {
      unbindHostCancel();
      ctx.ui?.setWorkingMessage?.();
      setChorusWidget(ctx, undefined);
    }
  })();
}

export function bindJobToHostSignal(job: ChorusJob, hostSignal: AbortSignal | undefined): () => void {
  if (!hostSignal) return () => undefined;
  const abortJob = () => {
    if (job.status === "running" && !job.abortController.signal.aborted) {
      job.abortController.abort(hostSignal.reason);
    }
  };
  if (hostSignal.aborted) abortJob();
  hostSignal.addEventListener("abort", abortJob, { once: true });
  return () => hostSignal.removeEventListener("abort", abortJob);
}
