import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../../src/cli/main.js";

describe("CLI main module detection", () => {
    it("recognizes direct and symlinked npm bin entry paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "chorus-cli-main-"));
        try {
            const entry = join(root, "entry.js");
            const bin = join(root, "chorus-command");
            await writeFile(entry, "#!/usr/bin/env node\n");
            await symlink(entry, bin);

            await expect(isMainModule(pathToFileURL(entry).href, entry)).resolves.toBe(true);
            await expect(isMainModule(pathToFileURL(entry).href, bin)).resolves.toBe(true);
            await expect(isMainModule(pathToFileURL(entry).href, join(root, "missing"))).resolves.toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
