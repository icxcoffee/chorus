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

describe("commands/ask", () => {
  it("reports missing ask prompt as usage instead of throwing", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const notices: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-ask-"));
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });
    await commands.get("chorus-ask")?.handler("", {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: { notify: (content) => notices.push(content) }
    });
    expect(notices[0]).toContain("/chorus ask <question>");
  });

  it("runs ask UI with prompt prefill and optimized prompt handoff", async () => {
    const statuses: string[] = [];
    const result = await runAskUi({
      prompt: "original",
      optimizedPrompt: "optimized",
      config,
      registry,
      signal: new AbortController().signal,
      runChorusImpl: async (args) => {
        expect(args.prompt).toBe("original");
        expect(args.optimizedPrompt).toBe("optimized");
        args.onProgress?.([
          {
            voiceIndex: 1,
            voice: preset.voices[1]!,
            status: "success"
          }
        ]);
        return {
          runId: "r",
          presetName: "default",
          prompt: args.prompt,
          voices: [voiceResult(0), voiceResult(1)],
          synthesis: "final",
          totalDurationMs: 1,
          totalCostUsd: 0,
          successfulVoices: 2,
          totalVoices: 2,
          startedAt: 1,
          finishedAt: 2,
          ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {})
        };
      },
      onStatus: (message) => statuses.push(message)
    });
    expect(statuses).toEqual(["voice[1] minimax/MiniMax-M3 success"]);
    expect(result.text).toContain("final");
  });

  it("rejects invalid preset in ask UI", async () => {
    await expect(
      runAskUi({
        prompt: "p",
        presetName: "missing",
        config,
        registry,
        signal: new AbortController().signal,
        runChorusImpl: vi.fn()
      })
    ).rejects.toThrow("unknown chorus preset");
  });
});
