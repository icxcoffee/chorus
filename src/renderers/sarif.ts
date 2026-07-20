import { createHash } from "node:crypto";
import type { CodeEvidence, EvidenceReference, Finding, ReviewReport } from "../review/contracts.js";
import type { ReviewRenderer } from "./registry.js";

export const sarifReviewRenderer: ReviewRenderer = {
    id: "sarif",
    mediaType: "application/sarif+json",
    extension: "sarif",
    render: (report) => `${JSON.stringify(renderSarif(report), null, 2)}\n`,
};

export function renderSarif(report: ReviewReport): Record<string, unknown> {
    const findings = report.findings.filter((finding) => finding.status === "verified" && finding.evidence.some((evidence) => evidence.kind === "code" && evidence.verification === "verified"));
    const ruleIds = [...new Set(findings.map(ruleId))].sort();
    return {
        version: "2.1.0",
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        runs: [{
            tool: { driver: { name: "Chorus", informationUri: "https://github.com/icxcoffee/chorus", rules: ruleIds.map((id) => ({ id, name: id, shortDescription: { text: `Chorus ${id} finding` } })) } },
            results: findings.map((finding) => ({
                ruleId: ruleId(finding),
                level: level(finding),
                message: { text: `${finding.title}: ${finding.description}` },
                locations: finding.evidence.filter(isVerifiedCode).map((evidence) => ({ physicalLocation: { artifactLocation: { uri: evidence.path }, region: { startLine: evidence.startLine, endLine: evidence.endLine ?? evidence.startLine } } })),
                partialFingerprints: { chorusFindingId: createHash("sha256").update(`${finding.id}:${finding.title}`).digest("hex") },
                properties: { severity: finding.severity, confidence: finding.confidence, reviewId: report.reviewId },
            })),
        }],
    };
}

function ruleId(finding: Finding): string { return `chorus/${finding.category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "review"}`; }
function level(finding: Finding): "error" | "warning" | "note" { return finding.severity === "critical" || finding.severity === "high" ? "error" : finding.severity === "medium" ? "warning" : "note"; }
function isVerifiedCode(evidence: EvidenceReference): evidence is CodeEvidence { return evidence.kind === "code" && evidence.verification === "verified"; }
