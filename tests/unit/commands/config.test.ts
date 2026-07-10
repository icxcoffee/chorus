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

describe("commands/config", () => {
  it("shows config details and model-setting usage", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const shown: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-"));
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });
    await commands.get("chorus-config")?.handler("", {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: { show: (content) => shown.push(content) }
    });
    expect(shown[0]).toContain("chorus config active preset: default");
    expect(shown[0]).toContain("/chorus config models");
    expect(shown[0]).toContain("/chorus config history");
    expect(shown[0]).toContain("/chorus config timeout");
    expect(shown[0]).toContain("session history isolated");
    expect(shown[0]).toContain("timeout 30m");
    expect(shown[0]).toContain("deepseek/deepseek-v4-pro");
  });

  it("updates active preset mode and timeout from config commands", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const shown: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-runtime-"));
    const ctx: PiLikeContext = {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: { show: (content) => shown.push(content) }
    };
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });

    await commands.get("chorus-config")?.handler("mode subagent", ctx);
    await commands.get("chorus-config")?.handler("timeout 2h", ctx);
    await commands.get("chorus-config")?.handler("show", ctx);

    expect(shown.at(-1)).toContain("preset default (subagent)");
    expect(shown.at(-1)).toContain("timeout 2h");
  });

  it("updates child-agent session history from config commands", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const shown: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-history-"));
    const ctx: PiLikeContext = {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: { show: (content) => shown.push(content) }
    };
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });

    await commands.get("chorus-config")?.handler("history on", ctx);
    expect(shown.at(-1)).toContain("chorus config history: include");
    expect(shown.at(-1)).toContain("session history include");

    await commands.get("chorus-config")?.handler("history off", ctx);
    expect(shown.at(-1)).toContain("chorus config history: isolated");
    expect(shown.at(-1)).toContain("session history isolated");
  });

  it("parses model config arguments with quotes and validates conductor flags", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const shown: string[] = [];
    const notices: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-models-"));
    const ctx: PiLikeContext = {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: {
        show: (content) => shown.push(content),
        notify: (content) => notices.push(content)
      }
    };
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });

    await commands.get("chorus-config")?.handler("models \"deepseek/deepseek-v4-pro\" minimax/MiniMax-M3 --conductor deepseek/deepseek-v4-flash", ctx);
    expect(shown.at(-1)).toContain("chorus config saved");
    expect(shown.at(-1)).toContain("conductor deepseek/deepseek-v4-flash");

    await commands.get("chorus-config")?.handler("models deepseek/deepseek-v4-pro minimax/MiniMax-M3 deepseek/deepseek-v4-flash", ctx);
    expect(shown.at(-1)).toContain("chorus config saved");

    await commands.get("chorus-config")?.handler("models deepseek/deepseek-v4-pro minimax/MiniMax-M3 --conductor deepseek/deepseek-v4-flash --conductor other/o1", ctx);
    expect(notices.at(-1)).toBe("Use --conductor only once");
  });

  it("opens config menu before model selection in interactive config", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const rendered: string[][] = [];
    const shown: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-menu-"));
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });

    await commands.get("chorus-config")?.handler("", {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: {
        show: (content) => shown.push(content),
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            rendered.push(view.render(100));
            view.handleInput({ name: "enter" });
          })
      }
    });

    expect(rendered[0]?.join("\n")).toContain("Chorus Config");
    expect(rendered[0]?.join("\n")).toContain("Models - choose voices and conductor");
    expect(rendered[0]?.join("\n")).toContain("History: include - child agents can see this chat");
    expect(rendered[0]?.join("\n")).not.toContain("Chorus voices");
    expect(shown[0]).toContain("chorus config active preset");
  });

  it("opens legacy config with conductor/voice collision so it can be repaired", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const shown: string[] = [];
    const rendered: string[][] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-repair-"));
    const legacyConfig = {
      ...config,
      presets: [{ ...preset, conductor: preset.voices[0]!.model }]
    };
    await writeFile(join(baseDir, "config.json"), `${JSON.stringify(legacyConfig, null, 2)}\n`);
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });

    await commands.get("chorus-config")?.handler("show", {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: { show: (content) => shown.push(content) }
    });
    expect(shown[0]).toContain("Config needs repair:");
    expect(shown[0]).toContain("must not also be voice[0]");

    await commands.get("chorus-config")?.handler("", {
      modelRegistry: { models: registry },
      storePaths: { baseDir },
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            rendered.push(view.render(100));
            view.handleInput({ name: "esc" });
          })
      }
    });
    expect(rendered[0]?.join("\n")).toContain("Config needs repair:");
  });

  it("filters config models to auth-configured runtime models", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const shown: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-filter-"));
    const unavailable = {
      provider: "amazon-bedrock",
      modelId: "amazon.nova-lite-v1:0",
      id: "amazon.nova-lite-v1:0",
      name: "Nova Lite"
    };
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });
    await commands.get("chorus-config")?.handler("show", {
      modelRegistry: {
        models: [unavailable, ...registry],
        hasConfiguredAuth: (model) => (model as { provider?: string }).provider !== "amazon-bedrock"
      },
      storePaths: { baseDir },
      ui: { show: (content) => shown.push(content) }
    });
    expect(shown[0]).toContain(`Available models (${registry.length})`);
    expect(shown[0]).not.toContain("amazon-bedrock");
  });

  it("focuses large model catalogs to runnable model metadata", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: PiLikeContext) => Promise<void> }>();
    const shown: string[] = [];
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-config-large-"));
    const catalog = Array.from({ length: 60 }, (_, index) => ({
      provider: "amazon-bedrock",
      modelId: `model-${index}`,
      id: `model-${index}`
    }));
    await activate({
      registerCommand: (name, definition) => {
        commands.set(name, definition as { handler: (args: string, ctx: PiLikeContext) => Promise<void> });
      }
    });
    await commands.get("chorus-config")?.handler("show", {
      modelRegistry: { models: [...catalog, ...registry] },
      storePaths: { baseDir },
      ui: { show: (content) => shown.push(content) }
    });
    expect(shown[0]).toContain("Available models (5)");
    expect(shown[0]).toContain("other/o1");
    expect(shown[0]).not.toContain("amazon-bedrock");
  });
});
