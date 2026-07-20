import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadReviewDsl, parseReviewDsl } from "../../src/review/dsl.js";
import { registerEvidenceValidationPolicy, registerReviewRenderer, registerReviewerRole, registerReviewWorkflow } from "../../src/review/extensions.js";
import { defaultReviewWorkflowRegistry } from "../../src/workflows/registry.js";

describe("constrained review DSL", () => {
    it("loads safe YAML into a built-in workflow definition", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-dsl-"));
        const path = join(root, "review.yaml");
        await writeFile(path, `version: 1
workflow: code-review
profile: quick
objective:
  - security
constraints:
  - preserve API
scope:
  kind: repository
  root: ${JSON.stringify(root)}
committee:
  - role: architect
  - role: security
  - role: devil
  - role: integrator
stages:
  - independent-review
  - cross-review
  - devil
  - integrate
crossReview:
  severityAtLeast: high
  maxChallengesPerFinding: 1
devil:
  enabled: true
output:
  - markdown
  - json
`);
        const loaded = await loadReviewDsl("review.yaml", { baseDir: root, cwd: root });
        expect(loaded.request).toEqual(expect.objectContaining({ workflow: "code-review", profile: "quick", renderer: "markdown", language: "zh-CN" }));
        expect(loaded.definition.roles.map((role) => role.roleId)).toEqual(["architect", "security", "devil", "integrator"]);
        expect(loaded.renderers).toEqual(["markdown", "json"]);
    });

    it("rejects unknown fields, unsafe stages, aliases, traversal, and excessive committee size", async () => {
        expect(() => parseReviewDsl({ version: 1, workflow: "code-review", objective: [], scope: { kind: "repository" }, execute: "rm -rf /" })).toThrow("unknown review definition field");
        expect(() => parseReviewDsl({ version: 1, workflow: "code-review", objective: [], scope: { kind: "repository" }, stages: ["independent-review", "shell", "integrate"] })).toThrow("unsafe review stage");
        expect(() => parseReviewDsl({ version: 1, workflow: "code-review", objective: [], scope: { kind: "repository" }, committee: Array.from({ length: 9 }, () => ({ role: "architect" })) })).toThrow("between 1 and 8");
        const root = await mkdtemp(join(tmpdir(), "chorus-dsl-"));
        const outside = join(root, "..", `outside-${Date.now()}.yaml`);
        await writeFile(outside, "version: 1\nworkflow: code-review\n");
        await expect(loadReviewDsl(outside, { baseDir: root })).rejects.toThrow("escapes base directory");
        await writeFile(join(root, "alias.yaml"), "version: 1\nworkflow: code-review\nobjective: &x [security]\nconstraints: *x\nscope: { kind: repository }\n");
        await expect(loadReviewDsl("alias.yaml", { baseDir: root })).rejects.toThrow();
    });
});

describe("review extension registries", () => {
    it("requires namespaced IDs and keeps custom workflows on policy-enforced stages", () => {
        expect(() => registerReviewerRole({ id: "plain", name: "Plain", objective: "x", instructions: "x", findingCategories: [], requiredEvidence: [] })).toThrow("namespaced");
        registerReviewerRole({ id: "example/legal", name: "Legal Reviewer", objective: "Review legal constraints", instructions: "Cite documents", findingCategories: ["legal"], requiredEvidence: ["document"] });
        registerReviewWorkflow({ definition: { version: 1, id: "example/legal-review", name: "Legal Review", roles: [{ roleId: "example/legal" }], stages: ["independent-review", "integrate"], maxChallengesPerFinding: 0, challengeSeverityAtLeast: "high" } });
        expect(defaultReviewWorkflowRegistry.get("example/legal-review").definition.roles[0]?.roleId).toBe("example/legal");
        registerReviewRenderer({ id: "example/text", mediaType: "text/plain", extension: "txt", render: (report) => report.executiveSummary });
        registerEvidenceValidationPolicy({ id: "example/no-generated", validate: (evidence) => evidence.id.includes("generated") ? "generated evidence ID is forbidden" : undefined });
    });
});
