import type { EvidenceReference, Finding, FindingChallenge } from "../review/contracts.js";
import { parseEvidence, parseFinding } from "../review/validation.js";
import type { ModelChallengeProposal, ModelFindingProposal } from "./contracts.js";

export function parseExecutionPayload(output: unknown): unknown {
    if (typeof output !== "string") return output;
    try {
        return JSON.parse(output);
    } catch {
        const match = /<chorus-review>([\s\S]*?)<\/chorus-review>\s*$/.exec(output);
        if (match) {
            try { return JSON.parse(match[1] ?? ""); }
            catch { throw new Error("reviewer <chorus-review> payload is not valid JSON"); }
        }
        const truncatedFindings = salvageTruncatedFindings(output);
        if (truncatedFindings) return truncatedFindings;
        const embedded = lastEmbeddedJson(output);
        if (embedded !== undefined) return embedded;
        throw new Error("reviewer output has no valid JSON object/array or <chorus-review> payload");
    }
}

function salvageTruncatedFindings(output: string): Record<string, unknown> | undefined {
    const matches = [...output.matchAll(/"findings"\s*:\s*\[/g)];
    const match = matches.at(-1);
    if (!match || match.index === undefined) return undefined;
    const arrayStart = match.index + match[0].length;
    const findings: unknown[] = [];
    let cursor = arrayStart;
    let sawTruncatedItem = false;
    while (cursor < output.length) {
        while (cursor < output.length && /[\s,]/.test(output[cursor]!)) cursor += 1;
        if (output[cursor] === "]") return undefined;
        if (output[cursor] !== "{") break;
        const end = balancedJsonEnd(output, cursor);
        if (end === -1) {
            sawTruncatedItem = true;
            break;
        }
        try {
            findings.push(JSON.parse(output.slice(cursor, end + 1)));
        } catch {
            break;
        }
        cursor = end + 1;
    }
    if (findings.length === 0 || (!sawTruncatedItem && cursor < output.length)) return undefined;
    return {
        findings,
        positiveObservations: [],
        unresolvedQuestions: ["Review output was truncated; only fully formed findings were recovered."],
        truncated: true,
    };
}

function lastEmbeddedJson(output: string): unknown | undefined {
    let found: unknown | undefined;
    let candidates = 0;
    for (let start = 0; start < output.length && candidates < 256; start += 1) {
        if (output[start] !== "{" && output[start] !== "[") continue;
        candidates += 1;
        const end = balancedJsonEnd(output, start);
        if (end === -1) continue;
        try {
            found = JSON.parse(output.slice(start, end + 1));
            start = end;
        } catch {
            // Keep scanning: prose may contain braces before the final JSON payload.
        }
    }
    return found;
}

function balancedJsonEnd(value: string, start: number): number {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const char = value[index]!;
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === "\"") inString = false;
            continue;
        }
        if (char === "\"") { inString = true; continue; }
        if (char === "{" || char === "[") stack.push(char);
        else if (char === "}" || char === "]") {
            const open = stack.pop();
            if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return -1;
            if (stack.length === 0) return index;
        }
    }
    return -1;
}

export function parseFindingProposal(output: unknown, roleId: string): { findings: Finding[]; positiveObservations: string[]; unresolvedQuestions: string[]; normalizationNotes: string[] } {
    const value = asRecord(parseExecutionPayload(output), "reviewer output") as ModelFindingProposal & Record<string, unknown>;
    const normalizationNotes: string[] = [];
    const findingValues = Array.isArray(value.findings)
        ? value.findings
        : value.findings && typeof value.findings === "object"
            ? (normalizationNotes.push("findings normalized to an array"), [value.findings])
            : undefined;
    if (!findingValues) throw new Error("reviewer output.findings must be an array or finding object");
    const findings = findingValues.flatMap((finding, index) => {
        try {
            const normalized = normalizeFinding(finding, roleId, index, normalizationNotes);
            const parsed = parseFinding(normalized);
            return [{ ...parsed, raisedBy: [roleId], status: "proposed" as const }];
        } catch (error) {
            normalizationNotes.push(`finding[${index}] discarded after normalization: ${errorMessage(error)}`);
            return [];
        }
    });
    return {
        findings,
        positiveObservations: normalizedStrings(value.positiveObservations, "positiveObservations", normalizationNotes),
        unresolvedQuestions: normalizedStrings(value.unresolvedQuestions, "unresolvedQuestions", normalizationNotes),
        normalizationNotes,
    };
}

export function parseChallengeProposal(output: unknown, defaultFindingId?: string): ModelChallengeProposal[] {
    return parseChallengeProposalWithNotes(output, defaultFindingId).proposals;
}

