import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateGitRevision } from "./git-ref.js";

const execFileAsync = promisify(execFile);

export type GitDiffSelection = "working" | "staged" | "commit" | "range";

export interface GitDiffFile {
    path: string;
    oldPath?: string;
    status: "modified" | "added" | "deleted" | "renamed" | "binary";
    changedLines: number[];
    deletedLines: number[];
}

export interface GitDiffScope {
    selection: GitDiffSelection;
    base?: string;
    head?: string;
    files: GitDiffFile[];
    patch: string;
}

export async function resolveGitDiff(args: { cwd: string; selection?: GitDiffSelection; base?: string; head?: string; execFileImpl?: typeof execFileAsync }): Promise<GitDiffScope> {
    const selection = args.selection ?? (args.base && args.head ? "range" : args.base ? "commit" : "working");
    const gitArgs = diffArgs(selection, args.base, args.head);
    const execute = args.execFileImpl ?? execFileAsync;
    const { stdout } = await execute("git", gitArgs, { cwd: args.cwd, maxBuffer: 20 * 1024 * 1024, encoding: "utf8" });
    return { selection, ...(args.base ? { base: args.base } : {}), ...(args.head ? { head: args.head } : {}), files: parseGitDiff(stdout), patch: stdout };
}

export function parseGitDiff(input: string): GitDiffFile[] {
    const files: GitDiffFile[] = [];
    let current: GitDiffFile | undefined;
    let oldLine = 0;
    let newLine = 0;
    for (const line of input.replaceAll("\r\n", "\n").split("\n")) {
        if (line.startsWith("diff --git ")) {
            const paths = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
            if (!paths) continue;
            current = { path: unquoteGitPath(paths[2]!), oldPath: unquoteGitPath(paths[1]!), status: "modified", changedLines: [], deletedLines: [] };
            files.push(current);
            continue;
        }
        if (!current) continue;
        if (line.startsWith("new file mode ")) { current.status = "added"; delete current.oldPath; continue; }
        if (line.startsWith("deleted file mode ")) { current.status = "deleted"; continue; }
        if (line.startsWith("rename from ")) { current.status = "renamed"; current.oldPath = unquoteGitPath(line.slice(12)); continue; }
        if (line.startsWith("rename to ")) { current.path = unquoteGitPath(line.slice(10)); continue; }
        if (line.startsWith("Binary files ") || line === "GIT binary patch") { current.status = "binary"; continue; }
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
        if (line.startsWith("+") && !line.startsWith("+++")) { current.changedLines.push(newLine); newLine += 1; continue; }
        if (line.startsWith("-") && !line.startsWith("---")) { current.deletedLines.push(oldLine); oldLine += 1; continue; }
        if (line.startsWith(" ")) { oldLine += 1; newLine += 1; }
    }
    return files.map((file) => ({ ...file, changedLines: [...new Set(file.changedLines)].sort((a, b) => a - b), deletedLines: [...new Set(file.deletedLines)].sort((a, b) => a - b) }));
}

function diffArgs(selection: GitDiffSelection, base?: string, head?: string): string[] {
    const common = ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--unified=0", "--find-renames"];
    if (selection === "working") return [...common, "--"];
    if (selection === "staged") return [...common, "--cached", "--"];
    if (selection === "commit") {
        if (!base) throw new Error("commit diff selection requires base commit");
        validateGitRevision(base, "base commit");
        return [...common, `${base}^`, base, "--"];
    }
    if (!base || !head) throw new Error("range diff selection requires base and head");
    validateGitRevision(base, "base ref");
    validateGitRevision(head, "head ref");
    return [...common, base, head, "--"];
}

function unquoteGitPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
}
