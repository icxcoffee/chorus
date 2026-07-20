import type { ChorusConfigFile, ModelInfo } from "../types.js";
import { runChorus, type RunChorusArgs } from "../chorus.js";
import { renderResult } from "./result.js";
import { findPreset } from "./ask.js";
import { modelRefToPiArg } from "../utils/models.js";
import { runOptionsFromPreset } from "../runtime/preset.js";

export interface AgentUiResult {
  text: string;
  result: Awaited<ReturnType<typeof runChorus>>;
}

export async function runAgentUi(args: {
  task: string;
  config: ChorusConfigFile;
  registry: ModelInfo[];
  signal: AbortSignal;
  presetName?: string;
  optimizedPrompt?: string;
  runChorusImpl?: typeof runChorus;
  onStatus?: (message: string) => void;
  onProgress?: RunChorusArgs["onProgress"];
} & Pick<RunChorusArgs, "fetchImpl" | "modelRegistry" | "storePaths" | "appendHistory" | "voiceTimeoutMs" | "conductorTimeoutMs" | "cwd" | "artifactDir">): Promise<AgentUiResult> {
  const preset = findPreset(args.config, args.presetName ?? args.config.activePresetName);
  const result = await (args.runChorusImpl ?? runChorus)({
    ...runOptionsFromPreset(preset, {
      mode: "subagent",
      synthesisMode: "agent",
      ...(args.voiceTimeoutMs !== undefined ? { voiceTimeoutMs: args.voiceTimeoutMs } : {}),
      ...(args.conductorTimeoutMs !== undefined ? { conductorTimeoutMs: args.conductorTimeoutMs } : {})
    }),
    prompt: args.task,
    registry: args.registry,
    signal: args.signal,
    ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
    ...(args.storePaths ? { storePaths: args.storePaths } : {}),
    ...(args.appendHistory ? { appendHistory: args.appendHistory } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.artifactDir ? { artifactDir: args.artifactDir } : {}),
    onProgress: (updates) => {
      args.onProgress?.(updates);
      for (const update of updates) {
        if (update.kind === "conductor") {
          args.onStatus?.(`conductor ${modelRefToPiArg(update.conductor)} ${update.status}`);
        } else {
          args.onStatus?.(`agent[${update.voiceIndex}] ${modelRefToPiArg(update.voice.model)} ${update.status}`);
        }
      }
    }
  });
    return {
      result,
      text: renderAgentResultForUi(result)
    };
}

function renderAgentResultForUi(result: AgentUiResult["result"]): string {
  const rendered = renderResult(result, {
    title: "Chorus Agent Result",
    summaryLabel: "Agents",
    actorLabel: "agent",
    actorPlural: "agents",
    outputsTitle: "Agent Outputs"
  }).expanded;
  if (!result.outputDir || rendered.length <= 24_000) return rendered;
  const finalReport = result.artifacts?.find((artifact) => artifact.label === "final-report")?.path;
  const preview = (result.synthesis ?? result.fallbackNote ?? "").slice(0, 8_000);
  return [
    "# Chorus Agent Result",
    "",
    `Preset: \`${result.presetName}\` | Agents: \`${result.successfulVoices}/${result.totalVoices}\``,
    "",
    "## Result Files",
    `Directory: ${result.outputDir}`,
    ...(finalReport ? [`Final report: ${finalReport}`] : []),
    "",
    "## Preview",
    preview,
    "",
    "Full report and child-agent outputs were written to the result files above."
  ].join("\n");
  }
