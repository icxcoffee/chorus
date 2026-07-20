import type { ModelInfo, ModelRef, VoiceResult } from "../types.js";
import { packEvidence, type EvidencePack } from "./evidence.js";

export interface SynthesisInput {
    originalPrompt: string;
    effectivePrompt: string;
    evidence: EvidencePack;
    omissions: string;
}

export function successfulSynthesisVoices(voices: VoiceResult[], failureMessage: string): Array<VoiceResult & { output: string }> {
    const successful = voices.filter((voice): voice is VoiceResult & { output: string } => voice.status === "success" && Boolean(voice.output));
    if (successful.length < 2) throw new Error(failureMessage);
    return successful;
}

export function prepareSynthesisInput(args: {
    prompt: string;
    optimizedPrompt?: string;
    voices: VoiceResult[];
    registry?: ModelInfo[];
    conductor?: ModelRef;
}): SynthesisInput {
    const evidence = packEvidence(args);
    return {
        originalPrompt: args.prompt,
        effectivePrompt: args.optimizedPrompt ?? args.prompt,
        evidence,
        omissions: evidence.omissions.length === 0
            ? "none"
            : evidence.omissions.map((item) => `${item.id} (${item.omittedChars} chars)`).join(", "),
    };
}
