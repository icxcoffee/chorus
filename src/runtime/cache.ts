import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface CachePolicy { enabled: boolean; ttlMs?: number; maxEntries?: number; bypass?: boolean; allowSessionHistory?: boolean; }
export interface CacheEntry<T> { key: string; createdAt: number; value: T; }
export interface CacheKeyParts { prompt: string; model: string; role: string; strategy: string; policyVersion: string; systemPrompt?: string; apiKind?: string; endpoint?: string; mode?: string; stage?: string; }
export function cacheKey(parts: CacheKeyParts): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
export function cacheKeyWhenEnabled(enabled: boolean, parts: CacheKeyParts): string | undefined { return enabled ? cacheKey(parts) : undefined; }
export class RunCache<T> {
    private writesSincePrune = 0;
    private pruning: Promise<void> | undefined;
    constructor(private readonly directory: string, private readonly policy: CachePolicy) {}
    async get(key: string): Promise<T | undefined> {
        if (!this.policy.enabled || this.policy.bypass) return undefined;
        const target = join(this.directory, `${key}.json`);
        try {
            const entry = JSON.parse(await readFile(target, "utf8")) as CacheEntry<T>;
            if (this.policy.ttlMs && Date.now() - entry.createdAt > this.policy.ttlMs) {
                await rm(target, { force: true });
                return undefined;
            }
            return entry.value;
        } catch {
            await rm(target, { force: true }).catch(() => undefined);
            return undefined;
        }
    }
    async set(key: string, value: T): Promise<void> { if (!this.policy.enabled || this.policy.bypass) return; await mkdir(this.directory, { recursive: true, mode: 0o700 }); const target = join(this.directory, `${key}.json`); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify({ key, createdAt: Date.now(), value })}\n`, { mode: 0o600 }); await rename(temporary, target); await this.prune(false); }
    async prune(force = true): Promise<void> {
        const max = Math.max(0, Math.floor(this.policy.maxEntries ?? 1000));
        const batch = Math.max(1, Math.min(64, Math.ceil(max * 0.1)));
        if (!force && ++this.writesSincePrune < batch) return;
        this.writesSincePrune = 0;
        if (this.pruning) return await this.pruning;
        this.pruning = this.pruneNow(max);
        try { await this.pruning; }
        finally { this.pruning = undefined; }
    }
    private async pruneNow(max: number): Promise<void> {
        const files = (await readdir(this.directory).catch(() => [] as string[]))
            .filter((file) => file.endsWith(".json"));
        if (files.length <= max) return;

        const entries: Array<{ file: string; modifiedAt: number }> = [];
        await forEachBatch(files, 32, async (file) => {
            try {
                const metadata = await stat(join(this.directory, file));
                if (metadata.isFile()) entries.push({ file, modifiedAt: metadata.mtimeMs });
            } catch {
                // The entry disappeared between readdir and stat.
            }
        });

        if (entries.length <= max) return;
        entries.sort((left, right) => left.modifiedAt - right.modifiedAt || left.file.localeCompare(right.file));
        await Promise.all(entries
            .slice(0, entries.length - max)
            .map(({ file }) => rm(join(this.directory, file), { force: true }).catch(() => undefined)));
    }
}

async function forEachBatch<T>(items: T[], batchSize: number, operation: (item: T) => Promise<void>): Promise<void> {
    for (let offset = 0; offset < items.length; offset += batchSize) {
        await Promise.all(items.slice(offset, offset + batchSize).map(operation));
    }
}
