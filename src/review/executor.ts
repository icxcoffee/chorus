import type { RegistryLike } from "../types.js";
import { runSubagentVoice, type SubagentVoiceArgs } from "../subagent.js";
import { buildReviewerSystemPrompt } from "../roles/registry.js";
import { ReviewRoleExecutionFailure, type ReviewRoleExecution, type ReviewRoleExecutor } from "../workflows/contracts.js";
import { classifyRetryReason, isRetryable, retry, RetryError, type RetryPolicy } from "../runtime/retry.js";
import { modelRefToPiArg } from "../utils/models.js";
import { redactSensitive } from "../utils/redact.js";
import { parseExecutionPayload, parseFindingProposal } from "../workflows/parsing.js";
import type { ModelRef, VoiceResult } from "../types.js";
import { reviewFailureCategory } from "./errors.js";
import { isCoverageOnlyIndependentReviewOutput } from "./coverage.js";

export function createSubagentReviewExecutor(options: {
    cwd?: string;
    timeoutMs?: number;
    permissionProfile?: SubagentVoiceArgs["permissionProfile"];
    runSubagentVoiceImpl?: typeof runSubagentVoice;
    retryPolicy?: RetryPolicy;
} = {}): ReviewRoleExecutor {
    const run = options.runSubagentVoiceImpl ?? runSubagentVoice;
    return {
        async execute(args) {
            if (!args.assignment.resolvedModel) throw new Error(`reviewer role ${args.role.id} has no resolved model`);
            const startedAt = Date.now();
            const models = [args.assignment.resolvedModel, ...(args.assignment.resolvedFallbackModels ?? [])];
            const retryPolicy: RetryPolicy = {
                maxAttempts: 3,
                baseDelayMs: 2_000,
                maxDelayMs: 15_000,
                jitter: 0.2,
                ...(options.retryPolicy ?? {}),
            };
            const integrateWithoutTools = args.stage === "integrate";
            let totalInputTokens = 0;
            let totalOutputTokens = 0;
            let totalCostUsd: number | null = 0;
            const executeAttempt = async (prompt: string, model: ModelRef, disableTools = false) => {
                const result = await run({
                    voice: { model, role: "reasoning" },
                    prompt: args.maxOutputTokens
                        ? `${prompt}\n\nOUTPUT BUDGET: Return the mandatory final JSON within approximately ${args.maxOutputTokens} output tokens. Prioritize source-backed conclusions and omit repetition.`
                        : prompt,
                    systemPrompt: buildReviewerSystemPrompt(args.role, args.stage),
                    timeoutMs: options.timeoutMs ?? 1_800_000,
                    timeoutMode: "inactivity",
                    ...(args.maxToolCalls !== undefined ? { maxToolCalls: args.maxToolCalls } : {}),
                    ...(args.maxTurns !== undefined ? { maxTurns: disableTools ? Math.min(4, args.maxTurns) : args.maxTurns } : {}),
                    signal: args.signal,
                    onProgress: (update) => {
                        if (update.status !== "running") return;
                        args.onProgress?.({
                            roleId: args.role.id,
                            stage: args.stage,
                            status: "running",
                            model,
                            ...(update.status === "running" ? { errorMessage: "" } : {}),
                            ...(update.partialOutput !== undefined ? { partialOutput: update.partialOutput } : {}),
                            ...(update.activityLog !== undefined ? { activityLog: update.activityLog } : {}),
                            ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage } : {}),
                            ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
                            ...(update.costUsd !== undefined ? { costUsd: update.costUsd } : {}),
                        });
                    },
                    ...(options.cwd ? { cwd: options.cwd } : {}),
                    permissionProfile: options.permissionProfile ?? "read-only",
                    retainRecoveryContext: true,
                    ...(disableTools ? { disableTools: true } : {}),
                });
                totalInputTokens += result.usage?.input ?? 0;
                totalOutputTokens += result.usage?.output ?? 0;
                totalCostUsd = totalCostUsd === null || result.costUsd === null ? null : totalCostUsd + result.costUsd;
                return result;
            };
            let totalAttempts = 0;
            let lastObservedResult: VoiceResult | undefined;
            const executeWithRetry = async (prompt: string, model: ModelRef, disableTools = false) => {
                try {
                    return (await retry(async (attempt) => {
                        totalAttempts += 1;
                        const result = await executeAttempt(prompt, model, disableTools);
                        lastObservedResult = mergeObservedResult(lastObservedResult, result);
                        const message = result.errorMessage ?? `${args.role.id} reviewer ${result.status}`;
                        const reason = classifyRetryReason(new Error(message));
                        if (result.status === "error" && reason !== "timeout" && isRetryable(reason) && !args.signal.aborted) {
                            throw new RetryError(message, retryAfterMs(message));
                        }
                        return result;
                    }, {
                        ...retryPolicy,
                        onRetry: (attempt) => {
                            retryPolicy.onRetry?.(attempt);
                            const label = modelRefToPiArg(model);
                            const message = `[retry] stage=${args.stage} role=${args.role.id} model=${label} attempt=${attempt.attempt + 1}/${retryPolicy.maxAttempts} reason=${attempt.reason ?? "unknown"} waiting=${attempt.delayMs}ms`;
                            args.onProgress?.({ roleId: args.role.id, stage: args.stage, status: "running", model, activityLog: message, errorMessage: message });
                        },
                    }, args.signal)).value;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const reason = classifyRetryReason(error);
                    throw new Error(`stage=${args.stage} role=${args.role.id} model=${modelRefToPiArg(model)} modelCalls=${totalAttempts} retryAttemptsPerCall=${retryPolicy.maxAttempts} category=${reason}: ${message}`);
                }
            };
            let lastResult: VoiceResult | undefined;
            let lastModel = args.assignment.resolvedModel;
            for (const [modelIndex, model] of models.entries()) {
                lastModel = model;
                if (args.signal.aborted) break;
                if (modelIndex > 0) {
                    const message = `[fallback] stage=${args.stage} role=${args.role.id} model=${modelRefToPiArg(model)} after=${lastResult?.errorMessage ?? "previous model failed"}`;
                    args.onProgress?.({ roleId: args.role.id, stage: args.stage, status: "running", model, activityLog: message, errorMessage: message });
                }
                let result: VoiceResult;
                try {
                    await args.switchProvider?.(model.provider);
                    result = await executeWithRetry(modelIndex === 0 ? args.prompt : fallbackPrompt(args.prompt), model, integrateWithoutTools);
                    if (shouldRetryEmptyInspection(result, args.stage) && !args.signal.aborted) {
                        const message = `[retry] stage=${args.stage} role=${args.role.id} model=${modelRefToPiArg(model)} reason=empty inspection produced no recoverable material; retrying source inspection once.`;
                        args.onProgress?.({ roleId: args.role.id, stage: args.stage, status: "running", model, activityLog: message, errorMessage: message });
                        result = await executeWithRetry(freshInspectionPrompt(args.prompt), model, false);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    lastResult = timeoutResult(model, startedAt, message);
                    if (modelIndex < models.length - 1 && canUseFallback(classifyRetryReason(error), message)) continue;
                    throw executionFailure(message, args.role.id, args.stage, model, startedAt, totalCostUsd, totalInputTokens, totalOutputTokens, lastObservedResult);
                }
                const salvaged = salvageOutput(result, args.stage, args.role.id, args.language);
                if (salvaged) {
                    if (args.stage === "independent-review" && modelIndex < models.length - 1 && isCoverageOnlyIndependentReviewOutput(salvaged)) {
                        lastResult = { ...result, errorMessage: "coverage-only reviewer output" };
                        continue;
                    }
                    return executionFromResult(args.role.id, args.stage, model, salvaged, startedAt, totalCostUsd, totalInputTokens, totalOutputTokens, lastObservedResult);
                }
                if (shouldFinalize(result) && !args.signal.aborted) {
                    const interruptedResult = result;
                    const message = `[recovery] stage=${args.stage} role=${args.role.id} model=${modelRefToPiArg(model)} source inspection stalled or ended without a usable final response; retrying bounded finalization without tools.`;
                    args.onProgress?.({ roleId: args.role.id, stage: args.stage, status: "running", model, activityLog: message, errorMessage: message });
                    try {
                        result = await executeWithRetry(recoveryPrompt(args.prompt, result, args.stage, args.role.id, args.role.findingCategories, args.language), model, true);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        lastResult = timeoutResult(model, startedAt, message);
                        if (modelIndex < models.length - 1 && canUseFallback(classifyRetryReason(error), message)) continue;
                        throw executionFailure(message, args.role.id, args.stage, model, startedAt, totalCostUsd, totalInputTokens, totalOutputTokens, lastObservedResult);
                    }
                    const recovered = salvageOutput(result, args.stage, args.role.id, args.language);
                    if (recovered) {
                        const retained = retainRecoveryGap(recovered, args.stage, interruptedResult, args.language);
                        if (args.stage === "independent-review" && modelIndex < models.length - 1 && isCoverageOnlyIndependentReviewOutput(retained)) {
                            lastResult = { ...result, errorMessage: "coverage-only reviewer recovery" };
                            continue;
                        }
                        return executionFromResult(args.role.id, args.stage, model, retained, startedAt, totalCostUsd, totalInputTokens, totalOutputTokens, lastObservedResult);
                    }
                }
                lastResult = result;
                const reason = classifyRetryReason(new Error(result.errorMessage ?? `${args.role.id} reviewer ${result.status}`));
                const unusableSuccessfulOutput = result.status === "success" && !result.errorMessage;
                if ((!unusableSuccessfulOutput && !canUseFallback(reason, result.errorMessage)) || modelIndex === models.length - 1) break;
            }
            const unusableOutput = lastResult && !lastResult.errorMessage;
            const message = lastResult?.errorMessage ?? (args.signal.aborted
                ? "review execution cancelled"
                : `reviewer output did not satisfy the ${args.stage} structured JSON contract`);
            const category = unusableOutput ? "output-format" : reviewFailureCategory(message);
            const failureMessage = `stage=${args.stage} role=${args.role.id} model=${modelRefToPiArg(lastModel)} modelCalls=${totalAttempts} retryAttemptsPerCall=${retryPolicy.maxAttempts} category=${category}: ${message}`;
            throw executionFailure(failureMessage, args.role.id, args.stage, lastModel, startedAt, totalCostUsd, totalInputTokens, totalOutputTokens, lastObservedResult ?? lastResult);
        },
    };
}

