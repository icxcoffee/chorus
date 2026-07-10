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

describe("commands/optimize", () => {
  it("persists prompt optimization command output as a message", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const messages: Array<{ customType: string; content: string; details?: unknown }> = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-optimize-persist-"));
    await writeFile(join(baseDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });

    await commands.get("chorus-optimize")?.handler("rough", {
      modelRegistry: { models: [] },
      storePaths: { baseDir },
      hasUI: true,
      sendMessage: (message) => {
        messages.push(message);
      }
    });

    expect(messages[0]?.customType).toBe("chorus-prompt-optimization");
    expect(messages[0]?.content).toContain("## Original Prompt\nrough");
    expect(messages[0]?.content).toContain("## Optimized Prompt\nrough");
    expect(messages[0]?.details).toMatchObject({ kind: "prompt-optimization", original: "rough", optimized: "rough" });
  });
});
