import type { ChorusVoice, ModelRef } from "../types.js";
import { ValidationError } from "./errors.js";

export function modelRefToPiArg(ref: ModelRef): string {
  assertModelRef(ref);
  return `${ref.provider}/${ref.modelId}`;
}

export function parseModelRef(value: string | ModelRef): ModelRef {
  if (typeof value !== "string") {
    assertModelRef(value);
    return { provider: value.provider, modelId: value.modelId };
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new ValidationError(`invalid model ref "${value}", expected provider/modelId`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

export function assertModelRef(ref: ModelRef): void {
  if (!ref || typeof ref.provider !== "string" || typeof ref.modelId !== "string") {
    throw new ValidationError("model ref must include provider and modelId");
  }
  if (ref.provider.trim() === "" || ref.modelId.trim() === "") {
    throw new ValidationError("model ref provider and modelId must be non-empty");
  }
  if (ref.provider.includes("/") || ref.modelId.includes("/")) {
    throw new ValidationError("model ref provider and modelId must not contain slash");
  }
}

export function modelFamily(ref: ModelRef): string {
  assertModelRef(ref);
  const provider = normalizeProviderFamily(ref.provider);
  const model = ref.modelId
    .trim()
    .replace(/^(models\/)/i, "")
    .replace(/[-_](latest|preview|thinking)$/i, "")
    .toLowerCase();
  return `${provider}/${model}`;
}

export function familyWarnings(voices: ChorusVoice[]): string[] {
  return voices.map((voice, index) => {
    const first = voices.findIndex((other) => modelFamily(other.model) === modelFamily(voice.model));
    return first >= 0 && first !== index ? `same base as #${first + 1}` : "";
  });
}

function normalizeProviderFamily(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower === "minimax-cn") return "minimax";
  if (lower.startsWith("custom-ark-cn-")) return "custom-ark";
  return lower.replace(/-(cn|us|eu|jp|sg)$/i, "");
}
