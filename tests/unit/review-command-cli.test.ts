import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseReviewCommandArgs } from "../../src/commands/review-args.js";
import { runReviewPolicyCli } from "../../src/cli/review-policy.js";

describe("review command arguments", () => {
    it("parses workflow, diff, profile, renderer, constraints, and CI policy", () => {
        expect(parseReviewCommandArgs("code-review --base main --head HEAD --profile deep --format sarif --language en --constraint preserve-api --fail-on high --summary out.json review auth", ["code-review"], "/repo")).toEqual({
            workflow: "code-review",
            objective: "review auth",
            constraints: ["preserve-api"],
            profile: "deep",
            renderer: "sarif",
            language: "en",
            scope: { kind: "diff", selection: "range", base: "main", head: "HEAD", root: "/repo" },
            failOn: "high",
            summaryPath: "out.json",
        });
        expect(() => parseReviewCommandArgs("--execute shell review", [], "/repo")).toThrow("unknown review option");
        expect(() => parseReviewCommandArgs("code-review --base --output=/tmp/leak review", ["code-review"], "/repo")).toThrow("--base must not start");
        expect(parseReviewCommandArgs("code-review --base HEAD@{1} --head HEAD review", ["code-review"], "/repo").scope).toEqual(expect.objectContaining({ base: "HEAD@{1}", head: "HEAD" }));
    });

    it("provides stable shell exit semantics over normalized report JSON", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-policy-cli-"));
        const reportPath = join(root, "report.json");
        const summaryPath = join(root, "summary.json");
        await writeFile(reportPath, JSON.stringify({
            version: 1, reviewId: "r", workflowId: "code-review", decision: "request-changes", executiveSummary: "blocking",
            findings: [{ id: "f", title: "x", description: "x", category: "security", severity: "high", confidence: "high", status: "verified", evidence: [{ id: "e", kind: "code", path: "x.js", startLine: 1, verification: "verified" }], raisedBy: ["security"], challenges: [] }],
            requiredActions: [], positiveObservations: [], unresolvedQuestions: [], coverage: { requestedRoles: 1, completedRoles: 1, reviewedFiles: 1, omittedStages: [] }, run: { durationMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 }, createdAt: 1,
        }));
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        expect(await runReviewPolicyCli([reportPath, "--fail-on", "high", "--summary", summaryPath])).toBe(1);
        expect(JSON.parse(await readFile(summaryPath, "utf8"))).toEqual(expect.objectContaining({ exitCode: 1, blockingFindingIds: ["f"] }));
        stdout.mockRestore();
    });
});
