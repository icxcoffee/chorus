import { access, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ChorusArtifact, ChorusResult, VoiceResult } from "./types.js";
import { resolveStorePaths, type StorePaths } from "./store.js";
import { fallbackAnswer } from "./utils/fallback.js";
import { modelRefToPiArg } from "./utils/models.js";
import { atomicPrivateWrite } from "./utils/private-file.js";

export interface WriteRunArtifactsArgs {
  result: ChorusResult;
  outputDir: string;
  actorLabel: "agent" | "voice";
}

export const RESULTS_WARNING_DIRS = 200;

export function resultDirForJob(jobId: string, paths: StorePaths = {}): string {
  return join(resolveStorePaths(paths).baseDir, "results", sanitizePathSegment(jobId));
}

export async function writeRunArtifacts(args: WriteRunArtifactsArgs): Promise<ChorusResult> {
  await mkdir(args.outputDir, { recursive: true, mode: 0o700 });
  await warnIfManyResults(args.outputDir);
  const artifacts: ChorusArtifact[] = [];
  const writeArtifact = async (label: string, fileName: string, content: string): Promise<string> => {
    const path = join(args.outputDir, fileName);
    await atomicPrivateWrite(path, content.endsWith("\n") ? content : `${content}\n`);
    artifacts.push({ label, path });
    return path;
  };

  await writeArtifact("request", "request.md", renderRequest(args.result));
  await addExistingArtifact(artifacts, "main-agent-input", join(args.outputDir, "main-agent-input.md"));

  const voices: VoiceResult[] = [];
  for (const [index, voice] of args.result.voices.entries()) {
    const actorLabel = args.actorLabel;
    const outputPath = await writeArtifact(
      `${actorLabel}-${index}`,
      `${actorLabel}-${index}.md`,
      renderVoice(index, voice, actorLabel)
    );
    const activityPath = voice.activityLog
      ? await writeArtifact(
          `${actorLabel}-${index}-activity`,
          `${actorLabel}-${index}-activity.md`,
          voice.activityLog
        )
      : undefined;
    voices.push({
      ...voice,
      outputPath,
      ...(activityPath ? { activityPath } : {})
    });
  }

  for (const [roundIndex, round] of args.result.strategy?.rounds.entries() ?? []) {
    for (const [voiceIndex, voice] of round.voices.entries()) {
      await writeArtifact(
        `round-${roundIndex}-${round.name}-${voiceIndex}`,
        `round-${roundIndex}-${sanitizePathSegment(round.name)}-${voiceIndex}.md`,
        renderVoice(voiceIndex, voice, round.name)
      );
    }
  }

  if (args.result.conductorActivityLog) {
    await writeArtifact("main-agent-activity", "main-agent-activity.md", args.result.conductorActivityLog);
  }
  if (args.result.quality) {
    await writeArtifact("conductor-raw", "conductor-raw.md", args.result.quality.raw);
    await writeArtifact("quality", "quality.json", JSON.stringify({ structured: args.result.quality.structured, metrics: args.result.quality.metrics }, null, 2));
  }
  await writeArtifact("final-report", "final-report.md", args.result.synthesis ?? fallbackAnswer(args.result));

  const resultWithArtifacts: ChorusResult = {
    ...args.result,
    voices,
    outputDir: args.outputDir,
    artifacts
  };
  await writeArtifact("result-json", "result.json", JSON.stringify(resultWithArtifacts, null, 2));
  return {
    ...resultWithArtifacts,
    artifacts
  };
}

async function addExistingArtifact(artifacts: ChorusArtifact[], label: string, path: string): Promise<void> {
  try {
    await access(path);
    artifacts.push({ label, path });
  } catch {
    // Optional artifact produced only by main-agent synthesis.
  }
}

function renderRequest(result: ChorusResult): string {
  return [
    "# Chorus Request",
    "",
    `Run: ${result.runId}`,
    `Preset: ${result.presetName}`,
    `Started: ${new Date(result.startedAt).toISOString()}`,
    "",
    "## Prompt",
    result.prompt,
    ...(result.optimizedPrompt ? ["", "## Optimized Prompt", result.optimizedPrompt] : [])
  ].join("\n");
}

function renderVoice(index: number, voice: VoiceResult, label: string): string {
  const lines = [
    `# ${label}[${index}] ${modelRefToPiArg(voice.voice.model)}`,
    "",
    `Status: ${voice.status}`,
    `DurationMs: ${voice.durationMs}`,
    `CostUsd: ${voice.costUsd ?? "unknown"}`
  ];
  if (voice.usage) lines.push(`Usage: input ${voice.usage.input}, output ${voice.usage.output}, cacheRead ${voice.usage.cacheRead}, cacheWrite ${voice.usage.cacheWrite}`);
  if (voice.errorMessage) lines.push("", "## Error", voice.errorMessage);
  if (voice.activityLog) lines.push("", "## Activity", voice.activityLog);
  const output = voice.output ?? voice.partialOutput;
  if (output) lines.push("", "## Output", output);
  return lines.join("\n");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

async function warnIfManyResults(outputDir: string): Promise<void> {
  try {
    const resultsDir = dirname(outputDir);
    if (basename(resultsDir) !== "results") return;
    const entries = await readdir(resultsDir, { withFileTypes: true });
    const count = entries.filter((entry) => entry.isDirectory()).length;
    if (count > RESULTS_WARNING_DIRS) {
      console.warn(`chorus results directory has ${count} runs at ${resultsDir}; consider archiving old result folders`);
    }
  } catch {
    // Retention warnings must not affect artifact writes.
  }
}
