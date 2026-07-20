import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { EvidenceReference, ReviewScope } from "../review/contracts.js";
import { isPathInside } from "../review/scope.js";
import { defaultEvidenceValidationPolicyRegistry } from "./registry.js";

const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_EVIDENCE_CONCURRENCY = 4;

interface LoadedEvidenceFile {
    data: Buffer;
    hash: string;
    content: string;
    lines: string[];
    binary: boolean;
}

type EvidenceFileLoad = { status: "ok"; file: LoadedEvidenceFile } | { status: "oversized" | "unreadable" };
type EvidenceFileCache = Map<string, Promise<EvidenceFileLoad>>;

export async function validateEvidence(reference: EvidenceReference, scope: ReviewScope): Promise<EvidenceReference> {
    return await validateEvidenceWithCache(reference, scope, new Map());
}

async function validateEvidenceWithCache(reference: EvidenceReference, scope: ReviewScope, cache: EvidenceFileCache): Promise<EvidenceReference> {
    const builtIn = await validateBuiltInEvidence(reference, scope, cache);
    if (builtIn.verification !== "verified") return builtIn;
    for (const policy of defaultEvidenceValidationPolicyRegistry.list()) {
        const reason = await policy.validate(Object.freeze({ ...builtIn }), Object.freeze({ ...scope }));
        if (reason) return { ...builtIn, verification: "invalid", verificationReason: `${policy.id}: ${reason}` };
    }
    return builtIn;
}

async function validateBuiltInEvidence(reference: EvidenceReference, scope: ReviewScope, cache: EvidenceFileCache): Promise<EvidenceReference> {
    if (reference.kind === "log") return validateLog(reference, scope);
    let canonical: string;
    try {
        canonical = await realpath(resolve(scope.workspaceRoot, reference.path));
    } catch {
        return { ...reference, verification: "unavailable", verificationReason: "referenced source does not exist" };
    }
    if (!isPathInside(scope.workspaceRoot, canonical)) return { ...reference, verification: "invalid", verificationReason: "referenced source escapes review scope" };
    const path = relative(scope.workspaceRoot, canonical).split(sep).join("/");
    if (!isIncluded(path, scope)) return { ...reference, path, verification: "invalid", verificationReason: "referenced source is outside the declared review scope" };
    const loaded = await loadEvidenceFile(canonical, cache);
    if (loaded.status !== "ok") return {
        ...reference,
        path,
        verification: "unavailable",
        verificationReason: loaded.status === "oversized" ? "referenced source exceeds evidence size limit" : "referenced source could not be read",
    };
    if (loaded.file.binary) return { ...reference, path, verification: "invalid", verificationReason: "binary files cannot be used as textual evidence" };
    const currentHash = loaded.file.hash;
    scope.snapshot ??= { files: {} };
    const expectedHash = scope.snapshot.files[path];
    if (expectedHash === undefined) scope.snapshot.files[path] = currentHash;
    else if (expectedHash !== currentHash) {
        scope.mutatedPaths = [...new Set([...(scope.mutatedPaths ?? []), path])].sort();
        return { ...reference, path, verification: "stale", verificationReason: "referenced source changed during the review" };
    }
    const content = loaded.file.content;
    if (reference.kind === "document") {
        if (reference.section && !content.includes(reference.section)) return { ...reference, path, verification: "stale", verificationReason: "document section was not found" };
        if (reference.excerpt && !content.includes(normalize(reference.excerpt))) return { ...reference, path, verification: "stale", verificationReason: "document excerpt no longer matches" };
        return { ...reference, path, verification: "verified", verificationReason: "document evidence matched source" };
    }
    const lines = loaded.file.lines;
    const endLine = reference.endLine ?? reference.startLine;
    if (endLine < reference.startLine) return { ...reference, path, verification: "invalid", verificationReason: "end line precedes start line" };
    const rangeInBounds = reference.startLine <= lines.length && endLine <= lines.length;
    const sourceExcerpt = rangeInBounds ? lines.slice(reference.startLine - 1, endLine).join("\n") : "";
    const relocated = reference.excerpt && (!rangeInBounds || normalize(sourceExcerpt) !== normalize(reference.excerpt))
        ? locateUniqueExcerpt(content, reference.excerpt)
        : undefined;
    const effectiveStartLine = relocated?.startLine ?? reference.startLine;
    const effectiveEndLine = relocated?.endLine ?? endLine;
    if (!rangeInBounds && !relocated) return { ...reference, path, verification: "stale", verificationReason: `line range exceeds source length ${lines.length}` };
    if (scope.kind === "diff" && !reference.contextual) {
        const changed = scope.changedLines?.[path] ?? [];
        if (!changed.some((line) => line >= effectiveStartLine && line <= effectiveEndLine)) return { ...reference, path, verification: "invalid", verificationReason: "code evidence is outside changed lines; mark it contextual to cite unchanged context" };
    }
    if (reference.excerpt && normalize(sourceExcerpt) !== normalize(reference.excerpt) && !relocated) {
        return { ...reference, path, verification: "stale", verificationReason: "code excerpt no longer matches line range" };
    }
    return {
        ...reference,
        path,
        startLine: effectiveStartLine,
        endLine: effectiveEndLine,
        verification: "verified",
        verificationReason: relocated ? "code evidence uniquely matched source at a relocated line range" : "code evidence matched source",
    };
}

