import { EventEmitter } from "node:events";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
    parseSubagentNdjson,
    runSubagentVoice,
    type SpawnLike,
} from "../../src/subagent.js";
import { preset } from "./fixtures.js";

describe("subagent", () => {
    it("parses message and usage events", () => {
        const parsed = parseSubagentNdjson(
            [
                JSON.stringify({ type: "message_end", message: { content: "hello" } }),
                JSON.stringify({
                    type: "usage",
                    usage: { input: 1, output: 2, cost: { total: 0.03 } },
                }),
            ].join("\n"),
        );
        expect(parsed.output).toBe("hello");
        expect(parsed.usage).toEqual({
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
        });
        expect(parsed.costUsd).toBe(0.03);
    });

    it("parses Pi json assistant content arrays and usage", () => {
        const parsed = parseSubagentNdjson(
            [
                JSON.stringify({
                    type: "message_end",
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "pwd" }],
                    },
                }),
                JSON.stringify({
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [
                            { type: "thinking", thinking: "checking" },
                            { type: "text", text: "/Users/icx/ai-workspace/chorus\n" },
                        ],
                        usage: {
                            input: 3,
                            output: 4,
                            cacheRead: 1,
                            cacheWrite: 2,
                            cost: { total: 0.05 },
                        },
                    },
                }),
            ].join("\n"),
        );
        expect(parsed.output).toBe("/Users/icx/ai-workspace/chorus");
        expect(parsed.usage).toEqual({
            input: 3,
            output: 4,
            cacheRead: 1,
            cacheWrite: 2,
        });
        expect(parsed.costUsd).toBe(0.05);
    });

    it("falls back to Pi json text update events", () => {
        const parsed = parseSubagentNdjson(
            [
                JSON.stringify({
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta", delta: "hel" },
                }),
                JSON.stringify({
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta", delta: "lo" },
                }),
                JSON.stringify({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_end",
                        content: "hello\n",
                        partial: { usage: { input: 5, output: 6, cost: { total: 0.07 } } },
                    },
                }),
            ].join("\n"),
        );
        expect(parsed.output).toBe("hello");
        expect(parsed.usage).toEqual({
            input: 5,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
        });
        expect(parsed.costUsd).toBe(0.07);
    });

    it("builds an activity log from assistant and tool events", () => {
        const parsed = parseSubagentNdjson(
            [
                JSON.stringify({ type: "turn_start", turnIndex: 0 }),
                JSON.stringify({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "thinking_start",
                        contentIndex: 0,
                        partial: { content: [] },
                    },
                }),
                JSON.stringify({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "thinking_delta",
                        contentIndex: 0,
                        delta: "private reasoning",
                        partial: { content: [] },
                    },
                }),
                JSON.stringify({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_delta",
                        contentIndex: 1,
                        delta: "checking files",
                        partial: { content: [] },
                    },
                }),
                JSON.stringify({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "toolcall_end",
                        contentIndex: 2,
                        toolCall: {
                            name: "grep",
                            arguments: { pattern: "runChorus", path: "src" },
                        },
                        partial: { content: [] },
                    },
                }),
                JSON.stringify({
                    type: "tool_execution_start",
                    toolCallId: "t1",
                    toolName: "grep",
                    args: { pattern: "runChorus", path: "src" },
                }),
                JSON.stringify({
                    type: "tool_execution_end",
                    toolCallId: "t1",
                    toolName: "grep",
                    result: "src/chorus.ts:30",
                    isError: false,
                }),
            ].join("\n"),
        );

        expect(parsed.output).toBe("checking files");
        expect(parsed.activityLog).toContain("[assistant] checking files");
        expect(parsed.activityLog).toContain(
            "[thinking] receiving hidden reasoning",
        );
        expect(parsed.activityLog).not.toContain("private reasoning");
        expect(parsed.activityLog).toContain("[tool call] grep");
        expect(parsed.activityLog).toContain("[tool done] grep src/chorus.ts:30");
    });

    it("records malformed lines", () => {
        expect(parseSubagentNdjson("{bad").malformedLines).toEqual(["{bad"]);
    });

    it("spawns pi with model and prompt files then succeeds without prompt in argv", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const secretPrompt = "p with SECRET_TOKEN_123";
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: secretPrompt,
            timeoutMs: 1000,
            signal: new AbortController().signal,
            spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(
            `${JSON.stringify({ type: "message_end", message: "ok" })}\n`,
        );
        child.stdout.write(
            `${JSON.stringify({ usage: { input: 1, output: 1, cost: { total: 0.01 } } })}\n`,
        );
        child.emit("close", 0);
        const result = await promise;
        const argv = spawn.mock.calls[0]![1];
        const options = spawn.mock.calls[0]![2];
        expect(argv).toContain("deepseek/deepseek-v4-pro");
        expect(argv).toContain("--no-session");
        expect(argv.join(" ")).not.toContain(secretPrompt);
        expect(
            argv.some((arg) => arg.startsWith("@") && arg.endsWith("task.md")),
        ).toBe(true);
        expect(options.detached).toBe(true);
        expect(result.status).toBe("success");
        expect(result.costUsd).toBe(0.01);
    });

    it("omits --no-session when session history is enabled", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            includeSessionHistory: true,
            signal: new AbortController().signal,
            spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(
            `${JSON.stringify({ type: "message_end", message: "ok" })}\n`,
        );
        child.emit("close", 0);
        const result = await promise;
        expect(spawn.mock.calls[0]![1]).not.toContain("--no-session");
        expect(result.status).toBe("success");
    });

    it("emits partial output from streaming Pi json events", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const updates: string[] = [];
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            signal: new AbortController().signal,
            spawnImpl: spawn,
            onProgress: (update) => {
                if (update.partialOutput) updates.push(update.partialOutput);
            },
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(
            `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } })}\n`,
        );
        child.stdout.write(
            `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } })}\n`,
        );
        child.stdout.write(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "hello" } })}\n`,
        );
        child.emit("close", 0);
        const result = await promise;
        expect(result.status).toBe("success");
        expect(updates).toContain("hel");
        expect(updates).toContain("hello");
    });

    it("emits activity logs while streaming Pi json events", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const logs: string[] = [];
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            signal: new AbortController().signal,
            spawnImpl: spawn,
            onProgress: (update) => {
                if (update.activityLog) logs.push(update.activityLog);
            },
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(
            `${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/index.ts" } })}\n`,
        );
        child.stdout.write(
            `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "read complete", partial: { content: [] } } })}\n`,
        );
        child.stdout.write(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "read complete" } })}\n`,
        );
        child.emit("close", 0);
        const result = await promise;
        expect(result.status).toBe("success");
        expect(result.activityLog).toContain("[tool start] read");
        expect(logs.at(-1)).toContain("[assistant] read complete");
    });

    it("turns stderr and malformed ndjson into errors", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            signal: new AbortController().signal,
            spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write("{bad\n");
        child.emit("close", 0);
        const result = await promise;
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("malformed");
    });

    it("turns empty successful pi output into an error", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            signal: new AbortController().signal,
            spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } })}\n`,
        );
        child.emit("close", 0);
        const result = await promise;
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("no assistant text");
    });

    it("terminates on timeout and parent abort", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1,
            signal: new AbortController().signal,
            spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 5));
        child.emit("close", null);
        const result = await promise;
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("timed out");
        expect(child.kills).toContain("SIGTERM");

        const controller = new AbortController();
        const abortChild = fakeChild();
        const abortSpawn = vi.fn<SpawnLike>(() => abortChild);
        const abortPromise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            signal: controller.signal,
            spawnImpl: abortSpawn,
        });
        await vi.waitFor(() => expect(abortSpawn).toHaveBeenCalled());
        controller.abort();
        abortChild.emit("close", null);
        expect((await abortPromise).status).toBe("aborted");
    });

    it("redacts credentials in pi stderr before persisting the error", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            signal: new AbortController().signal,
            spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stderr.write(
            "Error: invalid api_key sk-ant-api03-secretvalue in Authorization: Bearer abc.def\n",
        );
        child.emit("close", 1);
        const result = await promise;
        expect(result.status).toBe("error");
        expect(result.errorMessage).not.toContain("sk-ant-api03-secretvalue");
        expect(result.errorMessage).not.toContain("abc.def");
        expect(result.errorMessage).toContain("[redacted-api-key]");
    });

    it("refuses to spawn in a world-writable cwd", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-unsafe-cwd-"));
        await chmod(dir, 0o777);
        const result = await runSubagentVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            timeoutMs: 1000,
            cwd: dir,
            signal: new AbortController().signal,
            spawnImpl: vi.fn<SpawnLike>(() => fakeChild()),
        });
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("world-writable");
    });
});

type FakeChild = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    exitCode: number | null;
    kills: Array<NodeJS.Signals | number | undefined>;
};

function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kills = [];
    child.kill = (signal?: NodeJS.Signals | number) => {
        child.kills.push(signal);
        return true;
    };
    return child;
}
