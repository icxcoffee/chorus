import type { EvidenceReference, Finding, ReviewReport } from "../review/contracts.js";
import type { ReviewRenderer } from "./registry.js";
import { reviewReportExecutionStatus } from "../review/status.js";

export const markdownReviewRenderer: ReviewRenderer = {
    id: "markdown",
    mediaType: "text/markdown",
    extension: "md",
    render: renderReviewMarkdown,
};

export function renderReviewMarkdown(report: ReviewReport): string {
    const chinese = report.language !== "en";
    const execution = reviewReportExecutionStatus(report);
    const sampled = report.coverage.stages?.some((stage) => stage.omitted > 0) === true;
    const lines = [
        chinese ? "# Chorus 评审报告" : "# Chorus Review",
        "",
        chinese ? `结论：**${decisionLabel(report.decision, true)}**` : `Decision: **${decisionLabel(report.decision, false)}**`,
        chinese
            ? `执行状态：**${execution === "degraded" ? "降级" : "完整"}**（${roleCoverageZh(report)}${sampled ? "，按配置抽样" : ""}）`
            : `Execution: **${execution === "degraded" ? "Degraded" : "Complete"}** (${roleCoverageEn(report)}${sampled ? ", profile-sampled" : ""})`,
        ...renderStageCoverage(report, chinese),
        "",
        chinese ? "## 执行摘要" : "## Executive Summary",
        "",
        escapeMarkdown(report.executiveSummary),
    ];
    for (const [title, statuses] of [
        [chinese ? "已验证问题" : "Verified Findings", ["verified"]],
        [chinese ? "待复核问题" : "Proposed Findings", ["proposed"]],
        [chinese ? "存在争议的问题" : "Disputed Findings", ["disputed"]],
        [chinese ? "不受支持或已驳回的问题" : "Unsupported or Rejected Findings", ["unsupported", "rejected"]],
    ] as const) {
        const findings = report.findings.filter((finding) => statuses.includes(finding.status as never));
        if (findings.length === 0) continue;
        lines.push("", `## ${title}`, "");
        for (const finding of findings) lines.push(...renderFinding(finding, chinese));
    }
    section(lines, chinese ? "必须执行的操作" : "Required Actions", report.requiredActions, true);
    for (const [key, values] of Object.entries(report.workflowSections ?? {})) section(lines, titleFromKey(key, chinese), values, false);
    section(lines, chinese ? "积极观察" : "Positive Observations", report.positiveObservations, false);
    section(lines, chinese ? "执行诊断" : "Execution Diagnostics", report.executionDiagnostics ?? [], false);
    if (report.executionDiagnostics?.length) lines.push("", chinese ? "详细错误链和归一化记录请查看 stage/execution artifact。" : "Inspect stage/execution artifacts for full error chains and normalization records.");
    section(lines, chinese ? "未解决问题" : "Unresolved Questions", report.unresolvedQuestions, false);
    lines.push(
        "",
        chinese ? "## 评审覆盖范围" : "## Review Coverage",
        "",
        chinese ? `- 角色：${report.coverage.completedRoles}/${report.coverage.requestedRoles}` : `- Roles: ${report.coverage.completedRoles}/${report.coverage.requestedRoles}`,
        chinese ? `- 有效角色：${report.coverage.usableRoles ?? report.coverage.completedRoles}/${report.coverage.requestedRoles}` : `- Usable roles: ${report.coverage.usableRoles ?? report.coverage.completedRoles}/${report.coverage.requestedRoles}`,
        ...((report.coverage.emptyRoles?.length ?? 0) > 0 ? [chinese ? `- 空结果角色：${report.coverage.emptyRoles!.join(", ")}` : `- Empty-result roles: ${report.coverage.emptyRoles!.join(", ")}`] : []),
        chinese ? `- 报告涉及文件：${report.coverage.reviewedFiles}（引用 ${report.coverage.citedFiles ?? report.coverage.reviewedFiles}，显式指定 ${report.coverage.explicitFiles ?? report.coverage.reviewedFiles}）` : `- Files represented in report: ${report.coverage.reviewedFiles} (${report.coverage.citedFiles ?? report.coverage.reviewedFiles} cited, ${report.coverage.explicitFiles ?? report.coverage.reviewedFiles} explicitly scoped)`,
        chinese ? `- 未完成阶段：${report.coverage.omittedStages.join(", ") || "无"}` : `- Omitted stages: ${report.coverage.omittedStages.join(", ") || "none"}`,
        ...((report.coverage.mutatedFiles ?? 0) > 0 ? [chinese ? `- 评审期间变化的文件：${report.coverage.mutatedFiles}` : `- Files changed during review: ${report.coverage.mutatedFiles}`] : []),
        ...((report.coverage.budgetOverruns ?? 0) > 0 ? [chinese ? `- 预算超限执行：${report.coverage.budgetOverruns}` : `- Budget-overrun executions: ${report.coverage.budgetOverruns}`] : []),
        chinese ? `- 耗时：${(report.run.durationMs / 1000).toFixed(1)} 秒` : `- Duration: ${(report.run.durationMs / 1000).toFixed(1)}s`,
        chinese ? `- 成本：${report.run.costUsd === null ? "未知" : `$${report.run.costUsd.toFixed(3)}`}` : `- Cost: ${report.run.costUsd === null ? "unknown" : `$${report.run.costUsd.toFixed(3)}`}`,
    );
    return `${lines.join("\n")}\n`;
}

