import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
    ChorusVoice,
    PartialVoiceProgress,
    VoiceResult,
    SubagentPermissionProfile,
} from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { modelRefToPiArg } from "./utils/models.js";
import { redactSensitive } from "./utils/redact.js";
import {
    activityLogFromState,
    applySubagentLine,
    createParseState,
    outputFromState,
    parseSubagentNdjson,
    parsedOutputFromState,
    recoveryContextFromState,
} from "./subagent/ndjson.js";
import {
    assertPermissionProfileAllowed,
    buildChildEnvironment,
    permissionProfileArgs,
    resolvePiBinary,
    resolveSubagentCwd,
} from "./subagent/runtime.js";
import { registerActiveSubagentProcess, terminateSubagentProcess } from "./subagent/processes.js";
import { BoundedByteTail } from "./subagent/bounded-byte-tail.js";
export {
    parseSubagentNdjson,
    type ParsedSubagentOutput,
} from "./subagent/ndjson.js";

const MAX_RETAINED_STDERR_BYTES = 256 * 1024;

export type SpawnLike = (
    command: string,
    args: string[],
    options: SpawnOptions,
) => SubagentChild;

export interface SubagentChild extends EventEmitter {
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    exitCode: number | null;
    pid?: number;
}

export interface SubagentVoiceArgs {
    voice: ChorusVoice;
    prompt: string;
    systemPrompt?: string;
    voiceIndex?: number;
    timeoutMs: number;
    includeSessionHistory?: boolean;
    cwd?: string;
    signal: AbortSignal;
    spawnImpl?: SpawnLike;
    onProgress?: (update: PartialVoiceProgress) => void;
    permissionProfile?: SubagentPermissionProfile;
    disableTools?: boolean;
    timeoutMode?: "total" | "inactivity";
    progressIntervalMs?: number;
    maxToolCalls?: number;
    maxTurns?: number;
    retainRecoveryContext?: boolean;
}

/**
 * Executes one voice by spawning `pi --mode json`, streaming progress from NDJSON
 * events, and terminating the whole process group on timeout or parent abort.
 */
