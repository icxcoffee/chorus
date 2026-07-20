import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyReviewProfile, REVIEW_PROFILES, ReviewBudgetExceededError, reviewStageExecutionLimits, withReviewProfileBudget } from "../../src/review/profiles.js";
import { reviewFailureCategory } from "../../src/review/errors.js";
import { runSingleReviewerBaseline } from "../../src/review/single-reviewer.js";
import { codeReviewDefinition } from "../../src/workflows/code-review.js";
import { registry } from "./fixtures.js";

describe("review profiles", () => {
    it("makes quick and deep role and challenge tradeoffs explicit", () => {
        expect(applyReviewProfile(codeReviewDefinition, "quick").roles.map((role) => role.roleId)).toEqual(["architect", "security", "performance", "devil", "integrator"]);
        expect(applyReviewProfile(codeReviewDefinition, "deep").roles).toHaveLength(6);
        expect(REVIEW_PROFILES.quick.maxExecutions).toBeLessThan(REVIEW_PROFILES.deep.maxExecutions);
        expect(reviewStageExecutionLimits(REVIEW_PROFILES.quick, applyReviewProfile(codeReviewDefinition, "quick").roles)).toEqual({
            "independent-review": 3,
            "cross-review": 2,
            devil: 1,
            integrate: 1,
        });
    });

    it("reserves terminal-stage executions and classifies budget exhaustion", async () => {
        const execute = vi.fn(async (args) => ({ roleId: args.role.id, stage: args.stage, output: {}, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 }));
        const budgeted = withReviewProfileBudget({ execute }, REVIEW_PROFILES.quick, { "cross-review": 2, devil: 1, integrate: 1 });
        const base = { role: { id: "r", name: "r", objective: "r", instructions: "r", findingCategories: [], requiredEvidence: [] }, assignment: { roleId: "r", resolvedModel: { provider: "p", modelId: "m" } }, prompt: "p", signal: new AbortController().signal };
        await budgeted.execute({ ...base, stage: "cross-review" });
        await budgeted.execute({ ...base, stage: "cross-review" });
        const exhausted = await budgeted.execute({ ...base, stage: "cross-review" }).catch((error: unknown) => error);
        expect(exhausted).toBeInstanceOf(ReviewBudgetExceededError);
        expect(reviewFailureCategory((exhausted as Error).message)).toBe("budget");
        await expect(budgeted.execute({ ...base, stage: "devil" })).resolves.toBeDefined();
        await expect(budgeted.execute({ ...base, stage: "integrate" })).resolves.toBeDefined();
    });

    it("guarantees Cross Review after concurrent Independent Review overshoots its target allocation", async () => {
        const independentUsages = [16_000, 8_000, 7_000];
        const execute = vi.fn(async (args) => ({ roleId: args.role.id, stage: args.stage, output: {}, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: args.stage === "independent-review" ? independentUsages.shift() ?? 1 : 1_000 }));
        const budgeted = withReviewProfileBudget({ execute }, REVIEW_PROFILES.quick);
        const base = { role: { id: "r", name: "r", objective: "r", instructions: "r", findingCategories: [], requiredEvidence: [] }, assignment: { roleId: "r", resolvedModel: { provider: "p", modelId: "m" } }, prompt: "p", signal: new AbortController().signal };
        const independent = await Promise.all(Array.from({ length: 3 }, () => budgeted.execute({ ...base, stage: "independent-review" })));
        expect(independent.filter((execution) => execution.budgetOverrun)).toHaveLength(1);
        expect(independent.find((execution) => execution.budgetOverrun)?.budgetOverrun).toContain("stage output 31000/26000");
        await expect(Promise.all(Array.from({ length: 2 }, () => budgeted.execute({ ...base, stage: "cross-review" })))).resolves.toHaveLength(2);
        await expect(budgeted.execute({ ...base, stage: "devil" })).resolves.toBeDefined();
        await expect(budgeted.execute({ ...base, stage: "integrate" })).resolves.toBeDefined();
    });

    it("stops queued executions after the configured cost boundary", async () => {
        const execute = vi.fn(async (args) => ({ roleId: args.role.id, stage: args.stage, output: {}, durationMs: 1, costUsd: 3, inputTokens: 1, outputTokens: 1 }));
        const budgeted = withReviewProfileBudget({ execute }, { ...REVIEW_PROFILES.quick, maxUsd: 2 });
        const args = { role: { id: "r", name: "r", objective: "r", instructions: "r", findingCategories: [], requiredEvidence: [] }, assignment: { roleId: "r", resolvedModel: { provider: "p", modelId: "m" } }, stage: "independent-review" as const, prompt: "p", signal: new AbortController().signal };
        await budgeted.execute(args);
        await expect(budgeted.execute(args)).rejects.toBeInstanceOf(ReviewBudgetExceededError);
    });

    it("preserves the caller signal without imposing a profile deadline", async () => {
        let receivedSignal: AbortSignal | undefined;
        let receivedToolLimit: number | undefined;
        let receivedTurnLimit: number | undefined;
        const budgeted = withReviewProfileBudget({
            execute: async (args) => {
                receivedSignal = args.signal;
                receivedToolLimit = args.maxToolCalls;
                receivedTurnLimit = args.maxTurns;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { roleId: args.role.id, stage: args.stage, output: {}, durationMs: 30, costUsd: 0, inputTokens: 1, outputTokens: 1 };
            },
        }, REVIEW_PROFILES.quick);
        const signal = new AbortController().signal;
        const args = { role: { id: "r", name: "r", objective: "r", instructions: "r", findingCategories: [], requiredEvidence: [] }, assignment: { roleId: "r", resolvedModel: { provider: "p", modelId: "m" } }, stage: "independent-review" as const, prompt: "p", signal };
        await expect(budgeted.execute(args)).resolves.toBeDefined();
        expect(receivedSignal).toBe(signal);
        expect(receivedSignal?.aborted).toBe(false);
        expect(receivedToolLimit).toBe(REVIEW_PROFILES.quick.toolCallLimits["independent-review"]);
        expect(receivedTurnLimit).toBe(REVIEW_PROFILES.quick.turnLimits["independent-review"]);
    });

    it("does not accumulate elapsed time as a profile budget", async () => {
        const budgeted = withReviewProfileBudget({
            execute: async (args) => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                return { roleId: args.role.id, stage: args.stage, output: {}, durationMs: 15, costUsd: 0, inputTokens: 1, outputTokens: 1 };
            },
        }, REVIEW_PROFILES.quick);
        const args = { role: { id: "r", name: "r", objective: "r", instructions: "r", findingCategories: [], requiredEvidence: [] }, assignment: { roleId: "r", resolvedModel: { provider: "p", modelId: "m" } }, stage: "independent-review" as const, prompt: "p", signal: new AbortController().signal };
        await expect(budgeted.execute(args)).resolves.toBeDefined();
        await expect(budgeted.execute(args)).resolves.toBeDefined();
    });

    it("records real stage budget overruns instead of soft per-execution target misses", async () => {
        const base = { role: { id: "r", name: "r", objective: "r", instructions: "r", findingCategories: [], requiredEvidence: [] }, assignment: { roleId: "r", resolvedModel: { provider: "p", modelId: "m" } }, prompt: "p", signal: new AbortController().signal };
        const budgeted = withReviewProfileBudget({
            execute: async (args) => ({ roleId: args.role.id, stage: args.stage, output: {}, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 31_000 }),
        }, REVIEW_PROFILES.quick, { "independent-review": 3 });
        await expect(budgeted.execute({ ...base, stage: "independent-review" })).resolves.toEqual(expect.objectContaining({
            budgetOverrun: expect.stringContaining("stage output 31000/26000"),
        }));

    });
});

