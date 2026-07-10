import { describe, expect, it } from "vitest";
import {
  familyWarnings,
  getProviderAdapter,
  modelFamily,
  modelRefToPiArg,
  resolveModel,
  validateConfigFile,
  validatePreset,
  ValidationError
} from "../../src/utils/models.js";
import { config, preset, registry } from "./fixtures.js";

describe("model utilities", () => {
  it("serializes model refs for pi", () => {
    expect(modelRefToPiArg({ provider: "minimax", modelId: "MiniMax-M3" })).toBe("minimax/MiniMax-M3");
  });

  it("normalizes provider aliases into model families", () => {
    expect(modelFamily({ provider: "minimax-cn", modelId: "MiniMax-M3" })).toBe("minimax/minimax-m3");
    expect(modelFamily({ provider: "minimax", modelId: "MiniMax-M3" })).toBe("minimax/minimax-m3");
  });

  it("resolves models from registry and rejects missing refs", () => {
    expect(resolveModel({ provider: "deepseek", modelId: "deepseek-v4-pro" }, registry).apiKind).toBe("openai-chat");
    expect(() => resolveModel({ provider: "missing", modelId: "x" }, registry)).toThrow("not in your model registry");
  });

  it("validates presets and config invariants", () => {
    expect(() => validatePreset(preset, registry)).not.toThrow();
    expect(() => validateConfigFile(config, registry)).not.toThrow();
    expect(() => validatePreset({ ...preset, name: "Bad Name" }, registry)).toThrow(ValidationError);
    expect(() => validatePreset({ ...preset, conductor: preset.voices[0]!.model }, registry)).toThrow("must not also be voice[0]");
    expect(() => validatePreset({ ...preset, voiceTimeoutMs: 21_600_000 }, registry)).not.toThrow();
    expect(() => validatePreset({ ...preset, conductorTimeoutMs: 21_600_000 }, registry)).not.toThrow();
    expect(() => validatePreset({ ...preset, voiceTimeoutMs: 999 }, registry)).toThrow("voiceTimeoutMs");
    expect(() => validatePreset({ ...preset, conductorTimeoutMs: 999 }, registry)).toThrow("conductorTimeoutMs");
    expect(() =>
      validateConfigFile({ ...config, activePresetName: "missing" }, registry)
    ).toThrow("does not match any preset");
    expect(() =>
      validateConfigFile({ ...config, presets: [preset, { ...preset }] }, registry)
    ).toThrow("duplicate preset");
  });

  it("computes soft family warnings", () => {
    expect(
      familyWarnings([
        { model: { provider: "minimax", modelId: "MiniMax-M3" } },
        { model: { provider: "minimax-cn", modelId: "MiniMax-M3" } }
      ])
    ).toEqual(["", "same base as #1"]);
  });

  it("adapters parse success and error payloads", () => {
    const openai = getProviderAdapter("openai-chat");
    expect(openai.parseResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1 } })).toEqual({
      output: "ok",
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }
    });
    expect(openai.parseError({ error: { message: "rate-limited" } }, 429)).toContain("rate-limited");

    const anthropic = getProviderAdapter("anthropic-messages");
    expect(
      anthropic.parseResponse({
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 2, output_tokens: 3 }
      })
    ).toEqual({ output: "hello", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } });
  });
});
