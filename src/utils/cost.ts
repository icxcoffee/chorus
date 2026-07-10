import type { ResolvedModel, TokenUsage, VoiceResult } from "../types.js";

export function computeUsageCost(usage: TokenUsage | undefined, resolved: ResolvedModel): number | null {
  if (!usage || resolved.costPerMTokens == null) return null;
  const cost =
    (usage.input * resolved.costPerMTokens.input +
      usage.output * resolved.costPerMTokens.output +
      usage.cacheRead * resolved.costPerMTokens.cacheRead +
      usage.cacheWrite * resolved.costPerMTokens.cacheWrite) /
    1_000_000;
  return roundCost(cost);
}

export function aggregateTotalCost(args: {
  voices: VoiceResult[];
  conductorCostUsd?: number | null;
  conductorExecuted: boolean;
}): number | null {
  const executedVoiceCosts = args.voices
    .filter((voice) => voice.status === "success" || voice.status === "error" || voice.status === "aborted")
    .map((voice) => voice.costUsd);
  if (executedVoiceCosts.some((cost) => cost == null)) return null;
  if (args.conductorExecuted && args.conductorCostUsd == null) return null;
  const knownCosts = executedVoiceCosts as number[];
  const total =
    knownCosts.reduce((sum: number, cost: number) => sum + cost, 0) +
    (args.conductorExecuted ? (args.conductorCostUsd ?? 0) : 0);
  return roundCost(total);
}

export function roundCost(cost: number): number {
  return Math.round(cost * 1_000_000_000) / 1_000_000_000;
}
