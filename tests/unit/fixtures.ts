import type { ChorusConfigFile, ChorusPreset, ModelInfo, VoiceResult } from "../../src/types.js";

export const registry: ModelInfo[] = [
  {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKind: "openai-chat",
    endpoint: "https://example.test/openai",
    costPerMTokens: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }
  },
  {
    provider: "minimax",
    modelId: "MiniMax-M3",
    apiKind: "generic-json",
    endpoint: "https://example.test/generic",
    costPerMTokens: { input: 3, output: 4 }
  },
  {
    provider: "custom-ark-cn-beijing-volces-com",
    modelId: "glm-5.2",
    apiKind: "anthropic-messages",
    endpoint: "https://example.test/anthropic",
    costPerMTokens: null
  },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    apiKind: "openai-chat",
    endpoint: "https://example.test/flash",
    costPerMTokens: { input: 0.1, output: 0.2 }
  },
  {
    provider: "other",
    modelId: "o1",
    apiKind: "generic-json",
    endpoint: "https://example.test/other",
    costPerMTokens: { input: 5, output: 6 }
  }
];

export const preset: ChorusPreset = {
  name: "default",
  voices: [
    { model: { provider: "deepseek", modelId: "deepseek-v4-pro" }, role: "reasoning" },
    { model: { provider: "minimax", modelId: "MiniMax-M3" }, role: "balanced" }
  ],
  conductor: { provider: "deepseek", modelId: "deepseek-v4-flash" },
  mode: "direct",
  strategy: "A",
  optimizeBeforeAsk: false
};

export const config: ChorusConfigFile = {
  configVersion: 1,
  activePresetName: "default",
  presets: [preset]
};

export function voiceResult(index: number, status: VoiceResult["status"] = "success"): VoiceResult {
  const voice = preset.voices[index % preset.voices.length] ?? preset.voices[0]!;
  return {
    voice,
    status,
    durationMs: 1000 + index,
    costUsd: status === "success" ? 0.001 * (index + 1) : null,
    startedAt: 1,
    ...(status === "success"
      ? { output: `answer ${index}`, usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } }
      : {})
  };
}
