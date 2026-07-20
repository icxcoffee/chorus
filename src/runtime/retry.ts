export type RetryReason = "rate-limit" | "timeout" | "network" | "provider" | "validation" | "authentication" | "unsafe-endpoint" | "aborted" | "unknown";

export interface RetryPolicy {
    maxAttempts: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
    sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
    random?: () => number;
    onRetry?: (attempt: RetryAttempt) => void;
}

export interface RetryAttempt {
    attempt: number;
    delayMs: number;
    reason?: RetryReason;
    error?: string;
}

export class RetryError extends Error {
    constructor(message: string, public readonly retryAfterMs?: number, public readonly status?: number) {
        super(message);
        this.name = "RetryError";
    }
}

export function classifyRetryReason(error: unknown): RetryReason {
    if (error instanceof DOMException && error.name === "AbortError") return "aborted";
    const status = numericErrorField(error, "status") ?? numericErrorField(error, "statusCode");
    if (status === 401 || status === 403) return "authentication";
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate-limit";
    if (status !== undefined && status >= 500 && status <= 599) return "provider";
    const code = stringErrorField(error, "code")?.toLowerCase();
    if (code === "abort_err" || code === "aborted" || code === "cancelled") return "aborted";
    if (code === "resource_exhausted" || code === "too_many_requests") return "rate-limit";
    if (code === "unauthenticated" || code === "permission_denied") return "authentication";
    if (code === "etimedout" || code === "err_timeout") return "timeout";
    if (code?.startsWith("econn") || code === "enotfound" || code === "eai_again") return "network";
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    if (message.includes("abort") || message.includes("cancel")) return "aborted";
    if (message.includes("unsafe") || message.includes("non-https") || message.includes("metadata")) return "unsafe-endpoint";
    if (/\b(?:401|403)\b/.test(message) || /\b(?:auth(?:entication|orization)?|api[-_\s]?key)\b/.test(message)) return "authentication";
    if (message.includes("validation") || message.includes("invalid model") || message.includes("missing endpoint")) return "validation";
    if (/\b429\b/.test(message) || message.includes("rate limit") || message.includes("rate-limit") || message.includes("rate_limit")
        || message.includes("too many requests") || message.includes("resource exhausted") || message.includes("resource_exhausted")
        || message.includes("quota exceeded") || message.includes("concurrency limit") || message.includes("concurrent request")) return "rate-limit";
    if (message.includes("timeout") || message.includes("timed out")) return "timeout";
    if (message.includes("network") || message.includes("fetch") || message.includes("econn") || message.includes("socket")) return "network";
    if (/\b5\d\d\b/.test(message) || message.includes("provider") || message.includes("overloaded") || message.includes("service unavailable")) return "provider";
    return "unknown";
}

function numericErrorField(error: unknown, field: "status" | "statusCode"): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const value = (error as Record<string, unknown>)[field];
    return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringErrorField(error: unknown, field: "code"): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const value = (error as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
}

export function isRetryable(reason: RetryReason): boolean {
    return reason === "rate-limit" || reason === "timeout" || reason === "network" || reason === "provider";
}

export async function retry<T>(operation: (attempt: number) => Promise<T>, policy: RetryPolicy, signal: AbortSignal): Promise<{ value: T; attempts: RetryAttempt[] }> {
    const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
    const attempts: RetryAttempt[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        try {
            return { value: await operation(attempt), attempts };
        } catch (error) {
            const reason = classifyRetryReason(error);
            const retryAfterMs = error instanceof RetryError ? error.retryAfterMs : undefined;
            const delayMs = attempt >= maxAttempts || !isRetryable(reason)
                ? 0
                : retryDelay(attempt, policy, retryAfterMs);
            attempts.push({ attempt, delayMs, reason, error: error instanceof Error ? error.message : String(error) });
            if (delayMs === 0) throw error;
            policy.onRetry?.(attempts[attempts.length - 1]!);
            await (policy.sleep ?? defaultSleep)(delayMs, signal);
        }
    }
    throw new Error("retry policy exhausted");
}

export async function withFallback<T>(models: string[], operation: (model: string) => Promise<T>, signal: AbortSignal): Promise<{ value: T; model: string; attempts: string[] }> {
    const attempts: string[] = [];
    for (const model of models) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        attempts.push(model);
        try {
            return { value: await operation(model), model, attempts };
        } catch (error) {
            if (!isRetryable(classifyRetryReason(error))) throw error;
        }
    }
    throw new Error(`all fallback models failed: ${attempts.join(", ")}`);
}

export class CircuitBreaker {
    private failures = 0;
    private openedAt: number | undefined;
    constructor(private readonly threshold = 3, private readonly cooldownMs = 30_000, private readonly now: () => number = Date.now) {}
    get state(): "closed" | "open" | "half-open" {
        if (this.openedAt === undefined) return "closed";
        return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
    }
    canRequest(): boolean { return this.state !== "open"; }
    recordSuccess(): void { this.failures = 0; this.openedAt = undefined; }
    recordFailure(): void { this.failures += 1; if (this.failures >= this.threshold) this.openedAt = this.now(); }
}

function retryDelay(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
    const base = policy.baseDelayMs ?? 250;
    const cap = policy.maxDelayMs ?? 30_000;
    const exponential = Math.min(cap, retryAfterMs ?? base * (2 ** (attempt - 1)));
    const jitter = Math.max(0, Math.min(1, policy.jitter ?? 0.2));
    const random = policy.random?.() ?? Math.random();
    return Math.max(0, Math.round(exponential * (1 - jitter + random * jitter * 2)));
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}
