import { describe, expect, it } from "vitest";
import { CircuitBreaker, classifyRetryReason, retry, RetryError, withFallback } from "../../src/runtime/retry.js";

describe("retry policies", () => {
    it("classifies retryable and permanent failures", () => {
        expect(classifyRetryReason(new Error("HTTP 429 rate limit"))).toBe("rate-limit");
        expect(classifyRetryReason(new Error("RESOURCE_EXHAUSTED: concurrency limit"))).toBe("rate-limit");
        expect(classifyRetryReason(new Error("provider overloaded"))).toBe("provider");
        expect(classifyRetryReason(new Error("unsafe metadata endpoint"))).toBe("unsafe-endpoint");
        expect(classifyRetryReason(new Error("401 authentication"))).toBe("authentication");
        expect(classifyRetryReason(new Error("latency 403ms while provider returned HTTP 503"))).toBe("provider");
        expect(classifyRetryReason(new RetryError("HTTP 503 body mentions 401", undefined, 503))).toBe("provider");
        expect(classifyRetryReason(new RetryError("arbitrary body", undefined, 429))).toBe("rate-limit");
        expect(classifyRetryReason(Object.assign(new Error("socket failed"), { code: "ECONNRESET" }))).toBe("network");
    });
    it("uses deterministic backoff and Retry-After without real sleeps", async () => {
        let calls = 0;
        const delays: number[] = [];
        const notified: number[] = [];
        const result = await retry(async () => {
            calls += 1;
            if (calls < 3) throw new RetryError("429", 17, 429);
            return "ok";
        }, { maxAttempts: 3, jitter: 0, sleep: async (delay) => { delays.push(delay); }, onRetry: (attempt) => notified.push(attempt.attempt) }, new AbortController().signal);
        expect(result.value).toBe("ok");
        expect(delays).toEqual([17, 17]);
        expect(notified).toEqual([1, 2]);
    });
    it("does not sleep when an operation aborts its signal before throwing", async () => {
        const controller = new AbortController();
        const startedAt = Date.now();
        await expect(retry(async () => {
            controller.abort(new Error("stop now"));
            throw new Error("timed out");
        }, { maxAttempts: 2, baseDelayMs: 10_000, jitter: 0 }, controller.signal)).rejects.toThrow("stop now");
        expect(Date.now() - startedAt).toBeLessThan(500);
    });
    it("supports ordered fallback and a cooldown circuit", async () => {
        const fallback = await withFallback(["a", "b"], async (model) => { if (model === "a") throw new Error("provider 503"); return model; }, new AbortController().signal);
        expect(fallback.model).toBe("b");
        let now = 0;
        const breaker = new CircuitBreaker(2, 100, () => now);
        breaker.recordFailure();
        breaker.recordFailure();
        expect(breaker.canRequest()).toBe(false);
        now = 100;
        expect(breaker.state).toBe("half-open");
        breaker.recordSuccess();
        expect(breaker.state).toBe("closed");
    });
});
