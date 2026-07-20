import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderReviewMarkdown } from "../../src/renderers/markdown.js";
import { jsonReviewRenderer } from "../../src/renderers/json.js";
import { defaultReviewRendererRegistry } from "../../src/renderers/registry.js";
import { ReviewLiveArtifactWriter, writeReviewArtifacts } from "../../src/review/artifacts.js";
import { createSubagentReviewExecutor } from "../../src/review/executor.js";
import type { ReviewReport } from "../../src/review/contracts.js";
import { failedReviewExecution, type ReviewWorkflowResult } from "../../src/workflows/contracts.js";
import { runReviewService } from "../../src/review/service.js";
import { saveConfig } from "../../src/store.js";
import { config, registry } from "./fixtures.js";

describe("review renderers and artifacts", () => {
    it("renders Markdown and lossless JSON from the same normalized report", () => {
        const report = fixtureReport();
        const markdown = renderReviewMarkdown(report);
        expect(markdown).toContain("结论：**需要修改**");
        expect(markdown).toContain("执行状态：**完整**（4/4 个专家角色）");
        expect(renderReviewMarkdown({ ...report, coverage: { ...report.coverage, completedRoles: 0, omittedStages: ["independent-review"] } })).toContain("执行状态：**降级**（0/4 个专家角色）");
        expect(renderReviewMarkdown({ ...report, language: "en" })).toContain("Decision: **Request Changes**");
        expect(renderReviewMarkdown({ ...report, executionDiagnostics: ["integrate/integrator: budget"] })).toContain("## 执行诊断");
        expect(renderReviewMarkdown({ ...report, coverage: { ...report.coverage, usableRoles: 3, emptyRoles: ["security"], citedFiles: 2, explicitFiles: 0 } })).toContain("空结果角色：security");
        expect(renderReviewMarkdown({ ...report, coverage: { ...report.coverage, completedRoles: 4, usableRoles: 0, emptyRoles: ["architect", "security", "performance", "maintainability"] } })).toContain("完成 4/4 个专家角色，有效 0/4");
        expect(renderReviewMarkdown({ ...report, coverage: { ...report.coverage, stages: [{ stage: "cross-review", unit: "findings", planned: 2, attempted: 2, usable: 0, failed: 2, omitted: 3, status: "error" }] } })).toContain("阶段覆盖：交叉评审 0/2 个问题 (失败 2, 省略 3)");
        expect(renderReviewMarkdown(report)).toContain("报告涉及文件：");
        expect(markdown).toContain("src/auth.ts:10-12");
        expect(renderReviewMarkdown({
            ...report,
            findings: [{
                ...report.findings[0]!,
                evidence: [{ ...report.findings[0]!.evidence[0]!, verification: "stale", verificationReason: "code excerpt moved to a different line range" }],
            }],
        })).toContain("code excerpt moved to a different line range");
        expect(markdown).toContain("&lt;script&gt;");
        expect(renderReviewMarkdown({ ...report, findings: [{ ...report.findings[0]!, status: "proposed" }] })).toContain("## 待复核问题");
        expect(JSON.parse(jsonReviewRenderer.render(report))).toEqual(report);
        expect(() => defaultReviewRendererRegistry.get("missing")).toThrow("unknown review renderer");
    });

    it("atomically persists private stage, raw, Markdown, JSON, and result artifacts", async () => {
        const outputDir = await mkdtemp(join(tmpdir(), "chorus-artifacts-"));
        const result: ReviewWorkflowResult = {
            plan: {
                version: 1,
                workflowId: "code-review",
                workflowVersion: 1,
                request: { version: 1, workflow: "code-review", objective: [], constraints: [], scope: { kind: "repository" }, profile: "quick", renderer: "markdown" },
                scope: { kind: "repository", workspaceRoot: outputDir, includePaths: [], excludePaths: [], reviewedPatch: "diff --git a/a.ts b/a.ts\n" },
                assignments: [],
                stages: ["integrate"],
                createdAt: 1,
            },
            report: fixtureReport(),
            stages: [{ stage: "integrate", status: "success", output: fixtureReport(), diagnostics: [], startedAt: 1, finishedAt: 2 }],
            executions: [{ roleId: "integrator", stage: "integrate", output: {}, rawOutput: "raw", activityLog: "activity", recoveryContext: "recovery", durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 }],
        };
        const artifacts = await writeReviewArtifacts({ result, outputDir });
        expect(artifacts.map((artifact) => artifact.label)).toEqual(expect.arrayContaining(["review-plan", "review-scope-diff", "review-report", "review-report-json", "review-result", "execution-0-integrator-raw", "execution-0-integrator-activity", "execution-0-integrator-recovery"]));
        expect(await readFile(join(outputDir, "execution-0-integrator-activity.txt"), "utf8")).toBe("activity\n");
        expect(await readFile(join(outputDir, "review-scope.diff"), "utf8")).toContain("diff --git a/a.ts b/a.ts");
        expect(await readFile(join(outputDir, "review-report.md"), "utf8")).toContain("需要修改");
        expect((await stat(join(outputDir, "review-report.json"))).mode & 0o077).toBe(0);
    });

    it("creates bounded live diagnostics before the Review finishes", async () => {
        const outputDir = await mkdtemp(join(tmpdir(), "chorus-live-artifacts-"));
        const request = { version: 1 as const, workflow: "code-review", objective: ["review"], constraints: [], scope: { kind: "repository" as const, root: outputDir }, profile: "deep" as const, renderer: "markdown" };
        const writer = new ReviewLiveArtifactWriter(outputDir, request);
        await writer.initialize();
        writer.stage("independent-review", "running");
        writer.execution({ roleId: "architect", stage: "independent-review", status: "running", partialOutput: "x".repeat(90_000) });
        await writer.flush();
        const progress = JSON.parse(await readFile(join(outputDir, "review-progress.json"), "utf8"));
        expect(JSON.parse(await readFile(join(outputDir, "review-request.json"), "utf8"))).toEqual(request);
        expect(progress).toEqual(expect.objectContaining({ status: "running", stage: { id: "independent-review", status: "running" } }));
        expect(progress.executions.architect.partialOutput.length).toBeLessThan(90_000);
        expect((await stat(join(outputDir, "review-progress.json"))).mode & 0o077).toBe(0);
    });

    it("retains a failed stage snapshot when the same role runs again", async () => {
        const outputDir = await mkdtemp(join(tmpdir(), "chorus-live-failure-"));
        const request = { version: 1 as const, workflow: "code-review", objective: ["review"], constraints: [], scope: { kind: "repository" as const, root: outputDir }, profile: "quick" as const, renderer: "markdown" };
        const writer = new ReviewLiveArtifactWriter(outputDir, request);
        await writer.initialize();
        writer.execution({ roleId: "security", stage: "independent-review", status: "running", activityLog: "tool-only response" });
        writer.execution({ roleId: "security", stage: "independent-review", status: "error", errorMessage: "pi produced no assistant text" });
        writer.execution({ roleId: "security", stage: "cross-review", status: "success", partialOutput: "challenge" });
        await writer.flush();
        const progress = JSON.parse(await readFile(join(outputDir, "review-progress.json"), "utf8"));
        expect(progress.executions.security).toEqual(expect.objectContaining({ stage: "cross-review", status: "success" }));
        expect(progress.failedExecutions).toEqual([expect.objectContaining({ stage: "independent-review", status: "error", activityLog: "tool-only response" })]);
    });

    it("coalesces slow progress writes to one active write and one latest dirty snapshot", async () => {
        const outputDir = await mkdtemp(join(tmpdir(), "chorus-live-coalesced-"));
        const request = { version: 1 as const, workflow: "code-review", objective: ["review"], constraints: [], scope: { kind: "repository" as const, root: outputDir }, profile: "quick" as const, renderer: "markdown" };
        const snapshots: string[] = [];
        let active = 0;
        let maximum = 0;
        let initialized = false;
        let releaseSlowWrite: (() => void) | undefined;
        const writer = new ReviewLiveArtifactWriter(outputDir, request, {
            textPersistIntervalMs: 10,
            writeSnapshot: async (_path, value) => {
                active += 1;
                maximum = Math.max(maximum, active);
                snapshots.push(value);
                if (initialized && snapshots.length === 1) await new Promise<void>((resolve) => { releaseSlowWrite = resolve; });
                active -= 1;
            },
        });
        await writer.initialize();
        snapshots.length = 0;
        initialized = true;
        writer.execution({ roleId: "architect", stage: "independent-review", status: "running", partialOutput: "0" });
        await vi.waitFor(() => expect(releaseSlowWrite).toBeDefined());
        for (let index = 1; index <= 20; index += 1) writer.execution({ roleId: "architect", stage: "independent-review", status: "running", partialOutput: String(index) });
        writer.execution({ roleId: "architect", stage: "independent-review", status: "success", partialOutput: "latest" });
        writer.complete("success");
        releaseSlowWrite!();
        await writer.flush();

        expect(maximum).toBe(1);
        expect(snapshots.length).toBeLessThanOrEqual(3);
        expect(JSON.parse(snapshots.at(-1)!)).toEqual(expect.objectContaining({ status: "success", executions: { architect: expect.objectContaining({ status: "success", partialOutput: "latest" }) } }));
    });

    it("propagates scheduled progress persistence failures from flush", async () => {
        const outputDir = await mkdtemp(join(tmpdir(), "chorus-live-failure-"));
        const request = { version: 1 as const, workflow: "code-review", objective: ["review"], constraints: [], scope: { kind: "repository" as const, root: outputDir }, profile: "quick" as const, renderer: "markdown" };
        let writes = 0;
        const writer = new ReviewLiveArtifactWriter(outputDir, request, { writeSnapshot: async () => { writes += 1; if (writes > 1) throw new Error("disk full"); } });
        await writer.initialize();
        writer.complete("success");
        await expect(writer.flush()).rejects.toThrow("disk full");
    });

    it("persists service diagnostics while reviewers are still running", async () => {
        const baseDir = await mkdtemp(join(tmpdir(), "chorus-live-service-"));
        const root = join(baseDir, "workspace");
        await mkdir(root);
        await writeFile(join(root, "source.ts"), "export const value = 1;\n");
        await saveConfig(config, { baseDir }, registry);
        const abortController = new AbortController();
        const running = runReviewService(
            { cwd: root, storePaths: { baseDir }, modelRegistry: { models: registry } },
            { version: 1, workflow: "code-review", objective: ["review"], constraints: [], scope: { kind: "repository", root }, profile: "quick", renderer: "markdown" },
            {
                jobId: "review-live",
                signal: abortController.signal,
                executor: {
                    execute: async (args) => {
                        await new Promise((_resolve, reject) => args.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
                        throw new Error("unreachable");
                    },
                },
            },
        );
        const outputDir = join(baseDir, "results", "review-live");
        await vi.waitFor(async () => {
            const progress = JSON.parse(await readFile(join(outputDir, "review-progress.json"), "utf8"));
            expect(Object.values(progress.executions).some((execution) => (execution as { status?: string }).status === "running")).toBe(true);
            expect(Object.values(progress.executions).filter((execution) => (execution as { status?: string }).status === "running")).toHaveLength(1);
        });
        abortController.abort();
        const response = await running;
        expect(response.result.stages.at(-1)).toEqual(expect.objectContaining({ stage: "integrate", status: "aborted" }));
        expect(response.result.report.decision).toBe("needs-investigation");
        expect(JSON.parse(await readFile(join(outputDir, "review-request.json"), "utf8")).objective).toEqual(["review"]);
    });
});

describe("subagent review executor", () => {
    const emptyIndependentOutput = JSON.stringify({ findings: [], positiveObservations: [], unresolvedQuestions: [] });

    it("maps logical roles to resolved models and Pi-native read-only execution", async () => {
        const run = vi.fn(async (args) => {
            args.onProgress?.({ voiceIndex: 0, voice: args.voice, status: "running", partialOutput: "checking source", durationMs: 5, costUsd: 0.01 });
            return ({
            voice: args.voice,
            status: "success" as const,
            output: emptyIndependentOutput,
            durationMs: 12,
            costUsd: 0.1,
            startedAt: 1,
            usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
            });
        });
        const executor = createSubagentReviewExecutor({ cwd: "/tmp", runSubagentVoiceImpl: run });
        const progress: unknown[] = [];
        const execution = await executor.execute({
            role: { id: "security", name: "Security", objective: "Review security", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: { roleId: "security", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
            onProgress: (update) => progress.push(update),
        });
        expect(execution).toEqual(expect.objectContaining({ roleId: "security", output: emptyIndependentOutput, inputTokens: 2, outputTokens: 3 }));
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ permissionProfile: "read-only", cwd: "/tmp", systemPrompt: expect.stringContaining("Model responses are proposals") }));
        expect(progress).toEqual([expect.objectContaining({ roleId: "security", stage: "independent-review", status: "running", partialOutput: "checking source" })]);
    });

    it("retries bounded finalization when Pi exits after tools without assistant text", async () => {
        const run = vi.fn(async (args) => run.mock.calls.length === 1
            ? { voice: args.voice, status: "error" as const, durationMs: 10, costUsd: null, startedAt: 1, partialOutput: "Candidate finding from prior inspection", activityLog: "read src/index.ts", recoveryContext: "src/index.ts:42 export function activate() {}", errorMessage: "pi produced no assistant text" }
            : { voice: args.voice, status: "success" as const, output: emptyIndependentOutput, durationMs: 5, costUsd: 0, startedAt: 2 });
        const progress: Array<{ activityLog?: string }> = [];
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run, timeoutMs: 100_000 });
        await expect(executor.execute({
            role: { id: "architect", name: "Architect", objective: "Review", instructions: "Cite source", findingCategories: ["architecture"], requiredEvidence: ["code"] },
            assignment: { roleId: "architect", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
            onProgress: (update) => progress.push(update),
        })).resolves.toEqual(expect.objectContaining({
            output: expect.stringContaining("interrupted source inspection"),
            activityLog: "read src/index.ts",
            recoveryContext: "src/index.ts:42 export function activate() {}",
        }));
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]?.[0].prompt).toContain("RECOVERY FINALIZATION ONLY");
        expect(run.mock.calls[1]?.[0].prompt).toContain("Candidate finding from prior inspection");
        expect(run.mock.calls[1]?.[0].prompt).toContain("src/index.ts:42 export function activate() {}");
        expect(run.mock.calls[1]?.[0].prompt).toContain('"title":"Concrete defect title"');
        expect(run.mock.calls[1]?.[0].prompt).toContain('"startLine":1');
        expect(run.mock.calls[1]?.[0].prompt).toContain("at most four evidence items");
        expect(run.mock.calls[1]?.[0].prompt).toContain('"path":"package.json"');
        expect(run.mock.calls[1]?.[0].prompt).not.toContain("<reference-task>");
        expect(run.mock.calls[1]?.[0].disableTools).toBe(true);
        expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ timeoutMs: 100_000, timeoutMode: "inactivity" }));
        expect(progress.some((update) => update.activityLog?.includes("retrying bounded finalization"))).toBe(true);
    });

    it("retries bounded finalization when successful JSON misses the stage contract", async () => {
        const run = vi.fn(async (args) => run.mock.calls.length === 1
            ? { voice: args.voice, status: "success" as const, output: "{}", durationMs: 10, costUsd: 0, startedAt: 1 }
            : { voice: args.voice, status: "success" as const, output: JSON.stringify({ findings: [], positiveObservations: [], unresolvedQuestions: [] }), durationMs: 5, costUsd: 0, startedAt: 2 });
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        await expect(executor.execute({
            role: { id: "security", name: "Security", objective: "Review", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: { roleId: "security", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
        })).resolves.toEqual(expect.objectContaining({ output: expect.stringContaining('"findings":[]') }));
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ disableTools: true, prompt: expect.stringContaining("RECOVERY FINALIZATION ONLY") }));
    });

    it("reports an explicit output-format error after unusable finalization", async () => {
        const run = vi.fn(async (args) => ({ voice: args.voice, status: "success" as const, output: "<thinking>no final json</thinking>", durationMs: 5, costUsd: 0, startedAt: 1 }));
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        await expect(executor.execute({
            role: { id: "security", name: "Security", objective: "Review", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: { roleId: "security", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
        })).rejects.toThrow("category=output-format: reviewer output did not satisfy the independent-review structured JSON contract");
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("classifies persistent no-text finalization as output-format", async () => {
        const run = vi.fn(async (args) => ({ voice: args.voice, status: "error" as const, durationMs: 5, costUsd: 0, startedAt: 1, errorMessage: "pi produced no assistant text" }));
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        await expect(executor.execute({
            role: { id: "architect", name: "Architect", objective: "Review", instructions: "Cite source", findingCategories: ["architecture"], requiredEvidence: ["code"] },
            assignment: { roleId: "architect", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "independent-review", prompt: "review", signal: new AbortController().signal,
        })).rejects.toThrow("category=empty-output: pi produced no assistant text");
        expect(run).toHaveBeenCalledTimes(3);
    });

    it("retains redacted terminal partial output on failed executions", async () => {
        const run = vi.fn(async (args) => ({
            voice: args.voice,
            status: "success" as const,
            partialOutput: "partial contract with Authorization: Bearer secret-token-value",
            activityLog: "read source with x-api-key: secret-token-value",
            recoveryContext: "Authorization: Bearer secret-token-value",
            durationMs: 5,
            costUsd: 0,
            startedAt: 1,
        }));
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        const failure = await executor.execute({
            role: { id: "architect", name: "Architect", objective: "Review", instructions: "Cite source", findingCategories: ["architecture"], requiredEvidence: ["code"] },
            assignment: { roleId: "architect", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
        }).catch((error: unknown) => error);

        expect(failedReviewExecution(failure)).toEqual(expect.objectContaining({
            output: null,
            rawOutput: expect.stringContaining("[redacted]"),
            activityLog: expect.stringContaining("[redacted]"),
            recoveryContext: expect.stringContaining("[redacted]"),
        }));
        expect(failedReviewExecution(failure)?.rawOutput).not.toContain("secret-token-value");
        expect(failedReviewExecution(failure)?.activityLog).not.toContain("secret-token-value");
        expect(failedReviewExecution(failure)?.recoveryContext).not.toContain("secret-token-value");
    });

    it("runs integration from normalized packets without repository tools", async () => {
        const run = vi.fn(async (args) => ({
            voice: args.voice,
            status: "success" as const,
            output: JSON.stringify({ executiveSummary: "summary", positiveObservations: [], unresolvedQuestions: [], sections: {}, findingResolutions: [] }),
            durationMs: 5,
            costUsd: 0,
            startedAt: 1,
        }));
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        await executor.execute({
            role: { id: "integrator", name: "Integrator", objective: "Integrate", instructions: "Summarize", findingCategories: [], requiredEvidence: [] },
            assignment: { roleId: "integrator", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "integrate",
            prompt: "integrate normalized findings",
            signal: new AbortController().signal,
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ disableTools: true }));
    });

    it("falls back to the next resolved model after bounded no-text recovery fails", async () => {
        const run = vi.fn(async (args) => args.voice.model.modelId === "fallback"
            ? { voice: args.voice, status: "success" as const, output: emptyIndependentOutput, durationMs: 5, costUsd: 0, startedAt: 2 }
            : { voice: args.voice, status: "error" as const, durationMs: 5, costUsd: 0, startedAt: 1, errorMessage: "pi produced no assistant text" });
        const progress: Array<{ activityLog?: string; model?: { modelId: string } }> = [];
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        const result = await executor.execute({
            role: { id: "security", name: "Security", objective: "Review", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: {
                roleId: "security",
                resolvedModel: { provider: "p", modelId: "primary" },
                resolvedFallbackModels: [{ provider: "p", modelId: "fallback" }],
            },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
            onProgress: (update) => progress.push(update),
        });

        expect(result.model).toEqual({ provider: "p", modelId: "fallback" });
        expect(run).toHaveBeenCalledTimes(4);
        expect(progress.some((update) => update.activityLog?.includes("empty inspection produced no recoverable material"))).toBe(true);
        expect(progress.some((update) => update.activityLog?.includes("[fallback]") && update.model?.modelId === "fallback")).toBe(true);
    });

    it("uses a same-provider fallback after transient retries are exhausted", async () => {
        const run = vi.fn(async (args) => args.voice.model.modelId === "fallback"
            ? { voice: args.voice, status: "success" as const, output: emptyIndependentOutput, durationMs: 5, costUsd: 0, startedAt: 2 }
            : { voice: args.voice, status: "error" as const, durationMs: 5, costUsd: null, startedAt: 1, errorMessage: "HTTP 429 rate limit" });
        const executor = createSubagentReviewExecutor({
            runSubagentVoiceImpl: run,
            retryPolicy: { maxAttempts: 1, sleep: async () => undefined },
        });
        const result = await executor.execute({
            role: { id: "security", name: "Security", objective: "Review", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: {
                roleId: "security",
                resolvedModel: { provider: "p", modelId: "primary" },
                resolvedFallbackModels: [{ provider: "p", modelId: "fallback" }],
            },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
        });

        expect(result.model).toEqual({ provider: "p", modelId: "fallback" });
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("waits and retries transient provider failures with visible attempt details", async () => {
        const delays: number[] = [];
        const run = vi.fn(async (args) => run.mock.calls.length < 3
            ? { voice: args.voice, status: "error" as const, durationMs: 5, costUsd: 0.1, startedAt: 1, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, errorMessage: "HTTP 429 rate limit; retry after 1s" }
            : { voice: args.voice, status: "success" as const, output: emptyIndependentOutput, durationMs: 5, costUsd: 0.2, startedAt: 2, usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } });
        const progress: Array<{ activityLog?: string; errorMessage?: string }> = [];
        const executor = createSubagentReviewExecutor({
            runSubagentVoiceImpl: run,
            retryPolicy: { maxAttempts: 3, jitter: 0, sleep: async (delay) => { delays.push(delay); } },
        });
        await expect(executor.execute({
            role: { id: "security", name: "Security", objective: "Review", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: { roleId: "security", resolvedModel: { provider: "custom", modelId: "secure" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
            onProgress: (update) => progress.push(update),
        })).resolves.toEqual(expect.objectContaining({ output: emptyIndependentOutput, costUsd: 0.4, inputTokens: 5, outputTokens: 8 }));
        expect(run).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([1_000, 1_000]);
        expect(progress.some((update) => update.activityLog?.includes("reason=rate-limit") && update.errorMessage?.includes("attempt=2/3"))).toBe(true);
    });

    it("does not retry permanent failures and reports the full execution chain", async () => {
        const run = vi.fn(async (args) => ({ voice: args.voice, status: "error" as const, durationMs: 5, costUsd: 0.2, startedAt: 1, usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }, errorMessage: "401 authentication failed" }));
        const executor = createSubagentReviewExecutor({
            runSubagentVoiceImpl: run,
            retryPolicy: { maxAttempts: 3, sleep: async () => undefined },
        });
        const failure = await executor.execute({
            role: { id: "architect", name: "Architect", objective: "Review", instructions: "Cite source", findingCategories: ["architecture"], requiredEvidence: ["code"] },
            assignment: { roleId: "architect", resolvedModel: { provider: "custom", modelId: "architect" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
        }).catch((error: unknown) => error);
        expect(failure).toEqual(expect.objectContaining({ message: expect.stringContaining("stage=independent-review role=architect model=custom/architect modelCalls=1 retryAttemptsPerCall=3 category=authentication") }));
        expect(failedReviewExecution(failure)).toEqual(expect.objectContaining({ costUsd: 0.2, inputTokens: 3, outputTokens: 4, output: null }));
        expect(run).toHaveBeenCalledTimes(1);
    });
});

function fixtureReport(): ReviewReport {
    return {
        version: 1,
        reviewId: "r1",
        workflowId: "code-review",
        decision: "request-changes",
        executiveSummary: "A <script> defect blocks approval.",
        findings: [{
            id: "f1",
            title: "Missing authorization",
            description: "The route loads data before authorization.",
            category: "security",
            severity: "high",
            confidence: "high",
            status: "verified",
            evidence: [{ id: "e1", kind: "code", path: "src/auth.ts", startLine: 10, endLine: 12, verification: "verified" }],
            raisedBy: ["security"],
            challenges: [{ reviewerRoleId: "devil", verdict: "support", rationale: "The evidence is exact.", evidence: [] }],
            recommendation: "Authorize first.",
        }],
        requiredActions: ["Authorize first."],
        positiveObservations: [],
        unresolvedQuestions: [],
        coverage: { requestedRoles: 4, completedRoles: 4, reviewedFiles: 1, omittedStages: [] },
        run: { durationMs: 1000, costUsd: 0.1, inputTokens: 10, outputTokens: 20 },
        createdAt: 1,
    };
}
