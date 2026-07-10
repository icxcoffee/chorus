import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activate, chorusAnswerTool, renderPromptOptimization, renderRunStarted, type PiLikeContext } from "../../../src/index.js";
import { buildConfigViewModel, conductorOptions, validateConfigFromUi } from "../../../src/ui/config.js";
import { runAskUi } from "../../../src/ui/ask.js";
import { runAgentUi } from "../../../src/ui/agent.js";
import { composePrompt } from "../../../src/ui/prompt.js";
import { pickConductorModel, pickVoiceModels } from "../../../src/ui/select.js";
import { visibleWidth } from "../../../src/ui/width.js";
import { config, preset, registry, voiceResult } from "../fixtures.js";

describe("commands/agent", () => {
  it("runs agent UI through subagent mode and renders agent output", async () => {
    const statuses: string[] = [];
    const result = await runAgentUi({
      task: "pwd",
      config,
      registry,
      signal: new AbortController().signal,
      runChorusImpl: async (args) => {
          expect(args.prompt).toBe("pwd");
          expect(args.runConfig.mode).toBe("subagent");
          expect(args.synthesisMode).toBe("agent");
          expect(args.runConfig.voices).toEqual(preset.voices);
          args.onProgress?.([
            {
              voiceIndex: 0,
              voice: preset.voices[0]!,
              status: "running"
            },
            {
              kind: "conductor",
              conductor: preset.conductor,
              status: "running"
            }
          ]);
        return {
          runId: "agent-run",
          presetName: "default",
          prompt: args.prompt,
          voices: [voiceResult(0), voiceResult(1)],
          synthesis: "agent final",
          totalDurationMs: 2,
          totalCostUsd: 0,
          successfulVoices: 2,
          totalVoices: 2,
          startedAt: 1,
          finishedAt: 3
        };
      },
      onStatus: (message) => statuses.push(message)
    });
    expect(statuses).toEqual([
      "agent[0] deepseek/deepseek-v4-pro running",
      "conductor deepseek/deepseek-v4-flash running"
    ]);
    expect(result.text).toContain("# Chorus Agent Result");
    expect(result.text).toContain("Agents: `2/2`");
    expect(result.text).toContain("agent[0]");
    expect(result.text).toContain("agent final");
  });

  it("runs agent UI with original task and optimized prompt handoff", async () => {
    const result = await runAgentUi({
      task: "current project",
      optimizedPrompt: "analyze current project architecture",
      config,
      registry,
      signal: new AbortController().signal,
      runChorusImpl: async (args) => {
        expect(args.prompt).toBe("current project");
        expect(args.optimizedPrompt).toBe("analyze current project architecture");
        return {
          runId: "agent-run-optimized",
          presetName: "default",
          prompt: args.prompt,
          voices: [voiceResult(0), voiceResult(1)],
          synthesis: "agent final",
          totalDurationMs: 2,
          totalCostUsd: 0,
          successfulVoices: 2,
          totalVoices: 2,
          startedAt: 1,
          finishedAt: 3,
          ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {})
        };
      }
    });
    expect(result.result.prompt).toBe("current project");
    expect(result.result.optimizedPrompt).toBe("analyze current project architecture");
  });
});
