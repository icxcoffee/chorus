import { describe, expect, it } from "vitest";
import { parseChallengeProposalWithNotes, parseExecutionPayload, parseFindingProposal } from "../../src/workflows/parsing.js";

describe("Review model output parsing", () => {
    it("extracts the final JSON payload after harmless assistant prose", () => {
        expect(parseExecutionPayload("I inspected the requested paths.\n{\"findings\":[],\"positiveObservations\":[],\"unresolvedQuestions\":[\"incomplete\"]}"))
            .toEqual({ findings: [], positiveObservations: [], unresolvedQuestions: ["incomplete"] });
    });

    it("handles fenced JSON, nested braces in strings, and tagged payloads", () => {
        expect(parseExecutionPayload("```json\n{\"value\":\"a } brace\",\"items\":[1]}\n```"))
            .toEqual({ value: "a } brace", items: [1] });
        expect(parseExecutionPayload("note\n<chorus-review>{\"ok\":true}</chorus-review>"))
            .toEqual({ ok: true });
    });

    it("rejects prose without a structured payload", () => {
        expect(() => parseExecutionPayload("No structured response was produced.")).toThrow("no valid JSON");
    });

    it("salvages complete finding siblings from a truncated findings envelope", () => {
        const complete = {
            id: "architect-1",
            title: "Narrow peer range",
            description: "The package accepts only one upstream minor line.",
            category: "compatibility",
            severity: "medium",
            confidence: "medium",
            status: "proposed",
            evidence: [],
            raisedBy: ["architect"],
            challenges: [],
        };
        const payload = parseExecutionPayload(`{"findings":[${JSON.stringify(complete)},{"id":"architect-2","title":"cut off`) as Record<string, unknown>;

        expect(payload.findings).toEqual([complete]);
        expect(payload.truncated).toBe(true);
        expect(payload.unresolvedQuestions).toEqual([expect.stringContaining("truncated")]);
        expect(parseFindingProposal(payload, "architect").findings).toHaveLength(1);
    });

    it("normalizes common model shape errors without bypassing evidence validation", () => {
        const proposal = parseFindingProposal({
            findings: [{
                id: "perf-1",
                title: "Repeated directory scan",
                description: "The write path scans the cache directory.",
                category: "performance",
                severity: "medium",
                confidence: "high",
                status: "proposed",
                evidence: "src/runtime/cache.ts:17-21 - set() calls prune() after every write",
                raisedBy: "performance-reviewer",
                challenges: "The directory is bounded.",
            }, {
                id: "perf-2",
                title: "Repeated output reconstruction",
                description: "Streaming joins all text deltas for every update.",
                category: "performance",
                severity: "medium",
                confidence: "high",
                status: "proposed",
                evidence: [{ kind: "code", path: "src/subagent.ts", lines: "121-152", excerpt: "emitProgress()" }],
                raisedBy: ["performance-reviewer"],
                challenges: ["Impact depends on the event mix."],
            }],
            positiveObservations: [{ title: "Bounded cache", description: "The cache has a maximum size." }, { path: "src/runtime/scheduler.ts", note: "Provider concurrency is bounded." }],
            unresolvedQuestions: [{ question: "Which streaming event dominates?", impact: "This determines the practical severity." }],
        }, "performance");

        expect(proposal.findings[0]).toEqual(expect.objectContaining({
            raisedBy: ["performance"],
            evidence: [expect.objectContaining({ kind: "code", path: "src/runtime/cache.ts", startLine: 17, endLine: 21 })],
            challenges: [],
        }));
        expect(proposal.findings[1]).toEqual(expect.objectContaining({
            evidence: [expect.objectContaining({ id: "performance-2-evidence-1", startLine: 121, endLine: 152 })],
            challenges: [],
        }));
        expect(proposal.positiveObservations).toEqual([
            "Bounded cache: The cache has a maximum size.",
            "src/runtime/scheduler.ts: Provider concurrency is bounded.",
        ]);
        expect(proposal.unresolvedQuestions).toEqual(["Which streaming event dominates? Impact: This determines the practical severity."]);
        expect(proposal.normalizationNotes).toEqual(expect.arrayContaining([
            "finding[0].evidence normalized to an array",
            "finding[0].raisedBy normalized to the active role",
            "finding[1].evidence[0].id generated",
            "finding[1].evidence[0].lines normalized to startLine/endLine",
            "finding[1].challenges discarded 1 unstructured item(s)",
        ]));
    });

    it("normalizes recoverable challenge evidence and rejects ambiguous citations", () => {
        const result = parseChallengeProposalWithNotes({
            findingId: "finding-1",
            verdict: "support",
            rationale: "The current source confirms the claim.",
            evidence: [
                { kind: "code", path: "src/index.ts", lines: "10-12", excerpt: "activate()" },
                "src/store.ts:18-20 - bounded configuration",
                "not a source citation",
            ],
        });

        expect(result.proposals[0]?.evidence).toEqual([
            expect.objectContaining({ id: "finding-1-challenge-1", startLine: 10, endLine: 12 }),
            expect.objectContaining({ id: "finding-1-challenge-2", path: "src/store.ts", startLine: 18, endLine: 20 }),
        ]);
        expect(result.normalizationNotes).toEqual(expect.arrayContaining([
            "challenge[0].evidence[0].id generated",
            "challenge[0].evidence[0].lines normalized to startLine/endLine",
            "challenge[0].evidence[1] normalized from a citation string",
            "challenge[0].evidence[2] discarded because the citation string is ambiguous",
        ]));
    });

    it("normalizes partial-support and isolates malformed challenge siblings", () => {
        const result = parseChallengeProposalWithNotes({ challenges: [{
            findingId: "finding-1",
            verdict: "support",
            rationale: "Supported.",
            evidence: [],
        }, {
            findingId: "finding-2",
            verdict: "partial-support",
            rationale: "The claim needs a narrower correction.",
            evidence: [],
        }, {
            findingId: "finding-3",
            verdict: "invented",
            rationale: "Invalid sibling.",
            evidence: [],
        }] });

        expect(result.proposals.map((proposal) => proposal.verdict)).toEqual(["support", "correct"]);
        expect(result.normalizationNotes).toEqual(expect.arrayContaining([
            "challenge[1].verdict normalized from partial-support to correct",
            expect.stringContaining("challenge[2] discarded after normalization"),
        ]));
    });

    it("parses a complete corrected Finding replacement", () => {
        const result = parseChallengeProposalWithNotes({
            findingId: "finding-1",
            verdict: "correct",
            rationale: "The defect is real but narrower.",
            evidence: [],
            replacement: {
                title: "Narrow repeated scan",
                description: "The scan occurs only after explicit cache enablement.",
                category: "performance",
                severity: "medium",
                confidence: "high",
                recommendation: "Batch cache pruning.",
                evidence: [{ kind: "code", path: "src/runtime/cache.ts", startLine: 12 }],
            },
        });
        expect(result.proposals[0]?.replacement).toEqual(expect.objectContaining({
            id: "finding-1",
            title: "Narrow repeated scan",
            severity: "medium",
            raisedBy: ["integrator"],
        }));
    });

    it("recovers real-world line arrays and isolates invalid evidence and findings", () => {
        const proposal = parseFindingProposal({
            findings: [{
                id: "arch-1",
                title: "Abort listeners accumulate",
                description: "The retry sleep retains abort listeners until cancellation.",
                category: "reliability",
                severity: "medium",
                confidence: "medium",
                evidence: [{ path: "src/runtime/retry.ts", lines: [105, 106, 107, 108, 109], excerpt: "signal.addEventListener" }],
                raisedBy: [],
                challenges: [],
            }, {
                id: "security-1",
                title: "Endpoint validation is incomplete",
                description: "The cited source needs a precise location.",
                category: "security",
                severity: "medium",
                confidence: "low",
                evidence: [{ kind: "code", path: "src/providers/adapters.ts", excerpt: "assertSafeEndpoint" }],
                raisedBy: [],
                challenges: [],
            }, {
                id: "broken",
                title: "Malformed severity",
                description: "This item must not discard its siblings.",
                category: "correctness",
                severity: "urgent",
                confidence: "high",
                evidence: [],
                raisedBy: [],
                challenges: [],
            }],
            positiveObservations: [],
            unresolvedQuestions: [],
        }, "architect");

        expect(proposal.findings).toHaveLength(2);
        expect(proposal.findings[0]?.evidence).toEqual([
            expect.objectContaining({ kind: "code", startLine: 105, endLine: 109 }),
        ]);
        expect(proposal.findings[1]?.evidence).toEqual([]);
        expect(proposal.normalizationNotes).toEqual(expect.arrayContaining([
            "finding[0].evidence[0].kind inferred as code",
            "finding[0].evidence[0].lines normalized to startLine/endLine",
            expect.stringContaining("finding[1].evidence[0] discarded after normalization"),
            expect.stringContaining("finding[2] discarded after normalization"),
        ]));
    });

    it("normalizes a single finding object and scalar descriptive fields", () => {
        const proposal = parseFindingProposal({
            findings: {
                id: "one",
                title: "Single finding",
                description: "The envelope used an object instead of an array.",
                category: "compatibility",
                severity: "low",
                confidence: "medium",
                evidence: [],
                raisedBy: [],
                challenges: [],
            },
            positiveObservations: "The module is small.",
            unresolvedQuestions: { question: "Is the API public?" },
        }, "architect");

        expect(proposal.findings).toHaveLength(1);
        expect(proposal.positiveObservations).toEqual(["The module is small."]);
        expect(proposal.unresolvedQuestions).toEqual(["Is the API public?"]);
        expect(proposal.normalizationNotes).toEqual(expect.arrayContaining([
            "findings normalized to an array",
            "positiveObservations normalized to an array",
            "unresolvedQuestions normalized to an array",
        ]));
    });

    it("normalizes common recovery aliases without discarding supported content", () => {
        const proposal = parseFindingProposal({
            findings: [{
                id: "recovery-1",
                title: "Recovered defect",
                risk: "A recovered source path can fail.",
                category: "reliability",
                severity: "medium",
                confidence: "medium",
                sourceEvidence: [{ kind: "code", path: "src/index.ts", startLine: 4, excerpt: "throw error" }],
            }],
            positiveObservations: [{ observation: "The fallback is bounded." }, { claim: "Writes are atomic." }],
            unresolvedQuestions: [],
        }, "architect");

        expect(proposal.findings[0]).toEqual(expect.objectContaining({ description: "A recovered source path can fail.", evidence: [expect.objectContaining({ path: "src/index.ts" })] }));
        expect(proposal.positiveObservations).toEqual(["The fallback is bounded.", "Writes are atomic."]);
    });
});
