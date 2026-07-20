import { describe, expect, it, vi } from "vitest";
import { getProviderAdapter, getProviderCapabilities, ProviderAdapterRegistry } from "../../src/providers/adapters.js";
import { registryModels } from "../../src/models/registry.js";

describe("provider adapter registry", () => {
    it("registers built-ins deterministically with capabilities", () => {
        expect(getProviderAdapter("openai-chat").apiKind).toBe("openai-chat");
        expect(getProviderCapabilities("anthropic-messages")).toMatchObject({ usage: true, cancellation: true });
    });
    it("rejects duplicate and unknown registrations", () => {
        const registry = new ProviderAdapterRegistry();
        const adapter = getProviderAdapter("generic-json");
        const capabilities = { streaming: false, structuredOutput: false, reasoning: false, usage: true, cancellation: true };
        registry.register(adapter, capabilities);
        expect(() => registry.register(adapter, capabilities)).toThrow("already registered");
        expect(() => registry.get("missing")).toThrow("register an adapter");
    });
    it("warns when authentication filtering falls back to the full model list", async () => {
        const notify = vi.fn();
        const models = [{ provider: "local", modelId: "model", id: "model", name: "Model" }];
        await expect(registryModels({
            modelRegistry: { models, hasConfiguredAuth: () => false },
            ui: { notify },
        })).resolves.toHaveLength(1);
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("no models with configured authentication"), "warning");
    });
});
