import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultReviewObjective, handleReview } from "../../../src/commands/review.js";
import { loadConfig, saveConfig } from "../../../src/store.js";
import { config, registry } from "../fixtures.js";

describe("Review settings persistence", () => {
    it("uses the workflow objective when the optional focus is blank", () => {
        expect(defaultReviewObjective("code-review")).toBe("Find concrete defects and regression risks in the reviewed code change or repository.");
        expect(defaultReviewObjective("architecture-review")).toContain("system boundaries");
    });

    it("submits a blank focus with the selected workflow default", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-review-default-objective-"));
        await saveConfig(config, { baseDir: dir }, registry);
        let capturedObjective: string[] = [];
        let calledResolve: (() => void) | undefined;
        const called = new Promise<void>((resolve) => { calledResolve = resolve; });
        const service = vi.fn(async (_ctx, request) => {
            capturedObjective = request.objective;
            calledResolve?.();
            throw new Error("stop after request capture");
        });

        await handleReview({
            cwd: dir,
            storePaths: { baseDir: dir },
            modelRegistry: { models: registry },
            ui: {
                notify: vi.fn(),
                custom: async (factory) => await new Promise((resolve) => {
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    view.handleInput({ name: "enter" });
                }),
            },
        }, "", { runReviewServiceImpl: service });
        await called;

        expect(capturedObjective).toEqual(["Find concrete defects and regression risks in the reviewed code change or repository."]);
    });

    it("saves role models on Apply and shows them when returning to the draft", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-review-settings-"));
        await saveConfig(config, { baseDir: dir }, registry);
        let customCalls = 0;
        let returnedDraft = "";

        await handleReview({
            cwd: dir,
            storePaths: { baseDir: dir },
            modelRegistry: { models: registry },
            ui: {
                notify: vi.fn(),
                custom: async (factory) => await new Promise((resolve) => {
                    customCalls += 1;
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    if (customCalls === 1) {
                        view.handleInput("review this repository");
                        view.handleInput({ name: "right" }); // Settings
                        view.handleInput({ name: "enter" });
                    } else if (customCalls === 2) {
                        view.handleInput({ name: "down" }); // profile
                        view.handleInput({ name: "down" }); // architect model
                        view.handleInput({ name: "right" }); // first callable model
                        for (let index = 0; index < 8; index += 1) view.handleInput({ name: "down" });
                        view.handleInput({ name: "enter" }); // Apply
                    } else {
                        returnedDraft = view.render(100).join("\n");
                        view.handleInput({ name: "escape" });
                    }
                }),
            },
        }, "");

        const saved = await loadConfig({ baseDir: dir }, registry);
        expect(customCalls).toBe(3);
        expect(saved.presets[0]?.reviewRoleModels?.architect).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
        expect(returnedDraft).toContain("Models: 1 saved preset default(s)");
        expect(returnedDraft).toContain("review this repository");
    });
});
