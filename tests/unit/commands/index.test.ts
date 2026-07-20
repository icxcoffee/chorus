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

describe("commands/index", () => {
  it("registers commands and tool", async () => {
    const commands: string[] = [];
    const tools: string[] = [];
    const commandDefinitions: unknown[] = [];
    const toolDefinitions: unknown[] = [];
    await activate({
      registerCommand: (name, definition) => {
        commands.push(name);
        commandDefinitions.push(definition);
      },
      registerTool: (definition) => {
        tools.push(definition.name);
        toolDefinitions.push(definition);
      }
    });
    expect(commands).toEqual(["chorus", "chorus-config", "chorus-ask", "chorus-agent", "chorus-review", "chorus-review-eval", "chorus-optimize"]);
    expect(tools).toEqual(["chorus_answer", "chorus_review"]);
    expect(commandDefinitions[0]).toMatchObject({ description: expect.any(String), handler: expect.any(Function) });
    expect(toolDefinitions[0]).toMatchObject({
      parameters: { properties: { prompt: { type: "string" } } },
      execute: expect.any(Function)
    });
    expect(toolDefinitions[1]).toMatchObject({
      parameters: { properties: { objective: { type: "string" } } },
      execute: expect.any(Function)
    });
  });

  it("renders a persistent run-started message", () => {
    const text = renderRunStarted({
      kind: "agent",
      title: "Chorus Agent Task",
      presetName: "default",
      prompt: "fix esc",
      optimizedPrompt: "fix esc robustly"
    });
    expect(text).toContain("# Chorus Agent Task");
    expect(text).toContain("Status: `running`");
    expect(text).toContain("## Request");
    expect(text).toContain("/chorus agent fix esc");
    expect(text).toContain("fix esc robustly");
  });

  it("renders a persistent prompt optimization message with before and after text", () => {
    const text = renderPromptOptimization({
      original: "rough",
      optimized: "clean",
      model: { provider: "deepseek", modelId: "deepseek-v4-flash" }
    }, "Chorus Agent Task");
    expect(text).toContain("# Chorus Prompt Optimization");
    expect(text).toContain("Source: `Chorus Agent Task`");
    expect(text).toContain("Model: `deepseek/deepseek-v4-flash`");
    expect(text).toContain("## Original Prompt\nrough");
    expect(text).toContain("## Optimized Prompt\nclean");
  });
});
