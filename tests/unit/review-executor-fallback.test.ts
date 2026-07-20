import { describe, expect, it, vi } from "vitest";
import { createSubagentReviewExecutor } from "../../src/review/executor.js";

const emptyIndependentOutput = JSON.stringify({ findings: [], positiveObservations: [], unresolvedQuestions: [] });

describe("review executor coverage fallback", () => {
    it("continues across English and Chinese source-inspection coverage gaps", async () => {
        const englishCoverageOnly = JSON.stringify({
            findings: [],
            positiveObservations: [],
            unresolvedQuestions: ["Review coverage incomplete: repository tools were unavailable."],
        });
        const chineseCoverageOnly = JSON.stringify({
            findings: [],
            positiveObservations: [],
            unresolvedQuestions: [
                "本次审查未能完成源代码工具检查，因此无法提供满足证据要求的安全发现或正面观察。",
                "尚未核验外部输入到子进程启动、直接模式 HTTP 请求及持久化边界的完整数据流。",
            ],
        });
        const run = vi.fn(async (args) => ({
            voice: args.voice,
            status: "success" as const,
            output: args.voice.model.modelId === "fallback-two"
                ? emptyIndependentOutput
                : args.voice.model.modelId === "fallback-one" ? chineseCoverageOnly : englishCoverageOnly,
            durationMs: 5,
            costUsd: 0,
            startedAt: 1,
        }));
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        const providers: string[] = [];
        const result = await executor.execute({
            role: { id: "security", name: "Security", objective: "Review", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: {
                roleId: "security",
                resolvedModel: { provider: "p", modelId: "primary" },
                resolvedFallbackModels: [
                    { provider: "p", modelId: "fallback-one" },
                    { provider: "q", modelId: "fallback-two" },
                ],
            },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
            switchProvider: async (provider) => { providers.push(provider); },
        });

        expect(result.model).toEqual({ provider: "q", modelId: "fallback-two" });
        expect(result.output).toBe(emptyIndependentOutput);
        expect(run).toHaveBeenCalledTimes(3);
        expect(providers).toEqual(["p", "p", "q"]);
    });

    it("uses a fallback after bounded recovery can only report interrupted inspection", async () => {
        const run = vi.fn(async (args) => {
            if (args.voice.model.modelId === "fallback") {
                return { voice: args.voice, status: "success" as const, output: emptyIndependentOutput, durationMs: 5, costUsd: 0, startedAt: 3 };
            }
            if (args.disableTools) {
                return { voice: args.voice, status: "success" as const, output: emptyIndependentOutput, durationMs: 5, costUsd: 0, startedAt: 2 };
            }
            return { voice: args.voice, status: "error" as const, errorMessage: "pi produced no assistant text", durationMs: 5, costUsd: 0, startedAt: 1 };
        });
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        const result = await executor.execute({
            role: { id: "performance", name: "Performance", objective: "Review", instructions: "Cite source", findingCategories: ["performance"], requiredEvidence: ["code"] },
            assignment: {
                roleId: "performance",
                resolvedModel: { provider: "p", modelId: "primary" },
                resolvedFallbackModels: [{ provider: "p", modelId: "fallback" }],
            },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
        });

        expect(result.model).toEqual({ provider: "p", modelId: "fallback" });
        expect(run).toHaveBeenCalledTimes(4);
    });

    it("retries a full inspection before recovery when no material was produced", async () => {
        const run = vi.fn(async (args) => run.mock.calls.length === 1
            ? { voice: args.voice, status: "error" as const, errorMessage: "pi produced no assistant text", durationMs: 5, costUsd: 0, startedAt: 1 }
            : { voice: args.voice, status: "success" as const, output: emptyIndependentOutput, durationMs: 5, costUsd: 0, startedAt: 2 });
        const executor = createSubagentReviewExecutor({ runSubagentVoiceImpl: run });
        const result = await executor.execute({
            role: { id: "security", name: "Security", objective: "Review", instructions: "Cite source", findingCategories: ["security"], requiredEvidence: ["code"] },
            assignment: { roleId: "security", resolvedModel: { provider: "p", modelId: "primary" } },
            stage: "independent-review",
            prompt: "review",
            signal: new AbortController().signal,
        });

        expect(result.output).toBe(emptyIndependentOutput);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls.every(([args]) => args.disableTools !== true)).toBe(true);
    });
});
