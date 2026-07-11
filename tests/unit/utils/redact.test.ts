import { describe, expect, it } from "vitest";
import { redactSensitive } from "../../../src/utils/redact.js";

describe("redactSensitive", () => {
    it("redacts bearer tokens and sk- API keys", () => {
        expect(redactSensitive("Authorization Bearer abc.def")).toBe(
            "Authorization Bearer [redacted]",
        );
        expect(redactSensitive("bad key sk-ant-api03-secretvalue")).toBe(
            "bad key [redacted-api-key]",
        );
        expect(redactSensitive("Authorization: Bearer secret-token")).toBe(
            "Authorization: [redacted]",
        );
    });

    it("redacts query-style api_key / token assignments", () => {
        expect(redactSensitive("url?api_key=secret-token-value&x=1")).toBe(
            "url?api_key=[redacted]&x=1",
        );
        expect(redactSensitive("url?token=abcdefgh1234&x=1")).toBe(
            "url?token=[redacted]&x=1",
        );
        expect(redactSensitive("url?access_token=abcdefgh1234&keep=1")).toBe(
            "url?access_token=[redacted]&keep=1",
        );
    });

    it("does not redact short values or non-secret keys", () => {
        expect(redactSensitive("count=5")).toBe("count=5");
        expect(redactSensitive("token=abc")).toBe("token=abc");
        expect(redactSensitive("interval=5000")).toBe("interval=5000");
    });

    it("redacts x-api-key and proxy-authorization headers", () => {
        expect(redactSensitive("x-api-key: sk-ant-api03-secretvalue")).toBe(
            "x-api-key: [redacted]",
        );
        expect(redactSensitive("proxy-authorization: Bearer abc.def.ghi")).toBe(
            "proxy-authorization: [redacted]",
        );
    });

    it("redacts set-cookie header values", () => {
        expect(redactSensitive("set-cookie: session=abc123def456; Path=/")).toBe(
            "set-cookie: [redacted]",
        );
    });

    it("redacts JSON secret fields", () => {
        expect(redactSensitive('{"apiKey": "sk-ant-api03-secretvalue"}')).toBe(
            '{"apiKey": "[redacted]"}',
        );
        expect(redactSensitive('{"password": "supersecret-pw"}')).toBe(
            '{"password": "[redacted]"}',
        );
    });

    it("redacts URL userinfo credentials", () => {
        expect(redactSensitive("https://user:secretpass@host.example/path")).toBe(
            "https://[redacted]@host.example/path",
        );
    });

    it("redacts a realistic Anthropic-style error body", () => {
        const message =
            'HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key sk-ant-api03-verysecretkey"}}';
        const redacted = redactSensitive(message);
        expect(redacted).not.toContain("sk-ant-api03-verysecretkey");
        expect(redacted).toContain("[redacted-api-key]");
    });

    it("is idempotent (double redaction stays redacted)", () => {
        const once = redactSensitive("Authorization: Bearer secret-token-value");
        expect(redactSensitive(once)).toBe(once);
    });
});
