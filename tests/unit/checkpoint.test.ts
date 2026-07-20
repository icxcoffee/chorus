import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCheckpoint, planResume } from "../../src/runtime/checkpoint.js";
import { ChorusJobStore } from "../../src/jobs.js";
import { preset, voiceResult } from "./fixtures.js";

describe("job checkpoints", () => {
    it("reuses committed successful voice artifacts and reruns incomplete work", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-checkpoint-"));
        const output = join(dir, "voice-0.md");
        await writeFile(output, "answer");
        const store = new ChorusJobStore();
        const job = store.create({ kind: "ask", title: "q", presetName: "default", prompt: "p", command: "/chorus ask p", voices: preset.voices });
        job.voices[0]!.status = "success";
        job.voices[0]!.outputPath = output;
        job.result = { runId: "r", presetName: "default", prompt: "p", voices: [voiceResult(0), voiceResult(1, "error")], synthesis: null, totalDurationMs: 1, totalCostUsd: null, successfulVoices: 1, totalVoices: 2, startedAt: 1, finishedAt: 2 };
        const checkpoint = await createCheckpoint(job);
        const plan = await planResume(checkpoint, job);
        expect(plan.reusedVoices).toEqual([0]);
        expect(plan.rerunVoices).toEqual([1]);
        expect(plan.rerunConductor).toBe(true);
    });
    it("rejects a reused artifact whose hash changed", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-checkpoint-hash-"));
        const output = join(dir, "voice-0.md");
        await writeFile(output, "original");
        const store = new ChorusJobStore();
        const job = store.create({ kind: "ask", title: "q", presetName: "default", prompt: "p", command: "/chorus ask p", voices: preset.voices });
        job.voices[0]!.status = "success"; job.voices[0]!.outputPath = output;
        job.result = { runId: "r", presetName: "default", prompt: "p", voices: [{ ...voiceResult(0), outputPath: output }, voiceResult(1, "error")], synthesis: null, totalDurationMs: 1, totalCostUsd: 0.1, successfulVoices: 1, totalVoices: 2, startedAt: 1, finishedAt: 2, artifacts: [{ label: "voice-0", path: output }] };
        const checkpoint = await createCheckpoint(job);
        await writeFile(output, "tampered");
        const plan = await planResume(checkpoint, job);
        expect(plan.reusedVoices).toEqual([]);
        expect(plan.warnings).toContain("voice 0 artifact hash mismatch");
    });
});
