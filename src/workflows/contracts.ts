import type {
    EvidenceReference,
    Finding,
    FindingChallenge,
    ReviewDefinition,
    ReviewLanguage,
    ReviewerAssignment,
    ReviewerRole,
    ReviewPlan,
    ReviewReport,
    ReviewStageResult,
} from "../review/contracts.js";
import type { ModelRef } from "../types.js";
import type { ReviewStageExecutionLimits } from "../review/profiles.js";

export interface ReviewRoleExecutionProgress {
    roleId: string;
    stage: ReviewStageResult["stage"];
    status: "running" | "success" | "error" | "aborted";
    model?: ModelRef;
    partialOutput?: string;
    activityLog?: string;
    errorMessage?: string;
    durationMs?: number;
    costUsd?: number | null;
}

export interface ReviewRoleExecution {
    roleId: string;
    stage: ReviewStageResult["stage"];
    model?: ReviewerAssignment["resolvedModel"];
    output: unknown;
    rawOutput?: string;
    activityLog?: string;
    recoveryContext?: string;
    durationMs: number;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    budgetOverrun?: string;
}

export class ReviewRoleExecutionFailure extends Error {
    constructor(message: string, public execution: ReviewRoleExecution) {
        super(message);
        this.name = "ReviewRoleExecutionFailure";
    }
}

export function failedReviewExecution(error: unknown): ReviewRoleExecution | undefined {
    return error instanceof ReviewRoleExecutionFailure ? error.execution : undefined;
}

export interface ReviewRoleExecutor {
    execute(args: {
        role: ReviewerRole;
        assignment: ReviewerAssignment;
        stage: ReviewStageResult["stage"];
        language?: ReviewLanguage;
        prompt: string;
        signal: AbortSignal;
        maxOutputTokens?: number;
        maxToolCalls?: number;
        maxTurns?: number;
        switchProvider?: (provider: string) => Promise<void>;
        onProgress?: (progress: ReviewRoleExecutionProgress) => void;
    }): Promise<ReviewRoleExecution>;
}

export interface IndependentReviewOutput {
    findings: Finding[];
    positiveObservations: string[];
    unresolvedQuestions: string[];
    executions: ReviewRoleExecution[];
    completedRoles: string[];
}

export interface CrossReviewOutput {
    findings: Finding[];
    executions: ReviewRoleExecution[];
}

export interface DevilOutput {
    findings: Finding[];
    executions: ReviewRoleExecution[];
    missingAreaProposals: string[];
}

export interface ReviewWorkflowState {
    plan: ReviewPlan;
    findings: Finding[];
    positiveObservations: string[];
    unresolvedQuestions: string[];
    auditDiagnostics: string[];
    completedRoles: string[];
    usableRoles: string[];
    emptyRoles: string[];
    executions: ReviewRoleExecution[];
    report?: ReviewReport;
}

export interface ReviewStageContext {
    definition: ReviewDefinition;
    executor: ReviewRoleExecutor;
    signal: AbortSignal;
    state: ReviewWorkflowState;
    executionPolicy: {
        maxConcurrency: number;
        providerLimits?: Record<string, number>;
        stageExecutionLimits?: ReviewStageExecutionLimits;
    };
    onExecution?: (progress: ReviewRoleExecutionProgress) => void;
}

export interface ReviewStageRunner {
    id: ReviewStageResult["stage"];
    run(context: ReviewStageContext): Promise<ReviewStageResult>;
}

export interface ReviewWorkflow {
    definition: ReviewDefinition;
}

export interface ReviewWorkflowResult {
    plan: ReviewPlan;
    report: ReviewReport;
    stages: ReviewStageResult[];
    executions: ReviewRoleExecution[];
}

export interface ModelFindingProposal {
    findings: unknown[];
    positiveObservations?: unknown[];
    unresolvedQuestions?: unknown[];
}

export interface ModelChallengeProposal {
    findingId: string;
    verdict: FindingChallenge["verdict"];
    rationale: string;
    evidence: EvidenceReference[];
    replacement?: Finding;
}
