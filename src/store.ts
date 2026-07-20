import {
    mkdir,
    readFile,
    appendFile,
    stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
    ChorusConfigFile,
    LegacyChorusConfigFileV1,
    ChorusPreset,
    ChorusResult,
    ModelInfo,
} from "./types.js";
import { validateConfigFile, validatePreset } from "./utils/models.js";
import { atomicPrivateWrite, chmodPrivateBestEffort } from "./utils/private-file.js";

export const CONFIG_VERSION = 2 as const;
export const CONFIG_V2_OPTIONAL_DEFAULTS = {
    includeSessionHistory: false,
    voiceTimeoutMs: 1_800_000,
    conductorTimeoutMs: 1_800_000,
} as const;
export const HISTORY_WARNING_BYTES = 50 * 1024 * 1024;
export const HISTORY_MAX_ENTRIES = 1000;
export const HISTORY_PRUNE_TARGET_ENTRIES = 900;

const queues = new Map<string, Promise<unknown>>();
const historyCounts = new Map<string, { count: number; size: number }>();

export interface StorePaths {
    baseDir?: string;
    configPath?: string;
    historyPath?: string;
    jobsPath?: string;
}

export function defaultStoreDir(): string {
    return join(homedir(), ".pi", "agent", "chorus");
}

export function resolveStorePaths(
    paths: StorePaths = {},
): Required<StorePaths> {
    const baseDir = paths.baseDir ?? defaultStoreDir();
    return {
        baseDir,
        configPath: paths.configPath ?? join(baseDir, "config.json"),
        historyPath: paths.historyPath ?? join(baseDir, "history.jsonl"),
        jobsPath: paths.jobsPath ?? join(baseDir, "jobs.json"),
    };
}

export async function configExists(paths: StorePaths = {}): Promise<boolean> {
    try {
        await stat(resolveStorePaths(paths).configPath);
        return true;
    } catch {
        return false;
    }
}

export async function loadConfig(
    paths: StorePaths = {},
    registry: ModelInfo[] = [],
): Promise<ChorusConfigFile> {
    const document = await readConfigDocument(paths);
    validateConfigFile(document.config, registry);
    if (document.migrated) {
        await saveConfig(document.config, paths, registry);
    }
    return document.config;
}

export async function loadConfigUnchecked(
    paths: StorePaths = {},
): Promise<ChorusConfigFile> {
    return (await readConfigDocument(paths)).config;
}

async function readConfigDocument(paths: StorePaths = {}): Promise<{
    config: ChorusConfigFile;
    migrated: boolean;
}> {
    const { configPath } = resolveStorePaths(paths);
    const raw = await readFile(configPath, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
            `chorus config at ${configPath} is not valid JSON: ${reason}`,
        );
    }
    if (!isRecord(parsed)) {
        throw new Error(`chorus config at ${configPath} must be a JSON object`);
    }
    if (parsed.configVersion === CONFIG_VERSION) {
        return { config: parsed as unknown as ChorusConfigFile, migrated: false };
    }
    if (parsed.configVersion === 1) {
        return {
            config: migrateConfigV1(parsed as unknown as LegacyChorusConfigFileV1),
            migrated: true,
        };
    }
    throw new Error(
        `unsupported chorus configVersion ${String(parsed.configVersion)}; upgrade this extension or migrate config`,
    );
}

export function migrateConfigV1(config: LegacyChorusConfigFileV1): ChorusConfigFile {
    if (!Array.isArray(config.presets)) {
        throw new Error("config presets must be an array");
    }
    return {
        configVersion: CONFIG_VERSION,
        activePresetName: config.activePresetName,
        presets: config.presets.map((preset) => {
            if (preset.optimizeBeforeAsk !== false) {
                throw new Error(
                    `preset ${String(preset.name)} has unsupported optimizeBeforeAsk=true`,
                );
            }
            const { optimizeBeforeAsk: _removed, strategy, ...rest } = preset;
            return {
                ...rest,
                strategy: migrateStrategyV1(strategy),
            };
        }),
    };
}

