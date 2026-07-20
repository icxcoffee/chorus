import type { ModelInfo, ModelRef } from "../types.js";
import type { ModelPolicy, ReviewDefinition, ReviewProfile, ReviewerAssignment } from "./contracts.js";
import { sameModelRef } from "../utils/models.js";
import { applyReviewProfile } from "./profiles.js";

export function resolveProfiledReviewerAssignments(definition: ReviewDefinition, profile: ReviewProfile, registry: ModelInfo[]): { definition: ReviewDefinition; assignments: ReviewerAssignment[] } {
    const effective = applyReviewProfile(definition, profile);
    return { definition: effective, assignments: resolveReviewerAssignments(effective.roles, registry) };
}

export function addCommitteeFallbacks(assignments: ReviewerAssignment[], maximum = 2): ReviewerAssignment[] {
    return assignments.map((assignment) => {
        const primary = assignment.resolvedModel;
        if (!primary) return assignment;
        if (isPinnedModelPolicy(assignment.modelPolicy, primary)) return assignment;
        const excludedRoles = new Set(assignment.modelPolicy?.distinctFrom ?? []);
        const committee = assignments
            .filter((candidate) => candidate.roleId !== assignment.roleId && !excludedRoles.has(candidate.roleId))
            .flatMap((candidate) => candidate.resolvedModel ? [{ roleId: candidate.roleId, model: candidate.resolvedModel }] : [])
            .sort((left, right) => fallbackPriority(left, primary) - fallbackPriority(right, primary));
        const candidates = [
            ...(assignment.resolvedFallbackModels ?? []),
            ...committee.map((candidate) => candidate.model),
        ].filter((candidate, index, values) => !sameModelRef(candidate, primary)
            && values.findIndex((value) => sameModelRef(value, candidate)) === index);
        const selected = selectFallbacks(candidates, primary, maximum);
        return { ...assignment, ...(selected.length > 0 ? { resolvedFallbackModels: selected } : {}) };
    });
}

function fallbackPriority(candidate: { roleId: string; model: ModelRef }, primary: ModelRef): number {
    if (candidate.model.provider === primary.provider) return 0;
    if (candidate.roleId === "integrator") return 1;
    return 2;
}

export function applyReviewerModelOverrides(definition: ReviewDefinition, overrides: Record<string, ModelRef> = {}): ReviewDefinition {
    return {
        ...definition,
        roles: definition.roles.map((assignment) => {
            const model = overrides[assignment.roleId];
            return model ? { ...assignment, modelPolicy: { preferred: [model], fallback: [model], pinned: true } } : assignment;
        }),
    };
}

export function resolveReviewerAssignments(assignments: ReviewerAssignment[], registry: ModelInfo[]): ReviewerAssignment[] {
    const resolved = new Map<string, ModelRef>();
    return assignments.map((assignment) => {
        const model = resolveModelPolicy(assignment.modelPolicy ?? {}, registry, assignment.roleId, resolved);
        resolved.set(assignment.roleId, model);
        const resolvedFallbackModels = resolveRuntimeFallbacks(assignment.modelPolicy ?? {}, registry, model, resolved);
        return { ...assignment, resolvedModel: model, ...(resolvedFallbackModels.length > 0 ? { resolvedFallbackModels } : {}) };
    });
}

export function resolveModelPolicy(policy: ModelPolicy, registry: ModelInfo[], roleId: string, resolved: ReadonlyMap<string, ModelRef> = new Map()): ModelRef {
    const excluded = policy.exclude ?? [];
    const distinct = (policy.distinctFrom ?? []).map((id) => resolved.get(id)).filter((ref): ref is ModelRef => !!ref);
    const eligible = (model: ModelInfo): boolean => {
        const ref = toRef(model);
        return !excluded.some((candidate) => sameModelRef(candidate, ref))
            && !distinct.some((candidate) => sameModelRef(candidate, ref))
            && (!policy.requireReasoning || model.reasoning === true);
    };
    for (const ref of [...(policy.preferred ?? []), ...(policy.fallback ?? [])]) {
        const match = registry.find((model) => sameModelRef(model, ref) && eligible(model));
        if (match) return toRef(match);
    }
    const fallback = registry.find(eligible);
    if (fallback) return toRef(fallback);
    throw new Error(`no eligible model for reviewer role "${roleId}"`);
}

function toRef(model: Pick<ModelInfo, "provider" | "modelId">): ModelRef {
    return { provider: model.provider, modelId: model.modelId };
}

function resolveRuntimeFallbacks(policy: ModelPolicy, registry: ModelInfo[], selected: ModelRef, resolved: ReadonlyMap<string, ModelRef>): ModelRef[] {
    const excluded = policy.exclude ?? [];
    const distinct = (policy.distinctFrom ?? []).map((id) => resolved.get(id)).filter((ref): ref is ModelRef => !!ref);
    const eligible = (model: ModelInfo): boolean => {
        const ref = toRef(model);
        return !sameModelRef(ref, selected)
            && !excluded.some((candidate) => sameModelRef(candidate, ref))
            && !distinct.some((candidate) => sameModelRef(candidate, ref))
            && (!policy.requireReasoning || model.reasoning === true);
    };
    const configuredRefs = [...(policy.preferred ?? []), ...(policy.fallback ?? [])];
    const configured = configuredRefs
        .flatMap((ref) => registry.filter((model) => sameModelRef(model, ref) && eligible(model)))
        .map(toRef);
    const candidates = configuredRefs.length > 0
        ? configured
        : registry.filter((model) => model.provider === selected.provider && eligible(model)).map(toRef);
    return candidates.filter((candidate, index) => candidates.findIndex((item) => sameModelRef(item, candidate)) === index).slice(0, 2);
}

function selectFallbacks(candidates: ModelRef[], primary: ModelRef, maximum: number): ModelRef[] {
    const limit = Math.max(0, Math.floor(maximum));
    const selected = candidates.slice(0, limit);
    if (limit < 2 || selected.length < 2 || selected.some((candidate) => candidate.provider !== primary.provider)) return selected;
    const diverse = candidates.find((candidate) => candidate.provider !== primary.provider);
    if (diverse) selected[selected.length - 1] = diverse;
    return selected;
}

function isPinnedModelPolicy(policy: ModelPolicy | undefined, primary: ModelRef): boolean {
    return policy?.pinned === true
        && policy.preferred?.length === 1
        && policy.fallback?.length === 1
        && sameModelRef(policy.preferred[0]!, primary)
        && sameModelRef(policy.fallback[0]!, primary);
}
