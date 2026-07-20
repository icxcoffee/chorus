import { createHash } from "node:crypto";
import type { EvidenceReference, Finding, FindingChallenge, FindingConfidence, FindingSeverity, FindingStatus } from "./contracts.js";

const severityRank: Record<FindingSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const confidenceRank: Record<FindingConfidence, number> = { low: 0, medium: 1, high: 2 };

export function normalizeFinding(finding: Finding): Finding {
    const title = finding.title.trim().replace(/\s+/g, " ");
    const category = finding.category.trim().toLowerCase();
    const primaryEvidence = deduplicateEvidence(finding.evidence);
    const evidence = evidenceWithVerifiedSupport(primaryEvidence, finding.challenges);
    const raisedBy = [...new Set(finding.raisedBy)].sort();
    const id = stableFindingId({ ...finding, title, category, evidence: primaryEvidence });
    const status = findingStatusFromEvidenceAndChallenges(evidence, finding.challenges);
    return { ...finding, id, title, category, evidence, raisedBy, status };
}

export function normalizeAndDeduplicateFindings(findings: Finding[]): Finding[] {
    const groups = new Map<string, Finding[]>();
    for (const candidate of findings.map(normalizeFinding)) {
        const key = mergeKey(candidate);
        groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    return [...groups.values()].map(mergeGroup).sort((left, right) => severityRank[right.severity] - severityRank[left.severity] || left.id.localeCompare(right.id));
}

export function stableFindingId(finding: Pick<Finding, "category" | "title" | "evidence">): string {
    const locations = finding.evidence.map(evidenceKey).sort().join("|");
    const value = `${finding.category.trim().toLowerCase()}\n${finding.title.trim().toLowerCase().replace(/\s+/g, " ")}\n${locations}`;
    return `finding-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function mergeGroup(group: Finding[]): Finding {
    const first = group[0];
    if (!first) throw new Error("cannot merge an empty finding group");
    if (group.length === 1) return first;
    const severity = group.reduce((best, finding) => severityRank[finding.severity] > severityRank[best] ? finding.severity : best, first.severity);
    const confidence = group.reduce((best, finding) => confidenceRank[finding.confidence] < confidenceRank[best] ? finding.confidence : best, first.confidence);
    const challenges = group.flatMap((finding) => finding.challenges);
    const evidence = evidenceWithVerifiedSupport(group.flatMap((finding) => finding.evidence), challenges);
    const raisedBy = [...new Set(group.flatMap((finding) => finding.raisedBy))].sort();
    return {
        ...first,
        severity,
        confidence,
        evidence,
        raisedBy,
        challenges,
        status: findingStatusFromEvidenceAndChallenges(evidence, challenges),
        mergeRationale: `Merged ${group.length} findings with the same normalized category, title, and source location; retained the highest severity and lowest confidence.`,
        ...(group.find((finding) => finding.recommendation)?.recommendation ? { recommendation: group.find((finding) => finding.recommendation)!.recommendation } : {}),
    };
}

export function hasCompleteVerifiedEvidence(evidence: EvidenceReference[]): boolean {
    return evidence.length > 0 && evidence.every((item) => item.verification === "verified");
}

export function findingStatusFromEvidenceAndChallenges(evidence: EvidenceReference[], challenges: FindingChallenge[]): FindingStatus {
    const primaryEvidenceVerified = hasCompleteVerifiedEvidence(evidence);
    const corrections = challenges.filter((challenge) => challenge.verdict === "correct");
    const objections = challenges.filter((challenge) => challenge.verdict === "object");
    const support = challenges.filter((challenge) => challenge.verdict === "support");
    if (corrections.length > 0 || objections.length > 0 && support.length > 0) return "disputed";
    if (objections.length > 0) {
        return objections.some((challenge) => hasCompleteVerifiedEvidence(challenge.evidence)) ? "rejected" : "disputed";
    }
    if (support.length > 0) {
        return primaryEvidenceVerified || support.some((challenge) => hasCompleteVerifiedEvidence(challenge.evidence))
            ? "verified"
            : "unsupported";
    }
    return primaryEvidenceVerified ? "proposed" : "unsupported";
}

export function applyFindingChallengeStatus(finding: Finding): void {
    finding.evidence = evidenceWithVerifiedSupport(finding.evidence, finding.challenges);
    finding.status = findingStatusFromEvidenceAndChallenges(finding.evidence, finding.challenges);
}

function evidenceWithVerifiedSupport(evidence: EvidenceReference[], challenges: FindingChallenge[]): EvidenceReference[] {
    const verifiedSupport = challenges
        .filter((challenge) => challenge.verdict === "support" && hasCompleteVerifiedEvidence(challenge.evidence))
        .flatMap((challenge) => challenge.evidence);
    return deduplicateEvidence([...evidence, ...verifiedSupport]);
}

function mergeKey(finding: Finding): string {
    return `${finding.category}\n${finding.title.toLowerCase()}\n${finding.evidence.map(evidenceKey).sort().join("|")}`;
}

function deduplicateEvidence(evidence: EvidenceReference[]): EvidenceReference[] {
    const entries = new Map<string, EvidenceReference>();
    for (const item of evidence) {
        const key = evidenceKey(item);
        const existing = entries.get(key);
        if (!existing || verificationRank(item.verification) > verificationRank(existing.verification)) entries.set(key, item);
    }
    return [...entries.values()].sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)));
}

function evidenceKey(evidence: EvidenceReference): string {
    if (evidence.kind === "log") return `log:${evidence.source}:${evidence.timestamp ?? ""}:${evidence.excerpt}`;
    if (evidence.kind === "document") return `document:${evidence.path}:${evidence.section ?? ""}:${evidence.excerpt ?? ""}`;
    return `code:${evidence.path}:${evidence.startLine}:${evidence.endLine ?? evidence.startLine}`;
}

function verificationRank(value: EvidenceReference["verification"]): number {
    return { invalid: 0, unavailable: 1, stale: 2, unverified: 3, verified: 4 }[value];
}
