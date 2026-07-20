import type { ReviewerAssignment, ReviewDefinition, ReviewProfile, ReviewStageId } from "./contracts.js";
import { failedReviewExecution, type ReviewRoleExecution, type ReviewRoleExecutor } from "../workflows/contracts.js";

export interface ReviewProfileConfig {
    id: ReviewProfile;
    maxExpertRoles: number;
    maxChallengesPerFinding: number;
    maxFindingsPerReviewer: number;
    maxDevilFindings: number;
    maxExecutions: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxUsd: number;
    toolCallLimits: Record<ReviewStageId, number>;
    turnLimits: Record<ReviewStageId, number>;
    stageReserve: {
        "cross-review": { inputTokens: number; outputTokens: number; usd: number };
        devil: { inputTokens: number; outputTokens: number; usd: number };
        integrate: { inputTokens: number; outputTokens: number; usd: number };
    };
}

export const REVIEW_PROFILES: Record<ReviewProfile, ReviewProfileConfig> = {
    quick: {
        id: "quick", maxExpertRoles: 3, maxChallengesPerFinding: 1, maxFindingsPerReviewer: 3, maxDevilFindings: 5, maxExecutions: 7,
        maxInputTokens: 200_000, maxOutputTokens: 50_000, maxUsd: 2,
        toolCallLimits: { "independent-review": 12, "cross-review": 6, devil: 4, integrate: 0 },
        turnLimits: { "independent-review": 16, "cross-review": 10, devil: 8, integrate: 4 },
        stageReserve: {
            "cross-review": { inputTokens: 48_000, outputTokens: 8_000, usd: 0.2 },
            devil: { inputTokens: 24_000, outputTokens: 10_000, usd: 0.2 },
            integrate: { inputTokens: 24_000, outputTokens: 6_000, usd: 0.2 },
        },
    },
    deep: {
        id: "deep", maxExpertRoles: 4, maxChallengesPerFinding: 2, maxFindingsPerReviewer: 6, maxDevilFindings: 10, maxExecutions: 16,
        maxInputTokens: 400_000, maxOutputTokens: 80_000, maxUsd: 10,
        toolCallLimits: { "independent-review": 24, "cross-review": 12, devil: 8, integrate: 0 },
        turnLimits: { "independent-review": 28, "cross-review": 16, devil: 12, integrate: 4 },
        stageReserve: {
            "cross-review": { inputTokens: 80_000, outputTokens: 20_000, usd: 2 },
            devil: { inputTokens: 24_000, outputTokens: 8_000, usd: 0.5 },
            integrate: { inputTokens: 32_000, outputTokens: 8_000, usd: 0.5 },
        },
    },
};

export function applyReviewProfile(definition: ReviewDefinition, profile: ReviewProfile): ReviewDefinition {
    const config = REVIEW_PROFILES[profile];
    const experts = definition.roles.filter((assignment) => assignment.roleId !== "devil" && assignment.roleId !== "integrator").slice(0, config.maxExpertRoles);
    const special = definition.roles.filter((assignment) => assignment.roleId === "devil" || assignment.roleId === "integrator");
    return { ...definition, roles: [...experts, ...special], maxChallengesPerFinding: Math.min(definition.maxChallengesPerFinding, config.maxChallengesPerFinding) };
}

export type ReviewStageExecutionLimits = Partial<Record<ReviewStageId, number>>;

export class ReviewBudgetExceededError extends Error {
    readonly category = "budget";
}

export function reviewStageExecutionLimits(profile: ReviewProfileConfig, assignments: ReviewerAssignment[]): ReviewStageExecutionLimits {
    const independent = assignments.filter((assignment) => assignment.roleId !== "devil" && assignment.roleId !== "integrator").length;
    const devil = assignments.some((assignment) => assignment.roleId === "devil") ? 1 : 0;
    const integrate = assignments.some((assignment) => assignment.roleId === "integrator") ? 1 : 0;
    return {
        "independent-review": independent,
        "cross-review": Math.max(0, profile.maxExecutions - independent - devil - integrate),
        devil,
        integrate,
    };
}

