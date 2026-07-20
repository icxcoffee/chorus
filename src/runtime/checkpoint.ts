import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ChorusJob } from "../jobs.js";

export interface ChorusCheckpoint { version: 1; jobId: string; runId?: string; createdAt: number; completedVoices: number[]; artifactHashes: Record<string, string>; }
export interface ResumePlan { reusedVoices: number[]; rerunVoices: number[]; rerunConductor: boolean; warnings: string[]; }

export async function createCheckpoint(job: ChorusJob): Promise<ChorusCheckpoint> {
    const artifactHashes: Record<string, string> = {};
    for (const artifact of job.result?.artifacts ?? []) {
        try { artifactHashes[artifact.path] = createHash("sha256").update(await readFile(artifact.path)).digest("hex"); } catch { /* missing artifacts are reported during validation */ }
    }
    return { version: 1, jobId: job.id, ...(job.result?.runId ? { runId: job.result.runId } : {}), createdAt: Date.now(), completedVoices: job.voices.filter((voice) => voice.status === "success").map((voice) => voice.index), artifactHashes };
}

export async function planResume(checkpoint: ChorusCheckpoint, job: ChorusJob): Promise<ResumePlan> {
    const warnings: string[] = [];
    const reusedVoices: number[] = [];
    for (const index of checkpoint.completedVoices) {
        const voice = job.voices[index];
        if (!voice || voice.status !== "success") continue;
        const path = voice.outputPath;
        if (!path) { warnings.push(`voice ${index} has no committed artifact`); continue; }
        try {
            await stat(path);
            const expected = checkpoint.artifactHashes[path];
            if (expected) {
                const actual = createHash("sha256").update(await readFile(path)).digest("hex");
                if (actual !== expected) { warnings.push(`voice ${index} artifact hash mismatch`); continue; }
            }
            reusedVoices.push(index);
        } catch { warnings.push(`voice ${index} artifact is missing`); }
    }
    const rerunVoices = job.voices.map((voice) => voice.index).filter((index) => !reusedVoices.includes(index));
    return { reusedVoices, rerunVoices, rerunConductor: reusedVoices.length < job.voices.length || !job.result?.synthesis, warnings };
}

export async function reusableVoiceResults(checkpoint: ChorusCheckpoint, job: ChorusJob): Promise<{ plan: ResumePlan; results: Map<number, NonNullable<ChorusJob["result"]>["voices"][number]> }> {
    const plan = await planResume(checkpoint, job);
    const results = new Map<number, NonNullable<ChorusJob["result"]>["voices"][number]>();
    for (const index of plan.reusedVoices) {
        const result = job.result?.voices[index];
        if (result?.status === "success") results.set(index, result);
    }
    return { plan, results };
}
