import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { parseUiKey } from "../../src/ui/keys.js";
import { renderReviewWidget } from "../../src/render/jobs.js";
import { visibleWidth } from "../../src/ui/width.js";
import { preset, voiceResult } from "./fixtures.js";
import { handleCancel, handleResume } from "../../src/commands/jobs.js";
import { registry } from "./fixtures.js";

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

  it("recognizes terminal and structured viewport navigation keys", () => {
    expect(parseUiKey("\u001b[H")).toEqual({ key: "home" });
    expect(parseUiKey("\u001b[4~")).toEqual({ key: "end" });
    expect(parseUiKey("\u001b[5~")).toEqual({ key: "pageup" });
    expect(parseUiKey("\u001b[6~")).toEqual({ key: "pagedown" });
    expect(parseUiKey("\u001b[57423u")).toEqual({ key: "home" });
    expect(parseUiKey({ name: "pageDown" })).toEqual({ key: "pagedown" });
  });

  it("pages and jumps through long activity logs", async () => {
    const job = createChorusJob({
      kind: "review",
      title: "Chorus Review",
      presetName: "default",
      prompt: "review",
      command: "/chorus review",
      voices: preset.voices
    });
    job.voices[0]!.activityLog = Array.from({ length: 60 }, (_, index) => `activity line ${index}`).join("\n");

    const rendered: string[] = [];
    await watchChorusJob({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            rendered.push(view.render(100).join("\n"));
            view.handleInput({ name: "pageDown" });
            rendered.push(view.render(100).join("\n"));
            view.handleInput({ name: "end" });
            rendered.push(view.render(100).join("\n"));
            view.handleInput("g");
            rendered.push(view.render(100).join("\n"));
            view.handleInput("G");
            rendered.push(view.render(100).join("\n"));
            view.handleInput({ name: "escape" });
          })
      },
      job,
      subscribe: (listener) => subscribeChorusJob(job.id, listener)
    });

    expect(rendered[0]).toContain("lines 1-18 / 60 · 0%");
    expect(rendered[1]).toContain("lines 19-36 / 60");
    expect(rendered[2]).toContain("lines 43-60 / 60 · 100%");
    expect(rendered[3]).toContain("lines 1-18 / 60 · 0%");
    expect(rendered[4]).toContain("activity line 59");
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

  it("keeps a role error visible above a long activity log", () => {
    const job = createChorusJob({
      kind: "review",
      title: "Chorus Review",
      presetName: "default",
      prompt: "review",
      command: "/chorus review",
      voices: preset.voices,
      actorIds: ["security", "performance"],
      actorLabels: ["security model-a", "performance model-b"]
    });
    job.voices[0]!.status = "error";
    job.voices[0]!.activityLog = Array.from({ length: 100 }, (_, index) => `[tool done] read line ${index}`).join("\n");
    job.voices[0]!.errorMessage = "stage=independent-review role=security model=model-a attempts=3 category=rate-limit: HTTP 429 provider concurrency limit";

    const firstPage = renderWatch({ job, active: 0, scroll: 0, width: 100 }).lines.join("\n");
    const lastPage = renderWatch({ job, active: 0, scroll: 999, width: 100 }).lines.join("\n");

    expect(firstPage).toContain("Error: stage=independent-review");
    expect(firstPage).toContain("category=rate-limit");
    expect(firstPage).toContain("provider concurrency limit");
    expect(firstPage).toContain("Activity");
    expect(lastPage).toContain("Error: stage=independent-review");
    expect(lastPage).toContain("[tool done] read line 99");
  });

  it("stores and renders conductor partial output on its own tab", () => {
    const store = new ChorusJobStore();
    const job = store.create({ kind: "ask", title: "Question", presetName: "default", prompt: "p", command: "/chorus ask p", voices: preset.voices });
    store.updateProgress(job.id, [{ kind: "conductor", conductor: preset.conductor, status: "running", partialOutput: "streamed final" }]);
    expect(job.conductor?.partialOutput).toBe("streamed final");
    expect(renderWatch({ job, active: job.voices.length, scroll: 0, width: 100 }).lines.join("\n")).toContain("streamed final");
  });
  it("marks a deliberately skipped conductor as terminal", () => {
    const store = new ChorusJobStore();
    const job = store.create({ kind: "ask", title: "Question", presetName: "default", prompt: "p", command: "/chorus ask p", voices: preset.voices });
    store.finish(job.id, {
      runId: "run", presetName: "default", prompt: "p",
      voices: [voiceResult(0), { ...voiceResult(1, "error"), errorMessage: "failed" }],
      synthesis: null, fallbackNote: "1/2 voices responded; skipping synthesis",
      totalDurationMs: 1, totalCostUsd: 0, successfulVoices: 1, totalVoices: 2,
      startedAt: 1, finishedAt: 2,
    }, "rendered");
    expect(job.conductor?.status).toBe("skipped");
  });
  it("shows live Review role and stage progress instead of pending", () => {
    const store = new ChorusJobStore();
    const job = store.create({
      kind: "review",
      title: "Chorus Review",
      presetName: "default",
      prompt: "review architecture",
      command: "/chorus review review architecture",
      voices: preset.voices,
      actorIds: ["architect", "security"],
      actorLabels: ["architect model-a", "security model-b"]
    });
    store.updateReviewStage(job.id, "independent-review", "running");
    store.updateReviewExecution(job.id, { roleId: "architect", stage: "independent-review", status: "running", partialOutput: "reading module boundaries", durationMs: 10 });
    const rendered = renderWatch({ job, active: 0, scroll: 0, width: 100 }).lines.join("\n");
    expect(job.voices.map((voice) => voice.status)).toEqual(["running", "pending"]);
    expect(rendered).toContain("Stage: independent-review (running)");
    expect(rendered).toContain("[0:running]");
    expect(rendered).toContain("reading module boundaries");
    expect(renderReviewWidget(job)).toEqual(expect.arrayContaining([expect.stringContaining("architect model-a: running"), expect.stringContaining("security model-b: pending")]));
    expect(job.conductor?.status).toBe("pending");
  });
  it("closes pending Review roles when the workflow fails", () => {
    const store = new ChorusJobStore();
    const job = store.create({
      kind: "review", title: "Chorus Review", presetName: "default", prompt: "review", command: "/chorus review",
      voices: preset.voices, actorIds: ["architect", "devil"], actorLabels: ["architect model-a", "devil model-b"]
    });
    store.updateReviewExecution(job.id, { roleId: "architect", stage: "independent-review", status: "success" });
    store.fail(job.id, new Error("independent review failed"));
    expect(job.status).toBe("error");
    expect(job.voices.map((voice) => voice.status)).toEqual(["success", "error"]);
    expect(job.voices[1]?.errorMessage).toContain("review stopped before this role completed");
    expect(job.conductor?.status).toBe("error");
  });

  it("resume launches a new attempt through the stored run snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chorus-resume-command-"));
    const store = new ChorusJobStore({ baseDir: dir });
    const source = store.create({ kind: "ask", title: "Question", presetName: "default", prompt: "resume", command: "/chorus ask resume", voices: preset.voices });
    source.status = "stale";
    source.result = { runId: "old", presetName: "default", prompt: "resume", voices: [voiceResult(0, "error"), voiceResult(1, "error")], synthesis: null, totalDurationMs: 1, totalCostUsd: null, successfulVoices: 0, totalVoices: 2, startedAt: 1, finishedAt: 2, runConfigSnapshot: { presetName: "default", voices: preset.voices, conductor: preset.conductor, mode: "direct", strategy: "parallel" } };
    await handleResume({
      chorusJobStore: store, storePaths: { baseDir: dir }, modelRegistry: { models: registry }, ui: {},
      resumeRun: async (args) => ({ runId: "new", presetName: "default", prompt: args.prompt, voices: [voiceResult(0), voiceResult(1)], synthesis: "resumed", totalDurationMs: 1, totalCostUsd: 0, successfulVoices: 2, totalVoices: 2, startedAt: 1, finishedAt: 2, runConfigSnapshot: args.runConfig, attempt: { resumedFromJobId: source.id, reusedVoices: [], rerunVoices: [0, 1] } }),
    }, source.id);
    await vi.waitFor(() => expect(store.list().find((job) => job.id !== source.id)?.status).toBe("success"));
    expect(store.list().find((job) => job.id !== source.id)?.result?.attempt?.resumedFromJobId).toBe(source.id);
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

  it("uses semantic theme colors without changing terminal width", () => {
    const job = createChorusJob({
      kind: "review",
      title: "Chorus Review",
      presetName: "default",
      prompt: "review",
      command: "/chorus review",
      voices: preset.voices
    });
    job.voices[0]!.status = "running";
    job.voices[0]!.activityLog = "[thinking] inspect\n[tool call] read\n[tool done] read\n[assistant] result";
    job.voices[1]!.status = "error";
    job.voices[1]!.errorMessage = "provider failed";
    const usedColors: string[] = [];
    const theme = {
      fg: (name: string, text: string) => {
        usedColors.push(name);
        return `\u001b[31m${text}\u001b[0m`;
      },
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`
    };

    const lines = renderWatch({ job, active: 0, scroll: 0, width: 80, theme }).lines;

    expect(usedColors).toEqual(expect.arrayContaining(["accent", "success", "warning", "error", "muted"]));
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

  it("bounds persisted partial output and evicts stale jobs beyond the history limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chorus-jobs-bounded-"));
    const store = new ChorusJobStore({ baseDir: dir });
    for (let index = 0; index < 20; index += 1) {
      const stale = store.create({ kind: "ask", title: `Question ${index}`, presetName: "default", prompt: "p", command: "/chorus ask p", voices: preset.voices });
      stale.status = "stale";
    }
    const latest = store.create({ kind: "ask", title: "Latest", presetName: "default", prompt: "p", command: "/chorus ask p", voices: preset.voices });
    store.updateProgress(latest.id, [{ voiceIndex: 0, voice: preset.voices[0]!, status: "running", partialOutput: "x".repeat(90_000) }]);
    await store.flush();
    const snapshots = JSON.parse(await readFile(join(dir, "jobs.json"), "utf8")) as Array<{ id: string; voices: Array<{ partialOutput?: string }> }>;
    expect(store.list()).toHaveLength(20);
    expect(snapshots.find((job) => job.id === latest.id)?.voices[0]?.partialOutput).toContain("[older activity truncated]");
  });

  it("flushes debounced mutations and reports redacted persistence failures", async () => {
    resetChorusJobsForTest();
    const dir = await mkdtemp(join(tmpdir(), "chorus-jobs-flush-"));
    const store = new ChorusJobStore({ baseDir: dir });
    const errors: string[] = [];
    store.onPersistenceError((message) => errors.push(message));
    const job = store.create({
      kind: "ask",
      title: "Question",
      presetName: "default",
      prompt: "flush",
      command: "/chorus ask flush",
      voices: preset.voices,
    });
    store.updateProgress(job.id, [{ voiceIndex: 0, voice: preset.voices[0]!, status: "running" }]);
    await store.flush();
    expect(JSON.parse(await readFile(join(dir, "jobs.json"), "utf8"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: job.id })]),
    );
    expect(errors).toEqual([]);
  });

  it("recovers from a truncated jobs snapshot", async () => {
    resetChorusJobsForTest();
    const dir = await mkdtemp(join(tmpdir(), "chorus-jobs-truncated-"));
    await writeFile(join(dir, "jobs.json"), "[{\"id\":");
    const store = new ChorusJobStore({ baseDir: dir });
    await expect(store.initialize({ baseDir: dir })).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("flushes a canceled terminal job before the command returns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chorus-job-cancel-flush-"));
    const store = new ChorusJobStore({ baseDir: dir });
    const job = store.create({ kind: "agent", title: "Agent", presetName: "default", prompt: "long", command: "/chorus agent long", voices: preset.voices });
    await handleCancel({ chorusJobStore: store, storePaths: { baseDir: dir }, ui: { notify: vi.fn() } }, job.id);
    const persisted = JSON.parse(await readFile(join(dir, "jobs.json"), "utf8")) as Array<{ id: string; status: string }>;
    expect(persisted.find((item) => item.id === job.id)?.status).toBe("aborted");
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
