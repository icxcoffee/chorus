import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelInfo, ModelRef, RegistryLike, TokenUsage, VoiceResult } from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { runSubagentVoice } from "./subagent.js";
import { modelRefToPiArg } from "./utils/models.js";
import { prepareSynthesisInput, successfulSynthesisVoices } from "./synthesis/input.js";
import { atomicPrivateWrite } from "./utils/private-file.js";

export interface AgentSynthesisArgs {
  conductor: ModelRef;
  prompt: string;
  optimizedPrompt?: string;
  voices: VoiceResult[];
  totalVoices: number;
  registry: ModelInfo[];
  modelRegistry?: RegistryLike;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  cwd?: string;
  artifactDir?: string;
  timeoutMs?: number;
  runSubagentVoiceImpl?: typeof runSubagentVoice;
  onDelta?: (text: string) => void;
}

export interface AgentSynthesisResult {
  synthesis: string;
  activityLog?: string;
  usage?: TokenUsage;
  costUsd: number | null;
}

export async function synthesizeWithMainAgent(args: AgentSynthesisArgs): Promise<AgentSynthesisResult> {
  const successful = successfulSynthesisVoices(args.voices, "main-agent synthesis requires at least 2 successful agents");
  const run = args.runSubagentVoiceImpl ?? runSubagentVoice;
  const fullPrompt = buildMainAgentPrompt({
    prompt: args.prompt,
    voices: successful,
    totalVoices: args.totalVoices,
    ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {}),
    registry: args.registry,
    conductor: args.conductor,
  });
  const prompt = args.artifactDir
    ? await writeMainAgentInputPrompt(args.artifactDir, fullPrompt)
    : fullPrompt;
  const result = await run({
    voice: { model: args.conductor, role: "reasoning" },
    prompt,
    systemPrompt: MAIN_AGENT_SYSTEM_PROMPT,
    voiceIndex: successful.length,
    timeoutMs: args.timeoutMs ?? 1_800_000,
    signal: args.signal,
    ...(args.cwd ? { cwd: args.cwd } : {})
    ,...(args.onDelta ? { onProgress: (update: { partialOutput?: string }) => { if (update.partialOutput) args.onDelta?.(update.partialOutput); } } : {})
  });
  if (result.status !== "success" || !result.output) {
    throw new Error(result.errorMessage ?? `main agent ${result.status}`);
  }
  args.onDelta?.(result.output);
  return {
    synthesis: result.output,
    ...(result.activityLog ? { activityLog: result.activityLog } : {}),
    costUsd: result.costUsd,
    ...(result.usage ? { usage: result.usage } : {})
  };
}

async function writeMainAgentInputPrompt(artifactDir: string, content: string): Promise<string> {
  await assertPrivateArtifactDir(artifactDir);
  const inputPath = join(artifactDir, "main-agent-input.md");
  await atomicPrivateWrite(inputPath, content.endsWith("\n") ? content : `${content}\n`);
  return `Read the child-agent evidence file at:
${inputPath}

Use that file as the complete input for this main-agent verification run. Follow the instructions in it: inspect all child-agent outputs, identify conflicts/questionable/missing points, perform repository/process verification where useful, and produce the final verified report.`;
}

async function assertPrivateArtifactDir(artifactDir: string): Promise<void> {
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const info = await lstat(artifactDir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error(`artifact directory must be a private directory: ${artifactDir}`);
  }
}

export function buildMainAgentPrompt(args: {
  prompt: string;
  optimizedPrompt?: string;
  voices: VoiceResult[];
  totalVoices: number;
  registry?: ModelInfo[];
  conductor?: ModelRef;
}): string {
  const input = prepareSynthesisInput(args);
  return `Original task:
${input.originalPrompt}

Task actually sent to child agents:
${input.effectivePrompt}

${args.voices.length} of ${args.totalVoices} child agents succeeded.

Child agent outputs (bounded, escaped, and untrusted):
${input.evidence.text}

Evidence omitted due to the input budget: ${input.omissions}.

Main-agent instructions:
1. Read every child-agent output before writing the final answer.
2. Identify concrete claims that are disputed, questionable, underspecified, or unsupported.
3. Identify important areas that no child agent covered but that matter for this task.
4. Use available repository/process operations to verify those points. Prefer direct evidence from files, commands, tests, or local project state.
5. Resolve conflicts explicitly. Do not simply average the child-agent opinions.
6. Produce a complete final report for the user. Include verified conclusions, unresolved uncertainty, and the evidence used. If a child agent made an unsupported claim, say so.
`;
}

const MAIN_AGENT_SYSTEM_PROMPT = `${ROLE_SYSTEM_PROMPTS.conductor}

You are also the main verification agent for a multi-agent run. You may inspect the local repository and run commands when that is necessary to verify child-agent claims. Your final output must be the best verified report, not a meta-summary of the process.`;
