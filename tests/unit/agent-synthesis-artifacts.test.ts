import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildMainAgentPrompt, synthesizeWithMainAgent } from "../../src/agent-synthesis.js";
import { RESULTS_WARNING_DIRS, writeRunArtifacts } from "../../src/artifacts.js";
import { runChorus } from "../../src/chorus.js";
import type { ChorusResult } from "../../src/types.js";
import { preset, registry, voiceResult } from "./fixtures.js";

describe("agent synthesis and artifacts", () => {
  it("builds a verification prompt from child agent outputs", () => {
    const prompt = buildMainAgentPrompt({
      prompt: "audit architecture",
      voices: [
        { ...voiceResult(0), output: "claim A", activityLog: "[tool done] rg src" },
        { ...voiceResult(1), output: "claim B" }
      ],
      totalVoices: 2
    });

    expect(prompt).toContain("Original task:");
    expect(prompt).toContain("claim A");
    expect(prompt).toContain("[tool done] rg src");
    expect(prompt).toContain("Identify concrete claims that are disputed");
    expect(prompt).toContain("Use available repository/process operations");
  });

  it("runs the conductor as a main verification agent", async () => {
    const result = await synthesizeWithMainAgent({
      conductor: preset.conductor,
      prompt: "audit",
      voices: [voiceResult(0), voiceResult(1)],
      totalVoices: 2,
      registry,
      signal: new AbortController().signal,
      timeoutMs: 1234,
      cwd: "/repo",
      runSubagentVoiceImpl: async (args) => {
        expect(args.voice.model).toEqual(preset.conductor);
        expect(args.systemPrompt).toContain("main verification agent");
        expect(args.prompt).toContain("Child agent outputs");
        expect(args.timeoutMs).toBe(1234);
        expect(args.includeSessionHistory).toBeUndefined();
        expect(args.cwd).toBe("/repo");
        return {
          voice: args.voice,
          status: "success",
          output: "verified final",
          activityLog: "[tool done] npm test",
          durationMs: 10,
          costUsd: 0.004,
          startedAt: 1
        };
      }
    });

    expect(result.synthesis).toBe("verified final");
    expect(result.activityLog).toContain("npm test");
    expect(result.costUsd).toBe(0.004);
  });

  it("writes child agent outputs and final report to an artifact directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chorus-artifacts-"));
    const history: ChorusResult[] = [];
    const result = await runChorus({
      runConfig: { presetName: "default", voices: preset.voices, conductor: preset.conductor, mode: "subagent", strategy: "A" },
      prompt: "audit",
      registry,
      signal: new AbortController().signal,
      runVoiceSubagent: async (args) => ({
        ...voiceResult(args.voiceIndex ?? 0),
        voice: args.voice,
        activityLog: `[agent ${args.voiceIndex}] read files`
      }),
      synthesisMode: "agent",
      synthesizeAgentFn: async () => ({
        synthesis: "verified report",
        activityLog: "[main] verified with rg",
        costUsd: 0.004
      }),
      artifactDir: dir,
      appendHistory: async (entry) => {
        history.push(entry);
      }
    });

    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(["request.md", "agent-0.md", "agent-1.md", "main-agent-activity.md", "final-report.md", "result.json"]));
    expect(await readFile(join(dir, "final-report.md"), "utf8")).toContain("verified report");
    expect(await readFile(join(dir, "agent-0.md"), "utf8")).toContain("read files");
    expect(result.outputDir).toBe(dir);
    expect(result.artifacts?.some((artifact) => artifact.label === "final-report")).toBe(true);
    expect(result.voices[0]?.outputPath).toContain("agent-0.md");
    expect(history).toHaveLength(1);
    expect(history[0]?.outputDir).toBe(dir);
  });

  it("uses a main-agent input file when an artifact directory is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chorus-main-agent-input-"));
    const result = await synthesizeWithMainAgent({
      conductor: preset.conductor,
      prompt: "audit",
      voices: [voiceResult(0), voiceResult(1)],
      totalVoices: 2,
      registry,
      signal: new AbortController().signal,
      artifactDir: dir,
      runSubagentVoiceImpl: async (args) => {
        expect(args.prompt).toContain("main-agent-input.md");
        expect(args.prompt).not.toContain("answer 0");
        return {
          voice: args.voice,
          status: "success",
          output: "verified final",
          durationMs: 10,
          costUsd: 0,
          startedAt: 1
        };
      }
    });

    expect(result.synthesis).toBe("verified final");
    expect(await readFile(join(dir, "main-agent-input.md"), "utf8")).toContain("answer 0");
  });

  it("writes voice-labeled artifacts when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chorus-voice-artifacts-"));
    const result = await writeRunArtifacts({
      result: {
        runId: "run-1",
        presetName: "default",
        prompt: "ask",
        voices: [voiceResult(0)],
        synthesis: "answer",
        totalDurationMs: 10,
        successfulVoices: 1,
        totalVoices: 1,
        startedAt: 1,
        finishedAt: 11,
        totalCostUsd: 0
      },
      outputDir: dir,
      actorLabel: "voice"
    });

    const files = await readdir(dir);
    expect(files).toContain("voice-0.md");
    expect(files).not.toContain("agent-0.md");
    expect(result.voices[0]?.outputPath).toContain("voice-0.md");
  });

  it("warns when result folders grow past the retention threshold", async () => {
    const base = await mkdtemp(join(tmpdir(), "chorus-many-results-"));
    const parent = join(base, "results");
    await mkdir(parent);
    for (let index = 0; index <= RESULTS_WARNING_DIRS; index += 1) {
      await mkdir(join(parent, `old-${index}`));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeRunArtifacts({
        result: {
          runId: "run-1",
          presetName: "default",
          prompt: "ask",
          voices: [voiceResult(0)],
          synthesis: "answer",
          totalDurationMs: 10,
          successfulVoices: 1,
          totalVoices: 1,
          startedAt: 1,
          finishedAt: 11,
          totalCostUsd: 0
        },
        outputDir: join(parent, "new-run"),
        actorLabel: "voice"
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("chorus results directory has"));
    } finally {
      warn.mockRestore();
    }
  });
});
