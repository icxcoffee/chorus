import { describe, expect, it, vi } from "vitest";
import { configureReviewSettings, describeReviewSettings } from "../../../src/ui/review.js";
import { defaultReviewWorkflowRegistry } from "../../../src/workflows/registry.js";
import { defaultReviewRendererRegistry } from "../../../src/renderers/index.js";
import "../../../src/workflows/code-review.js";
import "../../../src/workflows/additional.js";
import { registry } from "../fixtures.js";

const workflows = defaultReviewWorkflowRegistry.list();
const renderers = defaultReviewRendererRegistry.list();

describe("ui/review", () => {
    it("changes review settings in place, including file paths", async () => {
        let rendered: string[] = [];
        const result = await configureReviewSettings({
            ui: {
                custom: async (factory) => await new Promise((resolve) => {
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    rendered = view.render(100);
                    view.handleInput({ name: "right" }); // architecture-review
                    view.handleInput({ name: "down" });
                    view.handleInput({ name: "right" }); // deep
                    for (let index = 0; index < 7; index += 1) view.handleInput({ name: "down" });
                    view.handleInput({ name: "right" }); // files
                    view.handleInput({ name: "down" });
                    view.handleInput({ name: "enter" });
                    view.handleInput("docs/adr.md, README.md");
                    view.handleInput({ name: "enter" });
                    view.handleInput({ name: "down" });
                    view.handleInput({ name: "right" }); // json
                    view.handleInput({ name: "down" });
                    view.handleInput({ name: "down" });
                    view.handleInput({ name: "enter" });
                }),
            },
            workflows,
            renderers,
            models: [],
            initial: { workflow: "code-review", profile: "quick", scope: { kind: "repository", root: "/repo" }, renderer: "markdown" },
        });
        expect(rendered.join("\n")).toContain("Chorus Review Settings");
        expect(result).toEqual({
            workflow: "architecture-review",
            profile: "deep",
            scope: { kind: "files", root: "/repo", paths: ["docs/adr.md", "README.md"] },
            renderer: "json",
            language: "zh-CN",
        });
    });

    it("repairs an incompatible scope when workflow changes", async () => {
        const result = await configureReviewSettings({
            ui: {
                custom: async (factory) => await new Promise((resolve) => {
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    view.handleInput({ name: "right" });
                    for (let index = 0; index < 10; index += 1) view.handleInput({ name: "down" });
                    view.handleInput({ name: "enter" });
                }),
            },
            workflows,
            renderers,
            models: [],
            initial: { workflow: "code-review", profile: "quick", scope: { kind: "diff", root: "/repo", selection: "staged" }, renderer: "markdown" },
        });
        expect(result).toEqual({ workflow: "architecture-review", profile: "quick", scope: { kind: "repository", root: "/repo" }, renderer: "markdown", language: "zh-CN" });
    });

    it("allows a model override for each effective reviewer role", async () => {
        const result = await configureReviewSettings({
            ui: {
                custom: async (factory) => await new Promise((resolve) => {
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    view.handleInput({ name: "down" }); // profile
                    view.handleInput({ name: "down" }); // architect model
                    view.handleInput({ name: "right" });
                    for (let index = 0; index < 8; index += 1) view.handleInput({ name: "down" });
                    view.handleInput({ name: "enter" });
                }),
            },
            workflows,
            renderers,
            models: registry,
            initial: { workflow: "code-review", profile: "quick", scope: { kind: "repository", root: "/repo" }, renderer: "markdown" },
        });
        expect(result?.roleModels?.architect).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
        expect(describeReviewSettings(result!)).toContain("Models: 1 saved preset default(s)");
    });

    it("searches and selects a role model without cycling through the registry", async () => {
        let picker = "";
        const result = await configureReviewSettings({
            ui: {
                custom: async (factory) => await new Promise((resolve) => {
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    view.handleInput({ name: "down" }); // profile
                    view.handleInput({ name: "down" }); // architect model
                    view.handleInput({ name: "enter" });
                    view.handleInput("flash");
                    picker = view.render(100).join("\n");
                    view.handleInput({ name: "enter" });
                    for (let index = 0; index < 8; index += 1) view.handleInput({ name: "down" });
                    view.handleInput({ name: "enter" });
                }),
            },
            workflows,
            renderers,
            models: registry,
            initial: { workflow: "code-review", profile: "quick", scope: { kind: "repository", root: "/repo" }, renderer: "markdown" },
        });
        expect(picker).toContain("Choose Model: architect");
        expect(picker).toContain("deepseek-v4-flash [deepseek]");
        expect(picker).not.toContain("MiniMax-M3");
        expect(result?.roleModels?.architect).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash" });
    });

    it("returns from model search without cancelling review settings", async () => {
        const result = await configureReviewSettings({
            ui: {
                custom: async (factory) => await new Promise((resolve) => {
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    view.handleInput({ name: "down" });
                    view.handleInput({ name: "down" });
                    view.handleInput("minimax"); // type directly to open search
                    view.handleInput({ name: "escape" });
                    for (let index = 0; index < 8; index += 1) view.handleInput({ name: "down" });
                    view.handleInput({ name: "enter" });
                }),
            },
            workflows,
            renderers,
            models: registry,
            initial: { workflow: "code-review", profile: "quick", scope: { kind: "repository", root: "/repo" }, renderer: "markdown" },
        });
        expect(result).toEqual({ workflow: "code-review", profile: "quick", scope: { kind: "repository", root: "/repo" }, renderer: "markdown", language: "zh-CN" });
    });

    it("summarizes the effective review before submission", () => {
        expect(describeReviewSettings({ workflow: "code-review", profile: "deep", scope: { kind: "diff", selection: "staged" }, renderer: "sarif" })).toEqual([
            "Workflow: code-review | Profile: deep",
            "Scope: diff:staged | Output: sarif",
            "Language: zh-CN",
        ]);
    });

    it("allows the default Chinese report language to be changed", async () => {
        const result = await configureReviewSettings({
            ui: {
                custom: async (factory) => await new Promise((resolve) => {
                    const view = factory({ requestRender: vi.fn() }, {}, {}, resolve);
                    for (let index = 0; index < 9; index += 1) view.handleInput({ name: "down" });
                    view.handleInput({ name: "right" });
                    view.handleInput({ name: "down" });
                    view.handleInput({ name: "enter" });
                }),
            },
            workflows,
            renderers,
            models: [],
            initial: { workflow: "code-review", profile: "quick", scope: { kind: "repository", root: "/repo" }, renderer: "markdown" },
        });
        expect(result?.language).toBe("en");
    });
});
