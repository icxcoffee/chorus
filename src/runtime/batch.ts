import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
export interface BatchCase { id: string; prompt: string; reference?: string; rubric?: string; }
export interface BatchReport { completed: string[]; invalid: string[]; failed: string[]; results: Record<string, unknown>; }
export async function runBatch(path: string, run: (item: BatchCase) => Promise<unknown>, completed = new Set<string>(), signal?: AbortSignal): Promise<BatchReport> {
    const report: BatchReport = { completed: [], invalid: [], failed: [], results: {} };
    const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of input) { if (signal?.aborted) break; if (!line.trim()) continue; let item: BatchCase; try { item = JSON.parse(line) as BatchCase; if (!item.id || !item.prompt) throw new Error("missing id/prompt"); } catch { report.invalid.push(line); continue; } if (completed.has(item.id)) { report.completed.push(item.id); continue; } try { report.results[item.id] = await run(item); report.completed.push(item.id); } catch { report.failed.push(item.id); } }
    return report;
}
