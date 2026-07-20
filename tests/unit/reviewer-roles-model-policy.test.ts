import { describe, expect, it } from "vitest";
import { defaultReviewerRoleRegistry, ReviewerRoleRegistry, buildReviewerSystemPrompt } from "../../src/roles/registry.js";
import { addCommitteeFallbacks, applyReviewerModelOverrides, resolveProfiledReviewerAssignments, resolveReviewerAssignments } from "../../src/review/model-policy.js";
import { registry } from "./fixtures.js";
import { codeReviewDefinition } from "../../src/workflows/code-review.js";

describe("reviewer roles and model policy", () => {
    it("uses the same profiled role set for jobs and workflow execution", () => {
        expect(resolveProfiledReviewerAssignments(codeReviewDefinition, "quick", registry).assignments.map((assignment) => assignment.roleId)).toEqual(["architect", "security", "performance", "devil", "integrator"]);
        expect(resolveProfiledReviewerAssignments(codeReviewDefinition, "deep", registry).assignments).toHaveLength(6);
    });
    it("honors explicit per-role model overrides", () => {
        const overridden = applyReviewerModelOverrides(codeReviewDefinition, { security: { provider: "minimax", modelId: "MiniMax-M3" } });
        const assignments = resolveProfiledReviewerAssignments(overridden, "quick", registry).assignments;
        expect(assignments.find((assignment) => assignment.roleId === "security")?.resolvedModel).toEqual({ provider: "minimax", modelId: "MiniMax-M3" });
    });
    it("registers stable expert responsibilities and returns immutable copies", () => {
        expect(defaultReviewerRoleRegistry.list().map((role) => role.id)).toEqual(expect.arrayContaining(["architect", "security", "performance", "maintainability", "devil", "integrator"]));
        const security = defaultReviewerRoleRegistry.get("security");
        expect(buildReviewerSystemPrompt(security)).toContain("Model responses are proposals, not evidence");
        expect(buildReviewerSystemPrompt(security, "cross-review")).toContain("Do not reject or downgrade a supplied finding merely because its category belongs to another reviewer role");
        expect(Object.isFrozen(security)).toBe(true);
        expect(() => defaultReviewerRoleRegistry.register(security)).toThrow("already registered");
        expect(() => new ReviewerRoleRegistry().get("missing")).toThrow("unknown reviewer role");
    });

    it("resolves preferred and distinct fallback models separately from roles", () => {
        const assignments = resolveReviewerAssignments([
            { roleId: "architect", modelPolicy: { preferred: [{ provider: "deepseek", modelId: "deepseek-v4-pro" }] } },
            { roleId: "security", modelPolicy: { preferred: [{ provider: "deepseek", modelId: "deepseek-v4-pro" }], distinctFrom: ["architect"] } },
        ], registry);
        expect(assignments[0]?.resolvedModel).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
        expect(assignments[1]?.resolvedModel).not.toEqual(assignments[0]?.resolvedModel);
        expect(assignments.map((assignment) => assignment.roleId)).toEqual(["architect", "security"]);
        const automatic = resolveReviewerAssignments([{ roleId: "architect" }], registry)[0]!;
        expect(automatic.resolvedFallbackModels).toEqual([{ provider: "deepseek", modelId: "deepseek-v4-flash" }]);
    });

    it("keeps explicit Settings model overrides pinned without runtime fallback", () => {
        const overridden = applyReviewerModelOverrides(codeReviewDefinition, { security: { provider: "minimax", modelId: "MiniMax-M3" } });
        const security = addCommitteeFallbacks(resolveProfiledReviewerAssignments(overridden, "quick", registry).assignments).find((assignment) => assignment.roleId === "security");
        expect(security?.resolvedModel).toEqual({ provider: "minimax", modelId: "MiniMax-M3" });
        expect(security?.resolvedFallbackModels).toBeUndefined();
    });

    it("adds committee models as failure-only fallbacks without changing primaries", () => {
        const assignments = addCommitteeFallbacks(resolveReviewerAssignments([
            { roleId: "security", modelPolicy: { preferred: [{ provider: "deepseek", modelId: "deepseek-v4-pro" }], fallback: [{ provider: "deepseek", modelId: "deepseek-v4-pro" }] } },
            { roleId: "performance", modelPolicy: { preferred: [{ provider: "minimax", modelId: "MiniMax-M3" }], fallback: [{ provider: "minimax", modelId: "MiniMax-M3" }] } },
            { roleId: "integrator", modelPolicy: { preferred: [{ provider: "deepseek", modelId: "deepseek-v4-flash" }] } },
        ], registry));
        const security = assignments.find((assignment) => assignment.roleId === "security");
        expect(security?.resolvedModel).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
        expect(security?.resolvedFallbackModels).toEqual([
            { provider: "deepseek", modelId: "deepseek-v4-flash" },
            { provider: "minimax", modelId: "MiniMax-M3" },
        ]);
        expect(assignments.find((assignment) => assignment.roleId === "performance")?.resolvedFallbackModels?.[0]).toEqual({
            provider: "deepseek",
            modelId: "deepseek-v4-flash",
        });
    });

    it("preserves explicit cross-provider fallbacks and reserves a diverse committee slot", () => {
        const customRegistry = [
            { provider: "p", modelId: "primary" },
            { provider: "p", modelId: "same-one" },
            { provider: "p", modelId: "same-two" },
            { provider: "q", modelId: "diverse" },
        ];
        const explicit = resolveReviewerAssignments([{
            roleId: "architect",
            modelPolicy: {
                preferred: [{ provider: "p", modelId: "primary" }],
                fallback: [{ provider: "q", modelId: "diverse" }],
            },
        }], customRegistry)[0];
        expect(explicit?.resolvedFallbackModels).toEqual([{ provider: "q", modelId: "diverse" }]);

        const selected = addCommitteeFallbacks([
            { roleId: "architect", resolvedModel: { provider: "p", modelId: "primary" }, resolvedFallbackModels: [{ provider: "p", modelId: "same-one" }, { provider: "p", modelId: "same-two" }] },
            { roleId: "security", resolvedModel: { provider: "q", modelId: "diverse" } },
        ]).find((assignment) => assignment.roleId === "architect");
        expect(selected?.resolvedFallbackModels).toEqual([
            { provider: "p", modelId: "same-one" },
            { provider: "q", modelId: "diverse" },
        ]);
    });
});
