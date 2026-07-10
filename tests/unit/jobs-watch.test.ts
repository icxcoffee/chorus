import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelChorusJob,
  ChorusJobStore,
  configureChorusJobStore,
  createChorusJob,
  finishChorusJob,
  getChorusJob,
  initializeChorusJobs,
  persistChorusJobs,
  resetChorusJobsForTest,
  subscribeChorusJob,
  updateChorusJobProgress
} from "../../src/jobs.js";
import { bindJobToHostSignal } from "../../src/index.js";
import { renderWatch, watchChorusJob } from "../../src/ui/watch.js";
import { visibleWidth } from "../../src/ui/width.js";
import { preset, voiceResult } from "./fixtures.js";

describe("jobs/watch", () => {
  it("supports isolated job store instances", () => {
    const first = new ChorusJobStore();
    const second = new ChorusJobStore();
    const job = first.create({
      kind: "ask",
      title: "Chorus Question",
      presetName: "default",
      prompt: "question",
      command: "/chorus ask question",
      voices: preset.voices
    });

    expect(first.get(job.id)).toBeDefined();
    expect(second.get(job.id)).toBeUndefined();
    expect(second.list()).toHaveLength(0);
  });

  it("tracks progress, subscriptions, and final results", () => {
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "audit code",
      command: "/chorus agent audit code",
      voices: preset.voices
    });
    const listener = vi.fn();
    const unsubscribe = subscribeChorusJob(job.id, listener);

    updateChorusJobProgress(job.id, [
      {
        voiceIndex: 0,
        voice: preset.voices[0]!,
        status: "running",
        partialOutput: "reading files"
      }
    ]);

    expect(getChorusJob(job.id)?.voices[0]?.partialOutput).toBe("reading files");
    expect(listener).toHaveBeenCalled();

    finishChorusJob(
      job.id,
      {
        runId: "run",
        presetName: "default",
        prompt: "audit code",
        voices: [voiceResult(0), voiceResult(1)],
        synthesis: "done",
        totalDurationMs: 10,
        totalCostUsd: 0,
        successfulVoices: 2,
        totalVoices: 2,
        startedAt: 1,
        finishedAt: 11
      },
      "rendered"
    );

    expect(getChorusJob(job.id)?.status).toBe("success");
    expect(getChorusJob(job.id)?.voices[0]?.output).toContain("answer 0");
    unsubscribe();
  });

  it("renders and switches watched agents", async () => {
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "pwd",
      command: "/chorus agent pwd",
      voices: preset.voices
    });
    updateChorusJobProgress(job.id, [
      { voiceIndex: 0, voice: preset.voices[0]!, status: "running", partialOutput: "agent zero" },
      { voiceIndex: 1, voice: preset.voices[1]!, status: "running", partialOutput: "agent one" }
    ]);

    expect(renderWatch({ job, active: 0, scroll: 0, width: 100 }).lines.join("\n")).toContain("agent zero");

    const rendered: string[][] = [];
    await watchChorusJob({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            rendered.push(view.render(100));
            view.handleInput({ name: "right" });
            rendered.push(view.render(100));
            view.handleInput({ name: "escape" });
          })
      },
      job,
      subscribe: (listener) => subscribeChorusJob(job.id, listener)
    });

    expect(rendered[0]?.join("\n")).toContain("agent zero");
    expect(rendered[1]?.join("\n")).toContain("agent one");
  });

  it("prefers activity logs in watch output", () => {
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "pwd",
      command: "/chorus agent pwd",
      voices: preset.voices
    });
    updateChorusJobProgress(job.id, [
      {
        voiceIndex: 0,
        voice: preset.voices[0]!,
        status: "running",
        partialOutput: "latest sentence",
        activityLog: "[tool start] read {\"path\":\"src/index.ts\"}\n\n[assistant] latest sentence"
      }
    ]);

    const rendered = renderWatch({ job, active: 0, scroll: 0, width: 100 }).lines.join("\n");
    expect(rendered).toContain("[tool start] read");
    expect(rendered).toContain("[assistant] latest sentence");
  });

  it("keeps rendered lines within terminal width for Chinese output", () => {
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "架构分析",
      command: "/chorus agent 架构分析",
      voices: preset.voices
    });
    updateChorusJobProgress(job.id, [
      {
        voiceIndex: 0,
        voice: preset.voices[0]!,
        status: "running",
        partialOutput: "当前项目的软件架构需要优化的部分包括命令入口职责过重、后台任务状态缺少持久化、TUI 渲染需要统一宽度处理。".repeat(4)
      }
    ]);

    const lines = renderWatch({ job, active: 0, scroll: 0, width: 80 }).lines;
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("clamps watch scroll and points to full artifact paths", () => {
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "long",
      command: "/chorus agent long",
      voices: preset.voices
    });
    job.voices[0]!.activityLog = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
    job.voices[0]!.activityPath = "/tmp/agent-0-activity.md";
    const rendered = renderWatch({ job, active: 0, scroll: 999, width: 100 });
    expect(rendered.maxScroll).toBeGreaterThan(0);
    expect(rendered.lines.join("\n")).toContain("full activity: /tmp/agent-0-activity.md");
    expect(rendered.lines.join("\n")).not.toContain("No output yet.");
  });

  it("retains long activity with a truncation marker", () => {
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "long",
      command: "/chorus agent long",
      voices: preset.voices
    });
    updateChorusJobProgress(job.id, [
      {
        voiceIndex: 0,
        voice: preset.voices[0]!,
        status: "running",
        activityLog: `start\n${"x".repeat(90_000)}`
      }
    ]);
    expect(getChorusJob(job.id)?.voices[0]?.activityLog).toContain("[older activity truncated]");
  });

  it("persists job snapshots and marks running jobs stale after reload", async () => {
    resetChorusJobsForTest();
    const dir = await mkdtemp(join(tmpdir(), "chorus-jobs-"));
    configureChorusJobStore({ baseDir: dir });
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "reload",
      command: "/chorus agent reload",
      voices: preset.voices
    });
    await persistChorusJobs();
    resetChorusJobsForTest();
    await initializeChorusJobs({ baseDir: dir });
    expect(getChorusJob(job.id)?.status).toBe("stale");
    expect(getChorusJob(job.id)?.errorMessage).toContain("cannot be reattached");
  });

  it("cancels a running job", () => {
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "long task",
      command: "/chorus agent long task",
      voices: preset.voices
    });
    expect(cancelChorusJob(job.id)).toBe(true);
    expect(getChorusJob(job.id)?.status).toBe("aborted");
    expect(job.abortController.signal.aborted).toBe(true);
  });

  it("binds host cancellation to the job abort controller and cleans up", () => {
    const host = new AbortController();
    const job = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "long task",
      command: "/chorus agent long task",
      voices: preset.voices
    });
    const cleanup = bindJobToHostSignal(job, host.signal);
    host.abort("stop");
    expect(job.abortController.signal.aborted).toBe(true);

    const nextHost = new AbortController();
    const nextJob = createChorusJob({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "long task",
      command: "/chorus agent long task",
      voices: preset.voices
    });
    const nextCleanup = bindJobToHostSignal(nextJob, nextHost.signal);
    nextCleanup();
    nextHost.abort("stop");
    expect(nextJob.abortController.signal.aborted).toBe(false);
    cleanup();
  });
});
