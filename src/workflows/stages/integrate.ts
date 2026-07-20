import { randomUUID } from "node:crypto";
import type { Finding, ReviewDecision, ReviewDecisionPolicy, ReviewDefinition, ReviewReport } from "../../review/contracts.js";
import { REVIEW_SCHEMA_VERSION } from "../../review/contracts.js";
import { defaultReviewerRoleRegistry } from "../../roles/registry.js";
import { failedReviewExecution, type ReviewRoleExecution, type ReviewStageRunner } from "../contracts.js";
import { parseExecutionPayload } from "../parsing.js";
import { integrationPrompt } from "../prompts.js";
import { formatReviewRoleFailure } from "../../review/errors.js";
import { compactReviewDiagnostics, qualifyReviewDiagnostics, reviewCoverageGap } from "../../review/diagnostics.js";
import { validateEvidenceSet } from "../../evidence/validation.js";
import { applyFindingChallengeStatus, hasCompleteVerifiedEvidence } from "../../review/findings.js";
import { challengeFor, parseChallengeProposalWithNotes } from "../parsing.js";

export const integrateStage: ReviewStageRunner = {
    id: "integrate",
    async run(context) {
        const startedAt = Date.now();
        const diagnostics: string[] = [];
        const normalizationNotes: string[] = [];
        const assignment = context.state.plan.assignments.find((candidate) => candidate.roleId === "integrator");
        let attemptedCount = 0;
        let usableCount = 0;
        let integration: Record<string, unknown> = {};
        if (assignment && !context.signal.aborted) {
            try {
                attemptedCount = 1;
                const role = defaultReviewerRoleRegistry.get("integrator");
                const execution = await context.executor.execute({ role, assignment, stage: "integrate", language: context.state.plan.request.language ?? "zh-CN", prompt: integrationPrompt(context.state.plan, context.state.findings, context.definition, context.state.unresolvedQuestions), signal: context.signal });
                context.state.executions.push(execution);
                const parsed = parseExecutionPayload(execution.output);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("integrator output must be a JSON object");
                integration = parsed as Record<string, unknown>;
                const resolutions = parseChallengeProposalWithNotes({ challenges: Array.isArray(integration.findingResolutions) ? integration.findingResolutions : [] });
                normalizationNotes.push(...resolutions.normalizationNotes.map((note) => `integrator: ${note}`));
                for (const proposal of resolutions.proposals) {
                    const finding = context.state.findings.find((candidate) => candidate.id === proposal.findingId);
                    if (!finding) { diagnostics.push(`integrator resolution references unknown finding ${proposal.findingId}`); continue; }
                    const evidence = await validateEvidenceSet(proposal.evidence, context.state.plan.scope);
                    if (proposal.verdict === "correct" && proposal.replacement) {
                        const replacementEvidence = await validateEvidenceSet(proposal.replacement.evidence, context.state.plan.scope);
                        if (hasCompleteVerifiedEvidence(replacementEvidence)) {
                            const originalTitle = finding.title;
                            Object.assign(finding, {
                                title: proposal.replacement.title,
                                description: proposal.replacement.description,
                                category: proposal.replacement.category,
                                severity: proposal.replacement.severity,
                                confidence: proposal.replacement.confidence,
                                evidence: replacementEvidence,
                                mergeRationale: `Integrator superseded \"${originalTitle}\" with a source-verified correction.`,
                            });
                            if (proposal.replacement.recommendation) finding.recommendation = proposal.replacement.recommendation;
                            else delete finding.recommendation;
                            finding.challenges.push(challengeFor("integrator", { ...proposal, verdict: "support" }, replacementEvidence));
                        } else {
                            finding.challenges.push(challengeFor("integrator", proposal, evidence));
                        }
                    } else {
                        finding.challenges.push(challengeFor("integrator", proposal, evidence));
                    }
                    applyFindingChallengeStatus(finding);
                }
                usableCount = 1;
                context.onExecution?.({ roleId: "integrator", stage: "integrate", status: "success", ...(execution.model ? { model: execution.model } : {}), durationMs: execution.durationMs, costUsd: execution.costUsd });
            } catch (error) {
                const failedExecution = failedReviewExecution(error);
                if (failedExecution) context.state.executions.push(failedExecution);
                const message = formatReviewRoleFailure("integrate", assignment, error);
                context.onExecution?.({ roleId: "integrator", stage: "integrate", status: context.signal.aborted ? "aborted" : "error", errorMessage: message });
                diagnostics.push(message);
            }
        } else if (!assignment) diagnostics.push("integrator role is not assigned; using deterministic report fallback");
        const coverageGap = reviewCoverageGap("integrate", diagnostics, context.state.plan.request.language);
        if (coverageGap) context.state.unresolvedQuestions.push(coverageGap);
        context.state.auditDiagnostics.push(...qualifyReviewDiagnostics("integrate", "integrator", diagnostics));
        const report = buildReviewReport(context.state, integration, context.definition, !assignment || usableCount === 1);
        context.state.report = report;
        return {
            stage: "integrate",
            status: context.signal.aborted ? "aborted" : diagnostics.length === 0 ? "success" : "partial",
            output: {
                ...report,
                ...(normalizationNotes.length > 0 ? { normalizationNotes } : {}),
                workCoverage: { unit: "executions", planned: assignment ? 1 : 0, attempted: attemptedCount, usable: usableCount, failed: Math.max(0, attemptedCount - usableCount), omitted: assignment ? Math.max(0, 1 - attemptedCount) : 0 },
            },
            diagnostics,
            startedAt,
            finishedAt: Date.now(),
        };
    },
};

