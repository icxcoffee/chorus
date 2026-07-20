import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChorusJobStore } from "../../src/jobs.js";
import type { PiLikeContext } from "../../src/pi-context.js";
import { saveConfig } from "../../src/store.js";
import { config, registry, voiceResult } from "../unit/fixtures.js";

const boundaries = vi.hoisted(() => ({
    direct: vi.fn(),
    subagent: vi.fn(),
    directSynthesis: vi.fn(),
    agentSynthesis: vi.fn(),
}));

vi.mock("../../src/direct-api.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/direct-api.js")>()),
    runDirectVoice: boundaries.direct,
}));
vi.mock("../../src/subagent.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/subagent.js")>()),
    runSubagentVoice: boundaries.subagent,
}));
vi.mock("../../src/synthesize.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/synthesize.js")>()),
    synthesize: boundaries.directSynthesis,
}));
vi.mock("../../src/agent-synthesis.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/agent-synthesis.js")>()),
    synthesizeWithMainAgent: boundaries.agentSynthesis,
}));

import { activate } from "../../src/index.js";

type Command = {
    handler: (args: string, ctx: PiLikeContext) => Promise<void>;
};
type Tool = {
    name?: string;
    execute: (
        id: string,
        params: unknown,
        signal: AbortSignal,
        onUpdate: (update: unknown) => void,
        ctx: PiLikeContext,
    ) => Promise<unknown>;
};

describe("activation characterization", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        boundaries.direct.mockImplementation(async (args) => ({
            ...voiceResult(args.voiceIndex ?? 0),
            voice: args.voice,
        }));
        boundaries.subagent.mockImplementation(async (args) => ({
            ...voiceResult(args.voiceIndex ?? 0),
            voice: args.voice,
        }));
        boundaries.directSynthesis.mockResolvedValue({
            synthesis: "combined answer",
            costUsd: 0,
        });
        boundaries.agentSynthesis.mockResolvedValue({
            synthesis: "combined agent report",
            costUsd: 0,
        });
    });

    it("runs ask and agent commands through completed persisted jobs and rendered messages", async () => {
        const harness = await createHarness();

        await harness.commands.get("chorus-ask")!.handler("compare options", harness.commandCtx);
        const ask = await waitForFinishedJob(harness.jobs, "ask");
        expect(ask.status).toBe("success");
        expect(ask.renderedText).toContain("combined answer");
        expect(boundaries.direct).toHaveBeenCalledTimes(2);

        await harness.commands.get("chorus-agent")!.handler("inspect repository", harness.commandCtx);
        const agent = await waitForFinishedJob(harness.jobs, "agent");
        expect(agent.status).toBe("success");
        expect(agent.renderedText).toContain("combined agent report");
        expect(boundaries.subagent).toHaveBeenCalledTimes(2);

        await harness.jobs.persist();
        const jobs = JSON.parse(await readFile(join(harness.baseDir, "jobs.json"), "utf8"));
        expect(jobs).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "ask", status: "success" }),
            expect.objectContaining({ kind: "agent", status: "success" }),
        ]));
        expect(harness.messages.some((message) => message.content.includes("combined answer"))).toBe(true);
        expect(harness.messages.some((message) => message.content.includes("combined agent report"))).toBe(true);
    });

    it("returns structured tool details and persists history without network access", async () => {
        const harness = await createHarness();
        const updates: unknown[] = [];
        const result = await harness.tool.execute(
            "tool-1",
            { prompt: "tool question" },
            new AbortController().signal,
            (update) => updates.push(update),
            harness.commandCtx,
        ) as { content: Array<{ text: string }>; details: { result: { runId: string } } };

        expect(result.content[0]?.text).toBe("combined answer");
        expect(result.details.result.runId).toEqual(expect.any(String));
        expect(updates).toEqual(expect.arrayContaining([
            expect.objectContaining({ message: "chorus conductor running" }),
            expect.objectContaining({ message: "chorus conductor success" }),
        ]));
        await vi.waitFor(async () => {
            const history = await readFile(join(harness.baseDir, "history.jsonl"), "utf8");
            expect(history).toContain("tool question");
        });
    });

    it("keeps partial output when a voice and then the conductor fail", async () => {
        boundaries.direct.mockImplementation(async (args) => {
            if (args.voiceIndex === 1) throw new Error("voice unavailable");
            return { ...voiceResult(0), voice: args.voice };
        });
        const partialHarness = await createHarness();
        await partialHarness.commands.get("chorus-ask")!.handler("partial", partialHarness.commandCtx);
        const partial = await waitForFinishedJob(partialHarness.jobs, "ask");
        expect(partial.result?.successfulVoices).toBe(1);
        expect(partial.result?.fallbackNote).toContain("skipping synthesis");

        boundaries.direct.mockImplementation(async (args) => ({
            ...voiceResult(args.voiceIndex ?? 0),
            voice: args.voice,
        }));
        boundaries.directSynthesis.mockRejectedValueOnce(new Error("conductor unavailable"));
        const conductorHarness = await createHarness();
        await conductorHarness.commands.get("chorus-ask")!.handler("fallback", conductorHarness.commandCtx);
        const conductor = await waitForFinishedJob(conductorHarness.jobs, "ask");
        expect(conductor.status).toBe("success");
        expect(conductor.result?.synthesis).toBeNull();
        expect(conductor.result?.fallbackNote).toContain("conductor failed");
        expect(conductor.renderedText).toContain("answer 0");
    });

    it("propagates host cancellation and persists an aborted job", async () => {
        boundaries.direct.mockImplementation(async (args) => await new Promise((_, reject) => {
            args.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }));
        const controller = new AbortController();
        const harness = await createHarness(controller.signal);
        await harness.commands.get("chorus-ask")!.handler("cancel me", harness.commandCtx);
        controller.abort("host cancelled");
        const job = await waitForFinishedJob(harness.jobs, "ask");
        expect(job.status).toBe("aborted");
        expect(job.result?.voices.every((voice) => voice.status === "aborted")).toBe(true);
        await harness.jobs.persist();
        expect(await readFile(join(harness.baseDir, "jobs.json"), "utf8")).toContain('"status": "aborted"');
    });
});

