import type { ChorusProgress, ChorusResult, ChorusRunConfig, ModelInfo, VoiceResult } from "../types.js";
import type { RunBudget } from "../runtime/budget.js";
import { debateStrategy, rankStrategy, refineStrategy } from "./advanced.js";

export interface StrategyContext {
    runConfig: ChorusRunConfig;
    prompt: string;
    registry: ModelInfo[];
    signal: AbortSignal;
    executeRound: (voices: ChorusRunConfig["voices"], prompt: string, roundName: string) => Promise<VoiceResult[]>;
    budget?: RunBudget;
    emit?: (updates: ChorusProgress[]) => void;
    persist?: (result: ChorusResult) => Promise<void>;
    synthesize?: (voices: VoiceResult[], prompt: string) => Promise<string>;
}

export interface StrategyResult {
    voices: VoiceResult[];
    synthesisVoices: VoiceResult[];
    rounds: Array<{ name: string; voices: VoiceResult[] }>;
    metadata?: Record<string, unknown>;
}

export interface StrategyRunner {
    id: string;
    validate?: (runConfig: ChorusRunConfig) => void;
    run: (context: StrategyContext) => Promise<StrategyResult>;
}

export class StrategyRegistry {
    private readonly runners = new Map<string, StrategyRunner>();
    register(runner: StrategyRunner): void {
        if (this.runners.has(runner.id)) throw new Error(`strategy already registered: ${runner.id}`);
        this.runners.set(runner.id, runner);
    }
    get(id: string): StrategyRunner {
        const runner = this.runners.get(id);
        if (!runner) throw new Error(`unknown chorus strategy "${id}"; migrate config or install a strategy runner`);
        return runner;
    }
}

export const defaultStrategyRegistry = new StrategyRegistry();
const parallelStrategy: StrategyRunner = {
    id: "parallel",
    async run(context) {
        const voices = context.runConfig.voices.slice(0, context.budget?.maxVoices ?? context.runConfig.voices.length);
        const results = await context.executeRound(voices, context.prompt, "answers");
        return { voices: results, synthesisVoices: results, rounds: [{ name: "answers", voices: results }], metadata: { successfulVoices: results.filter((voice) => voice.status === "success").length } };
    },
};

let builtinStrategiesRegistered = false;

export function registerBuiltinStrategies(): void {
    if (builtinStrategiesRegistered) return;
    for (const strategy of [parallelStrategy, debateStrategy, rankStrategy, refineStrategy]) {
        defaultStrategyRegistry.register(strategy);
    }
    builtinStrategiesRegistered = true;
}

export function registerStrategy(runner: StrategyRunner): void {
    registerBuiltinStrategies();
    defaultStrategyRegistry.register(runner);
}

export function getStrategyRunner(id: string): StrategyRunner {
    registerBuiltinStrategies();
    return defaultStrategyRegistry.get(id);
}
