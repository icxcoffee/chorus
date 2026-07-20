import type { ReviewReport } from "./contracts.js";
import type { ReviewWorkflowResult } from "../workflows/contracts.js";

export type ReviewExecutionStatus = "success" | "degraded";

export function reviewExecutionStatus(result: ReviewWorkflowResult): ReviewExecutionStatus {
    if (reviewReportExecutionStatus(result.report) === "degraded") return "degraded";
    return result.stages.some((stage) => stage.status === "partial" || stage.status === "error" || stage.status === "aborted")
        ? "degraded"
        : "success";
}

export function reviewReportExecutionStatus(report: ReviewReport): ReviewExecutionStatus {
    if (report.coverage.completedRoles < report.coverage.requestedRoles) return "degraded";
    if ((report.coverage.usableRoles ?? report.coverage.completedRoles) < report.coverage.requestedRoles) return "degraded";
    if ((report.coverage.mutatedFiles ?? 0) > 0) return "degraded";
    if ((report.coverage.budgetOverruns ?? 0) > 0) return "degraded";
    return report.coverage.omittedStages.some((stage) => stage !== "devil") ? "degraded" : "success";
}
