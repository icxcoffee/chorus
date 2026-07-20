import type { ModelInfo } from "../types.js";
import { defaultReviewerRoleRegistry } from "../roles/registry.js";
import { addCommitteeFallbacks, resolveProfiledReviewerAssignments } from "./model-policy.js";
import { resolveReviewScope } from "./scope.js";
import type { ReviewRequest, ReviewStageResult } from "./contracts.js";
import type { ReviewRoleExecutionProgress, ReviewRoleExecutor, ReviewWorkflowResult, ReviewWorkflowState } from "../workflows/contracts.js";
import { defaultReviewStageRegistry, defaultReviewWorkflowRegistry } from "../workflows/registry.js";
import { registerBuiltinReviewComponents } from "../workflows/builtins.js";
import { REVIEW_PROFILES, reviewStageExecutionLimits, withReviewProfileBudget } from "./profiles.js";
import { DEFAULT_MAX_CONCURRENCY } from "../runtime/scheduler.js";

export async function runReview(args: {
    request: ReviewRequest;
    registry: ModelInfo[];
    executor: ReviewRoleExecutor;
    signal?: AbortSignal;
    cwd?: string;
    onStage?: (result: ReviewStageResult) => void;
    onStageStart?: (stage: ReviewStageResult["stage"]) => void;
    onExecution?: (progress: ReviewRoleExecutionProgress) => void;
    executionPolicy?: { maxConcurrency: number; providerLimits?: Record<string, number> };
    reuse?: ReviewWorkflowResult;
    definition?: import("./contracts.js").ReviewDefinition;
}): Promise<ReviewWorkflowResult> {
    registerBuiltinReviewComponents();
    const reviewStartedAt = Date.now();
    const workflow = args.definition ? { definition: structuredClone(args.definition) } : defaultReviewWorkflowRegistry.get(args.request.workflow);
    if (workflow.definition.allowedScopeKinds && !workflow.definition.allowedScopeKinds.includes(args.request.scope.kind)) {
        throw new Error(`${workflow.definition.id} requires one of these scope kinds: ${workflow.definition.allowedScopeKinds.join(", ")}`);
    }
    const resolved = resolveProfiledReviewerAssignments(workflow.definition, args.request.profile, args.registry);
    workflow.definition = resolved.definition;
    for (const assignment of workflow.definition.roles) defaultReviewerRoleRegistry.get(assignment.roleId);
    const assignments = addCommitteeFallbacks(resolved.assignments);
    const stageExecutionLimits = reviewStageExecutionLimits(REVIEW_PROFILES[args.request.profile], assignments);
    const budgetedExecutor = withReviewProfileBudget(args.executor, REVIEW_PROFILES[args.request.profile], stageExecutionLimits);
    const executor = bindReviewProgress(budgetedExecutor, args.onExecution);
    const plan = await resolveReviewScope(args.request, {
        ...(args.cwd ? { cwd: args.cwd } : {}),
        workflowVersion: workflow.definition.revision ?? workflow.definition.version,
        assignments,
        stages: workflow.definition.stages,
    });
    const reuse = args.reuse?.plan.workflowId === plan.workflowId && args.reuse.plan.workflowVersion === plan.workflowVersion ? args.reuse : undefined;
    const state: ReviewWorkflowState = {
        plan,
        findings: [],
        positiveObservations: [],
        unresolvedQuestions: [],
        auditDiagnostics: [],
        completedRoles: [],
        usableRoles: [],
        emptyRoles: [],
        executions: reuse?.executions.filter((execution) => reuse.stages.some((stage) => stage.stage === execution.stage && (stage.status === "success" || stage.status === "partial"))) ?? [],
    };
    const signal = args.signal ?? new AbortController().signal;
    const stages: ReviewStageResult[] = [];
    for (const stageId of workflow.definition.stages) {
        const reusable = reuse?.stages.find((stage) => stage.stage === stageId && (stage.status === "success" || stage.status === "partial"));
        if (reusable) {
            hydrateReusedStage(state, reusable);
            state.auditDiagnostics.push(...reusable.diagnostics);
            const reused = structuredClone({
                ...reusable,
                diagnostics: [...reusable.diagnostics, "reused from validated review checkpoint"],
            });
            stages.push(reused);
            args.onStage?.(reused);
            continue;
        }
        if (signal.aborted && stageId !== "integrate") {
            const skipped: ReviewStageResult = { stage: stageId, status: "aborted", diagnostics: ["review aborted before stage started"], startedAt: Date.now(), finishedAt: Date.now() };
            stages.push(skipped);
            args.onStage?.(skipped);
            continue;
        }
        args.onStageStart?.(stageId);
        const result = await defaultReviewStageRegistry.get(stageId).run({
            definition: workflow.definition,
            executor,
            signal,
            state,
            executionPolicy: { ...(args.executionPolicy ?? { maxConcurrency: DEFAULT_MAX_CONCURRENCY }), stageExecutionLimits },
            ...(args.onExecution ? { onExecution: args.onExecution } : {}),
        });
        const snapshot = structuredClone(result);
        stages.push(snapshot);
        args.onStage?.(snapshot);
    }
    if (!state.report) throw new Error("review workflow finished without a normalized report");
    state.report.coverage.omittedStages = stages.filter((stage) => stage.status !== "success").map((stage) => stage.stage);
    state.report.coverage.stages = stages.map((stage) => stageCoverage(stage));
    state.report.run.durationMs = Date.now() - reviewStartedAt;
    return { plan, report: state.report, stages, executions: state.executions };
}

