import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cacheKey, cacheKeyWhenEnabled, RunCache } from "../../src/runtime/cache.js";

describe("run cache", () => {
    it("is opt-in, content addressed, and expires entries", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-cache-"));
        const key = cacheKey({ prompt: "p", model: "m", role: "r", strategy: "s", policyVersion: "1" });
        const cache = new RunCache<string>(dir, { enabled: true, ttlMs: 10_000 });
        await cache.set(key, "answer");
        expect(await cache.get(key)).toBe("answer");
        expect(key).toHaveLength(64);
        expect(await new RunCache<string>(dir, { enabled: false }).get(key)).toBeUndefined();
    });
    it("does not inspect or hash prompt content when disabled", () => {
        const parts = {
            get prompt(): string { throw new Error("prompt must not be read"); },
            model: "m",
            role: "r",
            strategy: "parallel",
            policyVersion: "1",
        };
        expect(cacheKeyWhenEnabled(false, parts)).toBeUndefined();
    });
    it("treats expired and corrupt entries as misses and tolerates concurrent writers", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-cache-race-"));
        const key = cacheKey({ prompt: "p", model: "m", role: "r", strategy: "parallel", policyVersion: "1" });
        const now = vi.spyOn(Date, "now").mockReturnValue(1);
        const cache = new RunCache<string>(dir, { enabled: true, ttlMs: 10 });
        await Promise.all([cache.set(key, "a"), cache.set(key, "b")]);
        expect(["a", "b"]).toContain(await cache.get(key));
        now.mockReturnValue(20);
        expect(await cache.get(key)).toBeUndefined();
        expect(await readdir(dir)).not.toContain(`${key}.json`);
        await writeFile(join(dir, `${key}.json`), "{bad");
        expect(await cache.get(key)).toBeUndefined();
        now.mockRestore();
    });
    it("evicts the least recently written entry by file metadata rather than hash filename", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-cache-eviction-"));
        const cache = new RunCache<string>(dir, { enabled: true, maxEntries: 10 });

        await cache.set("z-oldest", "oldest");
        await cache.set("a-middle", "middle");
        await cache.set("m-newest", "newest");
        await utimes(join(dir, "z-oldest.json"), new Date(100), new Date(100));
        await utimes(join(dir, "a-middle.json"), new Date(200), new Date(200));
        await utimes(join(dir, "m-newest.json"), new Date(300), new Date(300));
        await new RunCache<string>(dir, { enabled: true, maxEntries: 2 }).prune();

        expect(await cache.get("z-oldest")).toBeUndefined();
        expect(await cache.get("a-middle")).toBe("middle");
        expect(await cache.get("m-newest")).toBe("newest");
    });
    it("removes corrupt entries when read and ignores temporary files during pruning", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-cache-corrupt-"));
        const cache = new RunCache<string>(dir, { enabled: true, maxEntries: 2 });

        await cache.set("valid-one", "one");
        await cache.set("valid-two", "two");
        await writeFile(join(dir, "corrupt.json"), "{bad");
        await writeFile(join(dir, "in-flight.tmp"), "partial");
        expect(await cache.get("corrupt")).toBeUndefined();
        await cache.prune();

        expect(await cache.get("valid-one")).toBe("one");
        expect(await cache.get("valid-two")).toBe("two");
        expect(await readdir(dir)).toEqual(expect.arrayContaining([
            "in-flight.tmp",
            "valid-one.json",
            "valid-two.json",
        ]));
        expect(await readdir(dir)).not.toContain("corrupt.json");
    });
    it("batches steady-state pruning with a bounded high-water mark", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-cache-hysteresis-"));
        const cache = new RunCache<string>(dir, { enabled: true, maxEntries: 100 });
        for (let index = 0; index < 100; index += 1) await cache.set(`base-${index}`, "value");
        for (let index = 0; index < 9; index += 1) await cache.set(`burst-${index}`, "value");
        expect((await readdir(dir)).filter((file) => file.endsWith(".json"))).toHaveLength(109);
        await cache.set("burst-9", "value");
        expect((await readdir(dir)).filter((file) => file.endsWith(".json"))).toHaveLength(100);
    });
});
