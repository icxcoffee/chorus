import type { ReviewerRole } from "./contracts.js";
import type { ReviewWorkflow } from "../workflows/contracts.js";
import type { ReviewRenderer } from "../renderers/registry.js";
import type { EvidenceValidationPolicy } from "../evidence/registry.js";
import { defaultReviewerRoleRegistry } from "../roles/registry.js";
import { defaultReviewWorkflowRegistry } from "../workflows/registry.js";
import { defaultReviewRendererRegistry } from "../renderers/registry.js";
import { defaultEvidenceValidationPolicyRegistry } from "../evidence/registry.js";

export const REVIEW_EXTENSION_API_VERSION = 1 as const;

export function registerReviewerRole(role: ReviewerRole): void {
    requireNamespaced(role.id, "reviewer role");
    defaultReviewerRoleRegistry.register(role);
}

export function registerReviewWorkflow(workflow: ReviewWorkflow): void {
    requireNamespaced(workflow.definition.id, "review workflow");
    if (workflow.definition.version !== 1) throw new Error("custom review workflows must use schema version 1");
    if (workflow.definition.stages.some((stage) => !["independent-review", "cross-review", "devil", "integrate"].includes(stage))) throw new Error("custom workflows may only compose registered policy-enforced stages");
    defaultReviewWorkflowRegistry.register(workflow);
}

export function registerReviewRenderer(renderer: ReviewRenderer): void {
    requireNamespaced(renderer.id, "review renderer");
    const render = renderer.render.bind(renderer);
    defaultReviewRendererRegistry.register({
        ...renderer,
        render(report) {
            const output = render(report);
            if (output.length > 2_000_000) throw new Error(`custom renderer ${renderer.id} exceeded the output limit`);
            return output;
        },
    });
}

export function registerEvidenceValidationPolicy(policy: EvidenceValidationPolicy): void {
    requireNamespaced(policy.id, "evidence validation policy");
    defaultEvidenceValidationPolicyRegistry.register(policy);
}

function requireNamespaced(id: string, kind: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`${kind} ID must be namespaced, for example vendor/name`);
}
