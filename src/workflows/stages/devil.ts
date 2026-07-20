import { validateEvidenceSet } from "../../evidence/validation.js";
import { normalizeAndDeduplicateFindings } from "../../review/findings.js";
import { defaultReviewerRoleRegistry } from "../../roles/registry.js";
import { failedReviewExecution, type ReviewRoleExecution, type ReviewStageRunner } from "../contracts.js";
import { challengeFor, parseChallengeProposalWithNotes, parseExecutionPayload, parseFindingProposal } from "../parsing.js";
import { devilPrompt } from "../prompts.js";
import { applyChallengeStatus } from "./cross-review.js";
import { formatReviewRoleFailure } from "../../review/errors.js";
import { qualifyReviewDiagnostics, reviewCoverageGap } from "../../review/diagnostics.js";
import { REVIEW_PROFILES } from "../../review/profiles.js";
import { selectReviewCandidates } from "../../review/selection.js";

export const devilStage: ReviewStageRunner = {
    id: "devil",
    async run(context) {
        const startedAt = Date.now();
        const diagnostics: string[] = [];
        const executions: ReviewRoleExecution[] = [];
        const normalizationNotes: string[] = [];
        const assignment = context.state.plan.assignments.find((candidate) => candidate.roleId === "devil");
        const missingAreaProposals: string[] = [];
        const devilLimit = REVIEW_PROFILES[context.state.plan.request.profile].maxDevilFindings;
        const devilFindings = selectReviewCandidates(context.state.findings, devilLimit);
        const omittedDevilFindingCount = Math.max(0, context.state.findings.length - devilFindings.length);
        let attemptedChallenges = 0;
        let usableChallenges = 0;
        let executionFailed = false;
        if (!assignment) return { stage: "devil", status: "skipped", diagnostics: ["devil role is not assigned"], startedAt, finishedAt: Date.now() };
        if (context.state.findings.length === 0) {
            const reason = context.state.completedRoles.length === 0
                ? "Global Devil skipped because no independent reviewer completed"
                : "Global Devil skipped because independent review produced no findings to challenge";
            return { stage: "devil", status: "skipped", output: { findings: [], executions, missingAreaProposals }, diagnostics: [reason], startedAt, finishedAt: Date.now() };
        }
        try {
            const role = defaultReviewerRoleRegistry.get("devil");
            const execution = await context.executor.execute({ role, assignment, stage: "devil", language: context.state.plan.request.language ?? "zh-CN", prompt: devilPrompt(context.state.plan, devilFindings, context.definition), signal: context.signal });
            executions.push(execution);
            const payload = parseExecutionPayload(execution.output);
            const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
            attemptedChallenges = Array.isArray(record.challenges) ? record.challenges.length : 0;
            const parsedChallenges = parseChallengeProposalWithNotes({ challenges: Array.isArray(record.challenges) ? record.challenges : [] });
            normalizationNotes.push(...parsedChallenges.normalizationNotes.map((note) => `devil: ${note}`));
            for (const proposal of parsedChallenges.proposals) {
                const finding = context.state.findings.find((candidate) => candidate.id === proposal.findingId);
                if (!finding) { diagnostics.push(`devil challenge references unknown finding ${proposal.findingId}`); continue; }
                const evidence = await validateEvidenceSet(proposal.evidence, context.state.plan.scope);
                finding.challenges.push(challengeFor("devil", proposal, evidence));
                applyChallengeStatus(finding);
                usableChallenges += 1;
            }
            const findingProposal = parseFindingProposal({
                findings: Array.isArray(record.findings) ? record.findings : [],
                positiveObservations: [],
                unresolvedQuestions: [],
            }, "devil");
            normalizationNotes.push(...findingProposal.normalizationNotes.map((note) => `devil: ${note}`));
            const newFindings = [];
            for (const parsed of findingProposal.findings) newFindings.push({ ...parsed, evidence: await validateEvidenceSet(parsed.evidence, context.state.plan.scope) });
            context.state.findings = normalizeAndDeduplicateFindings([...context.state.findings, ...newFindings]);
            for (const item of Array.isArray(record.missingAreas) ? record.missingAreas : []) if (typeof item === "string") missingAreaProposals.push(item);
            context.state.unresolvedQuestions.push(...missingAreaProposals);
            context.onExecution?.({ roleId: "devil", stage: "devil", status: "success", ...(execution.model ? { model: execution.model } : {}), durationMs: execution.durationMs, costUsd: execution.costUsd });
            const discarded = Math.max(0, attemptedChallenges - parsedChallenges.proposals.length);
            const unaddressed = Math.max(0, devilFindings.length - attemptedChallenges);
            if (discarded > 0) diagnostics.push(`devil discarded ${discarded} malformed challenge(s)`);
            if (unaddressed > 0) diagnostics.push(`devil omitted ${unaddressed} planned finding challenge(s)`);
        } catch (error) {
            executionFailed = true;
            const failedExecution = failedReviewExecution(error);
            if (failedExecution) executions.push(failedExecution);
            const message = formatReviewRoleFailure("devil", assignment, error);
            context.onExecution?.({ roleId: "devil", stage: "devil", status: context.signal.aborted ? "aborted" : "error", errorMessage: message });
            diagnostics.push(message);
        }
        const coverageGap = reviewCoverageGap("devil", diagnostics, context.state.plan.request.language);
        if (coverageGap) context.state.unresolvedQuestions.push(coverageGap);
        context.state.auditDiagnostics.push(...qualifyReviewDiagnostics("devil", "devil", diagnostics));
        context.state.executions.push(...executions);
        return {
            stage: "devil",
            status: context.signal.aborted ? "aborted" : diagnostics.length === 0 ? "success" : executions.length > 0 ? "partial" : "error",
            output: {
                findings: context.state.findings, executions, missingAreaProposals, normalizationNotes, omittedDevilFindingCount,
                workCoverage: {
                    unit: "findings", planned: context.state.findings.length, attempted: attemptedChallenges, usable: usableChallenges,
                    failed: executionFailed ? devilFindings.length : Math.max(0, attemptedChallenges - usableChallenges),
                    omitted: omittedDevilFindingCount + Math.max(0, devilFindings.length - attemptedChallenges),
                },
            },
            diagnostics,
            startedAt,
            finishedAt: Date.now(),
        };
    },
};
