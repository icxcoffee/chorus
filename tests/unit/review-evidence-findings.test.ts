import { appendFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateEvidence, validateEvidenceSet } from "../../src/evidence/validation.js";
import { normalizeAndDeduplicateFindings } from "../../src/review/findings.js";
import { hashScopeFiles, resolveReviewScope } from "../../src/review/scope.js";
import type { Finding, ReviewRequest } from "../../src/review/contracts.js";

describe("review scope and source evidence", () => {
    it("resolves canonical scope and verifies exact source locations", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-"));
        await mkdir(join(root, "src"));
        await writeFile(join(root, "src", "auth.ts"), "export function check() {\n    return true;\n}\n");
        const plan = await resolveReviewScope(request(root, ["src/auth.ts"]));
        const evidence = await validateEvidence({
            id: "e1", kind: "code", path: "src/auth.ts", startLine: 1, endLine: 2,
            excerpt: "export function check() {\n    return true;", verification: "unverified",
        }, plan.scope);
        expect(plan.scope.includePaths).toEqual(["src/auth.ts"]);
        expect(evidence).toEqual(expect.objectContaining({ verification: "verified", path: "src/auth.ts" }));
    });

    it("marks stale, binary, missing, excluded, and escaping evidence explicitly", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-"));
        await writeFile(join(root, "a.ts"), "one\ntwo\n");
        await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
        const plan = await resolveReviewScope(request(root));
        expect((await validateEvidence({ id: "a", kind: "code", path: "a.ts", startLine: 4, verification: "unverified" }, plan.scope)).verification).toBe("stale");
        expect((await validateEvidence({ id: "b", kind: "document", path: "binary.dat", verification: "unverified" }, plan.scope)).verification).toBe("invalid");
        expect((await validateEvidence({ id: "c", kind: "code", path: "missing.ts", startLine: 1, verification: "unverified" }, plan.scope)).verification).toBe("unavailable");
        expect((await validateEvidence({ id: "d", kind: "code", path: "../outside", startLine: 1, verification: "unverified" }, plan.scope)).verification).not.toBe("verified");
    });

    it("distinguishes review-time mutation and safely relocates a unique shifted excerpt", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-mutation-"));
        const path = join(root, "source.ts");
        await writeFile(path, "one\ntwo\n");
        const explicit = await resolveReviewScope(request(root, ["source.ts"]));
        await writeFile(path, "one\ntwo\nthree\n");
        const mutated = await validateEvidence({ id: "mutation", kind: "code", path: "source.ts", startLine: 1, verification: "unverified" }, explicit.scope);
        expect(mutated).toEqual(expect.objectContaining({ verification: "stale", verificationReason: "referenced source changed during the review" }));
        expect(explicit.scope.mutatedPaths).toEqual(["source.ts"]);

        const stable = await resolveReviewScope(request(root));
        await validateEvidence({ id: "baseline", kind: "code", path: "source.ts", startLine: 1, verification: "unverified" }, stable.scope);
        const shifted = await validateEvidence({ id: "shifted", kind: "code", path: "source.ts", startLine: 1, excerpt: "two", verification: "unverified" }, stable.scope);
        expect(shifted).toEqual(expect.objectContaining({
            verification: "verified",
            verificationReason: "code evidence uniquely matched source at a relocated line range",
            startLine: 2,
            endLine: 2,
        }));

        await writeFile(path, "one\ntwo\ntwo\n");
        const duplicate = await resolveReviewScope(request(root));
        const ambiguous = await validateEvidence({ id: "ambiguous", kind: "code", path: "source.ts", startLine: 1, excerpt: "two", verification: "unverified" }, duplicate.scope);
        expect(ambiguous).toEqual(expect.objectContaining({ verification: "stale", verificationReason: "code excerpt no longer matches line range" }));
    });

    it("relocates a unique code block after removing common indentation and blank lines", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-indented-evidence-"));
        await writeFile(join(root, "source.ts"), [
            "class Example {",
            "    method(): void {",
            "        first();",
            "",
            "        second();",
            "    }",
            "}",
            "",
        ].join("\n"));
        const plan = await resolveReviewScope(request(root));
        const relocated = await validateEvidence({
            id: "indented",
            kind: "code",
            path: "source.ts",
            startLine: 1,
            endLine: 4,
            excerpt: "method(): void {\n    first();\n    second();\n}",
            verification: "unverified",
        }, plan.scope);

        expect(relocated).toEqual(expect.objectContaining({
            verification: "verified",
            startLine: 2,
            endLine: 6,
            verificationReason: "code evidence uniquely matched source at a relocated line range",
        }));
    });

    it("bounds oversized and growing evidence while preserving duplicate and multi-file order", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-bounded-evidence-"));
        const oversized = join(root, "oversized.log");
        const growing = join(root, "growing.log");
        await writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
        await writeFile(growing, Buffer.alloc(2 * 1024 * 1024, 66));
        for (let index = 0; index < 8; index += 1) await writeFile(join(root, `file-${index}.ts`), `export const value${index} = ${index};\n`);
        const plan = await resolveReviewScope(request(root));

        expect((await validateEvidence({ id: "large", kind: "document", path: "oversized.log", verification: "unverified" }, plan.scope))).toEqual(expect.objectContaining({ verification: "unavailable", verificationReason: "referenced source exceeds evidence size limit" }));
        await appendFile(growing, "x");
        expect(await validateEvidence({ id: "growing", kind: "document", path: "growing.log", verification: "unverified" }, plan.scope)).toEqual(expect.objectContaining({ verification: "unavailable", verificationReason: "referenced source exceeds evidence size limit" }));

        const references = [
            { id: "duplicate-a", kind: "code" as const, path: "file-0.ts", startLine: 1, verification: "unverified" as const },
            { id: "duplicate-b", kind: "code" as const, path: "file-0.ts", startLine: 1, verification: "unverified" as const },
            ...Array.from({ length: 8 }, (_, index) => ({ id: `file-${index}`, kind: "code" as const, path: `file-${index}.ts`, startLine: 1, verification: "unverified" as const })),
        ];
        const validated = await validateEvidenceSet(references, plan.scope);
        expect(validated.map((item) => item.id)).toEqual(references.map((item) => item.id));
        expect(validated.every((item) => item.verification === "verified")).toBe(true);
    });

    it("streams deterministic scope hashes and rejects canonical path escapes", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-review-hash-"));
        const outside = await mkdtemp(join(tmpdir(), "chorus-review-outside-"));
        await writeFile(join(root, "a.ts"), "alpha");
        await writeFile(join(root, "b.ts"), "beta");
        await writeFile(join(outside, "secret.ts"), "secret");
        await symlink(join(outside, "secret.ts"), join(root, "escape.ts"));

        expect(await hashScopeFiles(root, ["b.ts", "a.ts"], 1)).toEqual({
            "a.ts": createHash("sha256").update("alpha").digest("hex"),
            "b.ts": createHash("sha256").update("beta").digest("hex"),
        });
        await expect(hashScopeFiles(root, ["escape.ts"])).rejects.toThrow("escapes workspace");
    });
});