function stageCoverage(stage: ReviewStageResult): NonNullable<ReviewWorkflowResult["report"]["coverage"]["stages"]>[number] {
    const output = stage.output && typeof stage.output === "object" ? stage.output as Record<string, unknown> : {};
    const coverage = output.workCoverage && typeof output.workCoverage === "object" ? output.workCoverage as Record<string, unknown> : {};
    const value = (key: string): number => typeof coverage[key] === "number" && Number.isFinite(coverage[key]) ? Math.max(0, Math.floor(coverage[key])) : 0;
    return {
        stage: stage.stage,
        unit: coverage.unit === "roles" || coverage.unit === "findings" || coverage.unit === "executions" ? coverage.unit : "executions",
        planned: value("planned"), attempted: value("attempted"), usable: value("usable"), failed: value("failed"), omitted: value("omitted"), status: stage.status,
    };
}

function bindReviewProgress(executor: ReviewRoleExecutor, emit?: (progress: ReviewRoleExecutionProgress) => void): ReviewRoleExecutor {
    if (!emit) return executor;
    return {
        async execute(args) {
            const startedAt = Date.now();
            emit({ roleId: args.role.id, stage: args.stage, status: "running", durationMs: 0, ...(args.assignment.resolvedModel ? { model: args.assignment.resolvedModel } : {}) });
            try {
                return await executor.execute({ ...args, onProgress: emit });
            } catch (error) {
                const aborted = args.signal.aborted;
                emit({
                    roleId: args.role.id,
                    stage: args.stage,
                    status: aborted ? "aborted" : "error",
                    durationMs: Date.now() - startedAt,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        },
    };
}

function hydrateReusedStage(state: ReviewWorkflowState, stage: ReviewStageResult): void {
    if (!stage.output || typeof stage.output !== "object") return;
    if (stage.stage === "integrate") {
        state.report = stage.output as ReviewWorkflowResult["report"];
        return;
    }
    const output = stage.output as Record<string, unknown>;
    if (Array.isArray(output.findings)) {
        state.findings = structuredClone(output.findings as ReviewWorkflowState["findings"]);
    }
    if (stage.stage === "independent-review") {
        if (Array.isArray(output.positiveObservations)) state.positiveObservations = output.positiveObservations.filter((item): item is string => typeof item === "string");
        if (Array.isArray(output.unresolvedQuestions)) state.unresolvedQuestions = output.unresolvedQuestions.filter((item): item is string => typeof item === "string");
        if (Array.isArray(output.completedRoles)) state.completedRoles = output.completedRoles.filter((item): item is string => typeof item === "string");
        state.usableRoles = Array.isArray(output.usableRoles)
            ? output.usableRoles.filter((item): item is string => typeof item === "string")
            : [...state.completedRoles];
        if (Array.isArray(output.emptyRoles)) state.emptyRoles = output.emptyRoles.filter((item): item is string => typeof item === "string");
    }
}
