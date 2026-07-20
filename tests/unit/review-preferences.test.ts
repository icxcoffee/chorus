import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReviewRoleModelPreferences } from "../../src/review/preferences.js";
import { loadConfig, saveConfig } from "../../src/store.js";
import { config, registry } from "./fixtures.js";

describe("Review model preferences", () => {
    it("persists role defaults on one preset and clears them with Auto", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chorus-review-preferences-"));
        const configured = applyReviewRoleModelPreferences(config, "default", {
            architect: { provider: "deepseek", modelId: "deepseek-v4-pro" },
            devil: { provider: "minimax", modelId: "MiniMax-M3" },
        });
        await saveConfig(configured, { baseDir: dir }, registry);

        const loaded = await loadConfig({ baseDir: dir }, registry);
        expect(loaded.presets[0]?.reviewRoleModels).toEqual({
            architect: { provider: "deepseek", modelId: "deepseek-v4-pro" },
            devil: { provider: "minimax", modelId: "MiniMax-M3" },
        });

        const cleared = applyReviewRoleModelPreferences(loaded, "default", {});
        expect(cleared.presets[0]).not.toHaveProperty("reviewRoleModels");
    });

    it("does not mutate the loaded config", () => {
        const updated = applyReviewRoleModelPreferences(config, "default", {
            security: { provider: "minimax", modelId: "MiniMax-M3" },
        });
        expect(config.presets[0]).not.toHaveProperty("reviewRoleModels");
        expect(updated.presets[0]?.reviewRoleModels?.security).toEqual({ provider: "minimax", modelId: "MiniMax-M3" });
        expect(() => applyReviewRoleModelPreferences(config, "missing", {})).toThrow("preset \"missing\" is missing");
    });
});
