import { REVIEW_SCHEMA_VERSION, type ReviewDefinition } from "../review/contracts.js";

export const architectureReviewDefinition: ReviewDefinition = {
    version: REVIEW_SCHEMA_VERSION,
    revision: 2,
    id: "architecture-review",
    name: "Architecture Review",
    roles: [{ roleId: "architect" }, { roleId: "reliability" }, { roleId: "security" }, { roleId: "operability" }, { roleId: "devil" }, { roleId: "integrator" }],
    stages: ["independent-review", "cross-review", "devil", "integrate"],
    maxChallengesPerFinding: 1,
    challengeSeverityAtLeast: "medium",
    objective: "Assess system boundaries, dependency direction, data flow, failure domains, operational ownership, and evolutionary constraints across modules.",
    allowedScopeKinds: ["repository", "files", "document"],
    roleBriefs: {
        architect: "Build a system-level view of module boundaries, dependency direction, ownership, and architectural constraints. Avoid line-level style review.",
        reliability: "Evaluate failure domains, state consistency, recovery, concurrency, and degraded-mode behavior across components.",
        security: "Evaluate trust boundaries and privilege transitions at system and integration boundaries, not isolated syntax patterns.",
        operability: "Evaluate deployability, observability, configuration ownership, rollback, capacity, and incident diagnosis.",
    },
    findingCategories: ["boundaries", "coupling", "reliability", "data-flow", "security", "operability", "evolution"],
    decisionPolicy: { blockOn: ["critical"], investigateOn: ["critical", "high", "medium"], incomplete: "investigate" },
    reportSections: ["systemBoundaries", "keyDataFlows", "architecturalTradeoffs", "phasedRecommendations"],
};

export const designReviewDefinition: ReviewDefinition = {
    version: REVIEW_SCHEMA_VERSION,
    revision: 2,
    id: "design-review",
    name: "Design Review",
    roles: [{ roleId: "architect" }, { roleId: "security" }, { roleId: "maintainability" }, { roleId: "devil" }, { roleId: "integrator" }],
    stages: ["independent-review", "cross-review", "devil", "integrate"],
    maxChallengesPerFinding: 1,
    challengeSeverityAtLeast: "medium",
    objective: "Evaluate whether a proposed design is complete, internally coherent, operable, reversible, and compatible with its stated constraints.",
    allowedScopeKinds: ["files", "document"],
    roleBriefs: {
        architect: "Evaluate alternatives, interfaces, compatibility, migration sequencing, and explicit tradeoffs in the proposed design.",
        security: "Identify missing trust-boundary, abuse-case, data-handling, and authorization decisions in the design.",
        maintainability: "Evaluate ownership, testability, rollout complexity, and the long-term cost of the proposed interfaces.",
    },
    findingCategories: ["completeness", "compatibility", "security", "operability", "rollback", "tradeoff"],
    decisionPolicy: { blockOn: ["critical", "high"], investigateOn: ["critical", "high", "medium"], incomplete: "investigate" },
    reportSections: ["alternatives", "tradeoffs", "rolloutAndRollback", "openDecisions"],
};
