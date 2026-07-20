import type { CodeEvidence, EvidenceReference, ReviewReport } from "../review/contracts.js";
import { renderReviewMarkdown } from "./markdown.js";
import type { ReviewRenderer } from "./registry.js";

export interface GitHubReviewPayload {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
    comments: Array<{ path: string; line: number; side: "RIGHT"; body: string }>;
}

const MAX_COMMENTS = 50;
const MAX_BODY = 60_000;

export const githubReviewRenderer: ReviewRenderer = {
    id: "github",
    mediaType: "application/vnd.github+json",
    extension: "github.json",
    render: (report) => `${JSON.stringify(renderGitHubReview(report), null, 2)}\n`,
};

export function renderGitHubReview(report: ReviewReport): GitHubReviewPayload {
    const chinese = report.language !== "en";
    const eligible = report.findings.flatMap((finding) => finding.status === "verified"
        ? finding.evidence.filter((evidence): evidence is CodeEvidence => isVerifiedCode(evidence) && !evidence.contextual).map((evidence) => ({
            path: evidence.path,
            line: evidence.endLine ?? evidence.startLine,
            side: "RIGHT" as const,
            body: `**${finding.severity.toUpperCase()}: ${escape(finding.title)}**\n\n${escape(finding.description)}${finding.recommendation ? `\n\n${chinese ? "建议" : "Recommendation"}: ${escape(finding.recommendation)}` : ""}`,
        })) : []);
    const deduplicated = [...new Map(eligible.map((comment) => [`${comment.path}:${comment.line}:${comment.body}`, comment])).values()];
    const omitted = Math.max(0, deduplicated.length - MAX_COMMENTS);
    let body = renderReviewMarkdown(report);
    if (omitted > 0) body += chinese ? `\n由于 GitHub 评论数量限制，省略了 ${omitted} 条行内评论。\n` : `\n${omitted} inline comment(s) omitted due to the GitHub comment limit.\n`;
    if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY - 80)}\n\n${chinese ? "[摘要已截断至 GitHub 载荷限制]" : "[summary truncated to GitHub payload limit]"}\n`;
    return {
        event: report.decision === "approve" ? "APPROVE" : report.decision === "request-changes" ? "REQUEST_CHANGES" : "COMMENT",
        body,
        comments: deduplicated.slice(0, MAX_COMMENTS),
    };
}

function escape(value: string): string {
    return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isVerifiedCode(evidence: EvidenceReference): evidence is CodeEvidence {
    return evidence.kind === "code" && evidence.verification === "verified";
}
