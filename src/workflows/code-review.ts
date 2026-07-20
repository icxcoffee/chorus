import type { ReviewDefinition, ReviewerAssignment } from "../review/contracts.js";
import { REVIEW_SCHEMA_VERSION } from "../review/contracts.js";

const defaultAssignments: ReviewerAssignment[] = [
    { roleId: "architect" },
    { roleId: "security" },
    { roleId: "performance" },
    { roleId: "maintainability" },
    { roleId: "devil", modelPolicy: { distinctFrom: ["architect", "security", "performance", "maintainability"] } },
    { roleId: "integrator", modelPolicy: { distinctFrom: ["devil"] } },
];

export const codeReviewDefinition: ReviewDefinition = {
    version: REVIEW_SCHEMA_VERSION,
    revision: 2,
    id: "code-review",
    name: "Code Review",
    roles: defaultAssignments,
    stages: ["independent-review", "cross-review", "devil", "integrate"],
    maxChallengesPerFinding: 1,
    challengeSeverityAtLeast: "high",
    objective: "Find concrete defects and regression risks in the reviewed code change or repository.",
    allowedScopeKinds: ["repository", "files", "diff"],
    roleBriefs: {
        architect: "Focus on change-local compatibility, dependency direction, and failure isolation rather than proposing a broad redesign.",
        security: "Trace attacker-controlled inputs through the changed or reviewed code to a concrete impact.",
        performance: "Identify material request-path, I/O, concurrency, or memory regressions with a triggering workload.",
        maintainability: "Prioritize defect-prone duplication, brittle contracts, and missing regression tests over style preferences.",
    },
    findingCategories: ["correctness", "security", "performance", "maintainability", "compatibility", "testing"],
    decisionPolicy: { blockOn: ["critical", "high", "medium"], investigateOn: ["critical", "high", "medium"], incomplete: "investigate" },
    reportSections: ["regressionRisks", "testGaps"],
};
