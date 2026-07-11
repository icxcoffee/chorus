import type { ProviderAdapter, TokenUsage } from "../types.js";

export function getProviderAdapter(apiKind: string): ProviderAdapter {
    const adapter = ADAPTERS.get(apiKind);
    if (adapter) return adapter;
    // Prefer explicit matches over broad substring detection so a mislabeled
    // apiKind cannot silently route credentials to the wrong request shape.
    const normalized = apiKind.toLowerCase();
    if (normalized.startsWith("anthropic"))
        return anthropicMessagesAdapter(apiKind);
    if (normalized.startsWith("openai") || normalized.startsWith("chat"))
        return openAiChatAdapter(apiKind);
    return genericJsonAdapter(apiKind);
}

/**
 * Rejects non-https endpoints and link-local / cloud-metadata IPs before any
 * credentials are attached. Localhost (loopback) is permitted over plain http
 * for development. Throws on unsafe endpoints.
 */
export function assertSafeEndpoint(endpoint: string): void {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error(`invalid model endpoint URL: ${endpoint}`);
    }
    const host = url.hostname.toLowerCase().replace(/^\[|]$/g, "");
    const isLoopback =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "0:0:0:0:0:0:0:1";
    if (url.protocol !== "https:" && !isLoopback) {
        throw new Error(
            `chorus refuses non-https model endpoint ${url.protocol}//${host}; use https:// or localhost for local debugging`,
        );
    }
    if (isLinkLocalOrMetadata(host)) {
        throw new Error(`chorus refuses link-local/metadata IP endpoint: ${host}`);
    }
}

const METADATA_HOSTNAMES = new Set([
    "metadata.google.internal",
    "metadata",
    "metadata.aws.internal",
]);

function isLinkLocalOrMetadata(host: string): boolean {
    const lower = host.toLowerCase();
    // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:hex:hex, incl. the full
    // 0:0:0:0:0:ffff:... form) so an embedded link-local/metadata IPv4 is
    // caught instead of hiding behind a v6 wrapper.
    const mappedIpv4 = extractIpv4FromMappedV6(lower);
    if (mappedIpv4) return isLinkLocalOrMetadata(mappedIpv4);
    // DNS-based cloud metadata service hostnames (GCP/AWS).
    if (METADATA_HOSTNAMES.has(lower)) return true;
    // IPv4 link-local / cloud metadata (169.254.0.0/16, incl. 169.254.169.254)
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
    // IPv6 link-local (fe80::/10)
    if (/^fe[89ab][0-9a-f]{0,2}(:[0-9a-f]{0,4})*$/.test(lower)) return true;
    // Unspecified address
    if (lower === "0.0.0.0" || lower === "::") return true;
    return false;
}

function extractIpv4FromMappedV6(host: string): string | null {
    // Dotted-decimal embedded form: ::ffff:1.2.3.4 / 0:0:0:0:0:ffff:1.2.3.4
    const dotted = host.match(
        /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
    );
    if (dotted) return dotted[1]!;
    // Hex embedded form: ::ffff:xxYY:zzWW / 0:0:0:0:0:ffff:xxYY:zzWW
    const hex = host.match(
        /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
    );
    if (hex) {
        const hi = parseInt(hex[1]!, 16);
        const lo = parseInt(hex[2]!, 16);
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
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
        input: asNumber(
            raw.input ?? raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokens,
        ),
        output: asNumber(
            raw.output ??
                raw.completion_tokens ??
                raw.output_tokens ??
                raw.completionTokens,
        ),
        cacheRead: asNumber(raw.cacheRead),
        cacheWrite: asNumber(raw.cacheWrite),
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
                        ...(systemPrompt
                            ? [{ role: "system", content: systemPrompt }]
                            : []),
                        { role: "user", content: prompt },
                    ],
                }),
            },
        }),
        parseResponse: (json) => {
            const value = json as {
                choices?: Array<{ message?: { content?: string }; text?: string }>;
                usage?: object;
            };
            const output =
                value.choices?.[0]?.message?.content ?? value.choices?.[0]?.text;
            if (typeof output !== "string")
                throw new Error("OpenAI response missing choices[0] output");
            return {
                output,
                ...(value.usage ? { usage: normalizeUsage(value.usage) } : {}),
            };
        },
        parseError: parseProviderError,
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
                    messages: [{ role: "user", content: prompt }],
                }),
            },
        }),
        parseResponse: (json) => {
            const value = json as {
                content?: Array<{ type?: string; text?: string }>;
                usage?: object;
            };
            const output = value.content
                ?.filter(
                    (part) => part.type === "text" && typeof part.text === "string",
                )
                .map((part) => part.text)
                .join("");
            if (!output) throw new Error("Anthropic response missing text content");
            return {
                output,
                ...(value.usage ? { usage: normalizeUsage(value.usage) } : {}),
            };
        },
        parseError: parseProviderError,
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
                body: JSON.stringify({
                    model: resolved.ref.modelId,
                    prompt,
                    systemPrompt,
                    stream: false,
                }),
            },
        }),
        parseResponse: (json) => {
            const value = json as {
                output?: string;
                text?: string;
                message?: { content?: string };
                usage?: object;
            };
            const output = value.output ?? value.text ?? value.message?.content;
            if (typeof output !== "string")
                throw new Error("response missing output text");
            return {
                output,
                ...(value.usage ? { usage: normalizeUsage(value.usage) } : {}),
            };
        },
        parseError: parseProviderError,
    };
}

function parseProviderError(errorJson: unknown, status: number): string {
    const value = errorJson as { error?: unknown; message?: unknown };
    if (typeof value.message === "string")
        return `HTTP ${status}: ${value.message}`;
    if (typeof value.error === "string") return `HTTP ${status}: ${value.error}`;
    if (
        value.error &&
        typeof value.error === "object" &&
        "message" in value.error
    ) {
        const message = (value.error as { message?: unknown }).message;
        if (typeof message === "string") return `HTTP ${status}: ${message}`;
    }
    return `HTTP ${status}`;
}

const ADAPTERS = new Map<string, ProviderAdapter>([
    ["openai-completions", openAiChatAdapter("openai-completions")],
    ["openai-chat", openAiChatAdapter("openai-chat")],
    ["anthropic-messages", anthropicMessagesAdapter("anthropic-messages")],
    ["generic-json", genericJsonAdapter("generic-json")],
]);
