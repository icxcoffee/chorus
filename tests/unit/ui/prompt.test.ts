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

describe("ui/prompt", () => {
  it("allows domain composers to submit an optional blank focus", async () => {
    let rendered = "";
    const result = await composePrompt({
      ui: {
        custom: async (factory) => await new Promise((resolve) => {
          const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
          rendered = view.render(80).join("\n");
          view.handleInput({ name: "enter" });
        })
      },
      title: "Chorus Review",
      placeholder: "Optional focus (blank = workflow default)",
      registry,
      signal: new AbortController().signal,
      allowEmpty: true
    });
    expect(result).toEqual({ original: "", prompt: "" });
    expect(rendered).toContain("Optional focus (blank = workflow default)");
  });

  it("handles normalized prompt composer action keys", async () => {
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            view.handleInput("r");
            view.handleInput("u");
            view.handleInput("n");
            view.handleInput({ name: "right" });
            view.handleInput({ name: "left" });
            view.handleInput({ name: "tab" });
            view.handleInput({ name: "tab" });
            view.handleInput({ name: "enter" });
          })
      },
      title: "Chorus Agent Task",
      placeholder: "Agent task",
      registry,
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
  });

  it("keeps prompt composer rendered lines within terminal width for Chinese input", async () => {
    let rendered: string[] = [];
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory(
              { requestRender: vi.fn() },
              {
                fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
                bold: (text) => `\x1b[1m${text}\x1b[0m`
              },
              {},
              resolve
            );
            view.handleInput("当前项目的软件架构需要优化的部分包括命令入口职责过重、后台任务状态缺少持久化、TUI 渲染需要统一宽度处理。".repeat(4));
            rendered = view.render(80);
            view.handleInput({ name: "esc" });
          })
      },
      title: "Chorus Agent Task",
      placeholder: "Agent task",
      registry,
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("accepts pasted multi-line text in prompt composer", async () => {
    const pasted = "分析当前项目\n- 阅读关键文件\n- 输出优化建议";
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            view.handleInput(`\x1b[200~${pasted}\x1b[201~`);
            view.handleInput({ name: "enter" });
          })
      },
      title: "Chorus Agent Task",
      placeholder: "Agent task",
      registry,
      signal: new AbortController().signal
    });
    expect(result?.prompt).toBe(pasted);
  });

  it("scrolls pasted prompt content in composer", async () => {
    const lines = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
    let renderedBottom: string[] = [];
    let renderedAfterUp: string[] = [];
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            view.handleInput(`\x1b[200~${lines.join("\n")}\x1b[201~`);
            renderedBottom = view.render(80);
            view.handleInput({ name: "up" });
            renderedAfterUp = view.render(80);
            view.handleInput({ name: "esc" });
          })
      },
      title: "Chorus Agent Task",
      placeholder: "Agent task",
      registry,
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(renderedBottom.join("\n")).toContain("line 14");
    expect(renderedBottom.join("\n")).toContain("5-14 of 14");
    expect(renderedAfterUp.join("\n")).toContain("line 4");
    expect(renderedAfterUp.join("\n")).toContain("4-13 of 14");
  });

  it("accepts paste event objects in prompt composer", async () => {
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            view.handleInput({ name: "paste", text: "当前项目 架构分析" });
            view.handleInput({ name: "enter" });
          })
      },
      title: "Chorus Agent Task",
      placeholder: "Agent task",
      registry,
      signal: new AbortController().signal
    });
    expect(result?.prompt).toBe("当前项目 架构分析");
  });

  it("opens quick config from the prompt composer and keeps the draft", async () => {
    let calls = 0;
    let configured = 0;
    let firstRender: string[] = [];
    let secondRender: string[] = [];
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            calls += 1;
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            if (calls === 1) {
              view.handleInput("draft");
              firstRender = view.render(80);
              view.handleInput({ name: "right" });
              view.handleInput({ name: "enter" });
            } else {
              secondRender = view.render(80);
              view.handleInput({ name: "enter" });
            }
          })
      },
      title: "Chorus Question",
      placeholder: "Question",
      registry,
      signal: new AbortController().signal,
      onConfigure: async () => {
        configured += 1;
      }
    });
    expect(configured).toBe(1);
    expect(firstRender.join("\n")).toContain("Config");
    expect(secondRender.join("\n")).toContain("draft");
    expect(result?.prompt).toBe("draft");
  });

  it("renders dynamic context and a domain-specific settings label", async () => {
    let calls = 0;
    let profile = "quick";
    const renders: string[][] = [];
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            calls += 1;
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            if (calls === 1) view.handleInput("review auth");
            renders.push(view.render(100));
            if (calls === 1) {
              view.handleInput({ name: "right" });
              view.handleInput({ name: "enter" });
            } else view.handleInput({ name: "enter" });
          })
      },
      title: "Chorus Review",
      placeholder: "Review objective",
      registry,
      signal: new AbortController().signal,
      configureLabel: "Settings",
      context: () => [`Profile: ${profile}`],
      onConfigure: async () => { profile = "deep"; }
    });
    expect(renders[0]?.join("\n")).toContain("Profile: quick");
    expect(renders[0]?.join("\n")).toContain("Settings");
    expect(renders[1]?.join("\n")).toContain("Profile: deep");
    expect(result?.prompt).toBe("review auth");
  });

  it("shows and clears a transient working message while optimizing from composer", async () => {
    let calls = 0;
    const workingMessages: Array<string | undefined> = [];
    const workingVisible: boolean[] = [];
    const result = await composePrompt({
      ui: {
        setWorkingMessage: (message) => workingMessages.push(message),
        setWorkingVisible: (visible) => workingVisible.push(visible),
        custom: async (factory) =>
          await new Promise((resolve) => {
            calls += 1;
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            if (calls === 1) {
              view.handleInput("rough");
              view.handleInput({ name: "right" });
              view.handleInput({ name: "enter" });
            } else {
              view.handleInput({ name: "esc" });
            }
          })
      },
      title: "Chorus Question",
      placeholder: "Question",
      registry: [],
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(workingMessages).toEqual(["Optimizing prompt...", undefined]);
    expect(workingVisible).toEqual([true, false]);
  });

  it("reports prompt optimization results through a callback from composer", async () => {
    const optimizations: Array<{ original: string; optimized: string; errorMessage?: string }> = [];
    let calls = 0;
    await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            calls += 1;
            const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
            if (calls === 1) {
              view.handleInput("rough");
              view.handleInput({ name: "right" });
              view.handleInput({ name: "enter" });
            } else {
              view.handleInput({ name: "esc" });
            }
          })
      },
      title: "Chorus Question",
      placeholder: "Question",
      registry: [],
      signal: new AbortController().signal,
      onOptimized: (result) => optimizations.push(result)
    });
    expect(optimizations[0]).toMatchObject({
      original: "rough",
      optimized: "rough",
      errorMessage: expect.stringContaining("no optimizer")
    });
  });

  it("uses runtime keybindings for prompt composer cancel", async () => {
    const keybindings = {
      matches: vi.fn((data: unknown, action: string) => data === "runtime-esc" && action === "tui.select.cancel")
    };
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, keybindings, resolve);
            view.handleInput("runtime-esc");
          })
      },
      title: "Chorus Question",
      placeholder: "Question",
      registry,
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(keybindings.matches).toHaveBeenCalledWith("runtime-esc", "tui.select.cancel");
  });

  it("uses app interrupt keybindings for prompt composer escape", async () => {
    const keybindings = {
      matches: vi.fn((data: unknown, action: string) => data === "runtime-esc" && action === "app.interrupt")
    };
    const result = await composePrompt({
      ui: {
        custom: async (factory) =>
          await new Promise((resolve) => {
            const view = factory({ requestRender: vi.fn() }, {}, keybindings, resolve);
            view.handleInput("runtime-esc");
          })
      },
      title: "Chorus Question",
      placeholder: "Question",
      registry,
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(keybindings.matches).toHaveBeenCalledWith("runtime-esc", "app.interrupt");
  });

  it("treats Pi-TUI escape sequences as prompt composer cancel", async () => {
    for (const keyData of ["\x1b[27u", "\x1b[27;1;27~", Buffer.from("\x1b[27u"), { key: { sequence: "\x1b[27u" } }]) {
      const result = await composePrompt({
        ui: {
          custom: async (factory) =>
            await new Promise((resolve) => {
              const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
              view.handleInput(keyData);
            })
        },
        title: "Chorus Question",
        placeholder: "Question",
        registry,
        signal: new AbortController().signal
      });
      expect(result).toBeNull();
    }
  });
});
