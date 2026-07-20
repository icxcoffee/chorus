import type { Finding, FindingConfidence, FindingSeverity } from "./contracts.js";

const severityRank: Record<FindingSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const confidenceUncertainty: Record<FindingConfidence, number> = { low: 2, medium: 1, high: 0 };
const statusValue: Record<Finding["status"], number> = { unsupported: 3, disputed: 2, proposed: 2, verified: 1, rejected: 0 };

export function selectReviewCandidates(findings: Finding[], limit: number): Finding[] {
    const remaining = [...findings];
    const selected: Finding[] = [];
    const roleCounts = new Map<string, number>();
    while (selected.length < Math.max(0, limit) && remaining.length > 0) {
        remaining.sort((left, right) => compare(left, right, roleCounts));
        const next = remaining.shift();
        if (!next) break;
        selected.push(next);
        const role = origin(next);
        roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
    return selected;
}

function compare(left: Finding, right: Finding, roleCounts: Map<string, number>): number {
    return severityRank[right.severity] - severityRank[left.severity]
        || (roleCounts.get(origin(left)) ?? 0) - (roleCounts.get(origin(right)) ?? 0)
        || statusValue[right.status] - statusValue[left.status]
        || confidenceUncertainty[right.confidence] - confidenceUncertainty[left.confidence]
        || invalidEvidence(right) - invalidEvidence(left)
        || left.id.localeCompare(right.id);
}

function invalidEvidence(finding: Finding): number {
    return finding.evidence.filter((item) => item.verification !== "verified").length;
}

function origin(finding: Finding): string {
    return [...finding.raisedBy].sort()[0] ?? "unknown";
}
