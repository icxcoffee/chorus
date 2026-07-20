import type { PiLikeContext } from "../pi-context.js";
import { resultDirForJob } from "../artifacts.js";
import { registryModels } from "../models/registry.js";
import { loadOrBootstrap } from "../store/config.js";
import { saveConfig } from "../store.js";
import { getJobStore } from "../jobs/store.js";
import { bindJobToHostSignal } from "../runtime/job-runner.js";
import { notify, setChorusStatus, setChorusWidget, showPersistentOptimization, showPersistentResult, showReviewStarted } from "../runtime/pi-ui.js";
import { composePrompt } from "../ui/prompt.js";
import { reviewRequestFromInput, runReviewService } from "../review/service.js";
import { applyReviewerModelOverrides, resolveProfiledReviewerAssignments } from "../review/model-policy.js";
import { renderReviewWidget } from "../render/jobs.js";
import { defaultReviewWorkflowRegistry } from "../workflows/registry.js";
import { parseReviewCommandArgs } from "./review-args.js";
import { loadReviewDsl } from "../review/dsl.js";
import { evaluateReviewPolicy, writeReviewCiSummary } from "../review/ci.js";
import { defaultReviewRendererRegistry } from "../renderers/index.js";
import { configureReviewSettings, describeReviewSettings, type ReviewComposerSettings } from "../ui/review.js";
import { applyReviewRoleModelPreferences } from "../review/preferences.js";
import { reviewExecutionStatus } from "../review/status.js";
import { registerBuiltinReviewComponents } from "../workflows/builtins.js";

