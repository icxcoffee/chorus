import { mkdir, readFile, rename, writeFile, appendFile, chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ChorusConfigFile, ChorusPreset, ChorusResult, ModelInfo } from "./types.js";
import { validateConfigFile, validatePreset } from "./utils/models.js";

export const CONFIG_VERSION = 1 as const;
export const HISTORY_WARNING_BYTES = 50 * 1024 * 1024;

const queues = new Map<string, Promise<unknown>>();

export interface StorePaths {
  baseDir?: string;
  configPath?: string;
  historyPath?: string;
  jobsPath?: string;
}

export function defaultStoreDir(): string {
  return join(homedir(), ".pi", "agent", "chorus");
}

export function resolveStorePaths(paths: StorePaths = {}): Required<StorePaths> {
  const baseDir = paths.baseDir ?? defaultStoreDir();
  return {
    baseDir,
    configPath: paths.configPath ?? join(baseDir, "config.json"),
    historyPath: paths.historyPath ?? join(baseDir, "history.jsonl"),
    jobsPath: paths.jobsPath ?? join(baseDir, "jobs.json")
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

export async function loadConfig(paths: StorePaths = {}, registry: ModelInfo[] = []): Promise<ChorusConfigFile> {
  const parsed = await loadConfigUnchecked(paths);
  validateConfigFile(parsed, registry);
  return parsed;
}

export async function loadConfigUnchecked(paths: StorePaths = {}): Promise<ChorusConfigFile> {
  const { configPath } = resolveStorePaths(paths);
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw) as ChorusConfigFile;
}

export async function saveConfig(
  config: ChorusConfigFile,
  paths: StorePaths = {},
  registry: ModelInfo[] = []
): Promise<void> {
  validateConfigFile(config, registry);
  const { configPath } = resolveStorePaths(paths);
  await withFileMutationQueue(configPath, async () => {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  });
}

export async function savePresets(
  activePresetName: string,
  presets: ChorusPreset[],
  paths: StorePaths = {},
  registry: ModelInfo[] = []
): Promise<void> {
  for (const preset of presets) validatePreset(preset, registry);
  await saveConfig({ configVersion: CONFIG_VERSION, activePresetName, presets }, paths, registry);
}

export async function appendHistory(result: ChorusResult, paths: StorePaths = {}): Promise<void> {
  const { historyPath } = resolveStorePaths(paths);
  await withFileMutationQueue(historyPath, async () => {
    await mkdir(dirname(historyPath), { recursive: true, mode: 0o700 });
    await appendFile(historyPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    await chmodBestEffort(historyPath, 0o600);
    await warnIfLargeHistory(historyPath);
  });
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

export async function saveJsonFile(path: string, value: unknown): Promise<void> {
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  });
}

export async function bootstrapConfigIfAbsent(args: {
  paths?: StorePaths;
  registry: ModelInfo[];
  computePresets: (registry: ModelInfo[]) => ChorusPreset[];
}): Promise<ChorusConfigFile | null> {
  if (await configExists(args.paths)) return loadConfig(args.paths, args.registry);
  const presets = args.computePresets(args.registry);
  if (presets.length === 0) return null;
  const config: ChorusConfigFile = {
    configVersion: CONFIG_VERSION,
    activePresetName: presets[0]?.name ?? "default",
    presets
  };
  await saveConfig(config, args.paths, args.registry);
  return config;
}

export async function withFileMutationQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(path, next.finally(() => {
    if (queues.get(path) === next) queues.delete(path);
  }));
  return await next;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmodBestEffort(tmp, 0o600);
  await rename(tmp, path);
  await chmodBestEffort(path, 0o600);
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // chmod can fail on non-POSIX filesystems; validation should not depend on it.
  }
}

async function warnIfLargeHistory(path: string): Promise<void> {
  try {
    const size = (await stat(path)).size;
    if (size > HISTORY_WARNING_BYTES) {
      console.warn(`chorus history is ${(size / 1024 / 1024).toFixed(1)}MB at ${path}; consider archiving old entries`);
    }
  } catch {
    // Retention warnings must not affect the run.
  }
}
