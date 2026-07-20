import type { ModelInfo, ModelRef } from "../types.js";
import { modelFamily, sameModelRef } from "../utils/models.js";

export type RoutingTaskClass = "quick-answer" | "deep-reasoning" | "code-investigation" | "high-confidence-review";
export interface RoutingPolicy { enabled: boolean; taskClass?: RoutingTaskClass; voiceCount?: number; requireDiversity?: boolean; maxUsd?: number; }
export interface ModelHealth { failures: number; latencyMs?: number; }
export interface RoutingDecision { voices: ModelRef[]; conductor: ModelRef; rationale: string[]; fallback: boolean; }

export function routeModels(args: { models: ModelInfo[]; policy: RoutingPolicy; health?: Record<string, ModelHealth> }): RoutingDecision {
    if (!args.policy.enabled) throw new Error("dynamic routing is disabled; use the static preset");
    const taskClass = args.policy.taskClass ?? "quick-answer";
    const candidates = args.models
        .filter((model) => (args.health?.[key(model)]?.failures ?? 0) < 3)
        .map((model, index) => ({ model, index, score: score(model, taskClass, args.health?.[key(model)]) }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
    const count = Math.max(2, Math.min(args.policy.voiceCount ?? 2, candidates.length - 1));
    const voices: ModelRef[] = [];
    for (const candidate of candidates) {
        if (voices.length >= count) break;
        if (args.policy.requireDiversity !== false && voices.some((voice) => modelFamily(voice) === modelFamily(candidate.model))) continue;
        voices.push(ref(candidate.model));
    }
    const conductor = candidates.find((candidate) => !voices.some((voice) => sameModelRef(voice, candidate.model)))?.model;
    if (!conductor || voices.length < 2) return { voices, conductor: ref(conductor ?? candidates[0]?.model ?? args.models[0]!), rationale: ["insufficient healthy diverse models; deterministic fallback"], fallback: true };
    return { voices, conductor: ref(conductor), rationale: [`task class: ${taskClass}`, `selected ${voices.length} voices by capability/health score`], fallback: false };
}

function score(model: ModelInfo, taskClass: RoutingTaskClass, health?: ModelHealth): number {
    const reasoning = model.reasoning ? 20 : 0;
    const context = Math.min(20, (model.contextWindow ?? 0) / 10_000);
    const latency = health?.latencyMs ? Math.max(-10, 10 - health.latencyMs / 1000) : 0;
    const classBonus = taskClass === "quick-answer" ? -((model.costPerMTokens?.input ?? 0) + (model.costPerMTokens?.output ?? 0)) : reasoning;
    return classBonus + context + latency;
}
function key(model: ModelInfo): string { return `${model.provider}/${model.modelId}`; }
function ref(model: ModelInfo): ModelRef { return { provider: model.provider, modelId: model.modelId }; }
