import { randomUUID } from "node:crypto";
import type { PiLikeContext } from "../pi-context.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { resultDirForJob } from "../artifacts.js";
import type { ReviewArtifact, ReviewRequest, ReviewStageResult } from "./index.js";
import { parseReviewRequest } from "./validation.js";
import { createSubagentReviewExecutor } from "./executor.js";
import { runReview } from "./runner.js";
import { ReviewLiveArtifactWriter, writeReviewArtifacts } from "./artifacts.js";
import { defaultReviewRendererRegistry } from "../renderers/index.js";
import type { ReviewRoleExecutionProgress, ReviewRoleExecutor, ReviewWorkflowResult } from "../workflows/contracts.js";
import { reviewExecutionStatus } from "./status.js";
import { DEFAULT_MAX_CONCURRENCY } from "../runtime/scheduler.js";

export interface RunReviewServiceResult {
    request: ReviewRequest;
    result: ReviewWorkflowResult;
    text: string;
    artifacts: ReviewArtifact[];
    outputDir: string;
}

export async function runReviewService(ctx: PiLikeContext, rawRequest: unknown, options: {
    jobId?: string;
    signal?: AbortSignal;
    executor?: ReviewRoleExecutor;
    onStage?: (stage: ReviewStageResult) => void;
    onStageStart?: (stage: ReviewStageResult["stage"]) => void;
    onExecution?: (progress: ReviewRoleExecutionProgress) => void;
    writeArtifactsImpl?: typeof writeReviewArtifacts;
    reuse?: ReviewWorkflowResult;
    definition?: import("./contracts.js").ReviewDefinition;
} = {}): Promise<RunReviewServiceResult> {
    const request = parseReviewRequest(rawRequest);
    const registry = await registryModels(ctx);
    const config = await loadOrBootstrap(ctx, registry);
    const active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
    const signal = options.signal ?? ctx.signal ?? new AbortController().signal;
    const outputDir = resultDirForJob(options.jobId ?? `review-${randomUUID().slice(0, 8)}`, ctx.storePaths);
    const liveArtifacts = new ReviewLiveArtifactWriter(outputDir, request);
    await liveArtifacts.initialize();
    const executor = options.executor ?? createSubagentReviewExecutor({
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        ...(active?.voiceTimeoutMs ? { timeoutMs: active.voiceTimeoutMs } : {}),
        permissionProfile: active?.permissionProfile ?? "read-only",
    });
    const defaultProviderLimits = Object.fromEntries(registry.map((model) => [model.provider, 1]));
    try {
        const result = await runReview({
            request,
            registry,
            executor,
            signal,
            ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
            onStageStart: (stage) => { liveArtifacts.stage(stage, "running"); options.onStageStart?.(stage); },
            onStage: (stage) => { liveArtifacts.stage(stage.stage, stage.status); options.onStage?.(stage); },
            onExecution: (progress) => { liveArtifacts.execution(progress); options.onExecution?.(progress); },
            executionPolicy: {
                maxConcurrency: active?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
                providerLimits: { ...defaultProviderLimits, ...(active?.providerConcurrency ?? {}) },
            },
            ...(options.reuse ? { reuse: options.reuse } : {}),
            ...(options.definition ? { definition: options.definition } : {}),
        });
        liveArtifacts.complete(signal.aborted ? "aborted" : reviewExecutionStatus(result));
        await liveArtifacts.flush();
        const artifacts = await (options.writeArtifactsImpl ?? writeReviewArtifacts)({ result, outputDir });
        const text = defaultReviewRendererRegistry.get(request.renderer).render(result.report);
        return { request, result, text, artifacts, outputDir };
    } catch (error) {
        liveArtifacts.complete(signal.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
        await liveArtifacts.flush().catch(() => undefined);
        throw error;
    }
}

export function reviewRequestFromInput(args: {
    workflow?: unknown;
    objective?: unknown;
    prompt?: unknown;
    constraints?: unknown;
    scope?: unknown;
    profile?: unknown;
    renderer?: unknown;
    language?: unknown;
}, cwd?: string): ReviewRequest {
    const objectiveValue = args.objective ?? args.prompt;
    const objective = typeof objectiveValue === "string" ? [objectiveValue] : objectiveValue;
    const scope = args.scope ?? { kind: "repository", ...(cwd ? { root: cwd } : {}) };
    return parseReviewRequest({
        version: 1,
        workflow: args.workflow ?? "code-review",
        objective: objective ?? [],
        constraints: args.constraints ?? [],
        scope,
        profile: args.profile ?? "quick",
        renderer: args.renderer ?? "markdown",
        language: args.language ?? "zh-CN",
    });
}