function retryAfterMs(message: string): number | undefined {
    const seconds = /retry(?:-|\s+)after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i.exec(message);
    if (seconds) return Math.min(60_000, Math.max(0, Math.round(Number(seconds[1]) * 1_000)));
    const milliseconds = /retry(?:-|\s+)after\s*[:=]?\s*(\d+)\s*ms/i.exec(message);
    if (milliseconds) return Math.min(60_000, Math.max(0, Number(milliseconds[1])));
    const headerSeconds = /retry-after\s*[:=]\s*(\d+(?:\.\d+)?)(?!\s*(?:ms|s))/i.exec(message);
    if (headerSeconds) return Math.min(60_000, Math.max(0, Math.round(Number(headerSeconds[1]) * 1_000)));
    return undefined;
}

function recoveryPrompt(original: string, result: VoiceResult, stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"], roleId: string, categories: string[], language?: Parameters<ReviewRoleExecutor["execute"]>[0]["language"]): string {
    const recovered = [result.partialOutput, result.recoveryContext, tail(result.activityLog, 8_000)].filter(Boolean).join("\n\n");
    const referenceTask = stage === "independent-review" ? "" : `\n\n<reference-task>\n${tail(original, 16_000)}\n</reference-task>`;
    return `RECOVERY FINALIZATION ONLY. Source inspection has ended and tools are unavailable. Do not continue analysis, emit tool calls, XML, Markdown fences, or prose. Return exactly one concise JSON object matching this contract: ${recoveryContract(stage, roleId, categories, language)}. ${recoveryLanguageInstruction(language)} Use only claims supported by recovered material. Translate human-readable claims when needed, while preserving code identifiers, paths, model IDs, enum values, and evidence excerpts exactly. For independent review, return at most one finding with at most four evidence items. If evidence is incomplete, return an empty result and describe the coverage gap in unresolvedQuestions.${referenceTask}\n\n<recovered-material>\n${recovered || "No prior material was recoverable."}\n</recovered-material>`;
}

