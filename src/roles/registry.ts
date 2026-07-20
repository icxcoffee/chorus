import type { ReviewerRole, ReviewStageId } from "../review/contracts.js";

export class ReviewerRoleRegistry {
    private readonly roles = new Map<string, ReviewerRole>();

    register(role: ReviewerRole): void {
        if (this.roles.has(role.id)) throw new Error(`reviewer role already registered: ${role.id}`);
        this.roles.set(role.id, freezeRole(role));
    }

    get(id: string): ReviewerRole {
        const role = this.roles.get(id);
        if (!role) throw new Error(`unknown reviewer role "${id}"`);
        return freezeRole(role);
    }

    list(): ReviewerRole[] {
        return [...this.roles.values()].map(freezeRole);
    }
}

function freezeRole(role: ReviewerRole): ReviewerRole {
    return Object.freeze({
        ...role,
        findingCategories: Object.freeze([...role.findingCategories]) as unknown as string[],
        requiredEvidence: Object.freeze([...role.requiredEvidence]) as unknown as ReviewerRole["requiredEvidence"],
    });
}

export const defaultReviewerRoleRegistry = new ReviewerRoleRegistry();

const builtIns: ReviewerRole[] = [
    {
        id: "architect",
        name: "Architecture Reviewer",
        objective: "Assess boundaries, coupling, compatibility, failure isolation, and operational design.",
        instructions: "Report concrete design risks and cite the code or document location that creates each risk. Prefer small compatible improvements.",
        findingCategories: ["architecture", "reliability", "compatibility"],
        requiredEvidence: ["code", "document"],
    },
    {
        id: "security",
        name: "Security Reviewer",
        objective: "Find exploitable trust-boundary, authorization, secret, injection, and unsafe-input failures.",
        instructions: "Trace attacker-controlled input to impact. Do not report generic best practices without a concrete source citation and plausible consequence.",
        findingCategories: ["security", "privacy"],
        requiredEvidence: ["code", "log", "document"],
    },
    {
        id: "performance",
        name: "Performance Reviewer",
        objective: "Find material latency, memory, I/O, concurrency, and scalability risks.",
        instructions: "Identify the triggering workload and expensive operation. Distinguish measured behavior from a hypothesis that needs profiling.",
        findingCategories: ["performance", "scalability"],
        requiredEvidence: ["code", "log"],
    },
    {
        id: "maintainability",
        name: "Maintainability Reviewer",
        objective: "Find correctness risks caused by duplication, unclear ownership, brittle contracts, and missing tests.",
        instructions: "Prioritize issues likely to cause defects or expensive changes. Avoid subjective style comments and cite concrete locations.",
        findingCategories: ["maintainability", "correctness", "testing"],
        requiredEvidence: ["code", "document"],
    },
    {
        id: "reliability",
        name: "Reliability Reviewer",
        objective: "Assess failure domains, consistency, recovery, concurrency, and degraded operation across components.",
        instructions: "Trace failures across component boundaries. Distinguish demonstrated failure modes from assumptions that require load, chaos, or recovery testing.",
        findingCategories: ["reliability", "consistency", "recovery", "concurrency"],
        requiredEvidence: ["code", "log", "document"],
    },
    {
        id: "operability",
        name: "Operability Reviewer",
        objective: "Assess deployment, rollback, observability, configuration, capacity, and incident diagnosis.",
        instructions: "Tie operational risks to concrete configuration, code, runbook, or design evidence. Identify missing operational decisions as unresolved questions.",
        findingCategories: ["operability", "observability", "deployment", "capacity"],
        requiredEvidence: ["code", "log", "document"],
    },
    {
        id: "devil",
        name: "Global Devil",
        objective: "Challenge false positives, missing risks, unsupported assumptions, and disproportionate recommendations.",
        instructions: "Challenge normalized findings rather than personalities. New factual claims require source evidence; logical objections require explicit reasoning.",
        findingCategories: ["challenge"],
        requiredEvidence: ["code", "log", "document"],
    },
    {
        id: "integrator",
        name: "Review Integrator",
        objective: "Produce an auditable decision from verified findings, challenges, constraints, and uncertainty.",
        instructions: "Never upgrade unsupported claims to verified. Preserve disputed and rejected findings and derive actions from accepted findings only.",
        findingCategories: ["decision"],
        requiredEvidence: ["code", "log", "document"],
    },
];

for (const role of builtIns) defaultReviewerRoleRegistry.register(role);

export function buildReviewerSystemPrompt(role: ReviewerRole, stage: ReviewStageId = "independent-review"): string {
    const categoryInstruction = stage === "independent-review"
        ? `New findings proposed in this stage must use one of these role categories: ${role.findingCategories.join(", ")}.`
        : `The role categories (${role.findingCategories.join(", ")}) constrain only new findings you propose. Do not reject or downgrade a supplied finding merely because its category belongs to another reviewer role; assess it against the workflow categories, source evidence, and causal argument.`;
    return `${role.name}\n\nObjective: ${role.objective}\n\n${role.instructions}\n\n${categoryInstruction} Required source evidence kinds: ${role.requiredEvidence.join(", ")}. Model responses are proposals, not evidence. Keep source inspection bounded and targeted. You must finish with the exact JSON response requested by the task, even when coverage is incomplete; record uncertainty in unresolvedQuestions instead of ending after tool calls.`;
}
