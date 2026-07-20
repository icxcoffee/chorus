import { validateEvidenceSet } from "../../evidence/validation.js";
import { formatReviewRoleFailure } from "../../review/errors.js";
import { applyFindingChallengeStatus } from "../../review/findings.js";
import { selectReviewCandidates } from "../../review/selection.js";
import type { Finding, FindingChallenge, FindingSeverity, ReviewerAssignment } from "../../review/contracts.js";
import { qualifyReviewDiagnostics, reviewCoverageGap } from "../../review/diagnostics.js";
import { defaultReviewerRoleRegistry } from "../../roles/registry.js";
import { scheduleTasks, type ProviderLease } from "../../runtime/scheduler.js";
import { failedReviewExecution, type ReviewRoleExecution, type ReviewStageRunner } from "../contracts.js";
import { challengeFor, parseChallengeProposalWithNotes } from "../parsing.js";
import { crossReviewPrompt } from "../prompts.js";

const rank: Record<FindingSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface CrossReviewOutcome {
    finding: Finding;
    assignment?: ReviewerAssignment;
    execution?: ReviewRoleExecution;
    challenge?: FindingChallenge;
    normalizationNotes: string[];
    diagnostics: string[];
}

export const crossReviewStage: ReviewStageRunner = {
    id: "cross-review",
    async run(context) {
        const startedAt = Date.now();
        const diagnostics: string[] = [];
        const normalizationNotes: string[] = [];
        const executions: ReviewRoleExecution[] = [];
        const reviewers = context.state.plan.assignments.filter((assignment) => assignment.roleId !== "devil" && assignment.roleId !== "integrator");
        const eligible = context.state.findings.filter((finding) => rank[finding.severity] >= rank[context.definition.challengeSeverityAtLeast] || finding.confidence === "low" || finding.status === "unsupported");
        const challengeLimit = context.executionPolicy.stageExecutionLimits?.["cross-review"] ?? eligible.length;
        const selected = selectReviewCandidates(eligible, challengeLimit);
        const omittedChallengeCount = Math.max(0, eligible.length - selected.length);
        const reviewAssignments = assignCrossReviewers(selected, reviewers);
        let attemptedCount = 0;
        const tasks = selected.map((finding, index) => {
            const assignment = reviewAssignments[index];
            return {
                id: finding.id,
                ...(assignment?.resolvedModel?.provider ? { provider: assignment.resolvedModel.provider } : {}),
                run: async (lease: ProviderLease): Promise<CrossReviewOutcome> => {
                    attemptedCount += 1;
                    if (!assignment || finding.raisedBy.includes(assignment.roleId)) return { finding, normalizationNotes: [], diagnostics: [`${finding.id}: no distinct reviewer available`] };
                    const role = defaultReviewerRoleRegistry.get(assignment.roleId);
                    let execution: ReviewRoleExecution | undefined;
                    try {
                        execution = await context.executor.execute({ role, assignment, stage: "cross-review", language: context.state.plan.request.language ?? "zh-CN", prompt: crossReviewPrompt(context.state.plan, finding, context.definition), signal: context.signal, switchProvider: (provider) => lease.switchTo(provider, context.signal) });
                        const parsed = parseChallengeProposalWithNotes(execution.output, finding.id);
                        const proposal = parsed.proposals.find((item) => item.findingId === finding.id);
                        if (!proposal) throw new Error("challenge did not address the selected finding");
                        const evidence = await validateEvidenceSet(proposal.evidence, context.state.plan.scope);
                        context.onExecution?.({ roleId: role.id, stage: "cross-review", status: "success", ...(execution.model ? { model: execution.model } : {}), durationMs: execution.durationMs, costUsd: execution.costUsd });
                        return { finding, assignment, execution, challenge: challengeFor(role.id, proposal, evidence), normalizationNotes: parsed.normalizationNotes.map((note) => `${finding.id}/${role.id}: ${note}`), diagnostics: [] };
                    } catch (error) {
                        execution = failedReviewExecution(error);
                        const message = formatReviewRoleFailure("cross-review", assignment, error);
                        context.onExecution?.({ roleId: role.id, stage: "cross-review", status: context.signal.aborted ? "aborted" : "error", errorMessage: message });
                        return { finding, assignment, ...(execution ? { execution } : {}), normalizationNotes: [], diagnostics: [`${finding.id}/${role.id}: ${message}`] };
                    }
                },
            };
        });
        const settled = await scheduleTasks({ tasks, maxConcurrency: context.executionPolicy.maxConcurrency, ...(context.executionPolicy.providerLimits ? { providerLimits: context.executionPolicy.providerLimits } : {}), signal: context.signal });
        let completedChallenges = 0;
        for (const [index, entry] of settled.entries()) {
            const outcome = entry.status === "fulfilled"
                ? entry.value
                : { finding: selected[index]!, normalizationNotes: [], diagnostics: [`${selected[index]?.id ?? index}: ${String(entry.reason)}`] };
            diagnostics.push(...outcome.diagnostics);
            normalizationNotes.push(...outcome.normalizationNotes);
            if (outcome.execution) executions.push(outcome.execution);
            if (outcome.challenge) {
                outcome.finding.challenges.push(outcome.challenge);
                applyChallengeStatus(outcome.finding);
                completedChallenges += 1;
            }
        }
        const coverageGap = reviewCoverageGap("cross-review", diagnostics, context.state.plan.request.language);
        if (coverageGap) context.state.unresolvedQuestions.push(coverageGap);
        context.state.auditDiagnostics.push(...qualifyReviewDiagnostics("cross-review", "scheduler", diagnostics));
        context.state.executions.push(...executions);
        return {
            stage: "cross-review",
            status: context.signal.aborted ? "aborted" : diagnostics.length === 0 ? "success" : completedChallenges > 0 ? "partial" : selected.length === 0 ? "success" : "error",
            output: {
                findings: context.state.findings, executions, normalizationNotes, omittedChallengeCount,
                workCoverage: {
                    unit: "findings", planned: eligible.length, attempted: attemptedCount, usable: completedChallenges,
                    failed: Math.max(0, attemptedCount - completedChallenges),
                    omitted: omittedChallengeCount + Math.max(0, selected.length - attemptedCount),
                },
            },
            diagnostics,
            startedAt,
            finishedAt: Date.now(),
        };
    },
};