export function buildReviewReport(state: Parameters<ReviewStageRunner["run"]>[0]["state"], integration: Record<string, unknown> = {}, definition?: ReviewDefinition, integrationComplete = true): ReviewReport {
    const verified = state.findings.filter((finding) => finding.status === "verified");
    const requestedRoles = state.plan.assignments.filter((assignment) => !["devil", "integrator"].includes(assignment.roleId)).length;
    const usableRoles = new Set(state.usableRoles).size;
    const decisionPolicy = definition?.decisionPolicy ?? { blockOn: ["critical", "high"], investigateOn: ["critical", "high"], incomplete: "investigate" };
    const policyDecision = decisionFor(state.findings, usableRoles, requestedRoles, decisionPolicy);
    const decision = !integrationComplete && policyDecision === "approve" ? "needs-investigation" : policyDecision;
    const requiredActions = verified
        .filter((finding) => decisionPolicy.blockOn.includes(finding.severity))
        .map((finding) => finding.recommendation ?? (state.plan.request.language === "en" ? `Address: ${finding.title}` : `处理：${finding.title}`));
    const totals = summarizeExecutions(state.executions);
    const workflowSections = extractWorkflowSections(integration.sections, definition?.reportSections ?? []);
    const mutatedPaths = state.plan.scope.mutatedPaths ?? [];
    const scopeMutationGap = mutatedPaths.length > 0
        ? state.plan.request.language === "en"
            ? `Review coverage incomplete: ${mutatedPaths.length} cited file(s) changed during the review (${mutatedPaths.join(", ")}).`
            : `评审覆盖不完整：${mutatedPaths.length} 个被引用文件在评审期间发生变化（${mutatedPaths.join(", ")}）。`
        : undefined;
    const resolvedQuestionIds = new Set(strings(integration.resolvedQuestionIds));
    const resolvedQuestions = new Set(state.unresolvedQuestions.filter((_question, index) =>
        resolvedQuestionIds.has(`prior-${index + 1}`)));
    const unresolvedQuestions = state.unresolvedQuestions.filter((question, index) =>
        isCoverageGap(question) || !resolvedQuestionIds.has(`prior-${index + 1}`) && !resolvedQuestions.has(question));
    const emptyRoleGap = emptyRoleCoverageGap(state.emptyRoles, state.plan.request.language);
    const executionDiagnostics = compactReviewDiagnostics(state.auditDiagnostics);
    const budgetOverruns = state.executions.filter((execution) => execution.budgetOverrun);
    executionDiagnostics.push(...budgetOverruns.map((execution) => `${execution.stage}: budget overrun (${execution.budgetOverrun})`));
    const citedPaths = new Set(state.findings.flatMap((finding) => finding.evidence.flatMap((evidence) => evidence.kind === "log" ? [] : [evidence.path])));
    const representedPaths = new Set([...state.plan.scope.includePaths, ...citedPaths]);
    if (mutatedPaths.length > 0) executionDiagnostics.push(`scope/snapshot: mutated-files (${mutatedPaths.length} occurrences)`);
    return {
        version: REVIEW_SCHEMA_VERSION,
        reviewId: randomUUID(),
        workflowId: state.plan.workflowId,
        language: state.plan.request.language ?? "zh-CN",
        decision,
        executiveSummary: defaultSummary(decision, state.findings, state.plan.request.language, usableRoles, requestedRoles),
        findings: state.findings,
        requiredActions,
        positiveObservations: unique([...state.positiveObservations, ...narrativeStrings(integration.positiveObservations)]),
        unresolvedQuestions: unique([
            ...unresolvedQuestions,
            ...strings(integration.newUnresolvedQuestions),
            ...(emptyRoleGap ? [emptyRoleGap] : []),
            ...(scopeMutationGap ? [scopeMutationGap] : []),
        ]),
        ...(executionDiagnostics.length > 0 ? { executionDiagnostics } : {}),
        ...(Object.keys(workflowSections).length > 0 ? { workflowSections } : {}),
        coverage: {
            requestedRoles,
            completedRoles: new Set(state.completedRoles).size,
            usableRoles,
            ...(state.emptyRoles.length > 0 ? { emptyRoles: [...new Set(state.emptyRoles)].sort() } : {}),
            reviewedFiles: representedPaths.size,
            citedFiles: citedPaths.size,
            explicitFiles: state.plan.scope.includePaths.length,
            omittedStages: [],
            ...(mutatedPaths.length > 0 ? { mutatedFiles: mutatedPaths.length } : {}),
            ...(budgetOverruns.length > 0 ? { budgetOverruns: budgetOverruns.length } : {}),
        },
        run: totals,
        createdAt: Date.now(),
    };
}

