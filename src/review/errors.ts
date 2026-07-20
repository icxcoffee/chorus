import type { ReviewerAssignment, ReviewStageId } from "./contracts.js";
import { classifyRetryReason, type RetryReason } from "../runtime/retry.js";
import { modelRefToPiArg } from "../utils/models.js";

export type ReviewFailureCategory = RetryReason | "deadline" | "empty-output" | "output-format" | "budget";

export function formatReviewRoleFailure(
    stage: ReviewStageId,
    assignment: ReviewerAssignment,
    error: unknown,
): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("stage=")) return message;
    const model = assignment.resolvedModel ? modelRefToPiArg(assignment.resolvedModel) : "unresolved";
    return `stage=${stage} role=${assignment.roleId} model=${model} category=${reviewFailureCategory(message)}: ${message}`;
}

export function reviewFailureCategory(message: string): ReviewFailureCategory {
    const normalized = message.toLowerCase();
    if (normalized.includes("review budget exceeded") || normalized.includes("tool call limit exceeded") || normalized.includes("turn limit exceeded")) return "budget";
    if (normalized.includes("duration limit") || normalized.includes("deadline")) return "deadline";
    if (normalized.includes("no assistant text") || normalized.includes("empty assistant") || normalized.includes("returned no text")) return "empty-output";
    if (normalized.includes("json") || normalized.includes("payload") || normalized.includes("output.")
        || normalized.includes("reviewer output") || normalized.includes("finding.") || normalized.includes("finding[")
        || normalized.includes("challenge[") || normalized.includes("evidence[") || normalized.includes("startline")
        || normalized.includes("endline") || normalized.includes("raisedby")) return "output-format";
    return classifyRetryReason(new Error(message));
}
