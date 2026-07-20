import type { FindingSeverity, ReviewDecision, ReviewReport } from "./contracts.js";

export interface ExpectedFinding {
    id: string;
    category: string;
    severity: FindingSeverity;
    locations: Array<{ path: string; startLine?: number; endLine?: number }>;
}

export interface ReviewEvaluationFixture {
    id: string;
    description: string;
    expectedDecision: ReviewDecision;
    expectedFindings: ExpectedFinding[];
    disallowedFindingTitles?: string[];
}

export interface HumanReviewRubric {
    actionability?: number;
    developerAcceptance?: boolean;
    notes?: string;
}

export interface ReviewQualityMetrics {
    expectedFindings: number;
    matchedFindings: number;
    missedFindings: number;
    unmatchedFindings: number;
    falsePositiveRate: number;
    recall: number;
    citationValidity: number;
    severityCalibration: number;
    decisionCorrect: boolean;
    validFindings: number;
    costPerValidFinding: number | null;
    durationMs: number;
    costUsd: number | null;
    human?: HumanReviewRubric;
}

export interface AggregateMetrics {
    recall: number;
    falsePositiveRate: number;
    citationValidity: number;
    decisionAccuracy: number;
    durationMs: number;
    costUsd: number | null;
}

export interface ReviewComparisonReport {
    cases: Array<{ fixtureId: string; single: ReviewQualityMetrics; committee: ReviewQualityMetrics }>;
    summary: { single: AggregateMetrics; committee: AggregateMetrics };
}

export function evaluateReview(report: ReviewReport, fixture: ReviewEvaluationFixture, human?: HumanReviewRubric): ReviewQualityMetrics {
    const matched = new Set<string>();
    let calibrated = 0;
    for (const expected of fixture.expectedFindings) {
        const actual = report.findings.find((finding) => !matched.has(finding.id) && finding.category === expected.category && expected.locations.some((location) => finding.evidence.some((evidence) => evidence.kind !== "log" && evidence.path === location.path && (location.startLine === undefined || evidence.kind === "code" && evidence.startLine >= location.startLine && evidence.startLine <= (location.endLine ?? location.startLine)))));
        if (!actual) continue;
        matched.add(actual.id);
        if (severityDistance(actual.severity, expected.severity) <= 1) calibrated += 1;
    }
    const reportable = report.findings.filter((finding) => finding.status === "verified" || finding.status === "disputed");
    const disallowed = new Set(fixture.disallowedFindingTitles ?? []);
    const unmatched = reportable.filter((finding) => !matched.has(finding.id) || disallowed.has(finding.title)).length;
    const evidence = report.findings.flatMap((finding) => finding.evidence);
    const validFindings = report.findings.filter((finding) => finding.status === "verified" && finding.evidence.some((item) => item.verification === "verified")).length;
    return {
        expectedFindings: fixture.expectedFindings.length,
        matchedFindings: matched.size,
        missedFindings: fixture.expectedFindings.length - matched.size,
        unmatchedFindings: unmatched,
        falsePositiveRate: reportable.length === 0 ? 0 : unmatched / reportable.length,
        recall: fixture.expectedFindings.length === 0 ? 1 : matched.size / fixture.expectedFindings.length,
        citationValidity: evidence.length === 0 ? 1 : evidence.filter((item) => item.verification === "verified").length / evidence.length,
        severityCalibration: matched.size === 0 ? (fixture.expectedFindings.length === 0 ? 1 : 0) : calibrated / matched.size,
        decisionCorrect: report.decision === fixture.expectedDecision,
        validFindings,
        costPerValidFinding: report.run.costUsd === null || validFindings === 0 ? null : report.run.costUsd / validFindings,
        durationMs: report.run.durationMs,
        costUsd: report.run.costUsd,
        ...(human ? { human } : {}),
    };
}

export async function compareReviewModes(fixtures: ReviewEvaluationFixture[], run: (fixture: ReviewEvaluationFixture, mode: "single" | "committee") => Promise<ReviewReport>): Promise<ReviewComparisonReport> {
    const cases: ReviewComparisonReport["cases"] = [];
    for (const fixture of fixtures) {
        const single = evaluateReview(await run(fixture, "single"), fixture);
        const committee = evaluateReview(await run(fixture, "committee"), fixture);
        cases.push({ fixtureId: fixture.id, single, committee });
    }
    return { cases, summary: { single: aggregate(cases.map((item) => item.single)), committee: aggregate(cases.map((item) => item.committee)) } };
}

export function renderReviewComparison(report: ReviewComparisonReport): string {
    const lines = ["# Chorus Review Evaluation", "", "| Metric | Single reviewer | Committee |", "| --- | ---: | ---: |"];
    for (const [label, key] of [["Recall", "recall"], ["False-positive rate", "falsePositiveRate"], ["Citation validity", "citationValidity"], ["Decision accuracy", "decisionAccuracy"]] as const) lines.push(`| ${label} | ${percent(report.summary.single[key])} | ${percent(report.summary.committee[key])} |`);
    lines.push(`| Mean duration | ${report.summary.single.durationMs.toFixed(0)}ms | ${report.summary.committee.durationMs.toFixed(0)}ms |`);
    lines.push(`| Mean cost | ${cost(report.summary.single.costUsd)} | ${cost(report.summary.committee.costUsd)} |`);
    return `${lines.join("\n")}\n`;
}

function aggregate(metrics: ReviewQualityMetrics[]): AggregateMetrics {
    const knownCosts = metrics.map((item) => item.costUsd).filter((value): value is number => value !== null);
    return {
        recall: mean(metrics.map((item) => item.recall)),
        falsePositiveRate: mean(metrics.map((item) => item.falsePositiveRate)),
        citationValidity: mean(metrics.map((item) => item.citationValidity)),
        decisionAccuracy: mean(metrics.map((item) => item.decisionCorrect ? 1 : 0)),
        durationMs: mean(metrics.map((item) => item.durationMs)),
        costUsd: knownCosts.length === metrics.length ? mean(knownCosts) : null,
    };
}

function severityDistance(left: FindingSeverity, right: FindingSeverity): number {
    const rank: Record<FindingSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return Math.abs(rank[left] - rank[right]);
}

function mean(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function cost(value: number | null): string { return value === null ? "unknown" : `$${value.toFixed(3)}`; }
