import { describe, expect, it, vi } from "vitest";
import { createSubagentReviewExecutor } from "../../src/review/executor.js";

describe("review executor language contracts", () => {
    it("rewrites human-readable fields when a Chinese review returns English JSON", async () => {
        const english = JSON.stringify({
            findings: [{
                id: "performance-1",
                title: "Cache pruning repeatedly scans every cache entry",
                description: "The cache directory is fully scanned after each bounded batch of writes.",
                category: "performance",
                severity: "medium",
                confidence: "medium",
                status: "proposed",
                evidence: [],
                raisedBy: ["performance"],
                challenges: [],
                recommendation: "Maintain a bounded in-memory index.",
            }],
            positiveObservations: [],
            unresolvedQuestions: [],
        });
        const chinese = JSON.stringify({
            findings: [{
                id: "performance-1",
                title: "缓存裁剪会重复扫描全部缓存条目",
                description: "每批写入后都会完整扫描缓存目录。",
                category: "performance",
                severity: "medium",
                confidence: "medium",
                status: "proposed",
                evidence: [],
                raisedBy: ["performance"],
                challenges: [],
                recommendation: "维护一个有界的内存索引。",
            }],
            positiveObservations: [],
            unresolvedQuestions: [],
        });
        const run = vi.fn(async (args) => ({
            voice: args.voice,
            status: "success" as const,
            output: run.mock.calls.length === 1 ? english : chinese,
            durationMs: 5,
            costUsd: 0,
            startedAt: 1,
        }));
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        const result = await executor.execute({
            role: { id: "performance", name: "Performance", objective: "Review", instructions: "Cite source", findingCategories: ["performance"], requiredEvidence: ["code"] },
            assignment: { roleId: "performance", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "independent-review",
            language: "zh-CN",
            prompt: "review",
            signal: new AbortController().signal,
        });

        expect(result.output).toBe(chinese);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]?.[0].prompt).toContain("English prose will be rejected");
        expect(run.mock.calls[1]?.[0].prompt).toContain("具体缺陷标题");
        expect(run.mock.calls[1]?.[0].disableTools).toBe(true);
    });

    it("does not treat code evidence inside Chinese integration sections as English prose", async () => {
        const output = JSON.stringify({
            executiveSummary: "评审完成，保留现有结论。",
            positiveObservations: [{ title: "调度能力已存在", description: "现有调度器可以直接复用。" }],
            newUnresolvedQuestions: [],
            sections: {
                regressionRisks: [{
                    title: "默认路径缺少并发限制",
                    description: "省略 bounded 时会进入无界分支。",
                    recommendedAction: "默认使用有界调度。",
                    evidence: [{ kind: "code", path: "src/runtime/execution-coordinator.ts", excerpt: "const bounded = options.bounded ?? true;" }],
                }],
            },
            findingResolutions: [],
        });
        const run = vi.fn(async (args) => ({ voice: args.voice, status: "success" as const, output, durationMs: 5, costUsd: 0, startedAt: 1 }));
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });

        await expect(executor.execute({
            role: { id: "integrator", name: "Integrator", objective: "Integrate", instructions: "Summarize", findingCategories: [], requiredEvidence: [] },
            assignment: { roleId: "integrator", resolvedModel: { provider: "p", modelId: "m" } },
            stage: "integrate",
            language: "zh-CN",
            prompt: "integrate",
            signal: new AbortController().signal,
        })).resolves.toEqual(expect.objectContaining({ output }));
        expect(run).toHaveBeenCalledTimes(1);
    });
});
