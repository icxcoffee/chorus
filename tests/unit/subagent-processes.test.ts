import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { activeSubagentProcessCount, cleanupActiveSubagentProcesses, registerActiveSubagentProcess } from "../../src/subagent/processes.js";

describe("active subagent process registry", () => {
    it("tracks active children and removes terminal processes", () => {
        const first = child();
        const second = child();
        const unregisterFirst = registerActiveSubagentProcess(first);
        registerActiveSubagentProcess(second);
        expect(activeSubagentProcessCount()).toBe(2);
        unregisterFirst();
        second.emit("close", 0);
        expect(activeSubagentProcessCount()).toBe(0);
    });

    it("attempts best-effort termination for every active child", () => {
        const first = child();
        const second = child();
        const unregisterFirst = registerActiveSubagentProcess(first);
        const unregisterSecond = registerActiveSubagentProcess(second);
        const terminate = vi.fn();
        cleanupActiveSubagentProcesses(terminate);
        expect(terminate).toHaveBeenCalledTimes(2);
        expect(terminate.mock.calls.every((call) => call[1] === "SIGTERM")).toBe(true);
        unregisterFirst();
        unregisterSecond();
    });
});

function child() {
    const value = new EventEmitter() as EventEmitter & { kill: () => boolean };
    value.kill = () => true;
    return value;
}
