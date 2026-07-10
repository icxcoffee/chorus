import { describe, expect, it } from "vitest";
import { buildSynthesisPrompt, synthesize } from "../../src/synthesize.js";
import { preset, registry, voiceResult } from "./fixtures.js";

describe("synthesis", () => {
  it("builds prompt with original and effective prompts", () => {
    const prompt = buildSynthesisPrompt({
      prompt: "original",
      optimizedPrompt: "optimized",
      voices: [voiceResult(0), voiceResult(1)],
      totalVoices: 2
    });
    expect(prompt).toContain("Original question: original");
    expect(prompt).toContain("Prompt used for voices:\noptimized");
    expect(prompt).toContain("deepseek/deepseek-v4-pro");
  });

  it("calls conductor with fixed system prompt", async () => {
    const result = await synthesize({
      conductor: preset.conductor,
      prompt: "p",
      voices: [voiceResult(0), voiceResult(1)],
      totalVoices: 2,
      registry,
      signal: new AbortController().signal,
      callModel: async (args) => {
        expect(args.systemPrompt).toContain("synthesize multiple independent answers");
        return { output: "final", costUsd: 0.1 };
      }
    });
    expect(result.synthesis).toBe("final");
  });
});
