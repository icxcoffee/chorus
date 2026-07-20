#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { evaluateReviewPolicy, REVIEW_EXIT_CODES, writeReviewCiSummary } from "../review/ci.js";
import { parseReviewReport } from "../review/validation.js";
import type { FindingSeverity } from "../review/contracts.js";
import { isMainModule } from "./main.js";

export async function runReviewPolicyCli(args: string[]): Promise<number> {
    const [reportPath, ...options] = args;
    if (!reportPath) {
        console.error("Usage: chorus-review-policy <review-report.json> [--fail-on high] [--summary path] [--allow-incomplete]");
        return REVIEW_EXIT_CODES.invalidInput;
    }
    let failOn: FindingSeverity = "high";
    let summaryPath: string | undefined;
    let incomplete: "fail" | "allow" = "fail";
    for (let index = 0; index < options.length; index += 1) {
        const option = options[index]!;
        if (option === "--fail-on") {
            const value = options[++index];
            if (!value || !["critical", "high", "medium", "low", "info"].includes(value)) { console.error("--fail-on must be critical, high, medium, low, or info"); return REVIEW_EXIT_CODES.invalidInput; }
            failOn = value as FindingSeverity;
        } else if (option === "--summary") {
            summaryPath = options[++index];
            if (!summaryPath) { console.error("--summary requires a path"); return REVIEW_EXIT_CODES.invalidInput; }
        } else if (option === "--allow-incomplete") incomplete = "allow";
        else { console.error(`unknown option ${option}`); return REVIEW_EXIT_CODES.invalidInput; }
    }
    try {
        const report = parseReviewReport(JSON.parse(await readFile(reportPath, "utf8")));
        const summary = evaluateReviewPolicy(report, { failOn, minimumConfidence: "medium", requireVerifiedEvidence: true, incomplete });
        if (summaryPath) await writeReviewCiSummary(summaryPath, summary);
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        return summary.exitCode;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return (error as { code?: string }).code === "ENOENT" ? REVIEW_EXIT_CODES.invalidInput : REVIEW_EXIT_CODES.runtimeFailure;
    }
}

if (await isMainModule(import.meta.url, process.argv[1])) {
    process.exitCode = await runReviewPolicyCli(process.argv.slice(2));
}