export function parseChallengeProposalWithNotes(output: unknown, defaultFindingId?: string): { proposals: ModelChallengeProposal[]; normalizationNotes: string[] } {
    const payload = parseExecutionPayload(output);
    const values = Array.isArray(payload) ? payload : Array.isArray(asRecord(payload, "challenge output").challenges) ? asRecord(payload, "challenge output").challenges as unknown[] : [payload];
    const normalizationNotes: string[] = [];
    const proposals = values.flatMap((item, index) => {
        try {
            const value = asRecord(item, `challenge[${index}]`);
            const findingId = typeof value.findingId === "string" ? value.findingId : defaultFindingId;
            if (!findingId) throw new Error(`challenge[${index}].findingId is required`);
            const verdict = normalizeVerdict(value.verdict, index, normalizationNotes);
            if (typeof value.rationale !== "string" || !value.rationale.trim()) throw new Error(`challenge[${index}].rationale is required`);
            const path = `challenge[${index}].evidence`;
            const evidence = normalizeEvidenceItems(value.evidence, `${findingId}-challenge`, path, normalizationNotes);
            const replacement = verdict === "correct" && value.replacement !== undefined
                ? parseReplacement(value.replacement, findingId, index, normalizationNotes)
                : undefined;
            return [{ findingId, verdict, rationale: value.rationale, evidence, ...(replacement ? { replacement } : {}) }];
        } catch (error) {
            normalizationNotes.push(`challenge[${index}] discarded after normalization: ${errorMessage(error)}`);
            return [];
        }
    });
    return { proposals, normalizationNotes };
}

function parseReplacement(input: unknown, findingId: string, index: number, notes: string[]): Finding | undefined {
    try {
        const value = asRecord(input, `challenge[${index}].replacement`);
        const evidence = normalizeEvidenceItems(value.evidence, `${findingId}-replacement`, `challenge[${index}].replacement.evidence`, notes);
        return parseFinding({
            ...value,
            id: findingId,
            status: "proposed",
            evidence,
            raisedBy: ["integrator"],
            challenges: [],
        });
    } catch (error) {
        notes.push(`challenge[${index}].replacement discarded after normalization: ${errorMessage(error)}`);
        return undefined;
    }
}

function normalizeVerdict(value: unknown, index: number, notes: string[]): ModelChallengeProposal["verdict"] {
    if (value === "support" || value === "object" || value === "correct" || value === "abstain") return value;
    if (value === "partial-support" || value === "partial_support" || value === "partially-support") {
        notes.push(`challenge[${index}].verdict normalized from ${value} to correct`);
        return "correct";
    }
    throw new Error(`challenge[${index}].verdict is invalid`);
}

export function challengeFor(roleId: string, proposal: ModelChallengeProposal, evidence: EvidenceReference[]): FindingChallenge {
    return { reviewerRoleId: roleId, verdict: proposal.verdict, rationale: proposal.rationale, evidence };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    return value as Record<string, unknown>;
}

function normalizeFinding(input: unknown, roleId: string, index: number, notes: string[]): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const value = { ...(input as Record<string, unknown>) };
    if (value.evidence === undefined && value.sourceEvidence !== undefined) {
        value.evidence = value.sourceEvidence;
        notes.push(`finding[${index}].sourceEvidence normalized to evidence`);
    }
    if (value.description === undefined && typeof value.risk === "string") {
        value.description = value.risk;
        notes.push(`finding[${index}].risk normalized to description`);
    }
    const evidence = normalizeEvidence(value.evidence, roleId, index, notes);
    const challenges = normalizeChallenges(value.challenges, index, notes);
    if (!Array.isArray(value.evidence)) notes.push(`finding[${index}].evidence normalized to an array`);
    if (evidence.length === 0 && value.evidence !== undefined) notes.push(`finding[${index}] contained no safely convertible evidence`);
    if (!Array.isArray(value.raisedBy)) notes.push(`finding[${index}].raisedBy normalized to the active role`);
    return {
        ...value,
        evidence,
        raisedBy: [roleId],
        challenges,
        status: "proposed",
    };
}

function normalizeEvidence(input: unknown, roleId: string, findingIndex: number, notes: string[]): unknown[] {
    return normalizeEvidenceItems(input, `${roleId}-${findingIndex + 1}-evidence`, `finding[${findingIndex}].evidence`, notes);
}

