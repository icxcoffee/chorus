/**
 * Redacts common credential patterns from arbitrary text before it is rendered,
 * logged, or persisted (e.g. into history.jsonl / jobs.json).
 *
 * Coverage is best-effort: it targets the shapes that provider error bodies,
 * stack traces, and debug headers most commonly leak (Bearer tokens, `sk-...`
 * API keys, Authorization / x-api-key / proxy-authorization / set-cookie
 * headers, `key=value` assignments including URL query parameters, JSON secret
 * fields, and URL `userinfo:password@host`). Short values (<8 chars) are left
 * intact to avoid over-redacting ordinary words.
 */
export function redactSensitive(text: string): string {
    return REDACTION_PATTERNS.reduce(
        (sanitized, [pattern, replacement]) =>
            sanitized.replace(pattern, replacement),
        text,
    );
}

const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    // Bearer tokens, e.g. "Bearer eyJhbGci..." / "Authorization: Bearer abc.def"
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]"],
    // Anthropic / OpenAI style API keys, e.g. "sk-ant-api03-..."
    [/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]"],
    // Sensitive headers: Authorization, x-api-key, proxy-authorization
    [
        /(Authorization|x-api-key|proxy-authorization)\s*:\s*[^\s,;\r\n]+(?:\s+[^\s,;\r\n]+)?/gi,
        "$1: [redacted]",
    ],
    // set-cookie header values (may contain session ids)
    [/set-cookie\s*:\s*[^\r\n,]+/gi, "set-cookie: [redacted]"],
    // key=value assignments for known secret names; covers query params, env, inline config.
    // Requires an 8+ char value to avoid clobbering short tokens like "token=1".
    [
        /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?key|secret|token|password|passwd)([=:]\s*)["']?[A-Za-z0-9._~+/=-]{8,}/gi,
        "$1$2[redacted]",
    ],
    // JSON string fields for secret names, e.g. {"apiKey": "sk-..."}
    [
        /"(api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|secret[_-]?key|secretKey|secret|token|password|passwd)"\s*:\s*"[^"]*"/gi,
        '"$1": "[redacted]"',
    ],
    // URL userinfo credentials, e.g. "https://user:pass@host/"
    [/(?<=:\/\/)[^\s/:@]+:[^\s/:@]+@/g, "[redacted]@"],
];