function migrateStrategyV1(
    strategy: LegacyChorusConfigFileV1["presets"][number]["strategy"],
): ChorusConfigFile["presets"][number]["strategy"] {
    if (strategy === "A") return "parallel";
    if (strategy === "B") return "debate";
    if (strategy === "C") return "rank";
    throw new Error(`unsupported legacy chorus strategy "${String(strategy)}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function saveConfig(
    config: ChorusConfigFile,
    paths: StorePaths = {},
    registry: ModelInfo[] = [],
): Promise<void> {
    validateConfigFile(config, registry);
    const { configPath } = resolveStorePaths(paths);
    await withFileMutationQueue(configPath, async () => {
        await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
        await atomicPrivateWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
    });
}

export async function savePresets(
    activePresetName: string,
    presets: ChorusPreset[],
    paths: StorePaths = {},
    registry: ModelInfo[] = [],
): Promise<void> {
    for (const preset of presets) validatePreset(preset, registry);
    await saveConfig(
        { configVersion: CONFIG_VERSION, activePresetName, presets },
        paths,
        registry,
    );
}

export async function appendHistory(
    result: ChorusResult,
    paths: StorePaths = {},
): Promise<void> {
    const { historyPath } = resolveStorePaths(paths);
    await withFileMutationQueue(historyPath, async () => {
        await mkdir(dirname(historyPath), { recursive: true, mode: 0o700 });
        const line = `${JSON.stringify(result)}\n`;
        const currentSize = await fileSize(historyPath);
        const cached = historyCounts.get(historyPath);
        const count = cached?.size === currentSize ? cached.count : await countHistoryEntries(historyPath);
        await appendFile(historyPath, line, {
            mode: 0o600,
        });
        await chmodPrivateBestEffort(historyPath);
        const appended = { count: count + 1, size: currentSize + Buffer.byteLength(line) };
        const retained = appended.count > HISTORY_MAX_ENTRIES
            ? await pruneHistoryEntries(historyPath, HISTORY_PRUNE_TARGET_ENTRIES)
            : appended;
        historyCounts.set(historyPath, retained);
        await warnIfLargeHistory(historyPath, retained.size);
    });
}

export async function pruneHistory(
    paths: StorePaths = {},
    maxEntries: number = HISTORY_MAX_ENTRIES,
): Promise<void> {
    const { historyPath } = resolveStorePaths(paths);
    await withFileMutationQueue(historyPath, async () => {
        const retained = await pruneHistoryEntries(historyPath, maxEntries);
        historyCounts.set(historyPath, retained);
        await warnIfLargeHistory(historyPath, retained.size);
    });
}

export async function readHistory(paths: StorePaths = {}, onEntry?: (entry: ChorusResult) => void): Promise<{ entries: ChorusResult[]; corruptLines: number }> {
    const entries: ChorusResult[] = [];
    let corruptLines = 0;
    try {
        const reader = createInterface({ input: createReadStream(resolveStorePaths(paths).historyPath), crlfDelay: Infinity });
        for await (const line of reader) {
            if (!line.trim()) continue;
            try { const entry = JSON.parse(line) as ChorusResult; entries.push(entry); onEntry?.(entry); }
            catch { corruptLines += 1; }
        }
    } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    return { entries, corruptLines };
}

export async function loadJsonFile<T>(path: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ENOENT") return fallback;
        throw error;
    }
}

export async function saveJsonFile(
    path: string,
    value: unknown,
): Promise<void> {
    await withFileMutationQueue(path, async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await atomicPrivateWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    });
}

export async function bootstrapConfigIfAbsent(args: {
    paths?: StorePaths;
    registry: ModelInfo[];
    computePresets: (registry: ModelInfo[]) => ChorusPreset[];
}): Promise<ChorusConfigFile | null> {
    if (await configExists(args.paths))
        return loadConfig(args.paths, args.registry);
    const presets = args.computePresets(args.registry);
    if (presets.length === 0) return null;
    const config: ChorusConfigFile = {
        configVersion: CONFIG_VERSION,
        activePresetName: presets[0]?.name ?? "default",
        presets,
    };
    await saveConfig(config, args.paths, args.registry);
    return config;
}

export async function withFileMutationQueue<T>(
    path: string,
    work: () => Promise<T>,
): Promise<T> {
    const previous = queues.get(path) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(
        path,
        next.finally(() => {
            if (queues.get(path) === next) queues.delete(path);
        }),
    );
    return await next;
}

async function warnIfLargeHistory(path: string, knownSize?: number): Promise<void> {
    try {
        const size = knownSize ?? (await stat(path)).size;
        if (size > HISTORY_WARNING_BYTES) {
            console.warn(
                `chorus history is ${(size / 1024 / 1024).toFixed(1)}MB at ${path}; consider archiving old entries`,
            );
        }
    } catch {
        // Retention warnings must not affect the run.
    }
}

async function pruneHistoryEntries(
    path: string,
    maxEntries: number = HISTORY_MAX_ENTRIES,
): Promise<{ count: number; size: number }> {
    try {
        const raw = await readFile(path, "utf8");
        const lines = raw.split("\n");
        const nonEmpty = lines.filter((line) => line.trim() !== "");
        if (nonEmpty.length <= maxEntries) return { count: nonEmpty.length, size: Buffer.byteLength(raw) };
        const kept = nonEmpty.slice(nonEmpty.length - maxEntries);
        const text = `${kept.join("\n")}\n`;
        await atomicPrivateWrite(path, text);
        return { count: kept.length, size: Buffer.byteLength(text) };
    } catch {
        // Retention pruning must not affect the run.
        return { count: 0, size: await fileSize(path).catch(() => 0) };
    }
}

async function countHistoryEntries(path: string): Promise<number> {
    let count = 0;
    try {
        const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of reader) if (line.trim()) count += 1;
    } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    return count;
}

async function fileSize(path: string): Promise<number> {
    try { return (await stat(path)).size; }
    catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return 0;
        throw error;
    }
}
