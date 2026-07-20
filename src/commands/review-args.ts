import { splitCommandArgs } from "./args.js";
import { validateGitRevision } from "../review/git-ref.js";

export interface ParsedReviewCommand {
    definitionPath?: string;
    workflow?: string;
    objective: string;
    constraints: string[];
    profile?: "quick" | "deep";
    renderer?: string;
    language?: "zh-CN" | "en";
    scope?: { kind: "diff"; selection?: "working" | "staged" | "range"; base?: string; head?: string; root?: string };
    failOn?: "critical" | "high" | "medium" | "low" | "info";
    summaryPath?: string;
}

export function parseReviewCommandArgs(raw: string, workflowIds: string[], cwd?: string): ParsedReviewCommand {
    const parts = splitCommandArgs(raw);
    const rest: string[] = [];
    const result: ParsedReviewCommand = { objective: "", constraints: [] };
    let base: string | undefined;
    let head: string | undefined;
    let staged = false;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        const take = (): string => { const value = parts[index + 1]; if (!value) throw new Error(`${part} requires a value`); index += 1; return value; };
        if (part === "--file") result.definitionPath = take();
        else if (part === "--profile") { const value = take(); if (value !== "quick" && value !== "deep") throw new Error("--profile must be quick or deep"); result.profile = value; }
        else if (part === "--format") result.renderer = take();
        else if (part === "--language") {
            const value = take();
            if (value !== "zh-CN" && value !== "en") throw new Error("--language must be zh-CN or en");
            result.language = value;
        }
        else if (part === "--constraint") result.constraints.push(take());
        else if (part === "--base") base = validateGitRevision(take(), "--base");
        else if (part === "--head") head = validateGitRevision(take(), "--head");
        else if (part === "--staged") staged = true;
        else if (part === "--fail-on") { const value = take(); if (!["critical", "high", "medium", "low", "info"].includes(value)) throw new Error("--fail-on has invalid severity"); result.failOn = value as NonNullable<ParsedReviewCommand["failOn"]>; }
        else if (part === "--summary") result.summaryPath = take();
        else if (part.startsWith("--")) throw new Error(`unknown review option ${part}`);
        else rest.push(part);
    }
    if (rest[0] && workflowIds.includes(rest[0])) result.workflow = rest.shift()!;
    result.objective = rest.join(" ");
    if (staged || base || head) result.scope = { kind: "diff", ...(cwd ? { root: cwd } : {}), ...(staged ? { selection: "staged" } : base && head ? { selection: "range", base, head } : { selection: "working" }) };
    return result;
}
