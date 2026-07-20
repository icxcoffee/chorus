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

  it("extracts validated structured quality without changing the Markdown answer", async () => {
    const result = await synthesize({
      conductor: preset.conductor, prompt: "p", voices: [voiceResult(0), voiceResult(1)], totalVoices: 2, registry,
      signal: new AbortController().signal,
      callModel: async () => ({ output: 'Markdown answer\n<chorus-structured>{"version":1,"answer":"normalized","claims":[{"text":"c","evidenceIds":["voice-0"]}],"disagreements":[],"confidence":0.9,"unresolvedQuestions":[]}</chorus-structured>', costUsd: 0 }),
    });
    expect(result.synthesis).toBe("Markdown answer");
    expect(result.structured?.answer).toBe("normalized");
    expect(result.qualityMetrics?.coverage).toBe(1);
  });
  it("requests and parses native structured output when the adapter supports it", async () => {
    const result = await synthesize({ conductor: preset.conductor, prompt: "p", voices: [voiceResult(0), voiceResult(1)], totalVoices: 2, registry, signal: new AbortController().signal, callModel: async (args) => { expect(args.structuredOutput).toBe(true); return { output: JSON.stringify({ markdown: "native markdown", structured: { version: 1, answer: "a", claims: [], disagreements: [], confidence: null, unresolvedQuestions: [] } }), costUsd: 0 }; } });
    expect(result.synthesis).toBe("native markdown");
    expect(result.structured?.version).toBe(1);
  });
});
