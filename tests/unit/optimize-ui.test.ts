import { describe, expect, it } from "vitest";
import { optimizePrompt, selectOptimizerModel } from "../../src/optimize.js";
import { inlineOptimizeDecision } from "../../src/ui/ask.js";
import { runOptimizeUi } from "../../src/ui/optimize.js";
import { registry } from "./fixtures.js";

describe("optimizer", () => {
  it("selects the first available candidate", () => {
    expect(selectOptimizerModel(registry)).toEqual({ provider: "minimax", modelId: "MiniMax-M3" });
  });

  it("prefers the active conductor when provided", () => {
    expect(selectOptimizerModel(registry, { provider: "deepseek", modelId: "deepseek-v4-flash" })).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash"
    });
  });

  it("leaves prompt unchanged when no candidate exists", async () => {
    const result = await optimizePrompt({ prompt: "rough", registry: [], signal: new AbortController().signal });
    expect(result.optimized).toBe("rough");
    expect(result.errorMessage).toContain("no optimizer");
  });

  it("returns only optimized text from command flow", async () => {
    const result = await optimizePrompt({
      prompt: "rough",
      registry,
      signal: new AbortController().signal,
      callModel: async () => ({ output: "clean" })
    });
    expect(result).toMatchObject({ original: "rough", optimized: "clean" });
  });

  it("rejects optimizer output that introduces a filesystem path", async () => {
    const result = await optimizePrompt({
      prompt: "分析当前项目架构",
      registry,
      signal: new AbortController().signal,
      callModel: async () => ({ output: "对F:\\Dev\\Hannwu\\Source\\desktop-workflows\\event-gateway 项目进行架构分析" })
    });
    expect(result.optimized).toBe("分析当前项目架构");
    expect(result.errorMessage).toContain("optimizer introduced path");
  });

  it("allows optimizer output to keep a path that was already present", async () => {
    const prompt = "分析 /Users/icx/project 当前项目架构";
    const result = await optimizePrompt({
      prompt,
      registry,
      signal: new AbortController().signal,
      callModel: async () => ({ output: "请分析 /Users/icx/project 当前项目架构并输出问题" })
    });
    expect(result.optimized).toContain("/Users/icx/project");
    expect(result.errorMessage).toBeUndefined();
  });

  it("emits no-candidate errors in UI", async () => {
    const messages: string[] = [];
    await runOptimizeUi({
      prompt: "rough",
      registry: [],
      signal: new AbortController().signal,
      emit: (message) => messages.push(message)
    });
    expect(messages[0]).toContain("no optimizer");
  });

  it("supports inline accept and reject handoff", () => {
    expect(inlineOptimizeDecision({ original: "a", optimized: "b", accepted: true })).toEqual({
      prompt: "a",
      optimizedPrompt: "b"
    });
    expect(inlineOptimizeDecision({ original: "a", optimized: "b", accepted: false })).toEqual({ prompt: "a" });
  });
});