function roleCoverageZh(report: ReviewReport): string {
    const usable = report.coverage.usableRoles;
    return usable !== undefined && usable !== report.coverage.completedRoles
        ? `完成 ${report.coverage.completedRoles}/${report.coverage.requestedRoles} 个专家角色，有效 ${usable}/${report.coverage.requestedRoles}`
        : `${report.coverage.completedRoles}/${report.coverage.requestedRoles} 个专家角色`;
}

function roleCoverageEn(report: ReviewReport): string {
    const usable = report.coverage.usableRoles;
    return usable !== undefined && usable !== report.coverage.completedRoles
        ? `${report.coverage.completedRoles}/${report.coverage.requestedRoles} expert roles completed, ${usable}/${report.coverage.requestedRoles} usable`
        : `${report.coverage.completedRoles}/${report.coverage.requestedRoles} expert roles`;
}

function renderStageCoverage(report: ReviewReport, chinese: boolean): string[] {
    if (!report.coverage.stages?.length) return [];
    const labels = chinese
        ? { "independent-review": "独立评审", "cross-review": "交叉评审", devil: "全局反方", integrate: "最终整合" }
        : { "independent-review": "Independent", "cross-review": "Cross Review", devil: "Global Devil", integrate: "Integrator" };
    const entries = report.coverage.stages.map((stage) => {
        const unit = chinese
            ? { roles: " 个角色", findings: " 个问题", executions: " 次执行" }[stage.unit]
            : { roles: " roles", findings: " findings", executions: " executions" }[stage.unit];
        const detail = `${labels[stage.stage]} ${stage.usable}/${stage.planned}${unit}`;
        const exceptions = [stage.failed > 0 ? `${chinese ? "失败" : "failed"} ${stage.failed}` : "", stage.omitted > 0 ? `${chinese ? "省略" : "omitted"} ${stage.omitted}` : ""].filter(Boolean);
        return exceptions.length > 0 ? `${detail} (${exceptions.join(", ")})` : detail;
    });
    return [chinese ? `阶段覆盖：${entries.join(" · ")}` : `Stage coverage: ${entries.join(" · ")}`];
}