export function applyChallengeStatus(finding: Finding): void {
    applyFindingChallengeStatus(finding);
}

export function assignCrossReviewers(findings: Finding[], reviewers: ReviewerAssignment[]): Array<ReviewerAssignment | undefined> {
    const roleLoads = new Map<string, number>();
    const providerLoads = new Map<string, number>();
    return findings.map((finding) => {
        const candidates = reviewers.filter((candidate) => !finding.raisedBy.includes(candidate.roleId)
            && finding.challenges.every((challenge) => challenge.reviewerRoleId !== candidate.roleId));
        const assignment = candidates.sort((left, right) => {
            const leftProvider = left.resolvedModel?.provider ?? left.roleId;
            const rightProvider = right.resolvedModel?.provider ?? right.roleId;
            return (providerLoads.get(leftProvider) ?? 0) - (providerLoads.get(rightProvider) ?? 0)
                || (roleLoads.get(left.roleId) ?? 0) - (roleLoads.get(right.roleId) ?? 0)
                || reviewers.indexOf(left) - reviewers.indexOf(right);
        })[0];
        if (!assignment) return undefined;
        const provider = assignment.resolvedModel?.provider ?? assignment.roleId;
        roleLoads.set(assignment.roleId, (roleLoads.get(assignment.roleId) ?? 0) + 1);
        providerLoads.set(provider, (providerLoads.get(provider) ?? 0) + 1);
        return assignment;
    });
}
