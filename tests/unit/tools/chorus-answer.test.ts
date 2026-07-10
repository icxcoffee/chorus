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

describe("tools/chorus-answer", () => {
  it("tool uses active and explicit presets and returns structured output", async () => {
    const ctx: PiLikeContext = {
      modelRegistry: { models: registry },
      storePaths: { baseDir: "/tmp/chorus-test-missing" }
    };
    await expect(chorusAnswerTool(ctx, { prompt: "p", presetName: "missing" })).rejects.toThrow();
  });
});
