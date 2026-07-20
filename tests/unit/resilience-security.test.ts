import { describe, expect, it } from "vitest";
import { parseSubagentNdjson } from "../../src/subagent/ndjson.js";
import { assertSafeEndpoint } from "../../src/providers/adapters.js";
import { redactSensitive } from "../../src/utils/redact.js";

describe("resilience and security corpus (seed: chorus-20260712)", () => {
    it("handles deterministic NDJSON chunking, malformed lines, Unicode, and duplicate terminals", () => {
        const events = [
            JSON.stringify({ type: "message", message: { role: "assistant", content: "first" } }),
            "{malformed",
            JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "忽略" } }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: "最后的答案 🚀" } }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: "最后的答案 🚀" } }),
        ];
        const source = events.join("\r\n");
        const chunks: string[] = [];
        for (let index = 0; index < source.length; index += 7) chunks.push(source.slice(index, index + 7));
        const parsed = parseSubagentNdjson(chunks.join(""));
        expect(parsed.output).toBe("最后的答案 🚀");
        expect(parsed.malformedLines).toEqual(["{malformed"]);
        expect(parsed.output).not.toContain("忽略");
    });

    it("keeps long Unicode activity bounded", () => {
        const line = JSON.stringify({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "界".repeat(100_000) },
        });
        const parsed = parseSubagentNdjson(line);
        expect(Array.from(parsed.output).length).toBe(100_000);
        expect(parsed.activityLog ?? "").toBeDefined();
    });

    it("rejects encoded and mapped metadata endpoints", () => {
        for (const endpoint of [
            "https://%31%36%39.254.169.254/",
            "https://[::ffff:169.254.169.254]/latest",
            "https://[0:0:0:0:0:ffff:a9fe:a9fe]/latest",
            "https://metadata%2Egoogle%2Einternal/computeMetadata/v1",
        ]) {
            expect(() => assertSafeEndpoint(endpoint)).toThrow();
        }
    });

    it("redacts nested payloads, headers, URLs, and artifacts as one operation", () => {
        const payload = JSON.stringify({
            error: { headers: { authorization: "Bearer secret-token-value" } },
            artifact: "https://user:password123@host/path?api_key=secret-value",
        });
        const result = redactSensitive(payload);
        expect(result).not.toContain("secret-token-value");
        expect(result).not.toContain("password123");
        expect(result).not.toContain("secret-value");
    });
});
