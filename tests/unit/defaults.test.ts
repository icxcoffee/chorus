import { describe, expect, it } from "vitest";
import { computeDefaultPresetResult, computeDefaultPresets } from "../../src/defaults.js";
import { registry } from "./fixtures.js";

describe("default presets", () => {
  it("returns no runnable preset for 0, 1, or 2 distinct models", () => {
    expect(computeDefaultPresetResult([]).presets).toEqual([]);
    expect(computeDefaultPresetResult(registry.slice(0, 1)).healthMessage).toContain("only 1");
    expect(computeDefaultPresetResult(registry.slice(0, 2)).presets).toEqual([]);
  });

  it("creates two voices and a distinct conductor with 3 models", () => {
    const presets = computeDefaultPresets(registry.slice(0, 3));
    expect(presets).toHaveLength(1);
    expect(presets[0]!.voices).toHaveLength(2);
    expect(presets[0]!.voices.some((voice) => voice.model.provider === presets[0]!.conductor.provider && voice.model.modelId === presets[0]!.conductor.modelId)).toBe(false);
  });

  it("uses up to four voices with enough models", () => {
    const presets = computeDefaultPresets(registry);
    expect(presets[0]!.voices).toHaveLength(4);
  });
});
