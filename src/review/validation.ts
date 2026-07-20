import {
    REVIEW_SCHEMA_VERSION,
    type EvidenceReference,
    type Finding,
    type FindingChallenge,
    type ReviewReport,
    type ReviewRequest,
} from "./contracts.js";
import { validateGitRevision } from "./git-ref.js";

const MAX_TEXT = 100_000;
const MAX_SHORT_TEXT = 4_000;
const MAX_ITEMS = 1_000;
const severities = ["critical", "high", "medium", "low", "info"] as const;
const confidences = ["high", "medium", "low"] as const;
const statuses = ["proposed", "verified", "disputed", "rejected", "unsupported"] as const;
const verifications = ["unverified", "verified", "stale", "invalid", "unavailable"] as const;

export function parseReviewRequest(input: unknown): ReviewRequest {
    const value = record(input, "review request");
    version(value);
    const scope = record(value.scope, "review request.scope");
    const kind = enumeration(scope.kind, ["repository", "files", "diff", "document", "log"], "scope.kind");
    const profile = enumeration(value.profile ?? "quick", ["quick", "deep"], "profile");
    const language = enumeration(value.language ?? "zh-CN", ["zh-CN", "en"], "language");
    const root = optionalString(scope.root, "scope.root");
    const baseValue = optionalString(scope.base, "scope.base");
    const headValue = optionalString(scope.head, "scope.head");
    const base = baseValue ? validateGitRevision(baseValue, "scope.base") : undefined;
    const head = headValue ? validateGitRevision(headValue, "scope.head") : undefined;
    const selection = scope.selection === undefined ? undefined : enumeration(scope.selection, ["working", "staged", "commit", "range"], "scope.selection");
    return {
        version: REVIEW_SCHEMA_VERSION,
        workflow: shortString(value.workflow, "workflow"),
        objective: strings(value.objective ?? [], "objective"),
        constraints: strings(value.constraints ?? [], "constraints"),
        scope: {
            kind,
            ...(root ? { root } : {}),
            ...(scope.paths === undefined ? {} : { paths: strings(scope.paths, "scope.paths") }),
            ...(scope.exclude === undefined ? {} : { exclude: strings(scope.exclude, "scope.exclude") }),
            ...(base ? { base } : {}),
            ...(head ? { head } : {}),
            ...(selection ? { selection } : {}),
        },
        profile,
        renderer: shortString(value.renderer ?? "markdown", "renderer"),
        language,
    };
}

export function parseFinding(input: unknown): Finding {
    const value = record(input, "finding");
    const evidence = array(value.evidence, "finding.evidence").map((item, index) => parseEvidence(item, `finding.evidence[${index}]`));
    const challenges = value.challenges === undefined
        ? []
        : array(value.challenges, "finding.challenges").map((item, index) => parseChallenge(item, `finding.challenges[${index}]`));
    const recommendation = optionalString(value.recommendation, "finding.recommendation");
    const mergeRationale = optionalString(value.mergeRationale, "finding.mergeRationale");
    return {
        id: shortString(value.id, "finding.id"),
        title: shortString(value.title, "finding.title"),
        description: text(value.description, "finding.description"),
        category: shortString(value.category, "finding.category"),
        severity: enumeration(value.severity, severities, "finding.severity"),
        confidence: enumeration(value.confidence, confidences, "finding.confidence"),
        status: enumeration(value.status ?? "proposed", statuses, "finding.status"),
        evidence,
        raisedBy: uniqueStrings(value.raisedBy, "finding.raisedBy"),
        challenges,
        ...(recommendation ? { recommendation } : {}),
        ...(mergeRationale ? { mergeRationale } : {}),
    };
}

