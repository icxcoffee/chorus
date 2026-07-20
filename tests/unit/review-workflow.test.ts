import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runReview } from "../../src/review/runner.js";
import type { ReviewRequest } from "../../src/review/contracts.js";
import type { ReviewRoleExecutor } from "../../src/workflows/contracts.js";
import { defaultReviewWorkflowRegistry } from "../../src/workflows/registry.js";
import { registry } from "./fixtures.js";
import { reviewExecutionStatus } from "../../src/review/status.js";

describe("code review workflow", () => {
    it("runs independent, cross, devil, and integration stages into one decision report", async () => {
        const root = await fixtureRepository();
        const execute = vi.fn(async (args: Parameters<ReviewRoleExecutor["execute"]>[0]) => execution(args, false));
        const stages: string[] = [];
        const stageStarts: string[] = [];
        const progress: string[] = [];
        const reviewStartedAt = Date.now();
        const result = await runReview({
            request: request(root),
            registry,
            executor: { execute },
            onStage: (stage) => stages.push(`${stage.stage}:${stage.status}`),
            onStageStart: (stage) => stageStarts.push(stage),
            onExecution: (update) => progress.push(`${update.roleId}:${update.status}`),
        });
        expect(stages).toEqual([
            "independent-review:success",
            "cross-review:success",
            "devil:success",
            "integrate:success",
        ]);
        expect(result.report.decision).toBe("request-changes");
        expect(result.report.executiveSummary).toBe("结论：需要修改。已验证问题 1 项，待确认问题 0 项。");
        expect(result.report.findings).toHaveLength(1);
        expect(result.report.findings[0]).toEqual(expect.objectContaining({ status: "verified", raisedBy: ["architect"] }));
        expect(result.report.findings[0]?.evidence[0]?.verification).toBe("verified");
        expect(result.report.findings[0]?.challenges.map((challenge) => challenge.reviewerRoleId)).toEqual(expect.arrayContaining(["security", "devil"]));
        expect([0, 1, 2].map((index) => stageFindings(result, index)[0]?.challenges.length)).toEqual([0, 1, 2]);
        expect(result.executions).toHaveLength(7);
        expect(stageStarts).toEqual(["independent-review", "cross-review", "devil", "integrate"]);
        expect(progress).toEqual(expect.arrayContaining(["architect:running", "architect:success", "integrator:running", "integrator:success"]));
        expect(reviewExecutionStatus(result)).toBe("success");
        expect(reviewExecutionStatus({
            ...result,
            report: { ...result.report, coverage: { ...result.report.coverage, budgetOverruns: 1 } },
        })).toBe("degraded");
        expect(result.report.unresolvedQuestions.some((item) => item.includes("normalized"))).toBe(false);
        expect((result.stages[0]?.output as { normalizationNotes: string[] }).normalizationNotes).toEqual(expect.arrayContaining([expect.stringContaining("evidence[0].id generated")]));
        expect(result.report.language).toBe("zh-CN");
        expect(execute.mock.calls.every(([args]) => args.prompt.includes("所有面向用户的 JSON 字符串值必须使用简体中文"))).toBe(true);
        expect(result.report.run.durationMs).toBeLessThanOrEqual(Date.now() - reviewStartedAt + 10);
    });

    it("normalizes structured integrator narratives without rendering nested evidence", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: request(root),
            registry,
            executor: {
                execute: async (args) => {
                    if (args.stage !== "integrate") return execution(args, false);
                    return {
                        ...execution(args, false),
                        output: {
                            executiveSummary: "评审完成。",
                            positiveObservations: [{ title: "已有调度器", description: "现有实现可以复用。" }],
                            newUnresolvedQuestions: [],
                            sections: {
                                regressionRisks: [{ title: "默认并发风险", description: "省略选项时会进入无界分支。", recommendedAction: "默认启用有界调度。", evidence: [{ excerpt: "const bounded = true;" }] }],
                                testGaps: ["缺少默认值回归测试。"],
                            },
                            findingResolutions: [],
                        },
                    };
                },
            },
        });

        expect(result.report.positiveObservations).toContain("已有调度器：现有实现可以复用。");
        expect(result.report.workflowSections).toEqual({
            regressionRisks: ["默认并发风险：省略选项时会进入无界分支；建议：默认启用有界调度。"],
            testGaps: ["缺少默认值回归测试。"],
        });
        expect(JSON.stringify(result.report.workflowSections)).not.toContain("const bounded");
    });

    it("does not approve when the final integration execution fails", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: { ...request(root), profile: "quick" },
            registry,
            executor: {
                execute: async (args) => args.stage === "integrate"
                    ? execution(args, true)
                    : {
                        ...execution(args, false),
                        output: args.stage === "independent-review"
                            ? { findings: [], positiveObservations: ["源码检查已完成。"], unresolvedQuestions: [] }
                            : args.stage === "devil"
                                ? { challenges: [], findings: [], missingAreas: [] }
                                : execution(args, false).output,
                    },
            },
        });

        expect(result.stages.at(-1)).toEqual(expect.objectContaining({ stage: "integrate", status: "partial" }));
        expect(result.report.decision).toBe("needs-investigation");
        expect(result.report.executiveSummary).toContain("需要进一步调查");
    });

    it("runs independent expert roles concurrently while preserving assignment order", async () => {
        const root = await fixtureRepository();
        let active = 0;
        let maximum = 0;
        const result = await runReview({
            request: request(root),
            registry,
            executor: {
                execute: async (args) => {
                    if (args.stage === "independent-review") {
                        active += 1;
                        maximum = Math.max(maximum, active);
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        active -= 1;
                    }
                    return execution(args, false);
                },
            },
        });
        expect(maximum).toBe(4);
        expect(result.executions.filter((item) => item.stage === "independent-review").map((item) => item.roleId)).toEqual(["architect", "security", "performance", "maintainability"]);
    });

    it("bounds quick cross-review without starving Devil or Integrator", async () => {
        const root = await fixtureRepository();
        const stages: string[] = [];
        let activeCrossReviews = 0;
        let maximumCrossReviews = 0;
        const execute = vi.fn(async (args: Parameters<ReviewRoleExecutor["execute"]>[0]) => {
            if (args.stage === "cross-review") {
                activeCrossReviews += 1;
                maximumCrossReviews = Math.max(maximumCrossReviews, activeCrossReviews);
                await new Promise((resolve) => setTimeout(resolve, 5));
                activeCrossReviews -= 1;
            }
            const output = args.stage === "independent-review"
                ? {
                    findings: [{
                        id: `${args.role.id}-finding`, title: `${args.role.id} material risk`, description: "The reviewed route needs verification.", category: "correctness", severity: "high", confidence: "high", status: "proposed",
                        evidence: [{ id: `${args.role.id}-evidence`, kind: "code", path: "route.ts", startLine: 1, endLine: 2, excerpt: "export function route(user: unknown) {\n    return loadUser(user);" }], raisedBy: [args.role.id], challenges: [],
                    }], positiveObservations: [], unresolvedQuestions: [],
                }
                : args.stage === "cross-review"
                    ? { verdict: "support", rationale: "The source supports bounded follow-up.", evidence: [] }
                    : args.stage === "devil"
                        ? { challenges: abstainChallenges(args.prompt), findings: [], missingAreas: [] }
                        : { executiveSummary: "评审完成。", requiredActions: [], positiveObservations: [], unresolvedQuestions: [], sections: {} };
            return { roleId: args.role.id, stage: args.stage, output, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 };
        });

        const result = await runReview({ request: { ...request(root), profile: "quick" }, registry, executor: { execute }, onStage: (stage) => stages.push(`${stage.stage}:${stage.status}`) });

        expect(execute.mock.calls.map(([args]) => args.stage).filter((stage) => stage === "independent-review")).toHaveLength(3);
        expect(execute.mock.calls.map(([args]) => args.stage).filter((stage) => stage === "cross-review")).toHaveLength(2);
        expect(execute.mock.calls.map(([args]) => args.stage).filter((stage) => stage === "devil")).toHaveLength(1);
        expect(execute.mock.calls.map(([args]) => args.stage).filter((stage) => stage === "integrate")).toHaveLength(1);
        expect(stages).toEqual(["independent-review:success", "cross-review:success", "devil:success", "integrate:success"]);
        expect((result.stages.find((stage) => stage.stage === "cross-review")?.output as { omittedChallengeCount: number }).omittedChallengeCount).toBe(1);
        expect(result.report.coverage.stages).toEqual(expect.arrayContaining([
            expect.objectContaining({ stage: "independent-review", planned: 3, attempted: 3, usable: 3, failed: 0, omitted: 0, status: "success" }),
            expect.objectContaining({ stage: "cross-review", planned: 3, attempted: 2, usable: 2, failed: 0, omitted: 1, status: "success" }),
            expect.objectContaining({ stage: "devil", planned: 3, attempted: 3, usable: 3, failed: 0, omitted: 0, status: "success" }),
            expect.objectContaining({ stage: "integrate", planned: 1, attempted: 1, usable: 1, failed: 0, omitted: 0, status: "success" }),
        ]));
        expect(maximumCrossReviews).toBe(2);
    });

    it("caps Quick findings per reviewer and the Devil packet", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: { ...request(root), profile: "quick" },
            registry,
            executor: {
                execute: async (args) => {
                    const output = args.stage === "independent-review"
                        ? {
                            findings: Array.from({ length: 5 }, (_, index) => ({
                                id: `${args.role.id}-${index}`, title: `${args.role.id} candidate ${index}`, description: "A bounded candidate.", category: "maintainability", severity: "low", confidence: "high", status: "proposed",
                                evidence: [{ id: `${args.role.id}-${index}-e`, kind: "code", path: "route.ts", startLine: 1, excerpt: "export function route(user: unknown) {" }], raisedBy: [args.role.id], challenges: [],
                            })), positiveObservations: [], unresolvedQuestions: [],
                        }
                        : args.stage === "devil"
                            ? { challenges: abstainChallenges(args.prompt), findings: [], missingAreas: [] }
                            : { executiveSummary: "评审完成。", requiredActions: [], positiveObservations: [], unresolvedQuestions: [], sections: {} };
                    return { roleId: args.role.id, stage: args.stage, output, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 };
                },
            },
        });

        expect(result.report.findings).toHaveLength(9);
        expect((result.stages[0]?.output as { omittedFindingCount: number }).omittedFindingCount).toBe(6);
        expect((result.stages.find((stage) => stage.stage === "devil")?.output as { omittedDevilFindingCount: number }).omittedDevilFindingCount).toBe(4);
    });

    it("applies a source-validated Integrator resolution to the normalized Finding", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: { ...request(root), profile: "quick" },
            registry,
            executor: {
                execute: async (args) => {
                    let output: unknown;
                    if (args.stage === "independent-review") output = {
                        findings: args.role.id === "architect" ? [{
                            id: "conditional", title: "The route may be unreachable", description: "The exported route is claimed to be unreachable.", category: "compatibility", severity: "low", confidence: "high", status: "proposed",
                            evidence: [{ id: "route", kind: "code", path: "route.ts", startLine: 1, excerpt: "export function route(user: unknown) {" }], raisedBy: [args.role.id], challenges: [],
                        }] : [], positiveObservations: [], unresolvedQuestions: [],
                    };
                    else if (args.stage === "devil") output = { challenges: abstainChallenges(args.prompt), findings: [], missingAreas: [] };
                    else {
                        const findingId = /finding-[a-f0-9]+/.exec(args.prompt)?.[0] ?? "missing";
                        output = {
                            executiveSummary: "源码证明该条件性结论不成立。", requiredActions: [], positiveObservations: [], unresolvedQuestions: [], sections: {},
                            findingResolutions: [{
                                findingId,
                                verdict: "object",
                                rationale: "The route is publicly exported.",
                                evidence: [
                                    { kind: "code", path: "route.ts", startLine: 0, excerpt: "invalid optional evidence" },
                                    { kind: "code", path: "route.ts", startLine: 1, excerpt: "export function route(user: unknown) {" },
                                ],
                            }],
                        };
                    }
                    return { roleId: args.role.id, stage: args.stage, output, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 };
                },
            },
        });

        expect(result.report.findings).toHaveLength(1);
        expect(result.report.findings[0]).toEqual(expect.objectContaining({ status: "rejected" }));
        expect(result.report.findings[0]?.challenges).toEqual(expect.arrayContaining([expect.objectContaining({ reviewerRoleId: "integrator", verdict: "object" })]));
        expect(result.report.decision).toBe("approve");
        expect(result.stages.at(-1)).toEqual(expect.objectContaining({ stage: "integrate", status: "success", diagnostics: [] }));
        expect((result.stages.at(-1)?.output as { normalizationNotes: string[] }).normalizationNotes).toEqual(expect.arrayContaining([
            expect.stringContaining("discarded after normalization"),
        ]));
        expect(result.report.executionDiagnostics ?? []).not.toContain(expect.stringContaining("unknown-stage"));
    });

    it("supersedes a stale Finding with a verified corrected replacement", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: request(root),
            registry,
            executor: {
                execute: async (args) => {
                    let output: unknown;
                    if (args.stage === "independent-review") output = {
                        findings: args.role.id === "architect" ? [{
                            id: "broad", title: "Route is always unsafe", description: "The route is claimed to be unsafe in every mode.", category: "security", severity: "high", confidence: "high", status: "proposed",
                            evidence: [{ kind: "code", path: "route.ts", startLine: 2, excerpt: "export function route(user: unknown) {" }], raisedBy: [args.role.id], challenges: [], recommendation: "Disable the route.",
                        }] : [], positiveObservations: [], unresolvedQuestions: ["Is the route exported?"],
                    };
                    else if (args.stage === "cross-review") {
                        const findingId = /finding-[a-f0-9]+/.exec(args.prompt)?.[0] ?? "missing";
                        output = { findingId, verdict: "abstain", rationale: "The original citation is stale.", evidence: [] };
                    } else if (args.stage === "devil") output = { challenges: abstainChallenges(args.prompt), findings: [], missingAreas: [] };
                    else {
                        const findingId = /finding-[a-f0-9]+/.exec(args.prompt)?.[0] ?? "missing";
                        output = {
                            executiveSummary: "The corrected medium finding is verified.", positiveObservations: [], resolvedQuestionIds: ["prior-1"], newUnresolvedQuestions: ["Which deployment mode is active?"], sections: {},
                            findingResolutions: [{
                                findingId, verdict: "correct", rationale: "The route is exported; the narrower defect remains.", evidence: [],
                                replacement: {
                                    title: "Route lacks an authorization gate", description: "The exported route loads the user without an authorization gate.", category: "security", severity: "medium", confidence: "high",
                                    recommendation: "Authorize before loading the user.",
                                    evidence: [{ kind: "code", path: "route.ts", startLine: 1, endLine: 2, excerpt: "export function route(user: unknown) {\n    return loadUser(user);" }],
                                },
                            }],
                        };
                    }
                    return { roleId: args.role.id, stage: args.stage, output, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 };
                },
            },
        });

        expect(result.report.findings[0]).toEqual(expect.objectContaining({
            title: "Route lacks an authorization gate", severity: "medium", status: "verified",
        }));
        expect(result.report.requiredActions).toEqual(["Authorize before loading the user."]);
        expect(result.report.unresolvedQuestions).toEqual([
            "Which deployment mode is active?",
            "评审覆盖不完整：independent-review 阶段以下角色未产生可用评审信号：maintainability, performance, security。",
        ]);
        expect(result.report.unresolvedQuestions).not.toContain("Is the route exported?");
    });

    it("marks Global Devil partial when one planned challenge is malformed", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: { ...request(root), profile: "quick" },
            registry,
            executor: {
                execute: async (args) => {
                    let output: unknown;
                    if (args.stage === "independent-review") output = {
                        findings: args.role.id === "architect" ? [{
                            id: "candidate", title: "Low confidence boundary", description: "A review candidate.", category: "maintainability", severity: "low", confidence: "high", status: "proposed",
                            evidence: [{ id: "route", kind: "code", path: "route.ts", startLine: 1, excerpt: "export function route(user: unknown) {" }], raisedBy: [args.role.id], challenges: [],
                        }] : [], positiveObservations: [], unresolvedQuestions: [],
                    };
                    else if (args.stage === "devil") output = { challenges: [{ findingId: /finding-[a-f0-9]+/.exec(args.prompt)?.[0], verdict: "object", evidence: [] }], findings: [], missingAreas: [] };
                    else output = { executiveSummary: "评审降级。", requiredActions: [], positiveObservations: [], unresolvedQuestions: [], sections: {}, findingResolutions: [] };
                    return { roleId: args.role.id, stage: args.stage, output, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 };
                },
            },
        });

        const devil = result.report.coverage.stages?.find((stage) => stage.stage === "devil");
        expect(devil).toEqual(expect.objectContaining({ status: "partial", planned: 1, attempted: 1, usable: 0, failed: 1 }));
        expect(result.report.coverage.omittedStages).toContain("devil");
    });

    it("honors provider concurrency limits for expert roles", async () => {
        const root = await fixtureRepository();
        let active = 0;
        let maximum = 0;
        await runReview({
            request: request(root),
            registry,
            executionPolicy: { maxConcurrency: 4, providerLimits: { deepseek: 1 } },
            executor: {
                execute: async (args) => {
                    if (args.stage === "independent-review") {
                        active += 1;
                        maximum = Math.max(maximum, active);
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        active -= 1;
                    }
                    return execution(args, false);
                },
            },
        });
        expect(maximum).toBe(1);
    });

    it("keeps a complete report when one independent reviewer returns malformed output", async () => {
        const root = await fixtureRepository();
        const progress: string[] = [];
        const result = await runReview({
            request: request(root),
            registry,
            executor: { execute: async (args) => execution(args, args.role.id === "performance") },
            onExecution: (update) => progress.push(`${update.roleId}:${update.status}`),
        });
        expect(result.stages[0]?.status).toBe("partial");
        expect(result.report.coverage).toEqual(expect.objectContaining({ requestedRoles: 4, completedRoles: 3 }));
        expect(result.report.decision).toBe("request-changes");
        expect(progress).not.toContain("performance:success");
        expect(progress).toContain("performance:error");
    });

    it("distinguishes schema completion from usable role and repository file coverage", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: request(root),
            registry,
            executor: {
                execute: async (args) => args.stage === "independent-review" && args.role.id === "security"
                    ? { roleId: "security", stage: args.stage, output: { findings: [], positiveObservations: [], unresolvedQuestions: ["Source inspection stopped before relevant entry points were read."] }, durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 }
                    : execution(args, false),
            },
        });

        expect(result.report.coverage).toEqual(expect.objectContaining({
            requestedRoles: 4,
            completedRoles: 4,
            usableRoles: 3,
            emptyRoles: ["security"],
            reviewedFiles: 1,
            citedFiles: 1,
            explicitFiles: 0,
        }));
        expect(result.report.unresolvedQuestions).toContain("评审覆盖不完整：independent-review 阶段以下角色未产生可用评审信号：security。");
        expect(result.report.unresolvedQuestions).not.toContain("Source inspection stopped before relevant entry points were read.");
        expect((result.stages[0]?.output as { unresolvedQuestions: string[] }).unresolvedQuestions).toContain("Source inspection stopped before relevant entry points were read.");
        expect(reviewExecutionStatus(result)).toBe("degraded");
    });

    it("degrades once when a cited repository file changes between stages", async () => {
        const root = await fixtureRepository();
        const result = await runReview({
            request: request(root),
            registry,
            executor: {
                execute: async (args) => {
                    if (args.stage === "cross-review") await writeFile(join(root, "route.ts"), "// changed during review\nexport function route(user: unknown) {\n    return loadUser(user);\n}\n");
                    return execution(args, false);
                },
            },
        });

        expect(result.report.coverage.mutatedFiles).toBe(1);
        expect(result.report.unresolvedQuestions.filter((item) => item.includes("评审期间发生变化"))).toHaveLength(1);
        expect(result.report.executionDiagnostics).toContain("scope/snapshot: mutated-files (1 occurrences)");
        expect(reviewExecutionStatus(result)).toBe("degraded");
    });

    it("protects registries and degrades to an incomplete report when all reviewer nodes fail", async () => {
        expect(() => defaultReviewWorkflowRegistry.register(defaultReviewWorkflowRegistry.get("code-review"))).toThrow("already registered");
        const root = await fixtureRepository();
        const result = await runReview({
            request: request(root),
            registry,
            executor: { execute: async (args) => execution(args, true) },
        });
        expect(result.stages[0]).toEqual(expect.objectContaining({ stage: "independent-review", status: "error" }));
        expect(result.stages.at(-1)).toEqual(expect.objectContaining({ stage: "integrate", status: "partial" }));
        expect(result.report.decision).toBe("needs-investigation");
        expect(result.report.coverage).toEqual(expect.objectContaining({ requestedRoles: 4, completedRoles: 0, omittedStages: ["independent-review", "devil", "integrate"] }));
        expect(result.stages.find((stage) => stage.stage === "devil")).toEqual(expect.objectContaining({ status: "skipped" }));
        expect(result.report.unresolvedQuestions).toEqual(expect.arrayContaining([expect.stringContaining("independent-review 阶段以下节点不可用：architect, security, performance, maintainability")]));
        expect(result.report.unresolvedQuestions).toEqual(expect.arrayContaining([expect.stringContaining("integrate 阶段以下节点不可用：integrator")]));
        expect(result.report.executionDiagnostics).toEqual(expect.arrayContaining([
            "independent-review/architect: output-format",
            "integrate/integrator: output-format",
        ]));
        expect(reviewExecutionStatus(result)).toBe("degraded");
    });
});
function stageFindings(result: Awaited<ReturnType<typeof runReview>>, index: number) { const output = result.stages[index]?.output; return output && typeof output === "object" && "findings" in output && Array.isArray(output.findings) ? output.findings : []; }

