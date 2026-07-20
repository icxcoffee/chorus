import { lstat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { REVIEW_SCHEMA_VERSION, type ReviewPlan, type ReviewRequest, type ReviewScope } from "./contracts.js";
import { resolveGitDiff } from "./git-diff.js";

export async function resolveReviewScope(request: ReviewRequest, options: { cwd?: string; workflowVersion?: number; assignments?: ReviewPlan["assignments"]; stages?: ReviewPlan["stages"] } = {}): Promise<ReviewPlan> {
    const requestedRoot = request.scope.root ?? options.cwd ?? process.cwd();
    const workspaceRoot = await realpath(resolve(requestedRoot));
    const rootInfo = await lstat(workspaceRoot);
    if (!rootInfo.isDirectory()) throw new Error(`review workspace root is not a directory: ${workspaceRoot}`);
    const includePaths = await resolvePaths(workspaceRoot, request.scope.paths ?? [], "include");
    const excludePaths = await resolvePaths(workspaceRoot, request.scope.exclude ?? [], "exclude");
    if (request.scope.kind === "files" && includePaths.length === 0) throw new Error("files review scope requires at least one path");
    const diff = request.scope.kind === "diff" ? await resolveGitDiff({ cwd: workspaceRoot, ...(request.scope.selection ? { selection: request.scope.selection } : {}), ...(request.scope.base ? { base: request.scope.base } : {}), ...(request.scope.head ? { head: request.scope.head } : {}) }) : undefined;
    const scope: ReviewScope = {
        kind: request.scope.kind,
        workspaceRoot,
        includePaths: diff ? diff.files.filter((file) => file.status !== "deleted").map((file) => file.path) : includePaths,
        excludePaths,
        ...(request.scope.base ? { base: request.scope.base } : {}),
        ...(request.scope.head ? { head: request.scope.head } : {}),
        ...(diff ? {
            selection: diff.selection,
            changedLines: Object.fromEntries(diff.files.map((file) => [file.path, file.changedLines])),
            deletedPaths: diff.files.filter((file) => file.status === "deleted").map((file) => file.path),
            snapshot: {
                files: await hashScopeFiles(workspaceRoot, diff.files.filter((file) => file.status !== "deleted").map((file) => file.path)),
                diffSha256: sha256(diff.patch),
            },
        } : {}),
    };
    if (!diff && includePaths.length > 0) scope.snapshot = { files: await hashScopeFiles(workspaceRoot, includePaths) };
    if (diff) Object.defineProperty(scope, "reviewedPatch", { value: diff.patch, enumerable: false, configurable: false, writable: false });
    return {
        version: REVIEW_SCHEMA_VERSION,
        workflowId: request.workflow,
        workflowVersion: options.workflowVersion ?? 1,
        request,
        scope,
        assignments: options.assignments ?? [],
        stages: options.stages ?? [],
        createdAt: Date.now(),
    };
}

export async function hashScopeFiles(root: string, paths: string[], concurrency = 4): Promise<Record<string, string>> {
    const canonicalRoot = await realpath(root);
    const entries: Array<readonly [string, string]> = [];
    let cursor = 0;
    const worker = async () => {
        while (cursor < paths.length) {
            const path = paths[cursor++];
            if (!path) continue;
            const entry = await hashScopeFile(canonicalRoot, path);
            if (entry) entries.push(entry);
        }
    };
    await Promise.all(Array.from({ length: Math.min(paths.length, Math.max(1, Math.floor(concurrency))) }, worker));
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

async function hashScopeFile(root: string, path: string): Promise<readonly [string, string] | undefined> {
    let canonical: string;
    try { canonical = await realpath(resolve(root, path)); }
    catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
    }
    if (!isPathInside(root, canonical)) throw new Error(`scope hash path escapes workspace: ${path}`);
    if (!(await lstat(canonical)).isFile()) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(canonical)) hash.update(chunk as Buffer);
    return [path, hash.digest("hex")];
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

export function isPathInside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolvePaths(root: string, paths: string[], label: string): Promise<string[]> {
    const result: string[] = [];
    for (const path of paths) {
        const absolute = resolve(root, path);
        let canonical: string;
        try {
            canonical = await realpath(absolute);
        } catch {
            throw new Error(`${label} path does not exist: ${path}`);
        }
        if (!isPathInside(root, canonical)) throw new Error(`${label} path escapes review scope: ${path}`);
        const normalized = relative(root, canonical).split(sep).join("/") || ".";
        if (!result.includes(normalized)) result.push(normalized);
    }
    return result.sort();
}
