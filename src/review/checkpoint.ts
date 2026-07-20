import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReviewStageId } from "./contracts.js";
import type { ReviewArtifact } from "./artifacts.js";
import type { ReviewWorkflowResult } from "../workflows/contracts.js";

export interface ReviewCheckpoint {
    version: 1;
    reviewId: string;
    workflowId: string;
    workflowVersion: number;
    createdAt: number;
    completedStages: ReviewStageId[];
    artifactHashes: Record<string, string>;
    sourceHashes: Record<string, string>;
}

export interface ReviewResumePlan {
    reusableStages: ReviewStageId[];
    rerunStages: ReviewStageId[];
    warnings: string[];
}

export async function createReviewCheckpoint(result: ReviewWorkflowResult, artifacts: ReviewArtifact[]): Promise<ReviewCheckpoint> {
    const artifactHashes: Record<string, string> = {};
    for (const artifact of artifacts) {
        try { artifactHashes[artifact.path] = hash(await readFile(artifact.path)); } catch { /* validation reports missing artifacts */ }
    }
    const sourceHashes: Record<string, string> = {};
    for (const finding of result.report.findings) {
        for (const evidence of finding.evidence) {
            if (evidence.kind === "log" || evidence.verification !== "verified") continue;
            const path = resolve(result.plan.scope.workspaceRoot, evidence.path);
            if (sourceHashes[path]) continue;
            try { sourceHashes[path] = hash(await readFile(path)); } catch { /* validation reports missing sources */ }
        }
    }
    return {
        version: 1,
        reviewId: result.report.reviewId,
        workflowId: result.plan.workflowId,
        workflowVersion: result.plan.workflowVersion,
        createdAt: Date.now(),
        completedStages: result.stages.filter((stage) => stage.status === "success" || stage.status === "partial").map((stage) => stage.stage),
        artifactHashes,
        sourceHashes,
    };
}

export async function planReviewResume(checkpoint: ReviewCheckpoint, result: ReviewWorkflowResult, artifacts: ReviewArtifact[]): Promise<ReviewResumePlan> {
    const warnings: string[] = [];
    if (checkpoint.version !== 1) warnings.push(`unsupported review checkpoint version ${String(checkpoint.version)}`);
    if (checkpoint.workflowId !== result.plan.workflowId || checkpoint.workflowVersion !== result.plan.workflowVersion) warnings.push("review workflow ID or version changed");
    const knownArtifacts = new Set(artifacts.map((artifact) => artifact.path));
    for (const [path, expected] of Object.entries(checkpoint.artifactHashes)) {
        if (!knownArtifacts.has(path)) { warnings.push(`checkpoint artifact is no longer registered: ${path}`); continue; }
        try { if (hash(await readFile(path)) !== expected) warnings.push(`artifact hash mismatch: ${path}`); }
        catch { warnings.push(`artifact is missing: ${path}`); }
    }
    for (const [path, expected] of Object.entries(checkpoint.sourceHashes)) {
        try { if (hash(await readFile(path)) !== expected) warnings.push(`review source changed: ${path}`); }
        catch { warnings.push(`review source is missing: ${path}`); }
    }
    const reusableStages: ReviewStageId[] = [];
    if (warnings.length === 0) {
        for (const stageId of result.plan.stages) {
            if (!checkpoint.completedStages.includes(stageId)) break;
            const stage = result.stages.find((candidate) => candidate.stage === stageId);
            if (!stage || (stage.status !== "success" && stage.status !== "partial")) break;
            reusableStages.push(stageId);
        }
    }
    return { reusableStages, rerunStages: result.plan.stages.filter((stage) => !reusableStages.includes(stage)), warnings };
}

export function restrictReviewReuse(result: ReviewWorkflowResult, reusableStages: ReviewStageId[]): ReviewWorkflowResult {
    const allowed = new Set(reusableStages);
    const stages = result.stages.filter((stage) => allowed.has(stage.stage) && (stage.status === "success" || stage.status === "partial"));
    const reusable = new Set(stages.map((stage) => stage.stage));
    return { ...result, stages, executions: result.executions.filter((execution) => reusable.has(execution.stage)) };
}

function hash(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}
