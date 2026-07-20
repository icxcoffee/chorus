import { describe, expect, it, vi } from "vitest";
import { parseSubagentNdjson, runSubagentVoice, type SpawnLike } from "../../src/subagent.js";
import { applySubagentLine, createParseState, parsedOutputFromState } from "../../src/subagent/ndjson.js";
import { preset } from "./fixtures.js";
import { fakeChild } from "./helpers/subagent.js";

describe("subagent streaming", () => {
    it("keeps incremental parsing equivalent to full NDJSON parsing", () => {
        const lines = [
            JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
            JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你" } }),
            JSON.stringify({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_end",
                    contentIndex: 0,
                    content: "你好",
                    partial: { usage: { input: 2, output: 1, cost: { total: 0.02 } } },
                },
            }),
            JSON.stringify({ type: "message_end", message: { role: "assistant", content: "你好" } }),
            "{bad",
        ];
        const state = createParseState();
        for (const line of lines) applySubagentLine(state, line);
        expect(parsedOutputFromState(state)).toEqual(parseSubagentNdjson(lines.join("\n")));
    });

    it("decodes split UTF-8 and processes a final event without a newline", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({ voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000, signal: new AbortController().signal, spawnImpl: spawn });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        const line = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "你好" } }), "utf8");
        const character = line.indexOf(Buffer.from("你"));
        child.stdout.write(line.subarray(0, character + 1));
        child.stdout.write(line.subarray(character + 1));
        child.emit("close", 0);
        await expect(promise).resolves.toEqual(expect.objectContaining({ status: "success", output: "你好" }));
    });

    it("coalesces high-frequency text deltas into bounded progress updates", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const partialUpdates: string[] = [];
        const promise = runSubagentVoice({
            voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000, signal: new AbortController().signal, spawnImpl: spawn,
            onProgress: (update) => { if (update.partialOutput) partialUpdates.push(update.partialOutput); },
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        const lines = Array.from({ length: 2_000 }, () => JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }));
        child.stdout.write(`${lines.join("\n")}\n`);
        child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "x".repeat(2_000) } }));
        child.emit("close", 0);
        const result = await promise;
        expect(result.output).toHaveLength(2_000);
        expect(partialUpdates.length).toBeLessThanOrEqual(3);
        expect(partialUpdates.at(-1)).toHaveLength(2_000);
    });

    it("schedules progress once per decoded line batch even with zero interval", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const partialUpdates: string[] = [];
        const promise = runSubagentVoice({
            voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000, progressIntervalMs: 0,
            signal: new AbortController().signal, spawnImpl: spawn,
            onProgress: (update) => { if (update.status === "running" && update.partialOutput) partialUpdates.push(update.partialOutput); },
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        const deltas = Array.from({ length: 100 }, () => JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }));
        child.stdout.write(`${deltas.join("\n")}\n`);
        child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "x".repeat(100) } }));
        child.emit("close", 0);
        await expect(promise).resolves.toEqual(expect.objectContaining({ output: "x".repeat(100) }));
        expect(partialUpdates.length).toBeLessThanOrEqual(3);
    });

    it("resets an inactivity timeout while the subagent keeps producing output", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({ voice: preset.voices[0]!, prompt: "p", timeoutMs: 100, timeoutMode: "inactivity", signal: new AbortController().signal, spawnImpl: spawn });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        for (let index = 0; index < 4; index += 1) {
            child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: `t${index}`, toolName: "read", args: { path: `src/${index}.ts` } })}\n`);
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        expect(child.kills).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 110));
        expect(child.kills).toContain("SIGTERM");
        child.emit("close", null);
        expect((await promise).errorMessage).toContain("inactivity timeout");
    });

    it("keeps stderr activity as an inactivity heartbeat", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({ voice: preset.voices[0]!, prompt: "p", timeoutMs: 100, timeoutMode: "inactivity", signal: new AbortController().signal, spawnImpl: spawn });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        for (let index = 0; index < 4; index += 1) {
            child.stderr.write(`diagnostic ${index}\n`);
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        expect(child.kills).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 110));
        expect(child.kills).toContain("SIGTERM");
        child.emit("close", null);
        expect((await promise).errorMessage).toContain("inactivity timeout");
    });

    it("stops repeated agent turns without imposing a wall-clock deadline", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000, maxTurns: 2,
            signal: new AbortController().signal, spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        for (let index = 0; index < 3; index += 1) child.stdout.write(`${JSON.stringify({ type: "turn_start", turnIndex: index })}\n`);
        await vi.waitFor(() => expect(child.kills).toContain("SIGTERM"));
        child.emit("close", null);
        await expect(promise).resolves.toEqual(expect.objectContaining({ status: "error", errorMessage: "turn limit exceeded (2 allowed)" }));
    });

    it("retains bounded source context separately from the compact activity log", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({ voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000, retainRecoveryContext: true, signal: new AbortController().signal, spawnImpl: spawn });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        const source = `${"x".repeat(2_000)}\nexport const retainedEvidence = true;`;
        child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/evidence.ts" } })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: source }] } })}\n`);
        child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "done" } }));
        child.emit("close", 0);

        const result = await promise;
        expect(result.activityLog).not.toContain("retainedEvidence");
        expect(result.recoveryContext).toContain("[tool read {\"path\":\"src/evidence.ts\"}]");
        expect(result.recoveryContext).toContain("export const retainedEvidence = true;");
    });
});