function recoveryContract(stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"], roleId: string, categories: string[], language?: Parameters<ReviewRoleExecutor["execute"]>[0]["language"]): string {
    const chinese = language === "zh-CN";
    if (stage === "independent-review") return `{"findings":[{"id":"${roleId}-1","title":"${chinese ? "具体缺陷标题" : "Concrete defect title"}","description":"${chinese ? "有源码支持的影响与触发条件" : "Source-backed impact and trigger"}","category":"${categories[0] ?? "correctness"}","severity":"medium","confidence":"medium","status":"proposed","evidence":[{"id":"${roleId}-1-evidence-1","kind":"code","path":"relative/file.ts","startLine":1,"endLine":2,"excerpt":"exact source excerpt"},{"id":"${roleId}-1-evidence-2","kind":"document","path":"package.json","excerpt":"exact supporting excerpt"}],"raisedBy":["${roleId}"],"challenges":[],"recommendation":"${chinese ? "具体且兼容的修复方案" : "specific compatible fix"}"}],"positiveObservations":["${chinese ? "简洁描述" : "plain descriptive text"}"],"unresolvedQuestions":["${chinese ? "待确认问题" : "plain question text"}"]}. Use empty arrays when there are no supported items`;
    if (stage === "cross-review") return `{"findingId":"...","verdict":"abstain","rationale":"...","evidence":[]}`;
    if (stage === "devil") return `{"challenges":[],"findings":[],"missingAreas":[]}`;
    return `{"executiveSummary":"...","positiveObservations":[],"resolvedQuestionIds":[],"newUnresolvedQuestions":[],"sections":{},"findingResolutions":[]}`;
}