function normalizeEvidenceItems(input: unknown, idPrefix: string, path: string, notes: string[]): EvidenceReference[] {
    const values = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
    if (input !== undefined && input !== null && !Array.isArray(input)) notes.push(`${path} normalized to an array`);
    return values.flatMap((item, evidenceIndex) => {
        const id = `${idPrefix}-${evidenceIndex + 1}`;
        if (item && typeof item === "object" && !Array.isArray(item)) {
            const value = { ...(item as Record<string, unknown>) };
            if (typeof value.id !== "string" || !value.id.trim()) {
                value.id = id;
                notes.push(`${path}[${evidenceIndex}].id generated`);
            }
            if (value.kind === undefined || value.kind === null || value.kind === "") {
                const inferred = inferEvidenceKind(value);
                if (inferred) {
                    value.kind = inferred;
                    notes.push(`${path}[${evidenceIndex}].kind inferred as ${inferred}`);
                }
            }
            if (value.kind === "code" && value.startLine === undefined) {
                const lines = parseLineRange(value.lines ?? value.line);
                if (lines) {
                    value.startLine = lines.startLine;
                    value.endLine = lines.endLine;
                    delete value.lines;
                    delete value.line;
                    notes.push(`${path}[${evidenceIndex}].lines normalized to startLine/endLine`);
                }
            }
            try {
                return [parseEvidence(value, `${path}[${evidenceIndex}]`)];
            } catch (error) {
                notes.push(`${path}[${evidenceIndex}] discarded after normalization: ${errorMessage(error)}`);
                return [];
            }
        }
        if (typeof item !== "string") {
            notes.push(`${path}[${evidenceIndex}] discarded because it is not structured evidence`);
            return [];
        }
        const citation = /^([^:\n]+):(\d+)(?:-(\d+))?\s*(?:-|\u2014)\s*([\s\S]*)$/.exec(item.trim());
        if (!citation) {
            notes.push(`${path}[${evidenceIndex}] discarded because the citation string is ambiguous`);
            return [];
        }
        const startLine = Number(citation[2]);
        const endLine = citation[3] ? Number(citation[3]) : startLine;
        notes.push(`${path}[${evidenceIndex}] normalized from a citation string`);
        const normalized = {
            id,
            kind: "code",
            path: citation[1]!.trim(),
            startLine,
            endLine,
            contextual: true,
            verification: "unverified",
        };
        return [parseEvidence(normalized, `${path}[${evidenceIndex}]`)];
    });
}

function normalizeChallenges(input: unknown, findingIndex: number, notes: string[]): unknown[] {
    if (input === undefined) return [];
    const values = Array.isArray(input) ? input : [input];
    const structured = values.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    if (structured.length !== values.length) notes.push(`finding[${findingIndex}].challenges discarded ${values.length - structured.length} unstructured item(s)`);
    return structured;
}

function parseLineRange(value: unknown): { startLine: number; endLine: number } | undefined {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return { startLine: value, endLine: value };
    if (Array.isArray(value)) {
        const lines = value.map(positiveLine).filter((line): line is number => line !== undefined);
        if (lines.length !== value.length || lines.length === 0) return undefined;
        return { startLine: Math.min(...lines), endLine: Math.max(...lines) };
    }
    if (typeof value !== "string") return undefined;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(value.trim());
    if (!match) return undefined;
    const startLine = Number(match[1]);
    const endLine = match[2] ? Number(match[2]) : startLine;
    if (startLine < 1 || endLine < startLine) return undefined;
    return { startLine, endLine };
}

function normalizedStrings(value: unknown, path: string, notes: string[]): string[] {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : (notes.push(`${path} normalized to an array`), [value]);
    return values.flatMap((item, index) => {
        if (typeof item === "string") return [item];
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            notes.push(`${path}[${index}] discarded because it is not descriptive text`);
            return [];
        }
        const record = item as Record<string, unknown>;
        const title = typeof record.title === "string" ? record.title.trim() : "";
        const description = typeof record.description === "string" ? record.description.trim() : "";
        const question = typeof record.question === "string" ? record.question.trim() : "";
        const impact = typeof record.impact === "string" ? record.impact.trim() : "";
        const note = typeof record.note === "string" ? record.note.trim() : "";
        const observation = typeof record.observation === "string" ? record.observation.trim() : "";
        const claim = typeof record.claim === "string" ? record.claim.trim() : "";
        const source = typeof record.path === "string" ? record.path.trim() : "";
        const normalized = title || description
            ? [title, description].filter(Boolean).join(": ")
            : question || impact
                ? [question, impact ? `Impact: ${impact}` : ""].filter(Boolean).join(" ")
                : observation || claim
                    ? observation || claim
                    : note
                    ? [source, note].filter(Boolean).join(": ")
                    : "";
        if (!normalized) {
            notes.push(`${path}[${index}] discarded because it has no supported descriptive text`);
            return [];
        }
        notes.push(`${path}[${index}] normalized from an object to text`);
        return [normalized];
    });
}

function inferEvidenceKind(value: Record<string, unknown>): EvidenceReference["kind"] | undefined {
    if (typeof value.source === "string" && value.source.trim()) return "log";
    if (typeof value.path !== "string" || !value.path.trim()) return undefined;
    if (value.startLine !== undefined || value.endLine !== undefined || value.lines !== undefined || value.line !== undefined) return "code";
    if (value.section !== undefined) return "document";
    return undefined;
}

function positiveLine(value: unknown): number | undefined {
    const line = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    return typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
