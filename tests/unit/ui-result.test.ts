import { describe, expect, it } from "vitest";
import { renderResult } from "../../src/ui/result.js";
import { voiceResult } from "./fixtures.js";
import type { ChorusResult } from "../../src/types.js";

describe("result rendering", () => {
  it("renders success with conductor usage", () => {
    const rendered = renderResult(base({ synthesis: "final", conductorCostUsd: 0.001 }));
    expect(rendered.collapsed).toContain("Chorus · default · 2 voices");
    expect(rendered.finalAnswer).toBe("final");
  });

  it("renders partial failure and unknown cost as question mark", () => {
    const rendered = renderResult(
      base({
        voices: [voiceResult(0), { ...voiceResult(1, "error"), errorMessage: "rate-limited" }],
        totalCostUsd: null,
        successfulVoices: 1,
        synthesis: null,
        fallbackNote: "1/2 voices responded; skipping synthesis"
      })
    );
    expect(rendered.collapsed).toContain("?");
    expect(rendered.expanded).toContain("rate-limited");
    expect(rendered.finalAnswer).toBe("answer 0");
  });

  it("handles zero success without throwing", () => {
    const rendered = renderResult(
      base({
        voices: [
          { ...voiceResult(0, "error"), errorMessage: "a" },
          { ...voiceResult(1, "error"), errorMessage: "b" }
        ],
        synthesis: null,
        successfulVoices: 0,
        fallbackNote: "all 2 voices failed; no synthesis"
      })
    );
    expect(rendered.finalAnswer).toContain("all 2 voices failed");
  });
});

function base(overrides: Partial<ChorusResult>): ChorusResult {
  return {
    runId: "r",
    presetName: "default",
    prompt: "p",
    voices: [voiceResult(0), voiceResult(1)],
    synthesis: "final",
    totalDurationMs: 1200,
    totalCostUsd: 0.003,
    successfulVoices: 2,
    totalVoices: 2,
    startedAt: 1,
    finishedAt: 2,
    ...overrides
  };
}