describe("finding normalization", () => {
    it("assigns stable IDs and conservatively merges exact duplicates", () => {
        const findings = normalizeAndDeduplicateFindings([
            finding("security", "Missing authorization", "security", "high"),
            finding("security", "  Missing   authorization ", "architect", "critical"),
            finding("performance", "Missing authorization", "performance", "medium"),
        ]);
        expect(findings).toHaveLength(2);
        const security = findings.find((item) => item.category === "security");
        expect(security).toEqual(expect.objectContaining({ severity: "critical", status: "proposed", raisedBy: ["architect", "security"] }));
        expect(security?.mergeRationale).toContain("Merged 2 findings");
    });

    it("requires explicit support before source-backed evidence verifies a Finding", () => {
        const candidate = finding("security", "Missing authorization", "architect", "high");
        expect(normalizeAndDeduplicateFindings([candidate])[0]?.status).toBe("proposed");
        candidate.challenges.push({ reviewerRoleId: "security", verdict: "support", rationale: "Confirmed independently.", evidence: [] });
        expect(normalizeAndDeduplicateFindings([candidate])[0]?.status).toBe("verified");
        candidate.challenges.push({ reviewerRoleId: "integrator", verdict: "object", rationale: "The export proves the premise false.", evidence: [{ id: "counter", kind: "document", path: "package.json", verification: "verified" }] });
        expect(normalizeAndDeduplicateFindings([candidate])[0]?.status).toBe("disputed");
    });

    it("does not verify a Finding when material evidence has mixed status", () => {
        const candidate = finding("compatibility", "Strict model contract", "architect", "medium");
        candidate.evidence.push({ id: "stale-source", kind: "code", path: "src/pi-compat.ts", startLine: 64, verification: "stale" });
        expect(normalizeAndDeduplicateFindings([candidate])[0]?.status).toBe("unsupported");
    });

    it("accepts independently verified support when the original citation is stale", () => {
        const candidate = finding("performance", "Repeated scan", "performance", "medium");
        candidate.evidence[0] = { ...candidate.evidence[0]!, verification: "stale" };
        candidate.challenges.push({
            reviewerRoleId: "integrator",
            verdict: "support",
            rationale: "The current source independently confirms the behavior.",
            evidence: [{ id: "current", kind: "code", path: "src/runtime/cache.ts", startLine: 1, verification: "verified" }],
        });
        const normalized = normalizeAndDeduplicateFindings([candidate])[0];
        expect(normalized?.status).toBe("verified");
        expect(normalized?.evidence).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "current", verification: "verified" }),
        ]));
    });
});

function request(root: string, paths?: string[]): ReviewRequest {
    return { version: 1, workflow: "code-review", objective: [], constraints: [], scope: { kind: paths ? "files" : "repository", root, ...(paths ? { paths } : {}) }, profile: "quick", renderer: "markdown" };
}

function finding(category: string, title: string, role: string, severity: Finding["severity"]): Finding {
    return {
        id: "model-generated",
        title,
        description: "The route performs no authorization check.",
        category,
        severity,
        confidence: "high",
        status: "proposed",
        evidence: [{ id: `${role}-e`, kind: "code", path: "src/auth.ts", startLine: 1, verification: "verified" }],
        raisedBy: [role],
        challenges: [],
    };
}