function recoveryLanguageInstruction(language?: Parameters<ReviewRoleExecutor["execute"]>[0]["language"]): string {
    if (language === "zh-CN") return "Every human-readable JSON string value MUST be in Simplified Chinese; English prose will be rejected.";
    if (language === "en") return "Every human-readable JSON string value MUST be in English; Chinese prose will be rejected.";
    return "";
}

function fallbackPrompt(original: string): string {
    return `${original}\n\nFALLBACK REQUIREMENT: A previous model failed. Use at most 6 targeted tool calls, then return the mandatory JSON. Prefer a small, valid, evidence-backed result over broad exploration.`;
}

function freshInspectionPrompt(original: string): string {
    return `${original}\n\nRETRY REQUIREMENT: The previous attempt returned no assistant content and inspected no source. Start the source inspection again, then return the mandatory JSON. Prefer a small, valid, evidence-backed result over broad exploration.`;
}

function shouldRetryEmptyInspection(result: VoiceResult, stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"]): boolean {
    if (stage !== "independent-review" || result.status !== "error") return false;
    if (!result.errorMessage?.toLowerCase().includes("no assistant text")) return false;
    return !result.output && !result.partialOutput && !result.recoveryContext
        && !/\[tool (?:start|done)\]/.test(result.activityLog ?? "");
}

function salvageOutput(result: VoiceResult, stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"], roleId: string, language?: Parameters<ReviewRoleExecutor["execute"]>[0]["language"]): string | undefined {
    const candidate = result.output ?? result.partialOutput;
    if (!candidate) return undefined;
    try {
        const payload = parseExecutionPayload(candidate);
        if (!isCompleteStagePayload(payload, stage, roleId) || !responseLanguageMatches(payload, language)) return undefined;
        return candidate;
    } catch {
        return undefined;
    }
}

function retainRecoveryGap(output: string, stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"], interrupted: VoiceResult, language?: Parameters<ReviewRoleExecutor["execute"]>[0]["language"]): string {
    if (stage !== "independent-review" || /\[tool (?:start|done)\]/.test(interrupted.activityLog ?? "")) return output;
    const payload = parseExecutionPayload(output);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return output;
    const value = payload as Record<string, unknown>;
    const findings = Array.isArray(value.findings) ? value.findings : [];
    const observations = Array.isArray(value.positiveObservations) ? value.positiveObservations : [];
    const questions = Array.isArray(value.unresolvedQuestions) ? value.unresolvedQuestions : [];
    if (findings.length > 0 || observations.length > 0 || questions.length > 0) return output;
    return JSON.stringify({
        ...value,
        findings,
        positiveObservations: observations,
        unresolvedQuestions: [language === "zh-CN" ? "评审覆盖不完整：源码检查中断，未产生可用证据。" : "Review coverage incomplete: interrupted source inspection produced no usable evidence."],
    });
}

function responseLanguageMatches(payload: unknown, language?: Parameters<ReviewRoleExecutor["execute"]>[0]["language"]): boolean {
    if (!language) return true;
    return humanReadableStrings(payload).every((value) => {
        const han = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
        const englishWords = value.match(/[A-Za-z]{2,}/g)?.length ?? 0;
        if (language === "zh-CN") return han > 0 || englishWords < 4;
        return han < 4 || englishWords >= 2;
    });
}

function humanReadableStrings(value: unknown, key = ""): string[] {
    if (typeof value === "string") {
        const fields = new Set(["title", "description", "recommendation", "recommendedAction", "rationale", "executiveSummary", "positiveObservations", "unresolvedQuestions", "newUnresolvedQuestions", "missingAreas", "mergeRationale", "sectionItem"]);
        return fields.has(key) ? [value] : [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => humanReadableStrings(item, key));
    if (!value || typeof value !== "object") return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) => humanReadableStrings(child, key === "sections" ? "sectionItem" : childKey));
}