export async function validateEvidenceSet(references: EvidenceReference[], scope: ReviewScope): Promise<EvidenceReference[]> {
    const cache: EvidenceFileCache = new Map();
    const results: Array<EvidenceReference | undefined> = new Array(references.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(DEFAULT_EVIDENCE_CONCURRENCY, references.length) }, async () => {
        while (nextIndex < references.length) {
            const index = nextIndex;
            nextIndex += 1;
            const reference = references[index];
            if (reference) results[index] = await validateEvidenceWithCache(reference, scope, cache);
        }
    });
    await Promise.all(workers);
    return results.map((result, index) => result ?? { ...references[index]!, verification: "unavailable", verificationReason: "evidence validation did not run" });
}

async function loadEvidenceFile(canonical: string, cache: EvidenceFileCache): Promise<EvidenceFileLoad> {
    let pending = cache.get(canonical);
    if (!pending) {
        pending = readBoundedEvidenceFile(canonical);
        cache.set(canonical, pending);
    }
    return await pending;
}

async function readBoundedEvidenceFile(canonical: string): Promise<EvidenceFileLoad> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(canonical, "r");
        const initial = await handle.stat();
        if (!initial.isFile()) return { status: "unreadable" };
        if (initial.size > MAX_EVIDENCE_FILE_BYTES) return { status: "oversized" };
        const allocation = Buffer.allocUnsafe(MAX_EVIDENCE_FILE_BYTES + 1);
        let offset = 0;
        while (offset < allocation.length) {
            const { bytesRead } = await handle.read(allocation, offset, allocation.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        const final = await handle.stat();
        if (offset > MAX_EVIDENCE_FILE_BYTES || final.size > MAX_EVIDENCE_FILE_BYTES) return { status: "oversized" };
        const data = allocation.subarray(0, offset);
        const content = data.toString("utf8").replaceAll("\r\n", "\n");
        return {
            status: "ok",
            file: {
                data,
                hash: createHash("sha256").update(data).digest("hex"),
                content,
                lines: content.split("\n"),
                binary: data.includes(0),
            },
        };
    } catch {
        return { status: "unreadable" };
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function validateLog(reference: Extract<EvidenceReference, { kind: "log" }>, scope: ReviewScope): EvidenceReference {
    const known = scope.includePaths.length === 0 || scope.includePaths.includes(reference.source);
    if (!known) return { ...reference, verification: "invalid", verificationReason: "log source is outside the declared review scope" };
    if (!reference.excerpt.trim()) return { ...reference, verification: "invalid", verificationReason: "log evidence requires a non-empty excerpt" };
    return { ...reference, verification: "verified", verificationReason: "log excerpt is present in the declared source packet" };
}

function isIncluded(path: string, scope: ReviewScope): boolean {
    const included = scope.includePaths.length === 0 || scope.includePaths.some((entry) => path === entry || path.startsWith(`${entry}/`));
    const excluded = scope.excludePaths.some((entry) => path === entry || path.startsWith(`${entry}/`));
    return included && !excluded;
}

function normalize(value: string): string {
    return value.replaceAll("\r\n", "\n").trim();
}

function locateUniqueExcerpt(content: string, excerpt: string): { startLine: number; endLine: number } | undefined {
    const needle = normalize(excerpt);
    if (!needle) return undefined;
    const first = content.indexOf(needle);
    if (first >= 0 && content.indexOf(needle, first + 1) < 0) {
        const startLine = content.slice(0, first).split("\n").length;
        return { startLine, endLine: startLine + (needle.match(/\n/g)?.length ?? 0) };
    }

    const expected = normalizedCodeLines(excerpt);
    if (expected.length === 0) return undefined;
    const sourceLines = content.replaceAll("\r\n", "\n").split("\n");
    const matches: Array<{ startLine: number; endLine: number }> = [];
    for (let start = 0; start < sourceLines.length; start += 1) {
        if (!sourceLines[start]?.trim()) continue;
        let end = start;
        let nonEmptyLines = 0;
        while (end < sourceLines.length && nonEmptyLines < expected.length) {
            if (sourceLines[end]?.trim()) nonEmptyLines += 1;
            end += 1;
        }
        if (nonEmptyLines !== expected.length) continue;
        const candidate = normalizedCodeLines(sourceLines.slice(start, end).join("\n"));
        if (candidate.length === expected.length && candidate.every((line, index) => line === expected[index])) {
            matches.push({ startLine: start + 1, endLine: end });
            if (matches.length > 1) return undefined;
        }
    }
    return matches[0];
}

function normalizedCodeLines(value: string): string[] {
    const lines = value.replaceAll("\r\n", "\n").split("\n");
    while (lines[0]?.trim() === "") lines.shift();
    while (lines.at(-1)?.trim() === "") lines.pop();
    const nonEmpty = lines.filter((line) => line.trim() !== "");
    if (nonEmpty.length === 0) return [];
    const indentation = Math.min(...nonEmpty.map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
    return nonEmpty.map((line) => line.slice(indentation).trimEnd());
}
