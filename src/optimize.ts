import type { ModelInfo, ModelRef, RegistryLike } from "./types.js";
import { ROLE_SYSTEM_PROMPTS } from "./role-prompts.js";
import { callDirectModel } from "./direct-api.js";
import { parseModelRef, resolveModel } from "./utils/models.js";

export const OPTIMIZER_CANDIDATES = [
  "minimax/MiniMax-M3",
  "deepseek/deepseek-v4-pro",
  "custom-ark-cn-beijing-volces-com/glm-5.2",
  "deepseek/deepseek-v4-flash"
];

export interface OptimizeResult {
  original: string;
  optimized: string;
  model?: ModelRef;
  errorMessage?: string;
}

export async function optimizePrompt(args: {
  prompt: string;
  registry: ModelInfo[];
  model?: ModelRef;
  modelRegistry?: RegistryLike;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  callModel?: (args: { model: ModelRef; prompt: string; systemPrompt: string; signal: AbortSignal }) => Promise<{ output: string }>;
}): Promise<OptimizeResult> {
  const model = selectOptimizerModel(args.registry, args.model);
  if (!model) {
    return {
      original: args.prompt,
      optimized: args.prompt,
      errorMessage: "chorus: no optimizer model available in your registry"
    };
  }
  const metaPrompt = `You are a prompt engineer. Rewrite the user's prompt so it is:
- Clear about goal and audience
- Surfaces implicit constraints (format, length, perspective)
- Preserves the user's intent
- Does not introduce new requirements
- Does not add file paths, project names, frameworks, technologies, counts, or constraints that are not present in the user's prompt
- If the user says "current project" or "current directory", keep that wording; never replace it with a guessed filesystem path

Return ONLY the rewritten prompt. No preamble, no commentary.

User prompt:
${args.prompt}`;
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
  const result = await call({ model, prompt: metaPrompt, systemPrompt: ROLE_SYSTEM_PROMPTS.optimizer, signal: args.signal });
  const optimized = result.output.trim();
  const introducedPath = firstIntroducedAbsolutePath(args.prompt, optimized);
  if (introducedPath) {
    return {
      original: args.prompt,
      optimized: args.prompt,
      model,
      errorMessage: `chorus: optimizer introduced path "${introducedPath}"; keeping original prompt`
    };
  }
  return { original: args.prompt, optimized, model };
}

export function selectOptimizerModel(registry: ModelInfo[], preferred?: ModelRef): ModelRef | null {
  if (preferred) {
    try {
      resolveModel(preferred, registry);
      return preferred;
    } catch {
      // Fall back to the built-in candidate list if the preferred model is unavailable.
    }
  }
  for (const candidate of OPTIMIZER_CANDIDATES) {
    const ref = parseModelRef(candidate);
    try {
      resolveModel(ref, registry);
      return ref;
    } catch {
      // Try the next configured candidate.
    }
  }
  return null;
}

function firstIntroducedAbsolutePath(original: string, optimized: string): string | null {
  const originalPaths = new Set(findAbsolutePaths(original).map(normalizePathToken));
  for (const path of findAbsolutePaths(optimized)) {
    if (!originalPaths.has(normalizePathToken(path))) return path;
  }
  return null;
}

function findAbsolutePaths(text: string): string[] {
  const paths: string[] = [];
  const pattern = /\b[A-Za-z]:[\\/][^\s`"'<>|]+|(?<![\w])~[\\/][^\s`"'<>|]+|(?<![\w])\/(?:[^\s`"'<>|/]+\/)+[^\s`"'<>|]+/g;
  for (const match of text.matchAll(pattern)) {
    paths.push(trimPathToken(match[0]));
  }
  return paths.filter(Boolean);
}

function trimPathToken(path: string): string {
  return path.replace(/[),.;，。；）]+$/u, "");
}

function normalizePathToken(path: string): string {
  return trimPathToken(path).replace(/\\/g, "/").toLowerCase();
}
