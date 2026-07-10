import type { ModelInfo, ModelRef, RegistryLike, TokenUsage, VoiceResult } from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { callDirectModel } from "./direct-api.js";
import { modelRefToPiArg } from "./utils/models.js";

export interface SynthesisArgs {
  conductor: ModelRef;
  prompt: string;
  optimizedPrompt?: string;
  voices: VoiceResult[];
  totalVoices: number;
  registry: ModelInfo[];
  modelRegistry?: RegistryLike;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  callModel?: (args: {
    model: ModelRef;
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
  }) => Promise<{ output: string; usage?: TokenUsage; costUsd: number | null }>;
}

export interface SynthesisResult {
  synthesis: string;
  usage?: TokenUsage;
  costUsd: number | null;
}

export async function synthesize(args: SynthesisArgs): Promise<SynthesisResult> {
  const successful = args.voices.filter((voice) => voice.status === "success" && voice.output);
  if (successful.length < 2) throw new Error("synthesis requires at least 2 successful voices");
  const prompt = buildSynthesisPrompt({
    prompt: args.prompt,
    voices: successful,
    totalVoices: args.totalVoices,
    ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {})
  });
  const call =
    args.callModel ??
    ((callArgs) =>
      callDirectModel({
        model: callArgs.model,
        prompt: callArgs.prompt,
        systemPrompt: callArgs.systemPrompt,
        registry: args.registry,
        ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
        signal: callArgs.signal,
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {})
      }));
  const result = await call({
    model: args.conductor,
    prompt,
    systemPrompt: ROLE_SYSTEM_PROMPTS.conductor,
    signal: args.signal
  });
  return { synthesis: result.output, costUsd: result.costUsd, ...(result.usage ? { usage: result.usage } : {}) };
}

export function buildSynthesisPrompt(args: {
  prompt: string;
  optimizedPrompt?: string;
  voices: VoiceResult[];
  totalVoices: number;
}): string {
  const voiceBlocks = args.voices
    .map((voice) => {
      const output = voice.output ?? voice.partialOutput ?? "";
      return `---\n${modelRefToPiArg(voice.voice.model)}:\n${output}\n---`;
    })
    .join("\n\n");
  return `You are the conductor of a chorus. ${args.voices.length} of ${args.totalVoices} voices responded.

Original question: ${args.prompt}

Prompt used for voices:
${args.optimizedPrompt ?? args.prompt}

Voice responses:
${voiceBlocks}

Produce:
## Consensus
- ...

## Disagreements
- ...

## Final Answer
... (Markdown)
`;
}