export async function handleReview(ctx: PiLikeContext, rawArgs: string, overrides: { runReviewServiceImpl?: typeof runReviewService } = {}): Promise<void> {
    registerBuiltinReviewComponents();
    const registry = await registryModels(ctx);
    let config = await loadOrBootstrap(ctx, registry);
    const active = config.presets.find((preset) => preset.name === config.activePresetName) ?? config.presets[0];
    let parsed;
    try { parsed = parseReviewCommandArgs(rawArgs, defaultReviewWorkflowRegistry.list().map((workflow) => workflow.definition.id), ctx.cwd); }
    catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); return; }
    let loaded;
    try { loaded = parsed.definitionPath ? await loadReviewDsl(parsed.definitionPath, { ...(ctx.cwd ? { baseDir: ctx.cwd, cwd: ctx.cwd } : {}) }) : undefined; }
    catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); return; }
    let objective = parsed.objective || loaded?.request.objective.join("; ") || "";
    let reviewSettings: ReviewComposerSettings = {
        workflow: parsed.workflow ?? loaded?.request.workflow ?? "code-review",
        profile: parsed.profile ?? loaded?.request.profile ?? "quick",
        scope: parsed.scope ?? loaded?.request.scope ?? { kind: "repository", ...(ctx.cwd ? { root: ctx.cwd } : {}) },
        renderer: parsed.renderer ?? loaded?.request.renderer ?? "markdown",
        language: parsed.language ?? loaded?.request.language ?? "zh-CN",
        ...(!loaded && active?.reviewRoleModels ? { roleModels: structuredClone(active.reviewRoleModels) } : {}),
    };
    let originalObjective = objective;
    if (!objective) {
        const composed = await composePrompt({
            ui: ctx.ui ?? {},
            title: "Chorus Review",
            placeholder: "Optional focus (blank = workflow default)",
            allowEmpty: true,
            registry,
            signal: ctx.signal ?? new AbortController().signal,
            ...(active?.conductor ? { model: active.conductor } : {}),
            ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
            onOptimized: (result) => showPersistentOptimization(ctx, result, "Chorus Review"),
            context: () => describeReviewSettings(reviewSettings),
            ...(!loaded ? {
                configureLabel: "Settings",
                onConfigure: async () => {
                    const configured = await configureReviewSettings({
                        ui: ctx.ui ?? {},
                        workflows: defaultReviewWorkflowRegistry.list(),
                        renderers: defaultReviewRendererRegistry.list(),
                        models: registry,
                        initial: reviewSettings,
                    });
                    if (configured) {
                        reviewSettings = configured;
                        try {
                            config = applyReviewRoleModelPreferences(config, active?.name ?? config.activePresetName, configured.roleModels);
                            await saveConfig(config, ctx.storePaths, registry);
                        } catch (error) {
                            notify(ctx, `Review settings applied for this run, but model defaults could not be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
                        }
                    }
                },
            } : {}),
        });
        if (!composed) return;
        originalObjective = composed.original;
        objective = composed.prompt || defaultReviewObjective(reviewSettings.workflow);
    }
    const request = loaded
        ? { ...loaded.request, ...(parsed.language ? { language: parsed.language } : {}), objective: loaded.request.objective.length ? loaded.request.objective : [objective] }
        : reviewRequestFromInput({ ...reviewSettings, objective, constraints: parsed.constraints }, ctx.cwd);
    const workflow = defaultReviewWorkflowRegistry.get(request.workflow);
    const definitionOverride = applyReviewerModelOverrides(loaded?.definition ?? workflow.definition, reviewSettings.roleModels);
    const assignments = resolveProfiledReviewerAssignments(definitionOverride, request.profile, registry).assignments;
    const jobs = getJobStore(ctx);
    await jobs.initialize(ctx.storePaths ?? {});
    const job = jobs.create({
        kind: "review",
        title: "Chorus Review",
        presetName: active?.name ?? config.activePresetName,
        prompt: originalObjective || objective,
        ...(originalObjective && originalObjective !== objective ? { optimizedPrompt: objective } : {}),
        command: `/chorus review ${request.workflow} ${objective}`,
        voices: assignments.map((assignment) => ({ model: assignment.resolvedModel! })),
        actorIds: assignments.map((assignment) => assignment.roleId),
        actorLabels: assignments.map((assignment) => `${assignment.roleId} ${assignment.resolvedModel?.provider}/${assignment.resolvedModel?.modelId}`),
        reviewRequest: request,
        reviewDefinition: definitionOverride,
    });
    const outputDir = resultDirForJob(job.id, ctx.storePaths);
    showReviewStarted(ctx, { jobId: job.id, presetName: job.presetName, request, assignments: assignments.map((assignment) => ({ roleId: assignment.roleId, model: assignment.resolvedModel! })), outputDir });
    setChorusWidget(ctx, renderReviewWidget(job));
    setChorusStatus(ctx, "review starting");
    const unbind = bindJobToHostSignal(job, ctx.signal);
    void (async () => {
        try {
            const response = await (overrides.runReviewServiceImpl ?? runReviewService)(ctx, request, {
                jobId: job.id,
                signal: job.abortController.signal,
                ...(loaded || reviewSettings.roleModels ? { definition: definitionOverride } : {}),
                onStageStart: (stage) => {
                    jobs.updateReviewStage(job.id, stage, "running");
                    setChorusStatus(ctx, `${stage} running`);
                    setChorusWidget(ctx, renderReviewWidget(job));
                },
                onStage: (stage) => {
                    jobs.updateReviewStage(job.id, stage.stage, stage.status);
                    setChorusStatus(ctx, `${stage.stage} ${stage.status}`);
                    setChorusWidget(ctx, renderReviewWidget(job));
                },
                onExecution: (progress) => {
                    jobs.updateReviewExecution(job.id, progress);
                    setChorusWidget(ctx, renderReviewWidget(job));
                },
            });
            const status = job.abortController.signal.aborted ? "aborted" : reviewExecutionStatus(response.result);
            jobs.finishReview(job.id, response.result, response.text, response.artifacts, status);
            const ci = parsed.failOn ? evaluateReviewPolicy(response.result.report, { failOn: parsed.failOn, minimumConfidence: "medium", requireVerifiedEvidence: true, incomplete: "fail" }) : undefined;
            if (ci && parsed.summaryPath) await writeReviewCiSummary(parsed.summaryPath, ci);
            showPersistentResult(ctx, response.text, { kind: "review", jobId: job.id, report: response.result.report, artifacts: response.artifacts, ...(ci ? { ci } : {}) });
            if (ci?.exitCode) notify(ctx, `review CI policy exit code: ${ci.exitCode}`, "warning");
            setChorusStatus(ctx, `review ${status}: ${response.result.report.decision}`);
        } catch (error) {
            jobs.fail(job.id, error);
            notify(ctx, [
                "Chorus review failed",
                `Job: ${job.id}`,
                `Stage: ${job.reviewStage?.id ?? "startup"}`,
                `Cause: ${error instanceof Error ? error.message : String(error)}`,
                `Artifacts: ${outputDir}`,
                `Inspect: /chorus watch ${job.id}`,
            ].join("\n"), "error");
            setChorusStatus(ctx, "review failed");
        } finally {
            await jobs.flush().catch(() => undefined);
            unbind();
            setChorusWidget(ctx, undefined);
        }
    })();
}

export function defaultReviewObjective(workflowId: string): string {
    registerBuiltinReviewComponents();
    return defaultReviewWorkflowRegistry.get(workflowId).definition.objective ?? "Find material review issues in the declared scope.";
}
