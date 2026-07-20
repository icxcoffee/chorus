import type { ModelInfo, ModelRef, TokenUsage, ChorusVoice } from "../types.js";
import { resolveModel } from "../models/resolve.js";
import { computeUsageCost } from "../utils/cost.js";

export interface RunBudget {
    maxUsd?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxVoices?: number;
    conductorReserveUsd?: number;
}

export interface BudgetEstimate {
    usd: number | null;
    inputTokens: number;
    outputTokens: number;
    voices: number;
    unknownPricing: boolean;
}

export function estimateBudget(args: { voices: ChorusVoice[]; conductor: ModelRef; prompt: string; registry: ModelInfo[]; outputTokens?: number }): BudgetEstimate {
    const inputTokens = estimatedInputTokens(args.prompt);
    const outputTokens = args.outputTokens ?? 2_048;
    let usd = 0;
    let unknownPricing = false;
    for (const voice of [...args.voices, { model: args.conductor }]) {
        try {
            const model = resolveModel(voice.model, args.registry);
            const cost = computeUsageCost({ input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 }, model);
            if (cost == null) unknownPricing = true;
            else usd += cost;
        } catch {
            unknownPricing = true;
        }
    }
    return { usd: unknownPricing ? null : usd, inputTokens: inputTokens * (args.voices.length + 1), outputTokens: outputTokens * (args.voices.length + 1), voices: args.voices.length, unknownPricing };
}

export function budgetAllows(estimate: BudgetEstimate, budget: RunBudget): boolean {
    if (budget.maxUsd !== undefined && (estimate.usd === null || estimate.usd > budget.maxUsd)) return false;
    if (budget.maxInputTokens !== undefined && estimate.inputTokens > budget.maxInputTokens) return false;
    if (budget.maxOutputTokens !== undefined && estimate.outputTokens > budget.maxOutputTokens) return false;
    return budget.maxVoices === undefined || estimate.voices <= budget.maxVoices;
}

export class BudgetTracker {
    constructor(public readonly budget: RunBudget, private readonly reservedUsd = budget.conductorReserveUsd ?? 0) {}
    private spentUsd = 0;
    private inputTokens = 0;
    private outputTokens = 0;
    record(usage: TokenUsage | undefined, costUsd: number | null): void {
        this.inputTokens += usage?.input ?? 0;
        this.outputTokens += usage?.output ?? 0;
        if (costUsd != null) this.spentUsd += costUsd;
    }
    canSpend(estimatedUsd: number): boolean {
        return this.budget.maxUsd === undefined || this.spentUsd + estimatedUsd + this.reservedUsd <= this.budget.maxUsd;
    }
    canStart(estimate: { usd: number | null; inputTokens: number; outputTokens: number }, reserveConductor = true): { allowed: boolean; reason?: string } {
        if (this.budget.maxUsd !== undefined && (estimate.usd === null || this.spentUsd + estimate.usd + (reserveConductor ? this.reservedUsd : 0) > this.budget.maxUsd)) return { allowed: false, reason: estimate.usd === null ? "unknown pricing under USD budget" : "USD budget reached" };
        if (this.budget.maxInputTokens !== undefined && this.inputTokens + estimate.inputTokens > this.budget.maxInputTokens) return { allowed: false, reason: "input token budget reached" };
        if (this.budget.maxOutputTokens !== undefined && this.outputTokens + estimate.outputTokens > this.budget.maxOutputTokens) return { allowed: false, reason: "output token budget reached" };
        return { allowed: true };
    }
    get actual(): { usd: number; inputTokens: number; outputTokens: number } { return { usd: this.spentUsd, inputTokens: this.inputTokens, outputTokens: this.outputTokens }; }
}

export function estimateModelBudget(model: ModelRef, prompt: string, registry: ModelInfo[], outputTokens = 2_048): { usd: number | null; inputTokens: number; outputTokens: number } {
    const inputTokens = estimatedInputTokens(prompt);
    try {
        const resolved = resolveModel(model, registry);
        return { usd: computeUsageCost({ input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 }, resolved), inputTokens, outputTokens };
    } catch {
        return { usd: null, inputTokens, outputTokens };
    }
}

function estimatedInputTokens(prompt: string): number {
    let codePoints = 0;
    for (const _ of prompt) codePoints += 1;
    return Math.ceil(codePoints / 4);
}
