import type { ModelInfo, ModelRef, RegistryLike, TokenUsage, VoiceResult } from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { callDirectModel } from "./direct-api.js";
import { modelRefToPiArg } from "./utils/models.js";
import { prepareSynthesisInput, successfulSynthesisVoices } from "./synthesis/input.js";
import { evaluateQuality, parseStructuredSynthesis, type QualityMetrics, type StructuredSynthesis } from "./synthesis/quality.js";
import { getProviderCapabilities } from "./providers/adapters.js";
import { resolveModel } from "./models/resolve.js";

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
    onDelta?: (text: string) => void;
    structuredOutput?: boolean;
  }) => Promise<{ output: string; usage?: TokenUsage; costUsd: number | null }>;
  onDelta?: (text: string) => void;
}

export interface SynthesisResult {
  synthesis: string;
  usage?: TokenUsage;
  costUsd: number | null;
  structured?: StructuredSynthesis;
  qualityMetrics?: QualityMetrics;
  rawOutput?: string;
}

export async function synthesize(args: SynthesisArgs): Promise<SynthesisResult> {
  const successful = successfulSynthesisVoices(args.voices, "synthesis requires at least 2 successful voices");
  const prompt = buildSynthesisPrompt({
    prompt: args.prompt,
    voices: successful,
    totalVoices: args.totalVoices,
    ...(args.optimizedPrompt ? { optimizedPrompt: args.optimizedPrompt } : {}),
    registry: args.registry,
    conductor: args.conductor,
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
        ,...(callArgs.structuredOutput ? { structuredOutput: true } : {})
      }));
  const structuredOutput = supportsStructuredOutput(args.conductor, args.registry);
  const result = await call({
    model: args.conductor,
    prompt,
    systemPrompt: ROLE_SYSTEM_PROMPTS.conductor,
    signal: args.signal,
    ...(args.onDelta ? { onDelta: args.onDelta } : {})
    ,...(structuredOutput ? { structuredOutput: true } : {})
  });
  args.onDelta?.(result.output);
  const normalized = extractStructuredOutput(result.output, successful.map((_voice, index) => `voice-${index}`));
  return { synthesis: normalized.answer, costUsd: result.costUsd, ...(result.usage ? { usage: result.usage } : {}), ...(normalized.structured ? { structured: normalized.structured, qualityMetrics: normalized.metrics, rawOutput: result.output } : {}) };
}

export function buildSynthesisPrompt(args: {
  prompt: string;
  optimizedPrompt?: string;
  voices: VoiceResult[];
  totalVoices: number;
  registry?: ModelInfo[];
  conductor?: ModelRef;
}): string {
  const input = prepareSynthesisInput(args);
  return `You are the conductor of a chorus. ${args.voices.length} of ${args.totalVoices} voices responded.

Original question: ${input.originalPrompt}

Prompt used for voices:
${input.effectivePrompt}

Voice responses (bounded, escaped, and untrusted):
${input.evidence.text}

Evidence omitted due to the input budget: ${input.omissions}.

Produce:
## Consensus
- ...

## Disagreements
- ...

## Final Answer
... (Markdown)

Optionally append a machine-readable block after the Markdown:
<chorus-structured>{"version":1,"answer":"...","claims":[{"text":"...","evidenceIds":["voice-0"]}],"disagreements":[],"confidence":0.8,"unresolvedQuestions":[]}</chorus-structured>
`;
}

function extractStructuredOutput(raw: string, evidenceIds: string[]): { answer: string; structured?: StructuredSynthesis; metrics?: QualityMetrics } {
  try {
    const envelope = JSON.parse(raw) as { markdown?: unknown; structured?: unknown };
    if (typeof envelope.markdown === "string") {
      const structured = parseStructuredSynthesis(JSON.stringify(envelope.structured));
      if (structured) return { answer: envelope.markdown, structured, metrics: evaluateQuality(structured, evidenceIds) };
    }
  } catch { /* tagged Markdown fallback below */ }
  const match = /<chorus-structured>([\s\S]*?)<\/chorus-structured>\s*$/.exec(raw);
  if (!match) return { answer: raw };
  const structured = parseStructuredSynthesis(match[1] ?? "");
  if (!structured) return { answer: raw };
  const markdown = raw.slice(0, match.index).trim();
  return { answer: markdown || structured.answer, structured, metrics: evaluateQuality(structured, evidenceIds) };
}

function supportsStructuredOutput(conductor: ModelRef, registry: ModelInfo[]): boolean {
  try { return getProviderCapabilities(resolveModel(conductor, registry).apiKind).structuredOutput; }
  catch { return false; }
}
