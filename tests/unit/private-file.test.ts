import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicPrivateWrite } from "../../src/utils/private-file.js";

describe("private file writes", () => {
    it("atomically replaces content with owner-only permissions and no temporary files", async () => {
        const directory = await mkdtemp(join(tmpdir(), "chorus-private-write-"));
        const path = join(directory, "snapshot.json");
        await Promise.all([
            atomicPrivateWrite(path, "first\n"),
            atomicPrivateWrite(path, "second\n"),
        ]);

        expect(["first\n", "second\n"]).toContain(await readFile(path, "utf8"));
        expect((await stat(path)).mode & 0o077).toBe(0);
        expect((await readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    });
});
