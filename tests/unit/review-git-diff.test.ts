import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseGitDiff, resolveGitDiff } from "../../src/review/git-diff.js";
import { validateEvidence } from "../../src/evidence/validation.js";
import type { ReviewScope } from "../../src/review/contracts.js";

describe("git diff review scope", () => {
    it("parses modifications, additions, deletions, renames, binary files, and changed lines", () => {
        const files = parseGitDiff(`diff --git a/old.js b/new.js
similarity index 80%
rename from old.js
rename to new.js
@@ -2,2 +2,3 @@
-old
+new
+added
 context
diff --git a/deleted.js b/deleted.js
deleted file mode 100644
@@ -1 +0,0 @@
-gone
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`);
        expect(files).toEqual([
            expect.objectContaining({ path: "new.js", oldPath: "old.js", status: "renamed", changedLines: [2, 3], deletedLines: [2] }),
            expect.objectContaining({ path: "deleted.js", status: "deleted", changedLines: [], deletedLines: [1] }),
            expect.objectContaining({ path: "image.png", status: "binary" }),
        ]);
    });

    it("requires non-contextual code citations to intersect changed lines", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-diff-"));
        await writeFile(join(root, "file.js"), "one\ntwo\nthree\n");
        const scope: ReviewScope = { kind: "diff", workspaceRoot: await realpath(root), includePaths: ["file.js"], excludePaths: [], changedLines: { "file.js": [2] }, deletedPaths: [] };
        expect((await validateEvidence({ id: "e1", kind: "code", path: "file.js", startLine: 1, verification: "unverified" }, scope)).verification).toBe("invalid");
        expect((await validateEvidence({ id: "e2", kind: "code", path: "file.js", startLine: 2, verification: "unverified" }, scope)).verification).toBe("verified");
        expect((await validateEvidence({ id: "e3", kind: "code", path: "file.js", startLine: 1, contextual: true, verification: "unverified" }, scope)).verification).toBe("verified");
    });

    it("rejects option-like refs before invoking Git", async () => {
        const execute = vi.fn();
        await expect(resolveGitDiff({ cwd: "/repo", selection: "range", base: "--ext-diff", head: "HEAD", execFileImpl: execute as never })).rejects.toThrow("must not start");
        await expect(resolveGitDiff({ cwd: "/repo", selection: "range", base: "main", head: "--output=/tmp/result", execFileImpl: execute as never })).rejects.toThrow("must not start");
        expect(execute).not.toHaveBeenCalled();
    });
});
