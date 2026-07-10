import { describe, expect, it, vi } from "vitest";
import { callDirectModel, runDirectVoice, sanitizeProviderMessage } from "../../src/direct-api.js";
import { preset, registry } from "./fixtures.js";

describe("direct api", () => {
  it("calls an adapter, parses usage, and computes known cost", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 2000 } }), { status: 200 }));
    const result = await callDirectModel({
      model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
      prompt: "p",
      systemPrompt: "s",
      registry,
      signal: new AbortController().signal,
      fetchImpl
    });
    expect(result.output).toBe("ok");
    expect(result.costUsd).toBe(0.005);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(JSON.parse(String(init.body)).messages[0].content).toBe("s");
  });

  it("returns null cost for unknown pricing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1 } }), { status: 200 }));
    const result = await callDirectModel({
      model: { provider: "custom-ark-cn-beijing-volces-com", modelId: "glm-5.2" },
      prompt: "p",
      systemPrompt: "",
      registry,
      signal: new AbortController().signal,
      fetchImpl
    });
    expect(result.costUsd).toBeNull();
  });

  it("reports HTTP errors without leaking bearer tokens", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad Bearer secret-token" } }), { status: 429 }));
    const result = await runDirectVoice({
      voice: preset.voices[0]!,
      prompt: "p",
      registry,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetchImpl
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
        })
    );
    const result = await runDirectVoice({
      voice: preset.voices[0]!,
      prompt: "p",
      registry,
      timeoutMs: 1,
      signal: new AbortController().signal,
      fetchImpl
    });
    expect(aborted).toBe(true);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toBe("timed out after 1ms");
    expect(result.usage).toBeUndefined();
    expect(result.costUsd).toBeNull();
  });

  it("handles parent abort as aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort(new Error("stop"));
        })
    );
    const result = await runDirectVoice({
      voice: preset.voices[0]!,
      prompt: "p",
      registry,
      timeoutMs: 1000,
      signal: controller.signal,
      fetchImpl
    });
    expect(result.status).toBe("aborted");
  });

  it("sanitizes provider messages", () => {
    expect(sanitizeProviderMessage("Authorization Bearer abc.def")).toBe("Authorization Bearer [redacted]");
    expect(sanitizeProviderMessage("bad key sk-ant-api03-secretvalue")).toBe("bad key [redacted-api-key]");
    expect(sanitizeProviderMessage("url?api_key=secret-token-value&x=1")).toBe("url?api_key=[redacted]&x=1");
    expect(sanitizeProviderMessage("Authorization: Bearer secret-token")).toBe("Authorization: [redacted]");
  });
});
