import type { ModelInfo } from "../types.js";
import { validateEvidenceSet } from "../evidence/validation.js";
import { hasCompleteVerifiedEvidence, normalizeAndDeduplicateFindings } from "./findings.js";
import { resolveModelPolicy } from "./model-policy.js";
import { resolveReviewScope } from "./scope.js";
import type { ReviewRequest, ReviewerRole } from "./contracts.js";
import type { ReviewRoleExecutor, ReviewWorkflowState } from "../workflows/contracts.js";
import { parseFindingProposal } from "../workflows/parsing.js";
import { independentReviewPrompt } from "../workflows/prompts.js";
import { buildReviewReport } from "../workflows/stages/integrate.js";

const generalistRole: ReviewerRole = {
    id: "single-reviewer",
    name: "Single Generalist Reviewer",
    objective: "Review architecture, security, performance, correctness, and maintainability in one pass.",
    instructions: "Report material source-backed findings and avoid generic advice.",
    findingCategories: ["architecture", "security", "performance", "correctness", "maintainability"],
    requiredEvidence: ["code", "document", "log"],
};

export async function runSingleReviewerBaseline(args: { request: ReviewRequest; registry: ModelInfo[]; executor: ReviewRoleExecutor; signal?: AbortSignal; cwd?: string }) {
    const resolvedModel = resolveModelPolicy({}, args.registry, generalistRole.id);
    const assignment = { roleId: generalistRole.id, resolvedModel };
    const plan = await resolveReviewScope(args.request, {
        ...(args.cwd ? { cwd: args.cwd } : {}),
        assignments: [assignment],
        stages: ["independent-review", "integrate"],
    });
    const execution = await args.executor.execute({ role: generalistRole, assignment, stage: "independent-review", language: plan.request.language ?? "zh-CN", prompt: independentReviewPrompt(plan, generalistRole), signal: args.signal ?? new AbortController().signal });
    const proposal = parseFindingProposal(execution.output, generalistRole.id);
    const findings = [];
    for (const finding of proposal.findings) findings.push({ ...finding, evidence: await validateEvidenceSet(finding.evidence, plan.scope) });
    const normalizedFindings = normalizeAndDeduplicateFindings(findings).map((finding) => hasCompleteVerifiedEvidence(finding.evidence) ? { ...finding, status: "verified" as const } : finding);
    const state: ReviewWorkflowState = {
        plan,
        findings: normalizedFindings,
        positiveObservations: proposal.positiveObservations,
        unresolvedQuestions: proposal.unresolvedQuestions,
        auditDiagnostics: [],
        completedRoles: [generalistRole.id],
        usableRoles: findings.length > 0 || proposal.positiveObservations.length > 0 || proposal.unresolvedQuestions.length === 0 ? [generalistRole.id] : [],
        emptyRoles: findings.length > 0 || proposal.positiveObservations.length > 0 || proposal.unresolvedQuestions.length === 0 ? [] : [generalistRole.id],
        executions: [execution],
    };
    return buildReviewReport(state);
}
