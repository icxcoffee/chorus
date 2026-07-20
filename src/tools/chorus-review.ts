import type { PiLikeContext } from "../pi-context.js";
import { reviewRequestFromInput, runReviewService } from "../review/service.js";
import type { ReviewRoleExecutor } from "../workflows/contracts.js";
import { loadReviewDsl } from "../review/dsl.js";

export async function chorusReviewTool(
    ctx: PiLikeContext,
    rawArgs: unknown,
    onUpdate?: (update: unknown) => void,
    overrides: { executor?: ReviewRoleExecutor; runReviewServiceImpl?: typeof runReviewService } = {},
): Promise<unknown> {
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw new Error("chorus_review requires an object request");
    const args = rawArgs as Record<string, unknown>;
    const definitionPath = typeof args.definitionPath === "string" ? args.definitionPath : undefined;
    const objective = args.objective ?? args.prompt;
    if (!definitionPath && (typeof objective !== "string" || !objective.trim()) && !Array.isArray(objective)) throw new Error("chorus_review requires objective, prompt, or definitionPath");
    const loaded = definitionPath ? await loadReviewDsl(definitionPath, { ...(ctx.cwd ? { baseDir: ctx.cwd, cwd: ctx.cwd } : {}) }) : undefined;
    const request = loaded
        ? { ...loaded.request, ...(args.language === "zh-CN" || args.language === "en" ? { language: args.language } : {}) }
        : reviewRequestFromInput(args, ctx.cwd);
    const service = overrides.runReviewServiceImpl ?? runReviewService;
    const response = await service(ctx, request, {
        ...(overrides.executor ? { executor: overrides.executor } : {}),
        signal: ctx.signal ?? new AbortController().signal,
        ...(loaded ? { definition: loaded.definition } : {}),
        onStageStart: (stage) => onUpdate?.({ message: `chorus review ${stage} running`, stage: { stage, status: "running" } }),
        onStage: (stage) => onUpdate?.({ message: `chorus review ${stage.stage} ${stage.status}`, stage }),
        onExecution: (progress) => onUpdate?.({ message: `chorus review ${progress.roleId} ${progress.status}`, execution: progress }),
    });
    return {
        content: [{ type: "text", text: response.text }],
        details: { kind: "review", ...response },
    };
}
