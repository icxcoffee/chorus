import type { ChorusProgress, ChorusResult, ChorusVoice, VoiceResult } from "../types.js";

export type VoiceExecutor = (args: {
    voice: ChorusVoice;
    voiceIndex: number;
}) => Promise<VoiceResult>;

export interface VoiceExecutionResult {
    voices: VoiceResult[];
    successfulVoices: number;
}

export type SynthesisExecutor = (args: {
    voices: VoiceResult[];
    prompt: string;
    signal: AbortSignal;
}) => Promise<{
    synthesis: string;
    costUsd: number | null;
}>;

export type ChorusEventSink = (updates: ChorusProgress[]) => void;

export type ChorusResultPersister = (result: ChorusResult) => Promise<void>;
