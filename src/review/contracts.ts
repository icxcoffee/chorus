import type { ModelRef } from "../types.js";

export const REVIEW_SCHEMA_VERSION = 1 as const;

export type ReviewProfile = "quick" | "deep";
export type ReviewLanguage = "zh-CN" | "en";
export type ReviewInputKind = "repository" | "files" | "diff" | "document" | "log";
export type ReviewStageId = "independent-review" | "cross-review" | "devil" | "integrate";
export type EvidenceKind = "code" | "document" | "log";
export type EvidenceVerification = "unverified" | "verified" | "stale" | "invalid" | "unavailable";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingConfidence = "high" | "medium" | "low";
export type FindingStatus = "proposed" | "verified" | "disputed" | "rejected" | "unsupported";
export type ReviewDecision = "approve" | "request-changes" | "needs-investigation";

export interface ReviewScopeRequest {
    kind: ReviewInputKind;
    root?: string;
    paths?: string[];
    exclude?: string[];
    base?: string;
    head?: string;
    selection?: "working" | "staged" | "commit" | "range";
}

export interface ReviewRequest {
    version: typeof REVIEW_SCHEMA_VERSION;
    workflow: string;
    objective: string[];
    constraints: string[];
    scope: ReviewScopeRequest;
    profile: ReviewProfile;
    renderer: string;
    language?: ReviewLanguage;
}

export interface ModelPolicy {
    preferred?: ModelRef[];
    fallback?: ModelRef[];
    pinned?: boolean;
    requireReasoning?: boolean;
    exclude?: ModelRef[];
    distinctFrom?: string[];
}

export interface ReviewerRole {
    id: string;
    name: string;
    objective: string;
    instructions: string;
    findingCategories: string[];
    requiredEvidence: EvidenceKind[];
}

export interface ReviewerAssignment {
    roleId: string;
    modelPolicy?: ModelPolicy;
    resolvedModel?: ModelRef;
    resolvedFallbackModels?: ModelRef[];
}

export interface ReviewDefinition {
    version: typeof REVIEW_SCHEMA_VERSION;
    revision?: number;
    id: string;
    name: string;
    roles: ReviewerAssignment[];
    stages: ReviewStageId[];
    maxChallengesPerFinding: number;
    challengeSeverityAtLeast: FindingSeverity;
    objective?: string;
    allowedScopeKinds?: ReviewInputKind[];
    roleBriefs?: Record<string, string>;
    findingCategories?: string[];
    decisionPolicy?: ReviewDecisionPolicy;
    reportSections?: string[];
}

export interface ReviewDecisionPolicy {
    blockOn: FindingSeverity[];
    investigateOn: FindingSeverity[];
    incomplete: "investigate" | "allow";
}

export interface ReviewScope {
    kind: ReviewInputKind;
    workspaceRoot: string;
    includePaths: string[];
    excludePaths: string[];
    base?: string;
    head?: string;
    selection?: "working" | "staged" | "commit" | "range";
    changedLines?: Record<string, number[]>;
    deletedPaths?: string[];
    snapshot?: {
        files: Record<string, string>;
        diffSha256?: string;
    };
    mutatedPaths?: string[];
    reviewedPatch?: string;
}

export interface ReviewPlan {
    version: typeof REVIEW_SCHEMA_VERSION;
    workflowId: string;
    workflowVersion: number;
    request: ReviewRequest;
    scope: ReviewScope;
    assignments: ReviewerAssignment[];
    stages: ReviewStageId[];
    createdAt: number;
}

interface EvidenceBase {
    id: string;
    verification: EvidenceVerification;
    verificationReason?: string;
}

export interface CodeEvidence extends EvidenceBase {
    kind: "code";
    path: string;
    startLine: number;
    endLine?: number;
    excerpt?: string;
    contextual?: boolean;
}

export interface DocumentEvidence extends EvidenceBase {
    kind: "document";
    path: string;
    section?: string;
    excerpt?: string;
}

export interface LogEvidence extends EvidenceBase {
    kind: "log";
    source: string;
    timestamp?: string;
    excerpt: string;
}

export type EvidenceReference = CodeEvidence | DocumentEvidence | LogEvidence;

export interface FindingChallenge {
    reviewerRoleId: string;
    verdict: "support" | "object" | "correct" | "abstain";
    rationale: string;
    evidence: EvidenceReference[];
}

export interface Finding {
    id: string;
    title: string;
    description: string;
    category: string;
    severity: FindingSeverity;
    confidence: FindingConfidence;
    status: FindingStatus;
    evidence: EvidenceReference[];
    raisedBy: string[];
    challenges: FindingChallenge[];
    recommendation?: string;
    mergeRationale?: string;
}

export interface ReviewCoverage {
    requestedRoles: number;
    completedRoles: number;
    usableRoles?: number;
    emptyRoles?: string[];
    reviewedFiles: number;
    citedFiles?: number;
    explicitFiles?: number;
    omittedStages: ReviewStageId[];
    mutatedFiles?: number;
    budgetOverruns?: number;
    stages?: ReviewStageCoverage[];
}

export interface ReviewStageCoverage {
    stage: ReviewStageId;
    unit: "roles" | "findings" | "executions";
    planned: number;
    attempted: number;
    usable: number;
    failed: number;
    omitted: number;
    status: ReviewStageResult["status"];
}

export interface ReviewRunSummary {
    durationMs: number;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
}

export interface ReviewReport {
    version: typeof REVIEW_SCHEMA_VERSION;
    reviewId: string;
    workflowId: string;
    language?: ReviewLanguage;
    decision: ReviewDecision;
    executiveSummary: string;
    findings: Finding[];
    requiredActions: string[];
    positiveObservations: string[];
    unresolvedQuestions: string[];
    executionDiagnostics?: string[];
    workflowSections?: Record<string, string[]>;
    coverage: ReviewCoverage;
    run: ReviewRunSummary;
    createdAt: number;
}

export interface ReviewStageResult<T = unknown> {
    stage: ReviewStageId;
    status: "success" | "partial" | "error" | "aborted" | "skipped";
    output?: T;
    diagnostics: string[];
    startedAt: number;
    finishedAt: number;
}
