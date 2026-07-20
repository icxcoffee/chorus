export type ChorusStrategy = "parallel" | "debate" | "rank" | "refine";
export type ChorusMode = "direct" | "subagent";
export type VoiceRole = "balanced" | "reasoning" | "breadth" | "fast" | "heterodox";
export type SubagentPermissionProfile = "read-only" | "workspace-write" | "full";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ChorusVoice {
  model: ModelRef;
  role?: VoiceRole;
}

export interface ChorusPreset {
  name: string;
  voices: ChorusVoice[];
  conductor: ModelRef;
  reviewRoleModels?: Record<string, ModelRef>;
  mode: ChorusMode;
  strategy: ChorusStrategy;
  includeSessionHistory?: boolean;
  voiceTimeoutMs?: number;
  conductorTimeoutMs?: number;
  maxConcurrency?: number;
  providerConcurrency?: Record<string, number>;
  permissionProfile?: SubagentPermissionProfile;
  budget?: import("./runtime/budget.js").RunBudget;
  cachePolicy?: import("./runtime/cache.js").CachePolicy;
}

export interface ChorusRunConfig {
  presetName: string;
  voices: ChorusVoice[];
  conductor: ModelRef;
  mode: ChorusMode;
  strategy: ChorusStrategy;
  includeSessionHistory?: boolean;
  maxConcurrency?: number;
  providerConcurrency?: Record<string, number>;
  permissionProfile?: SubagentPermissionProfile;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface VoiceResult {
  voice: ChorusVoice;
  status: "running" | "success" | "error" | "aborted";
  output?: string;
  partialOutput?: string;
  activityLog?: string;
  recoveryContext?: string;
  outputPath?: string;
  activityPath?: string;
  durationMs: number;
  usage?: TokenUsage;
  costUsd: number | null;
  startedAt: number;
  errorMessage?: string;
  permissionProfile?: SubagentPermissionProfile;
  cacheHit?: boolean;
  cacheKey?: string;
  reused?: boolean;
}

export interface ChorusArtifact {
  label: string;
  path: string;
}

export interface ChorusResult {
  runId: string;
  presetName: string;
  prompt: string;
  optimizedPrompt?: string;
  voices: VoiceResult[];
  synthesis: string | null;
  fallbackNote?: string;
  conductorUsage?: TokenUsage;
  conductorCostUsd?: number | null;
  conductorActivityLog?: string;
  totalDurationMs: number;
  totalCostUsd: number | null;
  successfulVoices: number;
  totalVoices: number;
  startedAt: number;
  finishedAt: number;
  outputDir?: string;
  artifacts?: ChorusArtifact[];
  strategy?: {
    id: ChorusStrategy;
    rounds: Array<{ name: string; voices: VoiceResult[] }>;
    rationale?: string;
  };
  budget?: {
    configured: import("./runtime/budget.js").RunBudget;
    estimate: import("./runtime/budget.js").BudgetEstimate;
    terminationReason?: string;
    actual?: { usd: number; inputTokens: number; outputTokens: number };
  };
  cache?: { enabled: boolean; hits: number; misses: number };
  quality?: {
    structured: import("./synthesis/quality.js").StructuredSynthesis;
    metrics: import("./synthesis/quality.js").QualityMetrics;
    raw: string;
  };
  runConfigSnapshot?: ChorusRunConfig;
  attempt?: { resumedFromJobId?: string; reusedVoices: number[]; rerunVoices: number[]; previousCostUsd?: number | null; cumulativeCostUsd?: number | null };
}

export type ChorusRunEvent =
  | { version: 1; type: "run.started"; runId: string; at: number; totalVoices: number }
  | { version: 1; type: "voice.transition"; runId: string; at: number; voiceIndex: number; status: string; provider: string; modelId: string }
  | { version: 1; type: "conductor.transition"; runId: string; at: number; status: string }
  | { version: 1; type: "retry" | "budget" | "persistence"; runId: string; at: number; message: string }
  | { version: 1; type: "run.finished"; runId: string; at: number; status: "success" | "error" | "aborted" };

export interface PartialVoiceProgress {
  kind?: "voice";
  voiceIndex: number;
  voice: ChorusVoice;
  status: VoiceResult["status"];
  partialOutput?: string;
  activityLog?: string;
  durationMs?: number;
  usage?: TokenUsage;
  costUsd?: number | null;
  errorMessage?: string;
}

export interface PartialConductorProgress {
  kind: "conductor";
  conductor: ModelRef;
  status: VoiceResult["status"];
  durationMs?: number;
  usage?: TokenUsage;
  costUsd?: number | null;
  errorMessage?: string;
  activityLog?: string;
  partialOutput?: string;
}

export type ChorusProgress = PartialVoiceProgress | PartialConductorProgress;

export interface ModelInfo {
  provider: string;
  id?: string;
  modelId: string;
  name?: string;
  api?: string;
  apiKind?: string;
  baseUrl?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  sourceModel?: unknown;
  costPerMTokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null;
  contextWindow?: number;
  reasoning?: boolean;
}

export interface ResolvedModel {
  ref: ModelRef;
  apiKind: string;
  endpoint: string;
  headers: Record<string, string>;
  costPerMTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  contextWindow: number;
  reasoning: boolean;
}

export interface ProviderAdapter {
  apiKind: string;
  buildRequest(args: {
    resolved: ResolvedModel;
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
    structuredOutput?: boolean;
  }): { url: string; init: RequestInit };
  parseResponse(responseJson: unknown): { output: string; usage?: TokenUsage };
  parseError(errorJson: unknown, status: number): string;
}

export interface ChorusConfigFile {
  configVersion: 2;
  activePresetName: string;
  presets: ChorusPreset[];
}

export interface LegacyChorusPresetV1 extends Omit<ChorusPreset, "strategy"> {
  strategy: "A" | "B" | "C";
  optimizeBeforeAsk: boolean;
}

export interface LegacyChorusConfigFileV1 {
  configVersion: 1;
  activePresetName: string;
  presets: LegacyChorusPresetV1[];
}

export interface RegistryLike {
  getAllModels?: () => ModelInfo[] | Promise<ModelInfo[]>;
  getAll?: () => Array<ModelInfo | PiModelLike> | Promise<Array<ModelInfo | PiModelLike>>;
  getAvailable?: () => Array<ModelInfo | PiModelLike> | Promise<Array<ModelInfo | PiModelLike>>;
  find?: (provider: string, modelId: string) => unknown;
  hasConfiguredAuth?: (model: unknown) => boolean;
  getApiKeyAndHeaders?: (model: unknown) => Promise<ResolvedRequestAuth>;
  models?: ModelInfo[];
}

export interface PiModelLike {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  reasoning?: boolean;
}

export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };
