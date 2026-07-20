import { describe, expect, it } from "vitest";
import { buildChildEnvironment, findPiBinaryOnPath, PI_CHILD_ENV_ALLOWLIST } from "../../src/subagent/runtime.js";

describe("subagent runtime environment", () => {
    it("passes Pi provider credentials without exposing unrelated secrets", () => {
        const names = ["MINIMAX_CN_API_KEY", "HF_TOKEN", "COPILOT_GITHUB_TOKEN", "GOOGLE_CLOUD_PROJECT", "AWS_SESSION_TOKEN"] as const;
        const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
        const previousRandom = process.env.CHORUS_RANDOM_SECRET;
        try {
            for (const name of names) process.env[name] = `${name}-value`;
            process.env.CHORUS_RANDOM_SECRET = "do-not-forward";
            const env = buildChildEnvironment("read-only");
            for (const name of names) {
                expect(PI_CHILD_ENV_ALLOWLIST).toContain(name);
                expect(env[name]).toBe(`${name}-value`);
            }
            expect(env).not.toHaveProperty("CHORUS_RANDOM_SECRET");
        } finally {
            for (const name of names) {
                const value = previous[name];
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            if (previousRandom === undefined) delete process.env.CHORUS_RANDOM_SECRET;
            else process.env.CHORUS_RANDOM_SECRET = previousRandom;
        }
    });

    it("searches Windows PATHEXT entries individually and in order", () => {
        const checked: string[] = [];
        const result = findPiBinaryOnPath({
            platform: "win32",
            path: "/first;/second",
            pathExt: ".CMD;.EXE;.BAT",
            isFile: (candidate) => {
                checked.push(candidate);
                return candidate === "/second/pi.EXE";
            },
        });

        expect(result).toBe("/second/pi.EXE");
        expect(checked).toEqual([
            "/first/pi",
            "/first/pi.CMD",
            "/first/pi.EXE",
            "/first/pi.BAT",
            "/second/pi",
            "/second/pi.CMD",
            "/second/pi.EXE",
        ]);
    });
});