function isCompleteStagePayload(payload: unknown, stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"], roleId: string): boolean {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return stage === "cross-review" && Array.isArray(payload);
    const value = payload as Record<string, unknown>;
    if (stage === "independent-review") {
        if (!Array.isArray(value.findings)) return false;
        const proposal = parseFindingProposal(payload, roleId);
        const rawObservations = Array.isArray(value.positiveObservations) ? value.positiveObservations : value.positiveObservations === undefined ? [] : [value.positiveObservations];
        if (value.findings.length > 0 && proposal.findings.length === 0) return false;
        if (rawObservations.length > 0 && proposal.positiveObservations.length === 0) return false;
        return true;
    }
    if (stage === "cross-review") return typeof value.verdict === "string" || Array.isArray(value.challenges);
    if (stage === "devil") return Array.isArray(value.challenges) || Array.isArray(value.findings) || Array.isArray(value.missingAreas);
    return typeof value.executiveSummary === "string" || Array.isArray(value.requiredActions) || Array.isArray(value.unresolvedQuestions);
}

function shouldFinalize(result: VoiceResult): boolean {
    if (result.status === "success") return true;
    const message = result.errorMessage?.toLowerCase() ?? "";
    return message.includes("no assistant text") || message.includes("timed out") || message.includes("inactivity timeout") || message.includes("tool call limit") || message.includes("turn limit");
}

function canUseFallback(reason: ReturnType<typeof classifyRetryReason>, message?: string): boolean {
    if (reason === "aborted" || reason === "authentication" || reason === "unsafe-endpoint" || reason === "validation") return false;
    const normalized = message?.toLowerCase() ?? "";
    return reason !== "unknown" || normalized.includes("no assistant text") || normalized.includes("tool call limit")
        || normalized.includes("turn limit") || normalized.includes("structured json contract");
}

function executionFromResult(roleId: string, stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"], model: ModelRef, output: string, startedAt: number, costUsd: number | null, inputTokens: number, outputTokens: number, observed?: VoiceResult): ReviewRoleExecution {
    const activityLog = tail(observed?.activityLog, 80_000);
    const recoveryContext = tail(observed?.recoveryContext, 80_000);
    return {
        roleId,
        stage,
        model,
        output,
        rawOutput: output,
        ...(activityLog ? { activityLog: redactSensitive(activityLog) } : {}),
        ...(recoveryContext ? { recoveryContext: redactSensitive(recoveryContext) } : {}),
        durationMs: Date.now() - startedAt,
        costUsd,
        inputTokens,
        outputTokens,
    };
}

function executionFailure(message: string, roleId: string, stage: Parameters<ReviewRoleExecutor["execute"]>[0]["stage"], model: ModelRef, startedAt: number, costUsd: number | null, inputTokens: number, outputTokens: number, result?: VoiceResult): ReviewRoleExecutionFailure {
    const rawOutput = result?.output ?? result?.partialOutput;
    const activityLog = tail(result?.activityLog, 80_000);
    const recoveryContext = tail(result?.recoveryContext, 80_000);
    return new ReviewRoleExecutionFailure(message, {
        roleId,
        stage,
        model,
        output: null,
        ...(rawOutput ? { rawOutput: redactSensitive(rawOutput) } : {}),
        ...(activityLog ? { activityLog: redactSensitive(activityLog) } : {}),
        ...(recoveryContext ? { recoveryContext: redactSensitive(recoveryContext) } : {}),
        durationMs: Date.now() - startedAt,
        costUsd,
        inputTokens,
        outputTokens,
    });
}

function mergeObservedResult(previous: VoiceResult | undefined, current: VoiceResult): VoiceResult {
    if (!previous) return current;
    const join = (left: string | undefined, right: string | undefined): string | undefined => {
        const values = [left, right].filter((value): value is string => !!value);
        return values.length > 0 ? values.join("\n\n[next attempt]\n\n") : undefined;
    };
    const activityLog = join(previous.activityLog, current.activityLog);
    const recoveryContext = join(previous.recoveryContext, current.recoveryContext);
    return {
        ...current,
        ...(current.output ? {} : previous.output ? { output: previous.output } : {}),
        ...(current.partialOutput ? {} : previous.partialOutput ? { partialOutput: previous.partialOutput } : {}),
        ...(activityLog ? { activityLog } : {}),
        ...(recoveryContext ? { recoveryContext } : {}),
    };
}

function timeoutResult(model: ModelRef, startedAt: number, message: string): VoiceResult {
    return { voice: { model, role: "reasoning" }, status: "error", durationMs: Date.now() - startedAt, costUsd: null, startedAt, errorMessage: message };
}

function tail(value: string | undefined, maximum: number): string | undefined {
    if (!value) return undefined;
    return value.length <= maximum ? value : `[older recovery context omitted]\n${value.slice(-maximum)}`;
}

export type ReviewExecutorRegistryLike = RegistryLike;