function isCoverageGap(value: string): boolean {
    return value.startsWith("评审覆盖不完整：") || value.startsWith("Review coverage incomplete:");
}

function emptyRoleCoverageGap(roles: string[], language = "zh-CN"): string | undefined {
    const uniqueRoles = [...new Set(roles)].sort();
    if (uniqueRoles.length === 0) return undefined;
    return language === "en"
        ? `Review coverage incomplete: independent-review produced no usable review signal for ${uniqueRoles.join(", ")}.`
        : `评审覆盖不完整：independent-review 阶段以下角色未产生可用评审信号：${uniqueRoles.join(", ")}。`;
}

function decisionFor(findings: Finding[], completedRoles: number, requestedRoles: number, policy?: ReviewDecisionPolicy): ReviewDecision {
    const effective = policy ?? { blockOn: ["critical", "high"], investigateOn: ["critical", "high"], incomplete: "investigate" };
    if (findings.some((finding) => finding.status === "verified" && effective.blockOn.includes(finding.severity))) return "request-changes";
    if (effective.incomplete === "investigate" && completedRoles < requestedRoles) return "needs-investigation";
    if (findings.some((finding) => finding.status !== "rejected" && effective.investigateOn.includes(finding.severity))) return "needs-investigation";
    return "approve";
}

function summarizeExecutions(executions: ReviewRoleExecution[]): ReviewReport["run"] {
    const costs = executions.map((execution) => execution.costUsd);
    return {
        durationMs: executions.reduce((sum, execution) => sum + execution.durationMs, 0),
        costUsd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
        inputTokens: executions.reduce((sum, execution) => sum + execution.inputTokens, 0),
        outputTokens: executions.reduce((sum, execution) => sum + execution.outputTokens, 0),
    };
}

function defaultSummary(decision: ReviewDecision, findings: Finding[], language = "zh-CN", usableRoles?: number, requestedRoles?: number): string {
    const verified = findings.filter((finding) => finding.status === "verified").length;
    const uncertain = findings.filter((finding) => finding.status === "proposed" || finding.status === "disputed" || finding.status === "unsupported").length;
    const incomplete = usableRoles !== undefined && requestedRoles !== undefined && usableRoles < requestedRoles;
    return language === "en"
        ? `Decision: ${decision}. ${verified} verified finding(s), ${uncertain} uncertain finding(s).${incomplete ? ` Review coverage is incomplete (${usableRoles}/${requestedRoles} expert roles usable).` : ""}`
        : `结论：${decisionLabelZh(decision)}。已验证问题 ${verified} 项，待确认问题 ${uncertain} 项。${incomplete ? `评审覆盖不完整（有效专家角色 ${usableRoles}/${requestedRoles}）。` : ""}`;
}

function decisionLabelZh(decision: ReviewDecision): string {
    return { approve: "通过", "request-changes": "需要修改", "needs-investigation": "需要进一步调查" }[decision];
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function narrativeStrings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (typeof item === "string") return item.trim() ? [item] : [];
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const title = string(record.title);
        const description = string(record.description);
        const recommendation = string(record.recommendedAction) ?? string(record.recommendation);
        if (!title && !description && !recommendation) return [];
        const summary = [title, description].filter(Boolean).join(title && description ? "：" : "");
        const recommendationPrefix = summary ? `${summary.replace(/[。.;；]+$/, "")}；` : "";
        return [recommendation ? `${recommendationPrefix}建议：${recommendation}` : summary];
    });
}

function string(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function extractWorkflowSections(value: unknown, allowed: string[]): Record<string, string[]> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const source = value as Record<string, unknown>;
    const result: Record<string, string[]> = {};
    for (const key of allowed) {
        const items = narrativeStrings(source[key]);
        if (items.length > 0) result[key] = items;
    }
    return result;
}
