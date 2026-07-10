import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { ChorusVoice, PartialVoiceProgress, VoiceResult } from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { modelRefToPiArg } from "./utils/models.js";
import { activityLogFromState, applySubagentLine, createParseState, outputFromState, parseSubagentNdjson } from "./subagent/ndjson.js";
export { parseSubagentNdjson, type ParsedSubagentOutput } from "./subagent/ndjson.js";

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions
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
}

/**
 * Executes one voice by spawning `pi --mode json`, streaming progress from NDJSON
 * events, and terminating the whole process group on timeout or parent abort.
 */
export async function runSubagentVoice(args: SubagentVoiceArgs): Promise<VoiceResult> {
  const startedAt = Date.now();
  const voiceIndex = args.voiceIndex ?? 0;
  args.onProgress?.({ voiceIndex, voice: args.voice, status: "running" });
  let tempDir: string | undefined;
  let child:
    | SubagentChild
    | undefined;
  let timedOut = false;
  let aborted = false;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "chorus-subagent-"));
    const promptFile = join(tempDir, "system-prompt.txt");
    const taskFile = join(tempDir, "task.md");
    await writeFile(promptFile, args.systemPrompt ?? ROLE_SYSTEM_PROMPTS[args.voice.role ?? "balanced"], { mode: 0o600 });
    await writeFile(taskFile, args.prompt.endsWith("\n") ? args.prompt : `${args.prompt}\n`, { mode: 0o600 });
    const spawnImpl: SpawnLike = args.spawnImpl ?? ((command, spawnArgs, options) => nodeSpawn(command, spawnArgs, options) as SubagentChild);
    const sessionArgs = args.includeSessionHistory ? [] : ["--no-session"];
    child = spawnImpl(
      "pi",
      [
        "--mode",
        "json",
        "-p",
        ...sessionArgs,
        "--model",
        modelRefToPiArg(args.voice.model),
        "--append-system-prompt",
        promptFile,
        `@${taskFile}`,
        "Follow the task in the attached file."
      ],
      { cwd: args.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: true }
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const incrementalState = createParseState();
    let stdoutRemainder = "";
    const emitProgress = () => {
      const partialOutput = outputFromState(incrementalState).trim();
      const activityLog = activityLogFromState(incrementalState);
      if (!partialOutput && !activityLog) return;
      args.onProgress?.({
        voiceIndex,
        voice: args.voice,
        status: "running",
        ...(partialOutput ? { partialOutput } : {}),
        ...(activityLog ? { activityLog } : {}),
        durationMs: Date.now() - startedAt,
        ...(incrementalState.usage ? { usage: incrementalState.usage } : {}),
        costUsd: incrementalState.costUsd
      });
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      stdoutChunks.push(buffer);
      stdoutRemainder += buffer.toString("utf8");
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        applySubagentLine(incrementalState, line);
        emitProgress();
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => stderrChunks.push(Buffer.from(chunk)));

    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      terminateSubagentProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateSubagentProcess(child, "SIGKILL"), 5_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, args.timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    args.signal.addEventListener("abort", onAbort, { once: true });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child?.on("error", reject);
      child?.on("close", (code: number | null) => resolve(code));
    }).finally(() => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      args.signal.removeEventListener("abort", onAbort);
    });

    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const parsed = parseSubagentNdjson(Buffer.concat(stdoutChunks).toString("utf8"));
    if (timedOut) throw new Error(`timed out after ${args.timeoutMs}ms`);
    if (aborted || args.signal.aborted) throw new AbortError();
    if (exitCode !== 0) throw new Error(stderr || `pi exited with code ${String(exitCode)}`);
    if (parsed.malformedLines.length > 0) throw new Error(`malformed pi json: ${parsed.malformedLines[0]}`);
    if (stderr) throw new Error(stderr);
    if (!parsed.output) throw new Error("pi produced no assistant text");
    const result: VoiceResult = {
      voice: args.voice,
      status: "success",
      output: parsed.output,
      ...(parsed.activityLog ? { activityLog: parsed.activityLog } : {}),
      durationMs: Date.now() - startedAt,
      costUsd: parsed.costUsd,
      startedAt,
      ...(parsed.usage ? { usage: parsed.usage } : {})
    };
    args.onProgress?.({
      voiceIndex,
      voice: args.voice,
      status: "success",
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      ...(result.activityLog ? { activityLog: result.activityLog } : {}),
      ...(result.usage ? { usage: result.usage } : {})
    });
    return result;
  } catch (error) {
    const result: VoiceResult = {
      voice: args.voice,
      status: error instanceof AbortError ? "aborted" : "error",
      durationMs: Date.now() - startedAt,
      costUsd: null,
      startedAt,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
    args.onProgress?.({
      voiceIndex,
      voice: args.voice,
      status: result.status,
      durationMs: result.durationMs,
      costUsd: null,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {})
    });
    return result;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

function terminateSubagentProcess(child: SubagentChild | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process-group signaling is unavailable.
    }
  }
  child.kill(signal);
}

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}