export async function runSubagentVoice(
    args: SubagentVoiceArgs,
): Promise<VoiceResult> {
    const startedAt = Date.now();
    const voiceIndex = args.voiceIndex ?? 0;
    args.onProgress?.({ voiceIndex, voice: args.voice, status: "running" });
    let tempDir: string | undefined;
    let child: SubagentChild | undefined;
    let timedOut = false;
    let aborted = false;
    let retainedPartialOutput: string | undefined;
    let retainedActivityLog: string | undefined;
    let retainedRecoveryContext: string | undefined;
    let retainedUsage: VoiceResult["usage"];
    let retainedCostUsd: number | null = null;
    let progressTimer: NodeJS.Timeout | undefined;
    let unregisterChild: (() => void) | undefined;
    let toolLimitExceeded = false;
    let turnLimitExceeded = false;
    const permissionProfile = args.permissionProfile ?? "read-only";
    try {
        assertPermissionProfileAllowed(permissionProfile);
        tempDir = await mkdtemp(join(tmpdir(), "chorus-subagent-"));
        const promptFile = join(tempDir, "system-prompt.txt");
        const taskFile = join(tempDir, "task.md");
        await writeFile(
            promptFile,
            args.systemPrompt ?? ROLE_SYSTEM_PROMPTS[args.voice.role ?? "balanced"],
            { mode: 0o600 },
        );
        await writeFile(
            taskFile,
            args.prompt.endsWith("\n") ? args.prompt : `${args.prompt}\n`,
            { mode: 0o600 },
        );
        const spawnImpl: SpawnLike =
            args.spawnImpl ??
            ((command, spawnArgs, options) =>
                nodeSpawn(command, spawnArgs, options) as SubagentChild);
        const sessionArgs = args.includeSessionHistory ? [] : ["--no-session"];
        const permissionArgs = permissionProfileArgs(permissionProfile, args.disableTools === true);
        const cwd = resolveSubagentCwd(args.cwd);
        child = spawnImpl(
            resolvePiBinary(),
            [
                "--mode",
                "json",
                "-p",
                ...sessionArgs,
                ...permissionArgs,
                "--model",
                modelRefToPiArg(args.voice.model),
                "--append-system-prompt",
                promptFile,
                `@${taskFile}`,
                "Follow the task in the attached file.",
            ],
            { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: buildChildEnvironment(permissionProfile) },
        );
        unregisterChild = registerActiveSubagentProcess(child);
        const stderrTail = new BoundedByteTail(MAX_RETAINED_STDERR_BYTES);
        const incrementalState = createParseState();
        const stdoutDecoder = new StringDecoder("utf8");
        let stdoutSegments: string[] = [];
        let lastProgressAt = 0;
        let forceKillTimer: NodeJS.Timeout | undefined;
        const terminate = () => {
            terminateSubagentProcess(child, "SIGTERM");
            forceKillTimer = setTimeout(
                () => terminateSubagentProcess(child, "SIGKILL"),
                5_000,
            );
        };
        const emitProgress = () => {
            if (progressTimer) {
                clearTimeout(progressTimer);
                progressTimer = undefined;
            }
            lastProgressAt = Date.now();
            const partialOutput = outputFromState(incrementalState).trim();
            const activityLog = activityLogFromState(incrementalState);
            if (!partialOutput && !activityLog) return;
            if (partialOutput) retainedPartialOutput = partialOutput;
            if (activityLog) retainedActivityLog = activityLog;
            const recoveryContext = recoveryContextFromState(incrementalState);
            if (recoveryContext) retainedRecoveryContext = recoveryContext;
            if (incrementalState.usage) retainedUsage = incrementalState.usage;
            retainedCostUsd = incrementalState.costUsd;
            args.onProgress?.({
                voiceIndex,
                voice: args.voice,
                status: "running",
                ...(partialOutput ? { partialOutput } : {}),
                ...(activityLog ? { activityLog } : {}),
                durationMs: Date.now() - startedAt,
                ...(incrementalState.usage ? { usage: incrementalState.usage } : {}),
                costUsd: incrementalState.costUsd,
            });
        };
        const scheduleProgress = () => {
            const intervalMs = Math.max(0, args.progressIntervalMs ?? 50);
            const elapsed = Date.now() - lastProgressAt;
            if (lastProgressAt === 0 || elapsed >= intervalMs) {
                emitProgress();
                return;
            }
            if (!progressTimer) progressTimer = setTimeout(emitProgress, intervalMs - elapsed);
        };
        const applyDecodedChunk = (decoded: string) => {
            const parts = decoded.split("\n");
            if (parts.length === 1) {
                if (decoded) stdoutSegments.push(decoded);
                return;
            }
            let processed = false;
            const first = `${stdoutSegments.join("")}${parts[0] ?? ""}`;
            stdoutSegments = [];
            for (const line of [first, ...parts.slice(1, -1)]) {
                const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
                if (normalized.trim() === "") continue;
                applySubagentLine(incrementalState, normalized);
                if (args.maxToolCalls !== undefined && incrementalState.toolCallCount > args.maxToolCalls && !toolLimitExceeded) {
                    toolLimitExceeded = true;
                    terminate();
                }
                if (args.maxTurns !== undefined && incrementalState.turnCount > args.maxTurns && !turnLimitExceeded) {
                    turnLimitExceeded = true;
                    terminate();
                }
                processed = true;
            }
            const remainder = parts.at(-1) ?? "";
            if (remainder) stdoutSegments.push(remainder);
            if (processed) scheduleProgress();
        };
        child.stdout.on("data", (chunk: Buffer | string) => {
            refreshTimeout();
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            applyDecodedChunk(stdoutDecoder.write(buffer));
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
            refreshTimeout();
            stderrTail.append(chunk);
        });

        let timeout: NodeJS.Timeout | undefined;
        const onTimeout = () => {
            timedOut = true;
            terminate();
        };
        function refreshTimeout(): void {
            if (args.timeoutMode !== "inactivity" || timedOut || aborted) return;
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(onTimeout, args.timeoutMs);
        }
        timeout = setTimeout(onTimeout, args.timeoutMs);
        const onAbort = () => {
            aborted = true;
            terminate();
        };
        args.signal.addEventListener("abort", onAbort, { once: true });

        const exitCode = await new Promise<number | null>((resolve, reject) => {
            child?.on("error", reject);
            child?.on("close", (code: number | null) => resolve(code));
        }).finally(() => {
            if (timeout) clearTimeout(timeout);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            args.signal.removeEventListener("abort", onAbort);
        });

        applyDecodedChunk(stdoutDecoder.end());
        const finalLine = stdoutSegments.join("");
        stdoutSegments = [];
        if (finalLine.trim()) applySubagentLine(incrementalState, finalLine);
        emitProgress();

        const stderrText = redactSensitive(stderrTail.toBuffer().toString("utf8").trim());
        const stderr = stderrTail.omittedBytes() > 0
            ? `[stderr truncated: ${stderrTail.omittedBytes()} bytes omitted]\n${stderrText}`.trim()
            : stderrText;
        const parsed = parsedOutputFromState(incrementalState);
        if (parsed.output) retainedPartialOutput = parsed.output;
        if (parsed.activityLog) retainedActivityLog = parsed.activityLog;
        if (parsed.recoveryContext) retainedRecoveryContext = parsed.recoveryContext;
        if (parsed.usage) retainedUsage = parsed.usage;
        retainedCostUsd = parsed.costUsd;
        if (timedOut) throw new Error(args.timeoutMode === "inactivity"
            ? `inactivity timeout after ${args.timeoutMs}ms without subagent output`
            : `timed out after ${args.timeoutMs}ms`);
        if (aborted || args.signal.aborted) throw new AbortError();
        if (toolLimitExceeded) throw new Error(`tool call limit exceeded (${args.maxToolCalls ?? 0} allowed)`);
        if (turnLimitExceeded) throw new Error(`turn limit exceeded (${args.maxTurns ?? 0} allowed)`);
        if (exitCode !== 0)
            throw new Error(stderr || `pi exited with code ${String(exitCode)}`);
        if (parsed.malformedLines.length > 0)
            throw new Error(
                `malformed pi json: ${redactSensitive(parsed.malformedLines[0] ?? "")}`,
            );
        if (stderr) throw new Error(stderr);
        if (!parsed.output) throw new Error("pi produced no assistant text");
        const result: VoiceResult = {
            voice: args.voice,
            status: "success",
            output: parsed.output,
            ...(parsed.activityLog ? { activityLog: parsed.activityLog } : {}),
            ...(args.retainRecoveryContext && parsed.recoveryContext ? { recoveryContext: parsed.recoveryContext } : {}),
            durationMs: Date.now() - startedAt,
            costUsd: parsed.costUsd,
            startedAt,
            permissionProfile,
            ...(parsed.usage ? { usage: parsed.usage } : {}),
        };
        args.onProgress?.({
            voiceIndex,
            voice: args.voice,
            status: "success",
            durationMs: result.durationMs,
            costUsd: result.costUsd,
            ...(result.activityLog ? { activityLog: result.activityLog } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
        });
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: VoiceResult = {
            voice: args.voice,
            status: error instanceof AbortError ? "aborted" : "error",
            durationMs: Date.now() - startedAt,
            costUsd: retainedCostUsd,
            startedAt,
            permissionProfile,
            ...(retainedPartialOutput ? { partialOutput: retainedPartialOutput } : {}),
            ...(retainedActivityLog ? { activityLog: retainedActivityLog } : {}),
            ...(args.retainRecoveryContext && retainedRecoveryContext ? { recoveryContext: retainedRecoveryContext } : {}),
            ...(retainedUsage ? { usage: retainedUsage } : {}),
            errorMessage: redactSensitive(message),
        };
        args.onProgress?.({
            voiceIndex,
            voice: args.voice,
            status: result.status,
            durationMs: result.durationMs,
            costUsd: result.costUsd,
            ...(result.partialOutput ? { partialOutput: result.partialOutput } : {}),
            ...(result.activityLog ? { activityLog: result.activityLog } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        });
        return result;
    } finally {
        if (progressTimer) clearTimeout(progressTimer);
        unregisterChild?.();
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
}

class AbortError extends Error {
    constructor() {
        super("aborted");
        this.name = "AbortError";
    }
}
