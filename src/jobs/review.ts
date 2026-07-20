import type { ChorusJob } from "../jobs.js";
import type { ReviewArtifact } from "../review/index.js";
import type { ReviewRoleExecutionProgress, ReviewWorkflowResult } from "../workflows/contracts.js";
import { modelRefToPiArg } from "../utils/models.js";
import { redactSensitive } from "../utils/redact.js";
import { mergeActivitySnapshots } from "../utils/activity-log.js";

const MAX_PROGRESS_CHARS = 80_000;

export function applyReviewCompletion(job: ChorusJob, result: ReviewWorkflowResult, renderedText: string, artifacts: ReviewArtifact[], status: "success" | "degraded" | "aborted"): void {
    job.status = status;
    job.finishedAt = Date.now();
    job.reviewResult = result;
    job.reviewArtifacts = artifacts;
    job.renderedText = renderedText;
    job.voices = job.voices.map((voice, index) => {
        const executions = result.executions.filter((execution) => execution.roleId === voice.roleId);
        const last = executions.at(-1);
        const output = executions.map((execution) => `## ${execution.stage}\n${typeof execution.output === "string" ? execution.output : JSON.stringify(execution.output)}`).join("\n\n");
        const finalStatus = reviewRoleStatus(voice, result, status);
        const stage = roleStage(voice.roleId, result);
        const primaryExecution = executions.filter((execution) => execution.stage === stage?.stage).at(-1);
        const skippedOutput = finalStatus === "skipped" ? stage?.diagnostics.join("\n") || "Review stage skipped." : undefined;
        const roleFailure = finalStatus === "error" || finalStatus === "aborted"
            ? stage?.diagnostics.find((diagnostic) => !voice.roleId || diagnostic.includes(`role=${voice.roleId}`) || diagnostic.includes(`/${voice.roleId}:`))
            : undefined;
        const { errorMessage: _errorMessage, partialOutput: _partialOutput, activityLog: _activityLog, output: _output, durationMs: _durationMs, costUsd: _costUsd, ...rest } = voice;
        const finalError = roleFailure ?? _errorMessage;
        return {
            ...rest,
            index,
            label: last?.model ? `${voice.roleId ?? last.roleId} ${modelRefToPiArg(last.model)}` : voice.label,
            status: finalStatus,
            ...(output ? { output } : skippedOutput ? { output: skippedOutput } : {}),
            ...(primaryExecution ? { durationMs: primaryExecution.durationMs, costUsd: primaryExecution.costUsd } : {}),
            ...((finalStatus === "error" || finalStatus === "aborted") && finalError ? { errorMessage: finalError } : {}),
        };
    });
    job.reviewStage = { id: "integrate", status };
    job.conductor = { status: result.report ? "success" : "error", partialOutput: result.report.executiveSummary };
}

function reviewRoleStatus(voice: ChorusJob["voices"][number], result: ReviewWorkflowResult, jobStatus: "success" | "degraded" | "aborted"): ChorusJob["voices"][number]["status"] {
    const stage = roleStage(voice.roleId, result);
    if (stage?.status === "skipped") return "skipped";
    if (voice.status === "error" || voice.status === "aborted") return voice.status;
    if (jobStatus === "aborted" || stage?.status === "aborted") return "aborted";
    if (stage?.stage === "independent-review") {
        const roleCoverage = stage.output && typeof stage.output === "object" && !Array.isArray(stage.output)
            ? stage.output as { completedRoles?: unknown; usableRoles?: unknown; emptyRoles?: unknown }
            : undefined;
        if (!voice.roleId || !Array.isArray(roleCoverage?.completedRoles) || !roleCoverage.completedRoles.includes(voice.roleId)) return "error";
        if (Array.isArray(roleCoverage.usableRoles) && roleCoverage.usableRoles.includes(voice.roleId)) return "success";
        if (Array.isArray(roleCoverage.emptyRoles) && roleCoverage.emptyRoles.includes(voice.roleId)) return "empty";
        return "success";
    }
    if (stage?.status === "success") return "success";
    return voice.status === "success" ? "success" : "error";
}

function roleStage(roleId: string | undefined, result: ReviewWorkflowResult) {
    const stageId = roleId === "devil" ? "devil" : roleId === "integrator" ? "integrate" : "independent-review";
    return result.stages.find((stage) => stage.stage === stageId);
}

export function applyReviewStage(job: ChorusJob, stage: string, status: string): void {
    job.reviewStage = { id: stage, status };
}

export function applyReviewExecution(job: ChorusJob, update: ReviewRoleExecutionProgress): void {
    const voice = job.voices.find((candidate) => candidate.roleId === update.roleId);
    if (!voice) return;
    if (voice.stage !== update.stage) {
        voice.stage = update.stage;
        delete voice.partialOutput;
        delete voice.activityLog;
        delete voice.output;
        delete voice.errorMessage;
        delete voice.durationMs;
        delete voice.costUsd;
    }
    if (update.model) voice.label = `${update.roleId} ${modelRefToPiArg(update.model)}`;
    voice.status = update.status;
    if (update.status === "success") delete voice.errorMessage;
    if (update.partialOutput !== undefined) voice.partialOutput = retain(update.partialOutput);
    if (update.activityLog !== undefined) voice.activityLog = retain(mergeActivitySnapshots(voice.activityLog, update.activityLog));
    if (update.errorMessage !== undefined) voice.errorMessage = redactSensitive(update.errorMessage);
    if (update.durationMs !== undefined) voice.durationMs = update.durationMs;
    if (update.costUsd !== undefined) voice.costUsd = update.costUsd;
}

export function applyReviewFailure(job: ChorusJob, status: "error" | "aborted", message: string): void {
    for (const voice of job.voices) {
        if (voice.status !== "pending" && voice.status !== "running") continue;
        voice.status = status;
        voice.errorMessage ??= status === "aborted" ? "review cancelled before this role completed" : `review stopped before this role completed: ${message}`;
    }
    job.conductor = { status, errorMessage: message };
}

function retain(value: string): string {
    if (value.length <= MAX_PROGRESS_CHARS) return value;
    return `[older content truncated]\n${value.slice(-MAX_PROGRESS_CHARS)}`;
}
