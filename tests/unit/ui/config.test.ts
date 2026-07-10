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

describe("ui/config", () => {
  it("handles normalized config picker keys", async () => {
    const custom = async <T,>(
      factory: (
        tui: { requestRender?: () => void },
        theme: {},
        keybindings: unknown,
        done: (result: T) => void
      ) => { handleInput(data: unknown): void }
    ): Promise<T> =>
      await new Promise((resolve) => {
        const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
        view.handleInput({ name: "down" });
        view.handleInput({ name: "space" });
        view.handleInput({ name: "enter" });
      });

    const secondModel = registry[1]!;
    const secondModelRef = { provider: secondModel.provider, modelId: secondModel.modelId };
    const picked = await pickVoiceModels({ ui: { custom }, title: "Chorus voices", models: registry, initial: [preset.voices[0]!.model] });
    expect(picked).toEqual([preset.voices[0]!.model, secondModelRef]);

    const conductor = await pickConductorModel({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            view.handleInput({ name: "arrowdown" });
            view.handleInput({ name: "return" });
          })
      },
      title: "Chorus conductor",
      models: registry,
      voices: picked ?? []
    });
    expect(conductor).toEqual({ provider: registry[3]!.provider, modelId: registry[3]!.modelId });
  });

  it("treats ctrl-c key objects as cancel", async () => {
    const result = await pickConductorModel({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            view.handleInput({ ctrl: true, name: "c" });
          })
      },
      title: "Chorus conductor",
      models: registry,
      voices: []
    });
    expect(result).toBeNull();
  });

  it("uses runtime keybindings for config picker cancel", async () => {
    const keybindings = {
      matches: vi.fn((data: unknown, action: string) => data === "runtime-esc" && action === "tui.select.cancel")
    };
    const result = await pickConductorModel({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, keybindings, resolve);
            view.handleInput("runtime-esc");
          })
      },
      title: "Chorus conductor",
      models: registry,
      voices: []
    });
    expect(result).toBeNull();
    expect(keybindings.matches).toHaveBeenCalledWith("runtime-esc", "tui.select.cancel");
  });

  it("uses app interrupt keybindings for config picker escape", async () => {
    const keybindings = {
      matches: vi.fn((data: unknown, action: string) => data === "runtime-esc" && action === "app.interrupt")
    };
    const result = await pickConductorModel({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, keybindings, resolve);
            view.handleInput("runtime-esc");
          })
      },
      title: "Chorus conductor",
      models: registry,
      voices: []
    });
    expect(result).toBeNull();
    expect(keybindings.matches).toHaveBeenCalledWith("runtime-esc", "app.interrupt");
  });

  it("builds config view model with non-voice conductor candidates and health banner", () => {
    expect(conductorOptions(registry, [preset.voices[0]!.model]).some((model) => model.provider === "deepseek" && model.modelId === "deepseek-v4-pro")).toBe(false);
    expect(buildConfigViewModel({ config: null, registry: [] }).healthMessage).toContain("only 0");
    expect(validateConfigFromUi(config, registry)).toEqual([]);
  });
});
