import type { ChorusPreset, ChorusVoice, ModelInfo, ModelRef } from "./types.js";
import { familyWarnings, parseModelRef, sameModelRef } from "./utils/models.js";

const REASONING = [
  "deepseek/deepseek-v4-pro",
  "minimax/MiniMax-M3",
  "custom-ark-cn-beijing-volces-com/deepseek-v4-pro"
];
const BALANCED = ["minimax/MiniMax-M3", "minimax-cn/MiniMax-M3", "deepseek/deepseek-v4-pro"];
const HETERODOX = ["custom-ark-cn-beijing-volces-com/glm-5.2"];
const FAST = ["deepseek/deepseek-v4-flash", "minimax/MiniMax-M2.7-highspeed"];
const STRONGEST = [...REASONING, ...BALANCED, ...HETERODOX, ...FAST];

export interface DefaultPresetResult {
  presets: ChorusPreset[];
  healthMessage?: string;
  familyWarnings: string[];
}

export function computeDefaultPresets(registry: ModelInfo[]): ChorusPreset[] {
  return computeDefaultPresetResult(registry).presets;
}

export function computeDefaultPresetResult(registry: ModelInfo[]): DefaultPresetResult {
  const distinct = distinctRefs(registry);
  if (distinct.length < 3) {
    return {
      presets: [],
      healthMessage: `chorus: only ${distinct.length} distinct models available - install at least 3 or edit model registry to enable a runnable default preset`,
      familyWarnings: []
    };
  }

  const planned: ChorusVoice[] = [];
  addRole(planned, registry, REASONING, "reasoning");
  addRole(planned, registry, BALANCED, "balanced");
  addRole(planned, registry, HETERODOX, "heterodox");
  addRole(planned, registry, FAST, "fast");

  for (const ref of strongestAvailable(registry)) {
    if (planned.length >= Math.min(4, distinct.length - 1)) break;
    if (!planned.some((voice) => sameModelRef(voice.model, ref))) planned.push({ model: ref, role: "balanced" });
  }

  const voices = planned.slice(0, Math.min(8, distinct.length - 1));
  if (voices.length < 2) {
    for (const ref of distinct) {
      if (voices.length >= 2) break;
      if (!voices.some((voice) => sameModelRef(voice.model, ref))) voices.push({ model: ref, role: "balanced" });
    }
  }
  const conductor = strongestAvailableNotIn(
    voices.map((voice) => voice.model),
    registry
  );
  if (!conductor || voices.length < 2) {
    return {
      presets: [],
      healthMessage: `chorus: only ${distinct.length} distinct models available - install at least 3 or edit model registry to enable a runnable default preset`,
      familyWarnings: []
    };
  }
  const preset: ChorusPreset = {
    name: "default",
    voices,
    conductor,
    mode: "direct",
    strategy: "parallel"
  };
  return { presets: [preset], familyWarnings: familyWarnings(voices) };
}

export function strongestAvailableNotIn(exclude: ModelRef[], registry: ModelInfo[]): ModelRef | null {
  for (const ref of strongestAvailable(registry)) {
    if (!exclude.some((other) => sameModelRef(other, ref))) return ref;
  }
  return null;
}

function addRole(planned: ChorusVoice[], registry: ModelInfo[], candidates: string[], role: ChorusVoice["role"]): void {
  const ref = pickFirstAvailable(registry, candidates);
  if (ref && !planned.some((voice) => sameModelRef(voice.model, ref))) {
    planned.push(role ? { model: ref, role } : { model: ref });
  }
}

function pickFirstAvailable(registry: ModelInfo[], candidates: string[]): ModelRef | null {
  for (const candidate of candidates) {
    const ref = parseModelRef(candidate);
    if (registry.some((model) => sameModelRef(model, ref))) return ref;
  }
  return null;
}

function strongestAvailable(registry: ModelInfo[]): ModelRef[] {
  const ordered: ModelRef[] = [];
  for (const candidate of STRONGEST) {
    const ref = parseModelRef(candidate);
    if (registry.some((model) => sameModelRef(model, ref)) && !ordered.some((other) => sameModelRef(other, ref))) {
      ordered.push(ref);
    }
  }
  for (const ref of distinctRefs(registry)) {
    if (!ordered.some((other) => sameModelRef(other, ref))) ordered.push(ref);
  }
  return ordered;
}

function distinctRefs(registry: ModelInfo[]): ModelRef[] {
  const refs: ModelRef[] = [];
  for (const model of registry) {
    const ref = { provider: model.provider, modelId: model.modelId };
    if (!refs.some((other) => sameModelRef(other, ref))) refs.push(ref);
  }
  return refs;
}
