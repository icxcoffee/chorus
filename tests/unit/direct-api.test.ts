import { describe, expect, it, vi } from "vitest";
import {
    callDirectModel,
    runDirectVoice,
    sanitizeProviderMessage,
} from "../../src/direct-api.js";
import { preset, registry } from "./fixtures.js";

describe("direct api", () => {
    it("calls an adapter, parses usage, and computes known cost", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        choices: [{ message: { content: "ok" } }],
                        usage: { prompt_tokens: 1000, completion_tokens: 2000 },
                    }),
                    { status: 200 },
                ),
        );
        const result = await callDirectModel({
            model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
            prompt: "p",
            systemPrompt: "s",
            registry,
            signal: new AbortController().signal,
            fetchImpl,
        });
        expect(result.output).toBe("ok");
        expect(result.costUsd).toBe(0.005);
        const [, init] = fetchImpl.mock.calls[0] as unknown as [
            unknown,
            RequestInit,
        ];
        const body = parseRequestBody(init.body);
        expect(body.messages[0]?.content).toBe("s");
        expect(init.redirect).toBe("error");
    });

    it("rejects automatic redirects in the raw direct fetch path", async () => {
        const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            expect(init?.redirect).toBe("error");
            throw new TypeError("fetch failed: redirect mode is set to error");
        });
        const result = await runDirectVoice({
            voice: preset.voices[0]!, prompt: "p", registry, timeoutMs: 1000,
            signal: new AbortController().signal, fetchImpl,
        });
        expect(result).toEqual(expect.objectContaining({ status: "error" }));
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("returns null cost for unknown pricing", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        content: [{ type: "text", text: "ok" }],
                        usage: { input_tokens: 1 },
                    }),
                    { status: 200 },
                ),
        );
        const result = await callDirectModel({
            model: {
                provider: "custom-ark-cn-beijing-volces-com",
                modelId: "glm-5.2",
            },
            prompt: "p",
            systemPrompt: "",
            registry,
            signal: new AbortController().signal,
            fetchImpl,
        });
        expect(result.costUsd).toBeNull();
    });

    it("reports HTTP errors without leaking bearer tokens", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ error: { message: "bad Bearer secret-token" } }),
                    { status: 429 },
                ),
        );
        const result = await runDirectVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            registry,
            timeoutMs: 1000,
            signal: new AbortController().signal,
            fetchImpl,
        });
        expect(result.status).toBe("error");
        expect(result.errorMessage).toContain("Bearer [redacted]");
    });

    it("times out and aborts the underlying operation", async () => {
        let aborted = false;
        const fetchImpl = vi.fn(
            (_url: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        aborted = true;
                        reject(init.signal?.reason);
                    });
                }),
        );
        const result = await runDirectVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            registry,
            timeoutMs: 1,
            signal: new AbortController().signal,
            fetchImpl,
        });
        expect(aborted).toBe(true);
        expect(result.status).toBe("error");
        expect(result.errorMessage).toBe("timed out after 1ms");
        expect(result.usage).toBeUndefined();
        expect(result.costUsd).toBeNull();
    });

    it("counts retry backoff against the voice timeout", async () => {
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify({ error: { message: "temporarily unavailable" } }),
            { status: 503 },
        ));
        const sleep = vi.fn(async (_delayMs: number, signal: AbortSignal) => await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
        const result = await runDirectVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            registry,
            timeoutMs: 10,
            signal: new AbortController().signal,
            fetchImpl,
            retryPolicy: { maxAttempts: 3, sleep },
        });
        expect(result).toEqual(expect.objectContaining({ status: "error", errorMessage: "timed out after 10ms" }));
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("handles parent abort as aborted", async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(
            (_url: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(init.signal?.reason),
                    );
                    controller.abort(new Error("stop"));
                }),
        );
        const result = await runDirectVoice({
            voice: preset.voices[0]!,
            prompt: "p",
            registry,
            timeoutMs: 1000,
            signal: controller.signal,
            fetchImpl,
        });
        expect(result.status).toBe("aborted");
    });

    it("sanitizes provider messages", () => {
        expect(sanitizeProviderMessage("Authorization Bearer abc.def")).toBe(
            "Authorization Bearer [redacted]",
        );
        expect(sanitizeProviderMessage("bad key sk-ant-api03-secretvalue")).toBe(
            "bad key [redacted-api-key]",
        );
        expect(sanitizeProviderMessage("url?api_key=secret-token-value&x=1")).toBe(
            "url?api_key=[redacted]&x=1",
        );
        expect(sanitizeProviderMessage("Authorization: Bearer secret-token")).toBe(
            "Authorization: [redacted]",
        );
    });

    it("refuses non-https endpoints except localhost", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
                    { status: 200 },
                ),
        );
        const httpRegistry = [
            {
                provider: "deepseek",
                modelId: "deepseek-v4-pro",
                apiKind: "openai-chat",
                endpoint: "http://example.test/openai",
                costPerMTokens: {
                    input: 1,
                    output: 2,
                    cacheRead: 0.1,
                    cacheWrite: 0.2,
                },
            },
        ];
        await expect(
            callDirectModel({
                model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
                prompt: "p",
                systemPrompt: "s",
                registry: httpRegistry,
                signal: new AbortController().signal,
                fetchImpl,
            }),
        ).rejects.toThrow("non-https");
    });

    it("allows localhost http endpoints for debugging", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
                    { status: 200 },
                ),
        );
        const localRegistry = [
            {
                provider: "deepseek",
                modelId: "deepseek-v4-pro",
                apiKind: "openai-chat",
                endpoint: "http://localhost:8080/v1",
                costPerMTokens: {
                    input: 1,
                    output: 2,
                    cacheRead: 0.1,
                    cacheWrite: 0.2,
                },
            },
        ];
        const result = await callDirectModel({
            model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
            prompt: "p",
            systemPrompt: "s",
            registry: localRegistry,
            signal: new AbortController().signal,
            fetchImpl,
        });
        expect(result.output).toBe("ok");
    });

    it("refuses cloud-metadata IP endpoints", async () => {
        await expect(
            callDirectModel({
                model: { provider: "other", modelId: "o1" },
                prompt: "p",
                systemPrompt: "s",
                registry: [
                    {
                        provider: "other",
                        modelId: "o1",
                        apiKind: "generic-json",
                        endpoint: "https://169.254.169.254/latest/meta-data/",
                        costPerMTokens: { input: 1, output: 1 },
                    },
                ],
                signal: new AbortController().signal,
                fetchImpl: vi.fn(),
            }),
        ).rejects.toThrow("metadata");
    });

    it("refuses IPv6 link-local endpoints", async () => {
        await expect(
            callDirectModel({
                model: { provider: "other", modelId: "o1" },
                prompt: "p",
                systemPrompt: "s",
                registry: [
                    {
                        provider: "other",
                        modelId: "o1",
                        apiKind: "generic-json",
                        endpoint: "https://[fe80::1]/",
                        costPerMTokens: { input: 1, output: 1 },
                    },
                ],
                signal: new AbortController().signal,
                fetchImpl: vi.fn(),
            }),
        ).rejects.toThrow("link-local");
    });

    it("refuses IPv4-mapped IPv6 metadata endpoints", async () => {
        for (const endpoint of [
            "https://[::ffff:169.254.169.254]/",
            "https://[0:0:0:0:0:ffff:a9fe:a9fe]/",
        ]) {
            await expect(
                callDirectModel({
                    model: { provider: "other", modelId: "o1" },
                    prompt: "p",
                    systemPrompt: "s",
                    registry: [
                        {
                            provider: "other",
                            modelId: "o1",
                            apiKind: "generic-json",
                            endpoint,
                            costPerMTokens: { input: 1, output: 1 },
                        },
                    ],
                    signal: new AbortController().signal,
                    fetchImpl: vi.fn(),
                }),
            ).rejects.toThrow("metadata");
        }
    });

    it("refuses DNS-based cloud-metadata hostnames", async () => {
        await expect(
            callDirectModel({
                model: { provider: "other", modelId: "o1" },
                prompt: "p",
                systemPrompt: "s",
                registry: [
                    {
                        provider: "other",
                        modelId: "o1",
                        apiKind: "generic-json",
                        endpoint: "https://metadata.google.internal/computeMetadata/v1/",
                        costPerMTokens: { input: 1, output: 1 },
                    },
                ],
                signal: new AbortController().signal,
                fetchImpl: vi.fn(),
            }),
        ).rejects.toThrow("metadata");
    });
});

interface RequestBody {
    messages: Array<{ content: string }>;
}

function parseRequestBody(body: unknown): RequestBody {
    try {
        return JSON.parse(String(body)) as RequestBody;
    } catch {
        throw new Error("expected JSON request body");
    }
}
