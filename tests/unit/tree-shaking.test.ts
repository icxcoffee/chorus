import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("tree-shaken library consumers", () => {
    it("retain advanced strategies and built-in review workflows", async () => {
        const directory = await mkdtemp(join(resolve("node_modules"), ".chorus-tree-shaking-"));
        const entryPath = join(directory, "entry.ts");
        const outputPath = join(directory, "bundle.mjs");
        const chorusPath = resolve("src/chorus.ts");
        const dslPath = resolve("src/review/dsl.ts");
        await writeFile(entryPath, `
import { runChorus } from ${JSON.stringify(chorusPath)};
import { parseReviewDsl } from ${JSON.stringify(dslPath)};

const voices = [
    { model: { provider: "test", modelId: "one" } },
    { model: { provider: "test", modelId: "two" } },
];
const conductor = { provider: "test", modelId: "conductor" };
const registry = [...voices.map((voice) => voice.model), conductor].map((model) => ({ ...model, apiKind: "generic-json", endpoint: "https://example.test" }));

export async function bundledStrategyIds() {
    const ids = [];
    for (const strategy of ["debate", "rank", "refine"]) {
        const result = await runChorus({
            runConfig: { presetName: "test", voices, conductor, mode: "direct", strategy },
            prompt: "review",
            registry,
            signal: new AbortController().signal,
            runVoiceDirect: async (args) => ({ voice: args.voice, status: "success", output: "answer", durationMs: 1, costUsd: 0, startedAt: 1 }),
            synthesizeFn: async () => ({ synthesis: "final", costUsd: 0 }),
            appendHistory: async () => undefined,
        });
        ids.push(result.strategy?.id);
    }
    return ids;
}

export function bundledWorkflowIds() {
    return ["code-review", "architecture-review", "design-review"].map((workflow) => parseReviewDsl({
        version: 1,
        workflow,
        objective: [],
        scope: { kind: workflow === "design-review" ? "files" : "repository" },
    }).definition.id);
}
`);
        await build({
            entryPoints: [entryPath],
            outfile: outputPath,
            bundle: true,
            treeShaking: true,
            platform: "node",
            format: "esm",
            target: "node22",
            packages: "external",
            external: ["yaml"],
        });
        const bundled = await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`) as {
            bundledStrategyIds(): Promise<string[]>;
            bundledWorkflowIds(): string[];
        };

        await expect(bundled.bundledStrategyIds()).resolves.toEqual(["debate", "rank", "refine"]);
        expect(bundled.bundledWorkflowIds()).toEqual(["code-review", "architecture-review", "design-review"]);
        await rm(directory, { recursive: true, force: true });
    });
});