export function parseReviewReport(input: unknown): ReviewReport {
    const value = record(input, "review report");
    version(value);
    const coverage = record(value.coverage, "review report.coverage");
    const run = record(value.run, "review report.run");
    const findings = array(value.findings, "review report.findings").map(parseFinding);
    ensureUnique(findings.map((finding) => finding.id), "finding IDs");
    const workflowSections = value.workflowSections === undefined ? undefined : parseWorkflowSections(value.workflowSections);
    const language = value.language === undefined ? undefined : enumeration(value.language, ["zh-CN", "en"], "language");
    const executionDiagnostics = value.executionDiagnostics === undefined ? undefined : strings(value.executionDiagnostics, "executionDiagnostics");
    return {
        version: REVIEW_SCHEMA_VERSION,
        reviewId: shortString(value.reviewId, "reviewId"),
        workflowId: shortString(value.workflowId, "workflowId"),
        ...(language ? { language } : {}),
        decision: enumeration(value.decision, ["approve", "request-changes", "needs-investigation"], "decision"),
        executiveSummary: text(value.executiveSummary, "executiveSummary"),
        findings,
        requiredActions: strings(value.requiredActions, "requiredActions"),
        positiveObservations: strings(value.positiveObservations, "positiveObservations"),
        unresolvedQuestions: strings(value.unresolvedQuestions, "unresolvedQuestions"),
        ...(executionDiagnostics ? { executionDiagnostics } : {}),
        ...(workflowSections ? { workflowSections } : {}),
        coverage: {
            requestedRoles: nonNegativeInteger(coverage.requestedRoles, "coverage.requestedRoles"),
            completedRoles: nonNegativeInteger(coverage.completedRoles, "coverage.completedRoles"),
            ...(coverage.usableRoles === undefined ? {} : { usableRoles: nonNegativeInteger(coverage.usableRoles, "coverage.usableRoles") }),
            ...(coverage.emptyRoles === undefined ? {} : { emptyRoles: strings(coverage.emptyRoles, "coverage.emptyRoles") }),
            reviewedFiles: nonNegativeInteger(coverage.reviewedFiles, "coverage.reviewedFiles"),
            ...(coverage.citedFiles === undefined ? {} : { citedFiles: nonNegativeInteger(coverage.citedFiles, "coverage.citedFiles") }),
            ...(coverage.explicitFiles === undefined ? {} : { explicitFiles: nonNegativeInteger(coverage.explicitFiles, "coverage.explicitFiles") }),
            omittedStages: array(coverage.omittedStages, "coverage.omittedStages").map((stage) => enumeration(stage, ["independent-review", "cross-review", "devil", "integrate"], "omitted stage")),
            ...(coverage.mutatedFiles === undefined ? {} : { mutatedFiles: nonNegativeInteger(coverage.mutatedFiles, "coverage.mutatedFiles") }),
            ...(coverage.budgetOverruns === undefined ? {} : { budgetOverruns: nonNegativeInteger(coverage.budgetOverruns, "coverage.budgetOverruns") }),
            ...(coverage.stages === undefined ? {} : { stages: array(coverage.stages, "coverage.stages").map((item, index) => parseStageCoverage(item, `coverage.stages[${index}]`)) }),
        },
        run: {
            durationMs: nonNegativeNumber(run.durationMs, "run.durationMs"),
            costUsd: run.costUsd === null ? null : nonNegativeNumber(run.costUsd, "run.costUsd"),
            inputTokens: nonNegativeInteger(run.inputTokens, "run.inputTokens"),
            outputTokens: nonNegativeInteger(run.outputTokens, "run.outputTokens"),
        },
        createdAt: nonNegativeNumber(value.createdAt, "createdAt"),
    };
}

function parseStageCoverage(input: unknown, path: string): NonNullable<ReviewReport["coverage"]["stages"]>[number] {
    const value = record(input, path);
    return {
        stage: enumeration(value.stage, ["independent-review", "cross-review", "devil", "integrate"], `${path}.stage`),
        unit: enumeration(value.unit, ["roles", "findings", "executions"], `${path}.unit`),
        planned: nonNegativeInteger(value.planned, `${path}.planned`),
        attempted: nonNegativeInteger(value.attempted, `${path}.attempted`),
        usable: nonNegativeInteger(value.usable, `${path}.usable`),
        failed: nonNegativeInteger(value.failed, `${path}.failed`),
        omitted: nonNegativeInteger(value.omitted, `${path}.omitted`),
        status: enumeration(value.status, ["success", "partial", "error", "aborted", "skipped"], `${path}.status`),
    };
}

