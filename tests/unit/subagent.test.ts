import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    parseSubagentNdjson,
    runSubagentVoice,
    type SpawnLike,
} from "../../src/subagent.js";
import { preset } from "./fixtures.js";
import { fakeChild } from "./helpers/subagent.js";

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
    it("disables all tools for a bounded finalization run", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({ voice: preset.voices[0]!, prompt: "finalize", timeoutMs: 1000, signal: new AbortController().signal, spawnImpl: spawn, disableTools: true });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(`${JSON.stringify({ type: "message_end", message: "{}" })}\n`);
        child.emit("close", 0);
        await promise;
        const argv = spawn.mock.calls[0]![1];
        expect(argv).toContain("--no-tools");
        expect(argv).not.toContain("read,grep,find,ls");
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
    it("stops source exploration after the configured tool-call budget", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000, maxToolCalls: 1,
            signal: new AbortController().signal,
            spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/a.ts" } })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "src/b.ts" } })}\n`);
        await vi.waitFor(() => expect(child.kills).toContain("SIGTERM"));
        child.emit("close", null);
        const result = await promise;
        expect(result).toEqual(expect.objectContaining({ status: "error", errorMessage: "tool call limit exceeded (1 allowed)" }));
        expect(result.activityLog).toContain("src/b.ts");
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
        child.stdout.write(
            `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial finding" } })}\n`,
        );
        child.stdout.write(
            `${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/index.ts" } })}\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        child.emit("close", null);
        const result = await promise;
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("timed out");
        expect(result.partialOutput).toBe("partial finding");
        expect(result.activityLog).toContain("[tool start] read");
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

    it("retains a bounded stderr tail and reports omitted bytes", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000,
            signal: new AbortController().signal, spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stderr.write(`prefix-secret sk-test-secret ${"x".repeat(300 * 1024)}`);
        child.stderr.write("TAIL-MARKER Authorization: Bearer abc.def");
        child.emit("close", 1);
        const result = await promise;
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("stderr truncated:");
        expect(result.errorMessage).toContain("TAIL-MARKER");
        expect(result.errorMessage).not.toContain("prefix-secret");
        expect(result.errorMessage).not.toContain("abc.def");
        expect(result.errorMessage!.length).toBeLessThan(270 * 1024);
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

    it("defaults to read-only profile with an allowlisted child environment", async () => {
        const child = fakeChild();
        const spawn = vi.fn<SpawnLike>(() => child);
        const promise = runSubagentVoice({
            voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000,
            signal: new AbortController().signal, spawnImpl: spawn,
        });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        child.stdout.write(`${JSON.stringify({ type: "message_end", message: "ok" })}\n`);
        child.emit("close", 0);
        const result = await promise;
        const options = spawn.mock.calls[0]![2];
        expect(options.env).toMatchObject({ CHORUS_PERMISSION_PROFILE: "read-only" });
        expect(spawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls", "--no-extensions"]));
        expect(options.env).not.toHaveProperty("CHORUS_RANDOM_SECRET");
        expect(result.permissionProfile).toBe("read-only");
    });

    it("fails closed for workspace mutation without explicit confirmation", async () => {
        const result = await runSubagentVoice({
            voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000,
            permissionProfile: "workspace-write", signal: new AbortController().signal,
            spawnImpl: vi.fn<SpawnLike>(() => fakeChild()),
        });
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("CHORUS_ALLOW_WORKSPACE_WRITE");
    });

    it("uses Pi's write-only tool allowlist after explicit workspace confirmation", async () => {
        const previous = process.env.CHORUS_ALLOW_WORKSPACE_WRITE;
        process.env.CHORUS_ALLOW_WORKSPACE_WRITE = "1";
        try {
            const child = fakeChild(); const spawn = vi.fn<SpawnLike>(() => child);
            const promise = runSubagentVoice({ voice: preset.voices[0]!, prompt: "p", timeoutMs: 1000, permissionProfile: "workspace-write", signal: new AbortController().signal, spawnImpl: spawn });
            await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
            expect(spawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls,edit,write"]));
            expect(spawn.mock.calls[0]![1]).not.toContain("bash");
            child.stdout.write(`${JSON.stringify({ type: "message_end", message: "ok" })}\n`); child.emit("close", 0);
            expect((await promise).status).toBe("success");
        } finally {
            if (previous === undefined) delete process.env.CHORUS_ALLOW_WORKSPACE_WRITE; else process.env.CHORUS_ALLOW_WORKSPACE_WRITE = previous;
        }
    });
});
