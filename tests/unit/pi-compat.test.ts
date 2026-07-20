import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

const completeSimpleMock = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: completeSimpleMock }));

import { callPiModel } from "../../src/pi-compat.js";
import { callDirectModel } from "../../src/direct-api.js";

const runtimeModel: Model<Api> = {
    id: "model",
    name: "Model",
    api: "openai-responses",
    provider: "provider",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
};

describe("pi-ai compatibility boundary", () => {
    it("calls completeSimple through the exported pi-ai contracts", async () => {
        const assistant: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "typed result" }],
            api: runtimeModel.api,
            provider: runtimeModel.provider,
            model: runtimeModel.id,
            usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 } },
            stopReason: "stop",
            timestamp: 1,
        };
        completeSimpleMock.mockResolvedValueOnce(assistant);
        const signal = new AbortController().signal;
        const result = await callPiModel({
            model: { provider: "provider", modelId: "model" },
            prompt: "review",
            systemPrompt: "system",
            registry: [],
            modelRegistry: {
                find: () => runtimeModel,
                getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: { "x-test": "1" }, env: { REGION: "test" } }),
            },
            signal,
        });

        expect(result).toEqual({
            output: "typed result",
            costUsd: 0.31,
            usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 },
            resolved: {
                ref: { provider: "provider", modelId: "model" },
                apiKind: "openai-responses",
                endpoint: "https://example.test/v1",
                headers: {},
                costPerMTokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 100_000,
                reasoning: true,
            },
        });
        expect(completeSimpleMock).toHaveBeenCalledWith(
            runtimeModel,
            expect.objectContaining({ systemPrompt: "system", messages: [expect.objectContaining({ role: "user", content: "review" })] }),
            expect.objectContaining({ reasoning: "medium", signal, apiKey: "key", headers: { "x-test": "1" }, env: { REGION: "test" } }),
        );
    });

    it("allows callDirectModel to resolve a model that exists only in the Pi registry", async () => {
        completeSimpleMock.mockResolvedValueOnce({
            role: "assistant",
            content: [{ type: "text", text: "runtime-only result" }],
            api: runtimeModel.api,
            provider: runtimeModel.provider,
            model: runtimeModel.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: 1,
        } satisfies AssistantMessage);

        const result = await callDirectModel({
            model: { provider: "provider", modelId: "model" },
            prompt: "review",
            systemPrompt: "system",
            registry: [],
            modelRegistry: { find: () => runtimeModel },
            signal: new AbortController().signal,
        });

        expect(result.output).toBe("runtime-only result");
        expect(result.resolved).toEqual(expect.objectContaining({
            ref: { provider: "provider", modelId: "model" },
            endpoint: runtimeModel.baseUrl,
            apiKind: runtimeModel.api,
        }));
    });

    it("rejects an incompatible runtime model before calling pi-ai", async () => {
        completeSimpleMock.mockClear();
        await expect(callPiModel({
            model: { provider: "provider", modelId: "broken" },
            prompt: "review",
            systemPrompt: "system",
            registry: [],
            modelRegistry: { find: () => ({ id: "broken", provider: "provider" }) },
            signal: new AbortController().signal,
        })).rejects.toThrow("incompatible with the pi-ai Model contract");
        expect(completeSimpleMock).not.toHaveBeenCalled();
    });

    it("rejects invalid cost fields and input modalities at the compatibility boundary", async () => {
        for (const broken of [
            { ...runtimeModel, cost: { ...runtimeModel.cost, output: "2" } },
            { ...runtimeModel, input: ["audio"] },
        ]) {
            await expect(callPiModel({
                model: { provider: "provider", modelId: "broken" }, prompt: "review", systemPrompt: "system", registry: [],
                modelRegistry: { find: () => broken }, signal: new AbortController().signal,
            })).rejects.toThrow("incompatible with the pi-ai Model contract");
        }
    });

    it("rejects an unsafe registry endpoint before resolving credentials", async () => {
        completeSimpleMock.mockClear();
        const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "secret" }));
        await expect(callPiModel({
            model: { provider: "provider", modelId: "metadata" },
            prompt: "review",
            systemPrompt: "system",
            registry: [],
            modelRegistry: { find: () => ({ ...runtimeModel, id: "metadata", baseUrl: "https://169.254.169.254/v1" }), getApiKeyAndHeaders },
            signal: new AbortController().signal,
        })).rejects.toThrow("link-local/metadata");
        expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
        expect(completeSimpleMock).not.toHaveBeenCalled();
    });
});
