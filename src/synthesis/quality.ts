export interface StructuredSynthesis {
    version: 1;
    answer: string;
    claims: Array<{ text: string; evidenceIds: string[] }>;
    disagreements: string[];
    confidence: number | null;
    unresolvedQuestions: string[];
}
export interface QualityMetrics { coverage: number; agreement: number; evidenceSupport: number; }

export function parseStructuredSynthesis(raw: string): StructuredSynthesis | null {
    try {
        const value = JSON.parse(raw) as Partial<StructuredSynthesis>;
        if (value.version !== 1 || typeof value.answer !== "string" || !Array.isArray(value.claims) || !Array.isArray(value.disagreements) || !Array.isArray(value.unresolvedQuestions)) return null;
        const claims = value.claims.filter((claim): claim is { text: string; evidenceIds: string[] } => !!claim && typeof claim === "object" && typeof claim.text === "string" && Array.isArray(claim.evidenceIds) && claim.evidenceIds.every((id) => typeof id === "string"));
        if (claims.length !== value.claims.length) return null;
        return { version: 1, answer: value.answer, claims, disagreements: value.disagreements.filter((item): item is string => typeof item === "string"), confidence: typeof value.confidence === "number" ? Math.max(0, Math.min(1, value.confidence)) : null, unresolvedQuestions: value.unresolvedQuestions.filter((item): item is string => typeof item === "string") };
    } catch { return null; }
}

export function evaluateQuality(result: StructuredSynthesis, availableEvidenceIds: string[]): QualityMetrics {
    const evidence = new Set(availableEvidenceIds);
    const supported = result.claims.filter((claim) => claim.evidenceIds.some((id) => evidence.has(id))).length;
    return { coverage: result.claims.length === 0 ? 0 : Math.min(1, supported / result.claims.length), agreement: result.claims.length === 0 ? 0 : Math.max(0, 1 - result.disagreements.length / result.claims.length), evidenceSupport: result.claims.length === 0 ? 0 : supported / result.claims.length };
}
