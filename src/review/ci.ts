import type { FindingConfidence, FindingSeverity, ReviewReport } from "./contracts.js";
import { atomicPrivateWrite } from "../utils/private-file.js";

export const REVIEW_EXIT_CODES = {
    pass: 0,
    policyFailure: 1,
    incomplete: 2,
    invalidInput: 3,
    runtimeFailure: 4,
} as const;

export interface ReviewCiPolicy {
    failOn: FindingSeverity;
    minimumConfidence?: FindingConfidence;
    requireVerifiedEvidence?: boolean;
    incomplete: "fail" | "allow";
}

export interface ReviewCiSummary {
    version: 1;
    reviewId: string;
    decision: ReviewReport["decision"];
    exitCode: number;
    blockingFindingIds: string[];
    incompleteReasons: string[];
}

export function evaluateReviewPolicy(report: ReviewReport, policy: ReviewCiPolicy): ReviewCiSummary {
    const severityRank: Record<FindingSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    const confidenceRank: Record<FindingConfidence, number> = { low: 0, medium: 1, high: 2 };
    const minimumConfidence = policy.minimumConfidence ?? "low";
    const blocking = report.findings.filter((finding) => finding.status === "verified"
        && severityRank[finding.severity] >= severityRank[policy.failOn]
        && confidenceRank[finding.confidence] >= confidenceRank[minimumConfidence]
        && (!policy.requireVerifiedEvidence || finding.evidence.some((evidence) => evidence.verification === "verified")));
    const incompleteReasons = [
        ...(report.coverage.completedRoles < report.coverage.requestedRoles ? [`only ${report.coverage.completedRoles}/${report.coverage.requestedRoles} roles completed`] : []),
        ...(report.coverage.usableRoles !== undefined && report.coverage.usableRoles < report.coverage.requestedRoles ? [`only ${report.coverage.usableRoles}/${report.coverage.requestedRoles} roles produced usable review signal`] : []),
        ...(report.coverage.omittedStages.length ? [`omitted stages: ${report.coverage.omittedStages.join(", ")}`] : []),
        ...((report.coverage.budgetOverruns ?? 0) > 0 ? [`${report.coverage.budgetOverruns} execution budget overrun(s)`] : []),
        ...(report.decision === "needs-investigation" ? ["review decision needs investigation"] : []),
    ];
    const exitCode = incompleteReasons.length > 0 && policy.incomplete === "fail"
        ? REVIEW_EXIT_CODES.incomplete
        : blocking.length > 0 ? REVIEW_EXIT_CODES.policyFailure : REVIEW_EXIT_CODES.pass;
    return { version: 1, reviewId: report.reviewId, decision: report.decision, exitCode, blockingFindingIds: blocking.map((finding) => finding.id), incompleteReasons };
}

export async function writeReviewCiSummary(path: string, summary: ReviewCiSummary): Promise<void> {
    await atomicPrivateWrite(path, `${JSON.stringify(summary, null, 2)}\n`);
}