async function fixtureRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "chorus-workflow-"));
    await writeFile(join(root, "route.ts"), "export function route(user: unknown) {\n    return loadUser(user);\n}\n");
    return root;
}

function request(root: string): ReviewRequest {
    return {
        version: 1,
        workflow: "code-review",
        objective: ["security", "compatibility"],
        constraints: ["preserve public API"],
        scope: { kind: "repository", root },
        profile: "deep",
        renderer: "markdown",
        language: "zh-CN",
    };
}

function execution(args: Parameters<ReviewRoleExecutor["execute"]>[0], malformed: boolean) {
    let output: unknown;
    if (malformed) output = "not-json";
    else if (args.stage === "independent-review") output = {
        findings: args.role.id === "architect" ? [{
            id: "proposal",
            title: "Authorization is missing before user loading",
            description: "The route loads user-controlled input without an authorization gate.",
            category: "security",
            severity: "high",
            confidence: "high",
            status: "proposed",
            evidence: [{ kind: "code", path: "route.ts", startLine: 1, endLine: 2, excerpt: "export function route(user: unknown) {\n    return loadUser(user);" }],
            raisedBy: [args.role.id],
            challenges: [],
            recommendation: "Authorize before loading the user.",
        }] : [],
        positiveObservations: args.role.id === "maintainability" ? ["The route is small."] : [],
        unresolvedQuestions: [],
    };
    else if (args.stage === "cross-review") output = { verdict: "support", rationale: "The cited route has no authorization gate.", evidence: [{ kind: "code", path: "route.ts", lines: "1-2", excerpt: "export function route(user: unknown) {\n    return loadUser(user);" }] };
    else if (args.stage === "devil") {
        const findingId = /finding-[a-f0-9]+/.exec(args.prompt)?.[0] ?? "missing";
        output = { challenges: [{ findingId, verdict: "support", rationale: "The finding is narrowly stated and source-backed.", evidence: "route.ts:1-2 - source context" }], findings: [], missingAreas: [] };
    } else output = {
        executiveSummary: "One verified authorization defect blocks approval.",
        requiredActions: ["Authorize before loading the user."],
        positiveObservations: [],
        unresolvedQuestions: [],
    };
    return {
        roleId: args.role.id,
        stage: args.stage,
        model: args.assignment.resolvedModel,
        output,
        rawOutput: typeof output === "string" ? output : JSON.stringify(output),
        durationMs: 10,
        costUsd: 0.001,
        inputTokens: 10,
        outputTokens: 20,
    };
}

function abstainChallenges(prompt: string): Array<{ findingId: string; verdict: "abstain"; rationale: string; evidence: never[] }> {
    return [...new Set(prompt.match(/finding-[a-f0-9]+/g) ?? [])].map((findingId) => ({ findingId, verdict: "abstain", rationale: "No additional challenge is supported.", evidence: [] }));
}
