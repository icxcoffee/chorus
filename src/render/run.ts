import type { OptimizeResult } from "../optimize.js";
import { modelRefToPiArg } from "../utils/models.js";

export function renderRunStarted(args: {
  jobId?: string;
  kind: "ask" | "agent";
  title: string;
  presetName: string;
  prompt: string;
  optimizedPrompt?: string;
  outputDir?: string;
}): string {
  const command = args.kind === "agent" ? "/chorus agent" : "/chorus ask";
  const lines = [
    `# ${args.title}`,
    "",
    `Preset: \`${args.presetName}\` | Status: \`running\``,
    ...(args.jobId ? ["", `Job: \`${args.jobId}\``] : []),
    "",
    "## Request",
    args.prompt,
    "",
    "## Command",
    `${command} ${args.prompt}`
  ];
  if (args.jobId) {
    lines.push("", "## Watch", `/chorus watch ${args.jobId}`);
  }
  if (args.outputDir) {
    lines.push("", "## Result Files", args.outputDir);
  }
  if (args.optimizedPrompt) {
    lines.push("", "## Optimized Prompt", args.optimizedPrompt);
  }
  return lines.join("\n");
}

export function renderPromptOptimization(result: OptimizeResult, source = "Chorus Optimize"): string {
  const lines = [
    "# Chorus Prompt Optimization",
    "",
    `Source: \`${source}\``,
    ...(result.model ? [`Model: \`${modelRefToPiArg(result.model)}\``] : []),
    ...(result.errorMessage ? [`Status: \`warning\``, `Note: ${result.errorMessage}`] : [`Status: \`optimized\``]),
    "",
    "## Original Prompt",
    result.original,
    "",
    "## Optimized Prompt",
    result.optimized
  ];
  return lines.join("\n");
}
