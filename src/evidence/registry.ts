import type { EvidenceReference, ReviewScope } from "../review/contracts.js";

export interface EvidenceValidationPolicy {
    id: string;
    validate(reference: Readonly<EvidenceReference>, scope: Readonly<ReviewScope>): string | undefined | Promise<string | undefined>;
}

export class EvidenceValidationPolicyRegistry {
    private readonly policies = new Map<string, EvidenceValidationPolicy>();

    register(policy: EvidenceValidationPolicy): void {
        if (this.policies.has(policy.id)) throw new Error(`evidence validation policy already registered: ${policy.id}`);
        this.policies.set(policy.id, policy);
    }

    list(): EvidenceValidationPolicy[] { return [...this.policies.values()]; }
}

export const defaultEvidenceValidationPolicyRegistry = new EvidenceValidationPolicyRegistry();