function renderFinding(finding: Finding, chinese: boolean): string[] {
    const lines = [
        `### ${severityLabel(finding.severity, chinese)}: ${escapeMarkdown(finding.title)}`,
        "",
        escapeMarkdown(finding.description),
        "",
        chinese
            ? `状态：${statusLabel(finding.status)} | 置信度：${confidenceLabel(finding.confidence)} | 提出角色：${finding.raisedBy.map(escapeMarkdown).join(", ")}`
            : `Status: ${finding.status} | Confidence: ${finding.confidence} | Raised by: ${finding.raisedBy.map(escapeMarkdown).join(", ")}`,
    ];
    if (finding.evidence.length > 0) {
        lines.push("", chinese ? "证据：" : "Evidence:");
        for (const evidence of finding.evidence) lines.push(`- ${renderEvidence(evidence, chinese)}`);
    }
    if (finding.challenges.length > 0) {
        lines.push("", chinese ? "质疑与复核：" : "Challenges:");
        for (const challenge of finding.challenges) lines.push(`- ${escapeMarkdown(challenge.reviewerRoleId)}: ${chinese ? verdictLabel(challenge.verdict) : challenge.verdict} - ${escapeMarkdown(challenge.rationale)}`);
    }
    if (finding.recommendation) lines.push("", `${chinese ? "建议" : "Recommendation"}: ${escapeMarkdown(finding.recommendation)}`);
    lines.push("");
    return lines;
}

function renderEvidence(evidence: EvidenceReference, chinese: boolean): string {
    const verification = `[${chinese ? verificationLabel(evidence.verification) : evidence.verification}]`;
    const reason = evidence.verificationReason ? ` (${escapeMarkdown(evidence.verificationReason)})` : "";
    if (evidence.kind === "code") return `${verification} ${escapeMarkdown(evidence.path)}:${evidence.startLine}${evidence.endLine && evidence.endLine !== evidence.startLine ? `-${evidence.endLine}` : ""}${reason}`;
    if (evidence.kind === "document") return `${verification} ${escapeMarkdown(evidence.path)}${evidence.section ? ` - ${escapeMarkdown(evidence.section)}` : ""}${reason}`;
    return `${verification} ${escapeMarkdown(evidence.source)}${evidence.timestamp ? ` @ ${escapeMarkdown(evidence.timestamp)}` : ""}${reason}`;
}

function section(lines: string[], title: string, values: string[], numbered: boolean): void {
    if (values.length === 0) return;
    lines.push("", `## ${title}`, "");
    values.forEach((value, index) => lines.push(`${numbered ? `${index + 1}.` : "-"} ${escapeMarkdown(value)}`));
}

function escapeMarkdown(value: string): string {
    return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "");
}

function decisionLabel(decision: ReviewReport["decision"], chinese: boolean): string {
    return chinese
        ? { approve: "通过", "request-changes": "需要修改", "needs-investigation": "需要进一步调查" }[decision]
        : { approve: "Approve", "request-changes": "Request Changes", "needs-investigation": "Needs Investigation" }[decision];
}

function titleFromKey(value: string, chinese: boolean): string {
    if (chinese) return {
        regressionRisks: "回归风险",
        testGaps: "测试缺口",
        systemBoundaries: "系统边界",
        keyDataFlows: "关键数据流",
        architecturalTradeoffs: "架构权衡",
        phasedRecommendations: "分阶段建议",
        alternatives: "备选方案",
        tradeoffs: "权衡",
        rolloutAndRollback: "发布与回滚",
        openDecisions: "待决事项",
    }[value] ?? value;
    return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function severityLabel(value: Finding["severity"], chinese: boolean): string {
    return chinese ? { critical: "严重", high: "高", medium: "中", low: "低", info: "提示" }[value] : value.toUpperCase();
}

function statusLabel(value: Finding["status"]): string {
    return { proposed: "待验证", verified: "已验证", disputed: "有争议", rejected: "已驳回", unsupported: "不受支持" }[value];
}

function confidenceLabel(value: Finding["confidence"]): string {
    return { high: "高", medium: "中", low: "低" }[value];
}

function verdictLabel(value: Finding["challenges"][number]["verdict"]): string {
    return { support: "支持", object: "反对", correct: "需修正", abstain: "弃权" }[value];
}

function verificationLabel(value: EvidenceReference["verification"]): string {
    return { unverified: "未验证", verified: "已验证", stale: "已过期", invalid: "无效", unavailable: "不可用" }[value];
}
