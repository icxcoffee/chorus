import type { ChorusResult, TokenUsage, VoiceResult } from "../types.js";
import { fallbackAnswer } from "../utils/fallback.js";
import { modelRefToPiArg } from "../utils/models.js";

export interface RenderedChorusResult {
  collapsed: string;
  expanded: string;
  finalAnswer: string;
}

export interface RenderResultOptions {
  title?: string;
  summaryLabel?: string;
  actorLabel?: string;
  actorPlural?: string;
  outputsTitle?: string;
}

export function renderResult(result: ChorusResult, options: RenderResultOptions = {}): RenderedChorusResult {
  const collapsed = renderCollapsed(result, options);
  const expanded = renderExpanded(result, options);
  return { collapsed, expanded, finalAnswer: result.synthesis ?? fallbackAnswer(result) };
}

export function renderCollapsed(result: ChorusResult, options: RenderResultOptions = {}): string {
  const actorPlural = options.actorPlural ?? "voices";
  const status =
    result.successfulVoices < 2
      ? `${result.successfulVoices} responded · skipped synthesis`
      : `${result.totalVoices} ${actorPlural}`;
  const lines = [
    `Chorus · ${result.presetName} · ${status} · ${formatDuration(result.totalDurationMs)} · ${formatCost(result.totalCostUsd)}`
  ];
  for (const [index, voice] of result.voices.entries()) {
    lines.push(`  ${voiceLine(index, voice, options.actorLabel ?? "voice")}`);
  }
  if (result.conductorCostUsd !== undefined) {
    lines.push(`  Conductor · ${formatCost(result.conductorCostUsd)}${result.conductorUsage ? ` · ${formatUsage(result.conductorUsage)}` : ""}`);
  }
  if (result.fallbackNote) lines.push(`  ${result.fallbackNote}`);
  const preview = (result.synthesis ?? fallbackAnswer(result)).split(/\r?\n/).slice(0, 3).join("\n  ");
  if (preview) lines.push(`\n  ${preview}`);
  return lines.join("\n");
}

export function renderExpanded(result: ChorusResult, options: RenderResultOptions = {}): string {
  const title = options.title ?? "Chorus Result";
  const summaryLabel = options.summaryLabel ?? "Voices";
  const actorLabel = options.actorLabel ?? "voice";
  const outputsTitle = options.outputsTitle ?? "Voice Outputs";
  const lines = [
    `# ${title}`,
    "",
    `Preset: \`${result.presetName}\` | ${summaryLabel}: \`${result.successfulVoices}/${result.totalVoices}\` | Duration: \`${formatDuration(result.totalDurationMs)}\` | Cost: \`${formatCost(result.totalCostUsd)}\``,
    ...(result.outputDir ? ["", "## Result Files", `Directory: ${result.outputDir}`, ...artifactLines(result)] : []),
    "",
    "## Final Answer",
    result.synthesis ?? fallbackAnswer(result),
    "",
    "## Run Summary"
  ];
  for (const [index, voice] of result.voices.entries()) {
    lines.push(`- ${voiceSummary(index, voice, actorLabel)}`);
  }
  if (result.conductorUsage || result.conductorCostUsd !== undefined) {
    lines.push(`- OK conductor | cost ${formatCost(result.conductorCostUsd ?? null)}${result.conductorUsage ? ` | ${formatUsage(result.conductorUsage)}` : ""}`);
  }
  if (result.conductorActivityLog) lines.push("- OK main-agent verification activity captured");
  if (result.fallbackNote) lines.push(`- Note: ${result.fallbackNote}`);
  lines.push("", `## ${outputsTitle}`);
  for (const [index, voice] of result.voices.entries()) {
    lines.push(`\n### ${actorLabel}[${index}] ${modelRefToPiArg(voice.voice.model)}`);
    lines.push(`Status: ${voice.status} | Duration: ${formatDuration(voice.durationMs)} | Cost: ${formatCost(voice.costUsd)}`);
    if (voice.usage) lines.push(`Usage: ${formatUsage(voice.usage)}`);
    if (voice.errorMessage) lines.push(`Error: ${voice.errorMessage}`);
    if (voice.outputPath) lines.push(`Output file: ${voice.outputPath}`);
    if (voice.activityPath) lines.push(`Activity file: ${voice.activityPath}`);
    const output = voice.output ?? voice.partialOutput;
    if (output) lines.push(output);
  }
  return lines.join("\n");
}

export function renderCall(result: ChorusResult): string {
  return renderResult(result).finalAnswer;
}

export function formatCost(cost: number | null): string {
  if (cost == null) return "?";
  return `$${cost.toFixed(3)}`;
}

function voiceLine(index: number, voice: VoiceResult, actorLabel: string): string {
  const marker = voice.status === "success" ? "ok" : voice.status === "aborted" ? "aborted" : "error";
  const usage = voice.usage ? ` · ${formatUsage(voice.usage)}` : "";
  const error = voice.errorMessage ? ` · ${voice.errorMessage}` : "";
  return `${marker} ${actorLabel}[${index}] ${modelRefToPiArg(voice.voice.model)} · ${formatDuration(voice.durationMs)} · ${formatCost(voice.costUsd)}${usage}${error}`;
}

function voiceSummary(index: number, voice: VoiceResult, actorLabel: string): string {
  const marker = voice.status === "success" ? "OK" : voice.status === "aborted" ? "ABORTED" : "ERROR";
  const usage = voice.usage ? ` | ${formatUsage(voice.usage)}` : "";
  const error = voice.errorMessage ? ` | ${voice.errorMessage}` : "";
  return `${marker} ${actorLabel}[${index}] \`${modelRefToPiArg(voice.voice.model)}\` | ${formatDuration(voice.durationMs)} | ${formatCost(voice.costUsd)}${usage}${error}`;
}

function artifactLines(result: ChorusResult): string[] {
  if (!result.artifacts?.length) return [];
  return result.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`);
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUsage(usage: TokenUsage): string {
  return `up ${usage.input} down ${usage.output}`;
}
