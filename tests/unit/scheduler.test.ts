import { describe, expect, it } from "vitest";
import { scheduleTasks } from "../../src/runtime/scheduler.js";

describe("scheduler", () => {
    it("enforces global and provider limits while preserving result order", async () => {
        let active = 0;
        let maximum = 0;
        const states: string[] = [];
        const result = await scheduleTasks({
            maxConcurrency: 3,
            providerLimits: { same: 1 },
            tasks: Array.from({ length: 4 }, (_, index) => ({
                id: String(index),
                provider: index < 3 ? "same" : "other",
                run: async () => {
                    active += 1;
                    maximum = Math.max(maximum, active);
                    await new Promise((resolve) => setTimeout(resolve, 2));
                    active -= 1;
                    return index;
                },
            })),
            onState: (id, state) => states.push(`${id}:${state}`),
        });
        expect(result.map((entry) => entry.status === "fulfilled" ? entry.value : null)).toEqual([0, 1, 2, 3]);
        expect(maximum).toBe(2);
        expect(states).toContain("0:queued");
        expect(states).toContain("0:running");
        expect(states).toContain("3:success");
    });

    it("aborts queued work without starting it", async () => {
        const controller = new AbortController();
        let started = 0;
        const promise = scheduleTasks({
            maxConcurrency: 1,
            signal: controller.signal,
            tasks: [
                { id: "first", run: async () => { started += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return 1; } },
                { id: "second", run: async () => { started += 1; return 2; } },
            ],
        });
        controller.abort(new Error("stop"));
        const result = await promise;
        expect(started).toBeLessThan(2);
        expect(result[1]?.status).toBe("rejected");
    });

    it("transfers a running task permit before a cross-provider fallback", async () => {
        let releaseProviderB: (() => void) | undefined;
        let switching: (() => void) | undefined;
        let switched = false;
        let activeProviderB = 0;
        let maximumProviderB = 0;
        const providerBBlocked = new Promise<void>((resolve) => { releaseProviderB = resolve; });
        const switchStarted = new Promise<void>((resolve) => { switching = resolve; });
        const running = scheduleTasks({
            maxConcurrency: 2,
            providerLimits: { a: 1, b: 1 },
            tasks: [
                {
                    id: "holder",
                    provider: "b",
                    run: async () => {
                        activeProviderB += 1;
                        maximumProviderB = Math.max(maximumProviderB, activeProviderB);
                        await providerBBlocked;
                        activeProviderB -= 1;
                        return "holder";
                    },
                },
                {
                    id: "fallback",
                    provider: "a",
                    run: async (lease) => {
                        switching?.();
                        await lease.switchTo("b");
                        switched = true;
                        activeProviderB += 1;
                        maximumProviderB = Math.max(maximumProviderB, activeProviderB);
                        activeProviderB -= 1;
                        return "fallback";
                    },
                },
            ],
        });
        await switchStarted;
        await Promise.resolve();
        expect(switched).toBe(false);
        releaseProviderB?.();
        const result = await running;

        expect(result.every((entry) => entry.status === "fulfilled")).toBe(true);
        expect(maximumProviderB).toBe(1);
    });
});
