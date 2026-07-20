import { validateEvidenceSet } from "../../evidence/validation.js";
import { normalizeAndDeduplicateFindings } from "../../review/findings.js";
import { defaultReviewerRoleRegistry } from "../../roles/registry.js";
import { failedReviewExecution, type ReviewRoleExecution, type ReviewStageRunner } from "../contracts.js";
import { parseFindingProposal } from "../parsing.js";
import { independentReviewPrompt } from "../prompts.js";
import { scheduleTasks, type ProviderLease } from "../../runtime/scheduler.js";
import { formatReviewRoleFailure } from "../../review/errors.js";
import { qualifyReviewDiagnostics, reviewCoverageGap } from "../../review/diagnostics.js";
import { REVIEW_PROFILES } from "../../review/profiles.js";
import { selectReviewCandidates } from "../../review/selection.js";

export const independentReviewStage: ReviewStageRunner = {
    id: "independent-review",
    async run(context) {
        const startedAt = Date.now();
        const diagnostics: string[] = [];
        const findings = [];
        const positiveObservations: string[] = [];
        const unresolvedQuestions: string[] = [];
        const reportUnresolvedQuestions: string[] = [];
        const normalizationNotes: string[] = [];
        let omittedFindingCount = 0;
        const executions = [];
        const completedRoles: string[] = [];
        const usableRoles: string[] = [];
        const emptyRoles: string[] = [];
        let attemptedCount = 0;
        const assignments = context.state.plan.assignments.filter((assignment) => assignment.roleId !== "devil" && assignment.roleId !== "integrator");
        const tasks = assignments.map((assignment) => ({
            id: assignment.roleId,
            ...(assignment.resolvedModel?.provider ? { provider: assignment.resolvedModel.provider } : {}),
            run: async (lease: ProviderLease) => {
                attemptedCount += 1;
                const role = defaultReviewerRoleRegistry.get(assignment.roleId);
                let execution: ReviewRoleExecution | undefined;
                try {
                    execution = await context.executor.execute({ role, assignment, stage: "independent-review", language: context.state.plan.request.language ?? "zh-CN", prompt: independentReviewPrompt(context.state.plan, role, context.definition), signal: context.signal, switchProvider: (provider) => lease.switchTo(provider, context.signal) });
                    const proposal = parseFindingProposal(execution.output, role.id);
                    const selectedFindings = selectReviewCandidates(proposal.findings, REVIEW_PROFILES[context.state.plan.request.profile].maxFindingsPerReviewer);
                    const validatedFindings = [];
                    for (const finding of selectedFindings) validatedFindings.push({ ...finding, evidence: await validateEvidenceSet(finding.evidence, context.state.plan.scope) });
                    context.onExecution?.({ roleId: role.id, stage: "independent-review", status: "success", ...(execution.model ? { model: execution.model } : {}), durationMs: execution.durationMs, costUsd: execution.costUsd });
                    return { assignment, roleId: role.id, execution, findings: validatedFindings, omittedFindingCount: proposal.findings.length - selectedFindings.length, positiveObservations: proposal.positiveObservations, unresolvedQuestions: proposal.unresolvedQuestions, normalizationNotes: proposal.normalizationNotes, diagnostics: [] };
                } catch (error) {
                    execution = failedReviewExecution(error);
                    const message = formatReviewRoleFailure("independent-review", assignment, error);
                    context.onExecution?.({ roleId: role.id, stage: "independent-review", status: context.signal.aborted ? "aborted" : "error", errorMessage: message });
                    return { assignment, ...(execution ? { execution } : {}), diagnostics: [message] };
                }
            },
        }));
        const settled = await scheduleTasks({
            tasks,
            maxConcurrency: context.executionPolicy.maxConcurrency,
            ...(context.executionPolicy.providerLimits ? { providerLimits: context.executionPolicy.providerLimits } : {}),
            signal: context.signal,
        });
        const outcomes = settled.map((entry, index) => entry.status === "fulfilled"
            ? entry.value
            : { assignment: assignments[index]!, diagnostics: [formatReviewRoleFailure("independent-review", assignments[index]!, entry.reason)] });
        for (const outcome of outcomes) {
            diagnostics.push(...outcome.diagnostics);
            if (outcome.execution) executions.push(outcome.execution);
            if (!outcome.execution || !outcome.roleId) continue;
            findings.push(...(outcome.findings ?? []));
            positiveObservations.push(...(outcome.positiveObservations ?? []));
            const roleQuestions = outcome.unresolvedQuestions ?? [];
            unresolvedQuestions.push(...roleQuestions);
            normalizationNotes.push(...(outcome.normalizationNotes ?? []).map((note) => `${outcome.roleId}: ${note}`));
            omittedFindingCount += outcome.omittedFindingCount ?? 0;
            completedRoles.push(outcome.roleId);
            if ((outcome.findings?.length ?? 0) > 0 || (outcome.positiveObservations?.length ?? 0) > 0 || roleQuestions.length === 0) {
                usableRoles.push(outcome.roleId);
                reportUnresolvedQuestions.push(...roleQuestions);
            } else {
                emptyRoles.push(outcome.roleId);
            }
        }
        const coverageGap = reviewCoverageGap("independent-review", diagnostics, context.state.plan.request.language);
        if (coverageGap) {
            unresolvedQuestions.push(coverageGap);
            reportUnresolvedQuestions.push(coverageGap);
        }
        context.state.findings = normalizeAndDeduplicateFindings(findings);
        context.state.positiveObservations.push(...positiveObservations);
        context.state.unresolvedQuestions.push(...reportUnresolvedQuestions);
        context.state.auditDiagnostics.push(...qualifyReviewDiagnostics("independent-review", "scheduler", diagnostics));
        context.state.executions.push(...executions);
        context.state.completedRoles.push(...completedRoles);
        context.state.usableRoles.push(...usableRoles);
        context.state.emptyRoles.push(...emptyRoles);
        return {
            stage: "independent-review",
            status: context.signal.aborted ? "aborted" : completedRoles.length === assignments.length ? "success" : completedRoles.length > 0 ? "partial" : "error",
            output: {
                findings: context.state.findings, positiveObservations, unresolvedQuestions, normalizationNotes, omittedFindingCount, executions, completedRoles, usableRoles, emptyRoles,
                workCoverage: { unit: "roles", planned: assignments.length, attempted: attemptedCount, usable: usableRoles.length, failed: Math.max(0, attemptedCount - completedRoles.length), omitted: Math.max(0, assignments.length - attemptedCount) },
            },
            diagnostics,
            startedAt,
            finishedAt: Date.now(),
        };
    },
};