function parseWorkflowSections(input: unknown): Record<string, string[]> {
    const value = record(input, "workflowSections");
    const entries = Object.entries(value);
    if (entries.length > 20) throw new Error("workflowSections exceeds 20 sections");
    return Object.fromEntries(entries.map(([key, items]) => [shortString(key, "workflowSections key"), strings(items, `workflowSections.${key}`)]));
}

export function parseEvidence(input: unknown, path = "evidence"): EvidenceReference {
    const value = record(input, path);
    const kind = enumeration(value.kind, ["code", "document", "log"], `${path}.kind`);
    const verificationReason = optionalString(value.verificationReason, `${path}.verificationReason`);
    const common = {
        id: shortString(value.id, `${path}.id`),
        verification: enumeration(value.verification ?? "unverified", verifications, `${path}.verification`),
        ...(verificationReason ? { verificationReason } : {}),
    };
    if (kind === "code") {
        const excerpt = optionalString(value.excerpt, `${path}.excerpt`);
        return {
        ...common,
        kind,
        path: shortString(value.path, `${path}.path`),
        startLine: positiveInteger(value.startLine, `${path}.startLine`),
        ...(value.endLine === undefined ? {} : { endLine: positiveInteger(value.endLine, `${path}.endLine`) }),
        ...(excerpt ? { excerpt } : {}),
        ...(typeof value.contextual === "boolean" ? { contextual: value.contextual } : {}),
        };
    }
    if (kind === "document") {
        const section = optionalString(value.section, `${path}.section`);
        const excerpt = optionalString(value.excerpt, `${path}.excerpt`);
        return {
        ...common,
        kind,
        path: shortString(value.path, `${path}.path`),
        ...(section ? { section } : {}),
        ...(excerpt ? { excerpt } : {}),
        };
    }
    const timestamp = optionalString(value.timestamp, `${path}.timestamp`);
    return {
        ...common,
        kind,
        source: shortString(value.source, `${path}.source`),
        excerpt: text(value.excerpt, `${path}.excerpt`),
        ...(timestamp ? { timestamp } : {}),
    };
}

function parseChallenge(input: unknown, path: string): FindingChallenge {
    const value = record(input, path);
    return {
        reviewerRoleId: shortString(value.reviewerRoleId, `${path}.reviewerRoleId`),
        verdict: enumeration(value.verdict, ["support", "object", "correct", "abstain"], `${path}.verdict`),
        rationale: text(value.rationale, `${path}.rationale`),
        evidence: array(value.evidence ?? [], `${path}.evidence`).map((item, index) => parseEvidence(item, `${path}.evidence[${index}]`)),
    };
}

function record(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    return value as Record<string, unknown>;
}

function version(value: Record<string, unknown>): void {
    if (value.version !== REVIEW_SCHEMA_VERSION) throw new Error(`unsupported review schema version ${String(value.version)}; expected ${REVIEW_SCHEMA_VERSION}`);
}

function array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (value.length > MAX_ITEMS) throw new Error(`${path} exceeds ${MAX_ITEMS} items`);
    return value;
}

function strings(value: unknown, path: string): string[] {
    return array(value, path).map((item, index) => shortString(item, `${path}[${index}]`));
}

function uniqueStrings(value: unknown, path: string): string[] {
    const result = strings(value, path);
    ensureUnique(result, path);
    return result;
}

function ensureUnique(values: string[], path: string): void {
    if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicates`);
}

function text(value: unknown, path: string): string {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
    if (value.length > MAX_TEXT) throw new Error(`${path} exceeds ${MAX_TEXT} characters`);
    return value;
}

function shortString(value: unknown, path: string): string {
    const result = text(value, path);
    if (result.length > MAX_SHORT_TEXT) throw new Error(`${path} exceeds ${MAX_SHORT_TEXT} characters`);
    return result;
}

function optionalString(value: unknown, path: string): string | undefined {
    if (value === undefined) return undefined;
    return shortString(value, path);
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${path} must be one of ${allowed.join(", ")}`);
    return value as T;
}

function positiveInteger(value: unknown, path: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`);
    return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${path} must be a non-negative integer`);
    return value as number;
}

function nonNegativeNumber(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be a non-negative finite number`);
    return value;
}
