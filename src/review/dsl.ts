import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { ReviewDefinition, ReviewerAssignment, ReviewStageId } from "./contracts.js";
import { parseReviewRequest } from "./validation.js";
import { isPathInside } from "./scope.js";
import { parseModelRef } from "../utils/models.js";
import { defaultReviewWorkflowRegistry } from "../workflows/registry.js";
import { defaultReviewerRoleRegistry } from "../roles/registry.js";
import { defaultReviewRendererRegistry } from "../renderers/index.js";
import { registerBuiltinReviewComponents } from "../workflows/builtins.js";

const MAX_DSL_BYTES = 512 * 1024;
const allowedKeys = new Set(["version", "workflow", "profile", "language", "objective", "constraints", "scope", "committee", "stages", "crossReview", "devil", "output"]);
const stageIds = new Set<ReviewStageId>(["independent-review", "cross-review", "devil", "integrate"]);

export interface LoadedReviewDsl {
    path: string;
    request: ReturnType<typeof parseReviewRequest>;
    definition: ReviewDefinition;
    renderers: string[];
}

export async function loadReviewDsl(path: string, options: { baseDir?: string; cwd?: string } = {}): Promise<LoadedReviewDsl> {
    const baseDir = await realpath(resolve(options.baseDir ?? options.cwd ?? process.cwd()));
    const resolved = await realpath(resolve(baseDir, path));
    if (!isPathInside(baseDir, resolved)) throw new Error(`review definition escapes base directory: ${path}`);
    const info = await lstat(resolved);
    if (!info.isFile()) throw new Error(`review definition is not a file: ${path}`);
    if (info.size > MAX_DSL_BYTES) throw new Error(`review definition exceeds ${MAX_DSL_BYTES} bytes`);
    const text = await readFile(resolved, "utf8");
    const extension = extname(resolved).toLowerCase();
    let input: unknown;
    if (extension === ".json") input = JSON.parse(text);
    else if (extension === ".yaml" || extension === ".yml") {
        const document = parseDocument(text, { schema: "core", merge: false });
        if (document.errors.length > 0) throw new Error(`invalid review YAML: ${document.errors.map((error) => error.message).join("; ")}`);
        input = document.toJS({ maxAliasCount: 0 });
    } else throw new Error("review definition must use .json, .yaml, or .yml");
    return parseReviewDsl(input, resolved, options.cwd);
}

export function parseReviewDsl(input: unknown, sourcePath = "<inline>", cwd?: string): LoadedReviewDsl {
    registerBuiltinReviewComponents();
    const value = record(input, "review definition");
    for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new Error(`unknown review definition field: ${key}`);
    if (value.version !== 1) throw new Error(`unsupported review definition version ${String(value.version)}; expected 1`);
    const workflowId = string(value.workflow, "workflow");
    const base = defaultReviewWorkflowRegistry.get(workflowId).definition;
    const committee = value.committee === undefined ? base.roles : parseCommittee(value.committee);
    const stages = value.stages === undefined ? base.stages : parseStages(value.stages);
    const devil = value.devil === undefined ? true : boolean(record(value.devil, "devil").enabled, "devil.enabled");
    const effectiveStages = devil ? stages : stages.filter((stage) => stage !== "devil");
    const effectiveCommittee = devil ? committee : committee.filter((assignment) => assignment.roleId !== "devil");
    const cross = value.crossReview === undefined ? {} : record(value.crossReview, "crossReview");
    const maxChallenges = cross.maxChallengesPerFinding === undefined ? base.maxChallengesPerFinding : boundedInteger(cross.maxChallengesPerFinding, "crossReview.maxChallengesPerFinding", 0, 3);
    const severity = cross.severityAtLeast === undefined ? base.challengeSeverityAtLeast : enumeration(cross.severityAtLeast, ["critical", "high", "medium", "low", "info"], "crossReview.severityAtLeast");
    const renderers = value.output === undefined ? ["markdown"] : strings(value.output, "output");
    if (renderers.length === 0 || renderers.length > 4) throw new Error("output must contain between 1 and 4 renderers");
    for (const renderer of renderers) defaultReviewRendererRegistry.get(renderer);
    const scope = value.scope ?? { kind: "repository", ...(cwd ? { root: cwd } : {}) };
    const request = parseReviewRequest({ version: 1, workflow: workflowId, objective: value.objective ?? [], constraints: value.constraints ?? [], scope, profile: value.profile ?? "quick", renderer: renderers[0], language: value.language ?? "zh-CN" });
    return {
        path: sourcePath,
        request,
        definition: { ...base, roles: effectiveCommittee, stages: effectiveStages, maxChallengesPerFinding: maxChallenges, challengeSeverityAtLeast: severity },
        renderers,
    };
}

function parseCommittee(input: unknown): ReviewerAssignment[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > 8) throw new Error("committee must contain between 1 and 8 roles");
    const roles = input.map((item, index) => {
        const value = record(item, `committee[${index}]`);
        for (const key of Object.keys(value)) if (key !== "role" && key !== "preferred" && key !== "fallback") throw new Error(`unknown committee field: ${key}`);
        const roleId = string(value.role, `committee[${index}].role`);
        defaultReviewerRoleRegistry.get(roleId);
        const preferred = value.preferred === undefined ? undefined : strings(value.preferred, `committee[${index}].preferred`).map(parseModelRef);
        const fallback = value.fallback === undefined ? undefined : strings(value.fallback, `committee[${index}].fallback`).map(parseModelRef);
        return { roleId, ...(preferred || fallback ? { modelPolicy: { ...(preferred ? { preferred } : {}), ...(fallback ? { fallback } : {}) } } : {}) };
    });
    if (new Set(roles.map((role) => role.roleId)).size !== roles.length) throw new Error("committee role IDs must be unique");
    return roles;
}

function parseStages(input: unknown): ReviewStageId[] {
    const values = strings(input, "stages");
    if (values.length === 0 || values.length > 4) throw new Error("stages must contain between 1 and 4 built-in stages");
    if (new Set(values).size !== values.length) throw new Error("stages must not contain duplicates");
    for (const value of values) if (!stageIds.has(value as ReviewStageId)) throw new Error(`unknown or unsafe review stage: ${value}`);
    if (values[0] !== "independent-review" || values.at(-1) !== "integrate") throw new Error("review stages must start with independent-review and end with integrate");
    return values as ReviewStageId[];
}

function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`); return value as Record<string, unknown>; }
function string(value: unknown, path: string): string { if (typeof value !== "string" || !value.trim() || value.length > 4_000) throw new Error(`${path} must be a non-empty bounded string`); return value; }
function strings(value: unknown, path: string): string[] { if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${path} must be a bounded array`); return value.map((item, index) => string(item, `${path}[${index}]`)); }
function boolean(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`); return value; }
function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${path} must be an integer between ${minimum} and ${maximum}`); return value as number; }
function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${path} must be one of ${values.join(", ")}`); return value as T; }
