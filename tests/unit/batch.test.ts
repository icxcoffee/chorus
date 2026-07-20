import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/runtime/batch.js";
describe("batch execution", () => { it("skips completed cases and reports invalid/mixed outcomes", async () => { const dir = await mkdtemp(join(tmpdir(), "chorus-batch-")); const path = join(dir, "cases.jsonl"); await writeFile(path, '{"id":"a","prompt":"a"}\n{bad\n{"id":"b","prompt":"b"}\n'); const report = await runBatch(path, async (item) => { if (item.id === "b") throw new Error("fail"); return "ok"; }, new Set(["a"])); expect(report.completed).toEqual(["a"]); expect(report.invalid).toHaveLength(1); expect(report.failed).toEqual(["b"]); }); });