describe("single reviewer baseline", () => {
    it("uses one generalist execution and the same evidence/report contract", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-single-review-"));
        await writeFile(join(root, "route.js"), "export const route = () => load();\n");
        const execute = vi.fn(async (args) => ({
            roleId: args.role.id,
            stage: args.stage,
            model: args.assignment.resolvedModel,
            output: { findings: [{ id: "f", title: "Missing authorization", description: "The route loads data without authorization.", category: "security", severity: "high", confidence: "high", status: "proposed", evidence: [{ id: "e", kind: "code", path: "route.js", startLine: 1 }], raisedBy: ["single-reviewer"], challenges: [] }], positiveObservations: [], unresolvedQuestions: [] },
            durationMs: 1,
            costUsd: 0.01,
            inputTokens: 1,
            outputTokens: 1,
        }));
        const report = await runSingleReviewerBaseline({
            request: { version: 1, workflow: "code-review", objective: ["review"], constraints: [], scope: { kind: "repository", root }, profile: "quick", renderer: "json" },
            registry,
            executor: { execute },
        });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(report).toEqual(expect.objectContaining({ decision: "request-changes", coverage: expect.objectContaining({ requestedRoles: 1, completedRoles: 1 }) }));
        expect(report.findings[0]?.evidence[0]?.verification).toBe("verified");
    });
});