export function withReviewProfileBudget(executor: ReviewRoleExecutor, profile: ReviewProfileConfig, stageLimits: ReviewStageExecutionLimits = {}): ReviewRoleExecutor {
    let executions = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const stageExecutions = new Map<ReviewStageId, number>();
    const stageResources = new Map<ReviewStageId, { inputTokens: number; outputTokens: number; costUsd: number }>();
    const stageOverrunCarriers = new Map<ReviewStageId, ReviewRoleExecution>();
    let totalOverrunCarrier: ReviewRoleExecution | undefined;
    const overrunParts = new WeakMap<ReviewRoleExecution, Map<string, string[]>>();
    const updateOverrun = (execution: ReviewRoleExecution, key: string, parts: string[]): void => {
        const groups = overrunParts.get(execution) ?? new Map<string, string[]>();
        groups.set(key, parts);
        overrunParts.set(execution, groups);
        execution.budgetOverrun = [...groups.values()].flat().join(", ");
    };
    return {
        async execute(args) {
            const stageLimit = stageLimits[args.stage];
            const stageUsed = stageExecutions.get(args.stage) ?? 0;
            if (stageLimit !== undefined && stageUsed >= stageLimit) throw budgetError(profile, args.stage, "execution", stageUsed, stageLimit);
            if (executions >= profile.maxExecutions) throw budgetError(profile, args.stage, "execution", executions, profile.maxExecutions);
            const allocation = executionAllocation(profile, stageLimits, args.stage);
            const stageBudget = totalStageBudget(profile, args.stage);
            let used = stageResources.get(args.stage);
            if (!used) {
                used = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
                stageResources.set(args.stage, used);
            }
            if (used.inputTokens >= stageBudget.inputTokens) throw budgetError(profile, args.stage, "input", used.inputTokens, stageBudget.inputTokens);
            if (used.outputTokens >= stageBudget.outputTokens) throw budgetError(profile, args.stage, "output", used.outputTokens, stageBudget.outputTokens);
            if (used.costUsd >= stageBudget.usd) throw budgetError(profile, args.stage, "cost", used.costUsd, stageBudget.usd);
            executions += 1;
            stageExecutions.set(args.stage, stageUsed + 1);
            const account = (execution: ReviewRoleExecution): ReviewRoleExecution => {
                inputTokens += execution.inputTokens;
                outputTokens += execution.outputTokens;
                if (execution.costUsd !== null) costUsd += execution.costUsd;
                used.inputTokens += execution.inputTokens;
                used.outputTokens += execution.outputTokens;
                if (execution.costUsd !== null) used.costUsd += execution.costUsd;
                const stageOverruns = [
                    used.inputTokens > stageBudget.inputTokens ? `stage input ${used.inputTokens}/${stageBudget.inputTokens}` : "",
                    used.outputTokens > stageBudget.outputTokens ? `stage output ${used.outputTokens}/${stageBudget.outputTokens}` : "",
                    used.costUsd > stageBudget.usd ? `stage cost ${used.costUsd}/${stageBudget.usd}` : "",
                ].filter(Boolean);
                const totalOverruns = [
                    inputTokens > profile.maxInputTokens ? `total input ${inputTokens}/${profile.maxInputTokens}` : "",
                    outputTokens > profile.maxOutputTokens ? `total output ${outputTokens}/${profile.maxOutputTokens}` : "",
                    costUsd > profile.maxUsd ? `total cost ${costUsd}/${profile.maxUsd}` : "",
                ].filter(Boolean);
                if (stageOverruns.length > 0) {
                    const carrier = stageOverrunCarriers.get(args.stage) ?? execution;
                    stageOverrunCarriers.set(args.stage, carrier);
                    updateOverrun(carrier, `stage:${args.stage}`, stageOverruns);
                }
                if (totalOverruns.length > 0) {
                    totalOverrunCarrier ??= execution;
                    updateOverrun(totalOverrunCarrier, "total", totalOverruns);
                }
                return execution;
            };
            try {
                return account(await executor.execute({
                    ...args,
                    maxOutputTokens: allocation.outputTokens,
                    maxToolCalls: profile.toolCallLimits[args.stage],
                    maxTurns: profile.turnLimits[args.stage],
                }));
            } catch (error) {
                const failed = failedReviewExecution(error);
                if (failed) Object.assign(failed, account(failed));
                throw error;
            }
        },
    };
}

function totalStageBudget(profile: ReviewProfileConfig, stage: ReviewStageId): { inputTokens: number; outputTokens: number; usd: number } {
    if (stage !== "independent-review") return profile.stageReserve[stage];
    const reserve = totalStageReserve(profile);
    return {
        inputTokens: profile.maxInputTokens - reserve.inputTokens,
        outputTokens: profile.maxOutputTokens - reserve.outputTokens,
        usd: profile.maxUsd - reserve.usd,
    };
}

function executionAllocation(profile: ReviewProfileConfig, limits: ReviewStageExecutionLimits, stage: ReviewStageId): { inputTokens: number; outputTokens: number; usd: number } {
    const count = Math.max(1, limits[stage] ?? (stage === "independent-review" ? profile.maxExpertRoles : 1));
    if (stage !== "independent-review") {
        const reserve = profile.stageReserve[stage];
        return { inputTokens: Math.floor(reserve.inputTokens / count), outputTokens: Math.floor(reserve.outputTokens / count), usd: reserve.usd / count };
    }
    const reserve = totalStageReserve(profile);
    return {
        inputTokens: Math.floor((profile.maxInputTokens - reserve.inputTokens) / count),
        outputTokens: Math.floor((profile.maxOutputTokens - reserve.outputTokens) / count),
        usd: (profile.maxUsd - reserve.usd) / count,
    };
}

function totalStageReserve(profile: ReviewProfileConfig): { inputTokens: number; outputTokens: number; usd: number } {
    const reserves = Object.values(profile.stageReserve);
    return reserves.reduce((sum, reserve) => ({
        inputTokens: sum.inputTokens + reserve.inputTokens,
        outputTokens: sum.outputTokens + reserve.outputTokens,
        usd: sum.usd + reserve.usd,
    }), { inputTokens: 0, outputTokens: 0, usd: 0 });
}

function budgetError(profile: ReviewProfileConfig, stage: ReviewStageId, kind: "execution" | "input" | "output" | "cost", used: number, limit: number, reserved = 0): ReviewBudgetExceededError {
    return new ReviewBudgetExceededError(`review budget exceeded profile=${profile.id} stage=${stage} kind=${kind} used=${used} limit=${limit}${reserved > 0 ? ` reserved=${reserved}` : ""}`);
}
