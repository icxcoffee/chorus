import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewRequest } from "./contracts.js";
import type { ReviewRoleExecutionProgress, ReviewWorkflowResult } from "../workflows/contracts.js";
import { defaultReviewRendererRegistry } from "../renderers/index.js";
import { createReviewCheckpoint } from "./checkpoint.js";
import { redactSensitive } from "../utils/redact.js";
import { mergeActivitySnapshots } from "../utils/activity-log.js";
import { atomicPrivateWrite } from "../utils/private-file.js";

export interface ReviewArtifact {
    label: string;
    path: string;
}

export interface ReviewLiveProgress {
    status: "starting" | "running" | "success" | "degraded" | "error" | "aborted";
    updatedAt: number;
    stage?: { id: string; status: string };
    executions: Record<string, ReviewRoleExecutionProgress>;
    failedExecutions: ReviewRoleExecutionProgress[];
    errorMessage?: string;
}

export class ReviewLiveArtifactWriter {
    private readonly progress: ReviewLiveProgress = { status: "starting", updatedAt: Date.now(), executions: {}, failedExecutions: [] };
    private timer: ReturnType<typeof setTimeout> | undefined;
    private timerDelayMs = Number.POSITIVE_INFINITY;
    private activeWrite: Promise<void> | undefined;
    private dirty = false;
    private dirtyDelayMs = Number.POSITIVE_INFINITY;
    private flushing = false;
    private writeError: unknown;

    constructor(
        private readonly outputDir: string,
        private readonly request: ReviewRequest,
        private readonly options: { textPersistIntervalMs?: number; writeSnapshot?: (path: string, value: string) => Promise<void> } = {},
    ) {}

    async initialize(): Promise<void> {
        await mkdir(this.outputDir, { recursive: true, mode: 0o700 });
        await chmod(this.outputDir, 0o700);
        await atomicPrivateWrite(join(this.outputDir, "review-request.json"), `${JSON.stringify(this.request, null, 2)}\n`);
        await this.performWrite();
    }

    stage(id: string, status: string): void {
        this.progress.status = status === "running" ? "running" : this.progress.status;
        this.progress.stage = { id, status };
        this.schedule(0);
    }

    execution(update: ReviewRoleExecutionProgress): void {
        const current = this.progress.executions[update.roleId];
        const previous = current?.stage === update.stage ? current : undefined;
        const stateChanged = !previous || previous.status !== update.status || update.errorMessage !== undefined;
        this.progress.status = "running";
        this.progress.executions[update.roleId] = {
            ...(previous ?? { roleId: update.roleId, stage: update.stage, status: "running" }),
            ...update,
            ...(update.partialOutput ? { partialOutput: bound(update.partialOutput) } : {}),
            ...(update.activityLog ? { activityLog: bound(mergeActivitySnapshots(previous?.activityLog, update.activityLog)) } : {}),
            ...(update.errorMessage ? { errorMessage: redactSensitive(update.errorMessage) } : {}),
        };
        if (update.status === "error" || update.status === "aborted") {
            const failure = this.progress.executions[update.roleId]!;
            const existing = this.progress.failedExecutions.findIndex((item) => item.roleId === update.roleId && item.stage === update.stage);
            if (existing >= 0) this.progress.failedExecutions[existing] = failure;
            else this.progress.failedExecutions.push(failure);
        }
        this.schedule(stateChanged ? 0 : Math.max(0, this.options.textPersistIntervalMs ?? 500));
    }

    complete(status: ReviewLiveProgress["status"], errorMessage?: string): void {
        this.progress.status = status;
        if (errorMessage) this.progress.errorMessage = redactSensitive(errorMessage);
        this.schedule(0);
    }

    async flush(): Promise<void> {
        this.flushing = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.timerDelayMs = Number.POSITIVE_INFINITY;
        this.dirty = true;
        this.dirtyDelayMs = 0;
        try {
            while (this.activeWrite || this.dirty) {
                if (this.activeWrite) await this.activeWrite.catch(() => undefined);
                else {
                    this.dirty = false;
                    await this.performWrite().catch(() => undefined);
                }
            }
            if (this.writeError) throw this.writeError;
        } finally {
            this.flushing = false;
        }
    }

