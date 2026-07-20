import type { ChorusJob } from "../jobs.js";
import { firstLine, formatElapsed } from "../utils/format.js";

export function renderJobs(jobs: ChorusJob[]): string {
  if (jobs.length === 0) return "No chorus jobs.";
  const lines = ["chorus jobs", ""];
  for (const job of jobs) {
    const done = job.voices.filter((voice) => voice.status === "success").length;
    const active = job.voices.filter((voice) => voice.status === "running").length;
    const elapsed = formatElapsed((job.finishedAt ?? Date.now()) - job.startedAt);
    lines.push(`${job.id}  ${job.kind}  ${job.status}  ${done}/${job.voices.length} ok  ${active} running  ${elapsed}`);
    lines.push(`  ${job.prompt}`);
    lines.push(`  /chorus watch ${job.id}`);
  }
  return lines.join("\n");
}

export function renderJob(job: ChorusJob): string {
  const lines = [
    `chorus job ${job.id}`,
    "",
    `Kind: ${job.kind}`,
    `Preset: ${job.presetName}`,
    `Status: ${job.status}`,
    `Elapsed: ${formatElapsed((job.finishedAt ?? Date.now()) - job.startedAt)}`,
    "",
    "Request",
    job.prompt,
    "",
    ...(job.result?.outputDir ? ["Result Files", job.result.outputDir, ""] : []),
    ...(job.reviewArtifacts?.length ? ["Review Artifacts", ...job.reviewArtifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`), ""] : []),
    "Agents"
  ];
  for (const voice of job.voices) {
    const output = voice.output ?? voice.partialOutput ?? voice.errorMessage ?? "";
    const suffix = output ? ` - ${firstLine(output, 100)}` : "";
    lines.push(`- ${voice.label}: ${voice.status}${suffix}`);
    if (voice.outputPath) lines.push(`  output: ${voice.outputPath}`);
    if (voice.activityPath) lines.push(`  activity: ${voice.activityPath}`);
  }
  lines.push("", `Watch: /chorus watch ${job.id}`);
  if (job.status === "stale") lines.push("This job was running before reload and cannot be reattached.");
  if (job.status === "running") lines.push(`Cancel: /chorus cancel ${job.id}`);
  return lines.join("\n");
}

export function renderReviewWidget(job: ChorusJob): string[] {
  return [
    `${job.title} · ${job.id}`,
    `Stage: ${job.reviewStage ? `${job.reviewStage.id} (${job.reviewStage.status})` : "starting"}`,
    ...job.voices.map((voice) => `${voice.status === "running" ? ">" : "-"} ${voice.label}: ${voice.status}${voice.errorMessage ? ` · ${firstLine(voice.errorMessage, 80)}` : ""}`),
  ];
}
