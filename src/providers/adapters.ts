import type { ProviderAdapter, TokenUsage } from "../types.js";

export function getProviderAdapter(apiKind: string): ProviderAdapter {
  const adapter = ADAPTERS.get(apiKind);
  if (adapter) return adapter;
  if (apiKind.includes("anthropic")) return anthropicMessagesAdapter(apiKind);
  if (apiKind.includes("openai") || apiKind.includes("chat")) return openAiChatAdapter(apiKind);
  return genericJsonAdapter(apiKind);
}

function normalizeUsage(raw: {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
}): TokenUsage {
  return {
    input: asNumber(raw.input ?? raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokens),
    output: asNumber(raw.output ?? raw.completion_tokens ?? raw.output_tokens ?? raw.completionTokens),
    cacheRead: asNumber(raw.cacheRead),
    cacheWrite: asNumber(raw.cacheWrite)
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function openAiChatAdapter(apiKind: string): ProviderAdapter {
  return {
    apiKind,
    buildRequest: ({ resolved, prompt, systemPrompt, signal }) => ({
      url: resolved.endpoint,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...resolved.headers },
        signal,
        body: JSON.stringify({
          model: resolved.ref.modelId,
          stream: false,
          messages: [
            ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
            { role: "user", content: prompt }
          ]
        })
      }
    }),
    parseResponse: (json) => {
      const value = json as { choices?: Array<{ message?: { content?: string }; text?: string }>; usage?: object };
      const output = value.choices?.[0]?.message?.content ?? value.choices?.[0]?.text;
      if (typeof output !== "string") throw new Error("OpenAI response missing choices[0] output");
      return { output, ...(value.usage ? { usage: normalizeUsage(value.usage) } : {}) };
    },
    parseError: parseProviderError
  };
}

function anthropicMessagesAdapter(apiKind: string): ProviderAdapter {
  return {
    apiKind,
    buildRequest: ({ resolved, prompt, systemPrompt, signal }) => ({
      url: resolved.endpoint,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...resolved.headers },
        signal,
        body: JSON.stringify({
          model: resolved.ref.modelId,
          stream: false,
          max_tokens: 4096,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: [{ role: "user", content: prompt }]
        })
      }
    }),
    parseResponse: (json) => {
      const value = json as { content?: Array<{ type?: string; text?: string }>; usage?: object };
      const output = value.content
        ?.filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (!output) throw new Error("Anthropic response missing text content");
      return { output, ...(value.usage ? { usage: normalizeUsage(value.usage) } : {}) };
    },
    parseError: parseProviderError
  };
}

function genericJsonAdapter(apiKind: string): ProviderAdapter {
  return {
    apiKind,
    buildRequest: ({ resolved, prompt, systemPrompt, signal }) => ({
      url: resolved.endpoint,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...resolved.headers },
        signal,
        body: JSON.stringify({ model: resolved.ref.modelId, prompt, systemPrompt, stream: false })
      }
    }),
    parseResponse: (json) => {
      const value = json as {
        output?: string;
        text?: string;
        message?: { content?: string };
        usage?: object;
      };
      const output = value.output ?? value.text ?? value.message?.content;
      if (typeof output !== "string") throw new Error("response missing output text");
      return { output, ...(value.usage ? { usage: normalizeUsage(value.usage) } : {}) };
    },
    parseError: parseProviderError
  };
}

function parseProviderError(errorJson: unknown, status: number): string {
  const value = errorJson as { error?: unknown; message?: unknown };
  if (typeof value.message === "string") return `HTTP ${status}: ${value.message}`;
  if (typeof value.error === "string") return `HTTP ${status}: ${value.error}`;
  if (value.error && typeof value.error === "object" && "message" in value.error) {
    const message = (value.error as { message?: unknown }).message;
    if (typeof message === "string") return `HTTP ${status}: ${message}`;
  }
  return `HTTP ${status}`;
}

const ADAPTERS = new Map<string, ProviderAdapter>([
  ["openai-completions", openAiChatAdapter("openai-completions")],
  ["openai-chat", openAiChatAdapter("openai-chat")],
  ["anthropic-messages", anthropicMessagesAdapter("anthropic-messages")],
  ["generic-json", genericJsonAdapter("generic-json")]
]);