    private schedule(delayMs: number): void {
        this.progress.updatedAt = Date.now();
        this.dirty = true;
        this.dirtyDelayMs = Math.min(this.dirtyDelayMs, delayMs);
        if (this.flushing || this.activeWrite) return;
        if (this.timer && delayMs >= this.timerDelayMs) return;
        if (this.timer) clearTimeout(this.timer);
        this.timerDelayMs = delayMs;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.timerDelayMs = Number.POSITIVE_INFINITY;
            this.startWrite();
        }, delayMs);
    }

    private startWrite(): void {
        if (this.activeWrite || !this.dirty) return;
        this.dirty = false;
        this.dirtyDelayMs = Number.POSITIVE_INFINITY;
        const pending = this.performWrite();
        this.activeWrite = pending;
        void pending.catch(() => undefined).finally(() => {
            if (this.activeWrite === pending) this.activeWrite = undefined;
            if (this.dirty && !this.flushing) this.schedule(Number.isFinite(this.dirtyDelayMs) ? this.dirtyDelayMs : Math.max(0, this.options.textPersistIntervalMs ?? 500));
        });
    }

    private async performWrite(): Promise<void> {
        this.progress.updatedAt = Date.now();
        const path = join(this.outputDir, "review-progress.json");
        const value = `${JSON.stringify(this.progress, null, 2)}\n`;
        try {
            await (this.options.writeSnapshot ?? atomicPrivateWrite)(path, value);
        } catch (error) {
            this.writeError ??= error;
            throw error;
        }
    }
}

export async function writeReviewArtifacts(args: { result: ReviewWorkflowResult; outputDir: string }): Promise<ReviewArtifact[]> {
    await mkdir(args.outputDir, { recursive: true, mode: 0o700 });
    await chmod(args.outputDir, 0o700);
    const artifacts: ReviewArtifact[] = [];
    const write = async (label: string, fileName: string, value: string): Promise<void> => {
        const path = join(args.outputDir, fileName);
        await atomicPrivateWrite(path, value.endsWith("\n") ? value : `${value}\n`);
        artifacts.push({ label, path });
    };
    await write("review-request", "review-request.json", JSON.stringify(args.result.plan.request, null, 2));
    await write("review-plan", "review-plan.json", JSON.stringify(args.result.plan, null, 2));
    if (args.result.plan.scope.reviewedPatch !== undefined) await write("review-scope-diff", "review-scope.diff", args.result.plan.scope.reviewedPatch);
    for (const [index, stage] of args.result.stages.entries()) await write(`stage-${index}-${stage.stage}`, `stage-${index}-${stage.stage}.json`, JSON.stringify(stage, null, 2));
    for (const [index, execution] of args.result.executions.entries()) {
        await write(`execution-${index}-${execution.roleId}`, `execution-${index}-${sanitize(execution.roleId)}.json`, JSON.stringify(execution, null, 2));
        if (execution.rawOutput) await write(`execution-${index}-${execution.roleId}-raw`, `execution-${index}-${sanitize(execution.roleId)}-raw.txt`, execution.rawOutput);
        if (execution.activityLog) await write(`execution-${index}-${execution.roleId}-activity`, `execution-${index}-${sanitize(execution.roleId)}-activity.txt`, execution.activityLog);
        if (execution.recoveryContext) await write(`execution-${index}-${execution.roleId}-recovery`, `execution-${index}-${sanitize(execution.roleId)}-recovery.txt`, execution.recoveryContext);
    }
    await write("review-report", "review-report.md", defaultReviewRendererRegistry.get("markdown").render(args.result.report));
    await write("review-report-json", "review-report.json", defaultReviewRendererRegistry.get("json").render(args.result.report));
    await write("review-result", "review-result.json", JSON.stringify(args.result, null, 2));
    const checkpoint = await createReviewCheckpoint(args.result, artifacts);
    await write("review-checkpoint", "review-checkpoint.json", JSON.stringify(checkpoint, null, 2));
    return artifacts;
}

function sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "role";
}

function bound(value: string): string {
    const maximum = 80_000;
    return value.length <= maximum ? value : `[older content truncated]\n${value.slice(-maximum)}`;
}
