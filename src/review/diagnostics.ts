import type { ReviewLanguage, ReviewStageId } from "./contracts.js";

const MAX_REPORT_DIAGNOSTICS = 20;

export function compactReviewDiagnostics(messages: string[], limit = MAX_REPORT_DIAGNOSTICS): string[] {
    const groups = new Map<string, { stage: string; role: string; category: string; count: number }>();
    for (const message of messages) {
        const stage = field(message, "stage") ?? "unknown-stage";
        const role = field(message, "role") ?? "unknown-role";
        const category = field(message, "category") ?? classifyLocalDiagnostic(message);
        const key = `${stage}\u0000${role}\u0000${category}`;
        const current = groups.get(key);
        if (current) current.count += 1;
        else groups.set(key, { stage, role, category, count: 1 });
    }
    const compact = [...groups.values()]
        .sort((left, right) => left.stage.localeCompare(right.stage) || left.role.localeCompare(right.role) || left.category.localeCompare(right.category))
        .map((item) => `${item.stage}/${item.role}: ${item.category}${item.count > 1 ? ` (${item.count} occurrences)` : ""}`);
    if (compact.length <= limit) return compact;
    return [...compact.slice(0, Math.max(0, limit - 1)), `${compact.length - limit + 1} additional diagnostic group(s) omitted; inspect stage artifacts`];
}

export function qualifyReviewDiagnostics(stage: ReviewStageId, role: string, messages: string[]): string[] {
    return messages.map((message) => {
        if (field(message, "stage") && field(message, "role")) return message;
        const category = field(message, "category") ?? classifyLocalDiagnostic(message);
        return `stage=${stage} role=${role} category=${category}: ${message}`;
    });
}

export function reviewCoverageGap(stage: ReviewStageId, messages: string[], language: ReviewLanguage = "zh-CN"): string | undefined {
    if (messages.length === 0) return undefined;
    const roles = [...new Set(messages.map((message) => field(message, "role")).filter((role): role is string => Boolean(role)))];
    const subject = roles.length > 0 ? roles.join(", ") : `${messages.length} execution(s)`;
    return language === "en"
        ? `Review coverage incomplete: ${stage} unavailable for ${subject}.`
        : `评审覆盖不完整：${stage} 阶段以下节点不可用：${subject}。`;
}

function field(message: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)${name}=([^\\s:]+)`).exec(message);
    return match?.[1];
}

function classifyLocalDiagnostic(message: string): string {
    if (message.includes("no distinct reviewer")) return "no-distinct-reviewer";
    if (message.includes("unknown finding")) return "unknown-finding";
    if (message.includes("not assigned")) return "not-assigned";
    return "stage-diagnostic";
}