async function createHarness(signal?: AbortSignal) {
    const baseDir = await mkdtemp(join(tmpdir(), "chorus-integration-"));
    await saveConfig(config, { baseDir }, registry);
    const commands = new Map<string, Command>();
    let tool: Tool | undefined;
    const jobs = new ChorusJobStore({ baseDir });
    const messages: Array<{ content: string; details?: unknown }> = [];
    await activate({
        storePaths: { baseDir },
        chorusJobStore: jobs,
        registerCommand: (name, definition) => commands.set(name, definition as Command),
        registerTool: (definition) => {
            if (definition.name === "chorus_answer") tool = definition as Tool;
        },
        sendMessage: (message) => messages.push(message),
    });
    const commandCtx: PiLikeContext = {
        modelRegistry: { models: registry },
        storePaths: { baseDir },
        chorusJobStore: jobs,
        ...(signal ? { signal } : {}),
        sendMessage: (message) => messages.push(message),
        ui: {
            show: (content) => messages.push({ content }),
        },
    };
    if (!commands.has("chorus-ask") || !tool) {
        throw new Error("activation did not register commands and tool");
    }
    return { baseDir, commands, tool, jobs, messages, commandCtx };
}

async function waitForFinishedJob(store: ChorusJobStore, kind: "ask" | "agent") {
    await vi.waitFor(() => {
        const job = store.list().find((candidate) => candidate.kind === kind);
        expect(job?.status).not.toBe("running");
    });
    return store.list().find((candidate) => candidate.kind === kind)!;
}
