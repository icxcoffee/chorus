import { parseExecutionPayload } from "../workflows/parsing.js";

export function isReviewerInspectionGap(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (/^(?:source|repository|file) inspection (?:stopped|stalled|failed|was interrupted)/.test(normalized)) return true;
    if (/(?:no|without|unavailable) (?:repository |source |filesystem |file )?(?:access|tools?)/.test(normalized)) return true;
    if (/(?:unable|could not|couldn't|failed) to (?:access|inspect|read|review|verify).*(?:source|repository|files?|code)/.test(normalized)) return true;
    if (normalized.startsWith("review coverage incomplete:") && /(?:source|repository|files?|tools?|evidence)/.test(normalized)) return true;
    if (/(?:当前会话)?未提供.*(?:文件读取|源码|源代码|仓库|工具)/.test(value)) return true;
    const hasChineseLimitation = /(?:无法|未能|不能|尚未|未完成|中断|缺少|不可用)/.test(value);
    const hasChineseInspectionTarget = /(?:源码|源代码|仓库|文件|代码|工具|证据|数据流)/.test(value);
    const hasChineseInspectionAction = /(?:读取|检查|审阅|核查|访问|验证|核验|执行)/.test(value);
    if (hasChineseLimitation && hasChineseInspectionTarget && hasChineseInspectionAction) return true;
    return value.startsWith("评审覆盖不完整：") && /(?:源码|源代码|仓库|文件|工具|证据)/.test(value);
}

export function isCoverageOnlyIndependentReviewOutput(output: unknown): boolean {
    let payload: unknown;
    try {
        payload = parseExecutionPayload(output);
    } catch {
        return false;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const value = payload as Record<string, unknown>;
    const findings = Array.isArray(value.findings) ? value.findings : [];
    const observations = Array.isArray(value.positiveObservations) ? value.positiveObservations : [];
    const questions = Array.isArray(value.unresolvedQuestions)
        ? value.unresolvedQuestions.filter((item): item is string => typeof item === "string")
        : [];
    return findings.length === 0 && observations.length === 0 && questions.some(isReviewerInspectionGap);
}
